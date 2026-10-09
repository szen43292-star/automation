import { DelayedError, Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';
import type { PushEvent } from '../push/PushHub';
import type { PushPublisher } from '../executions/types';

export const QUEUE_NAME = 'flowforge-executions';
const PUSH_CHANNEL = 'flowforge:push';
const COMMAND_CHANNEL = 'flowforge:commands';

export interface ExecutionJobData {
  executionId: string;
  workflowId: string;
  maxConcurrency?: number;
}

export type Command =
  | { type: 'cancel'; executionId: string }
  /** Workers ask the main process (which hosts call audio) to request permission or call. */
  | { type: 'callPermission'; accountId: string; to: string; text?: string }
  | { type: 'startCall'; accountId: string; to: string; agentId?: string | null; purpose: string };

/**
 * Redis-backed pieces of queue mode:
 * - BullMQ queue of executions (main enqueues, workers consume)
 * - pub/sub: workers → main live events, main → workers cancel commands
 */
export class QueueService {
  readonly queue: Queue<ExecutionJobData>;
  private readonly publisher: Redis;
  private subscriber?: Redis;
  private readonly connections: Redis[] = [];

  constructor(
    private readonly redisUrl: string,
    private readonly logger: FastifyBaseLogger,
    readonly prefix = 'flowforge',
  ) {
    this.publisher = this.connect();
    this.queue = new Queue<ExecutionJobData>(QUEUE_NAME, { connection: this.connect(), prefix });
  }

  private connect(): Redis {
    const connection = new Redis(this.redisUrl, { maxRetriesPerRequest: null, lazyConnect: false });
    connection.on('error', (error) => this.logger.warn({ err: error }, 'Redis connection error'));
    this.connections.push(connection);
    return connection;
  }

  async enqueue(data: ExecutionJobData, priority?: number) {
    await this.queue.add('execute', data, {
      jobId: data.executionId,
      removeOnComplete: 1000,
      removeOnFail: 1000,
      ...(priority ? { priority } : {}),
    });
  }

  /** Remove a job that has not started yet. Returns true when it was removed. */
  async removeWaiting(executionId: string): Promise<boolean> {
    const job = await this.queue.getJob(executionId);
    if (!job) return false;
    const state = await job.getState();
    if (state === 'waiting' || state === 'delayed' || state === 'prioritized') {
      await job.remove();
      return true;
    }
    return false;
  }

  /** Publisher used by workers to forward live events to the main process. */
  pushPublisher(): PushPublisher {
    return {
      publish: (topics, event) => {
        void this.publisher
          .publish(PUSH_CHANNEL, JSON.stringify({ topics, event }))
          .catch(() => undefined);
      },
    };
  }

  sendCommand(command: Command) {
    void this.publisher.publish(COMMAND_CHANNEL, JSON.stringify(command)).catch(() => undefined);
  }

  /** Main process: relay worker events to WebSocket clients. Workers: receive commands. */
  async subscribe(handlers: {
    onPush?: (topics: string[], event: PushEvent) => void;
    onCommand?: (command: Command) => void;
  }) {
    this.subscriber ??= this.connect();
    const channels = [
      handlers.onPush ? PUSH_CHANNEL : null,
      handlers.onCommand ? COMMAND_CHANNEL : null,
    ].filter((c): c is string => Boolean(c));
    await this.subscriber.subscribe(...channels);
    this.subscriber.on('message', (channel, raw) => {
      try {
        const message = JSON.parse(raw);
        if (channel === PUSH_CHANNEL) handlers.onPush?.(message.topics, message.event);
        if (channel === COMMAND_CHANNEL) handlers.onCommand?.(message);
      } catch (error) {
        this.logger.warn({ err: error }, 'Invalid pub/sub message');
      }
    });
  }

  /**
   * Start consuming jobs. Enforces each workflow's `maxConcurrency` across all
   * workers with a Redis counter; over-limit jobs are delayed and retried.
   */
  createWorker(
    concurrency: number,
    run: (data: ExecutionJobData) => Promise<void>,
  ): Worker<ExecutionJobData> {
    const redis = this.publisher;
    const worker = new Worker<ExecutionJobData>(
      QUEUE_NAME,
      async (job: Job<ExecutionJobData>, token?: string) => {
        const { workflowId, maxConcurrency } = job.data;
        const key = `${this.prefix}:running:${workflowId}`;
        if (maxConcurrency) {
          const running = await redis.incr(key);
          await redis.expire(key, 3600);
          if (running > maxConcurrency) {
            await redis.decr(key);
            await job.moveToDelayed(Date.now() + 500, token);
            throw new DelayedError();
          }
        }
        try {
          await run(job.data);
        } finally {
          if (maxConcurrency) await redis.decr(key);
        }
      },
      { connection: this.connect(), prefix: this.prefix, concurrency, maxStalledCount: 1 },
    );
    worker.on('failed', (job, error) => {
      if (!(error instanceof DelayedError))
        this.logger.error({ err: error, jobId: job?.id }, 'Execution job failed');
    });
    return worker;
  }

  async close() {
    await this.queue.close();
    await Promise.allSettled(this.connections.map((c) => c.quit()));
  }
}
