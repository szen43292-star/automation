import type { FastifyBaseLogger } from 'fastify';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  Workflow,
  summariseTask,
  type IDataObject,
  type IExecuteWorkflowResult,
  type IExecuteWorkflowSource,
  type ILogger,
  type INodeExecutionData,
  type INodeTypes,
  type IRun,
  type IRunExecutionData,
  type IWhatsAppHelper,
  type IWorkflowBase,
} from '@flowforge/workflow';
import { CodeSandbox, WorkflowExecute, createAdditionalData } from '@flowforge/engine';
import type { AuthUser } from '../auth/auth';
import type { Config } from '../config';
import type { CredentialsService } from '../credentials/CredentialsService';
import { badRequest, conflict, notFound } from '../lib/errors';
import type { QueueService } from '../queue/QueueService';
import type { VariablesService } from '../variables/routes';
import { toWorkflowDTO, type WorkflowService } from '../workflows/WorkflowService';
import { KeyedSemaphore } from './Semaphore';
import type { PushPublisher, StartData, StartExecutionOptions } from './types';

interface ActiveExecution {
  executor: WorkflowExecute;
  workflowId: string;
  done: Promise<IRun>;
}

const json = (value: unknown) => value as Prisma.InputJsonValue;
const MAX_SUBWORKFLOW_DEPTH = 10;

export interface ExecutionServiceDeps {
  prisma: PrismaClient;
  nodeTypes: INodeTypes;
  workflows: WorkflowService;
  credentials: CredentialsService;
  variables: VariablesService;
  push: PushPublisher;
  config: Config;
  logger: FastifyBaseLogger;
  /** Present in queue mode on the main process. */
  queue?: QueueService;
  /** Worker processes never enqueue: they run everything they receive. */
  inProcessOnly?: boolean;
  /** Connected WhatsApp numbers for WhatsApp nodes. */
  whatsapp?: IWhatsAppHelper;
}

/**
 * Starts, runs and persists executions.
 *
 * Two paths:
 * - in-process: manual runs, synchronous webhooks, sub-workflows (low latency)
 * - queued (EXECUTIONS_MODE=queue): production executions go to BullMQ workers
 */
export class ExecutionService {
  private readonly active = new Map<string, ActiveExecution>();
  /** Every in-process run, registered as soon as it is started. */
  private readonly pending = new Map<string, Promise<IRun>>();
  /** Stop requested before the executor existed. */
  private readonly cancelRequested = new Set<string>();
  private readonly sandbox: CodeSandbox;
  private readonly engineLogger: ILogger;
  private readonly limiter = new KeyedSemaphore();

  constructor(private readonly deps: ExecutionServiceDeps) {
    const { config, logger } = deps;
    this.sandbox = new CodeSandbox({
      timeoutMs: config.CODE_TIMEOUT_MS,
      memoryLimitMb: config.CODE_MEMORY_MB,
    });
    this.engineLogger = {
      debug: (msg, meta) => logger.debug(meta ?? {}, msg),
      info: (msg, meta) => logger.info(meta ?? {}, msg),
      warn: (msg, meta) => logger.warn(meta ?? {}, msg),
      error: (msg, meta) => logger.error(meta ?? {}, msg),
    };
  }

  private get prisma() {
    return this.deps.prisma;
  }

  private get queued() {
    return Boolean(this.deps.queue) && !this.deps.inProcessOnly;
  }

  // -------------------------------------------------------------------------
  // Starting executions
  // -------------------------------------------------------------------------

  /** Create the execution and run it (in-process or via the queue). Returns immediately. */
  async start(options: StartExecutionOptions): Promise<{ executionId: string }> {
    const executionId = await this.createRecord(options);
    if (this.queued && !options.inProcess && options.mode !== 'manual') {
      await this.deps.queue!.enqueue({
        executionId,
        workflowId: options.workflowId,
        maxConcurrency: options.workflowData.settings?.maxConcurrency,
      });
      return { executionId };
    }
    this.runInProcess(executionId, options);
    return { executionId };
  }

  /** Run in this process and wait for the result (sync webhooks, sub-workflows, tests). */
  async runSync(options: StartExecutionOptions): Promise<{ executionId: string; run: IRun }> {
    const executionId = await this.createRecord(options);
    const run = await this.runInProcess(executionId, { ...options, inProcess: true });
    return { executionId, run };
  }

  private async createRecord(options: StartExecutionOptions): Promise<string> {
    try {
      new Workflow({ ...options.workflowData, id: options.workflowId });
    } catch (error) {
      throw badRequest((error as Error).message);
    }
    const startData: StartData = {
      startNode: options.startNode,
      destinationNode: options.destinationNode,
      triggerItems: options.triggerItems,
      resumeFrom: options.resumeFrom,
      resumeData: options.resumeData,
      runData: options.runData,
      dirtyNodes: options.dirtyNodes,
    };
    const execution = await this.prisma.execution.create({
      data: {
        workflowId: options.workflowId,
        mode: options.mode,
        status: 'new',
        retryOfId: options.retryOfId,
        parentExecutionId: options.parentExecutionId,
        triggeredById: options.userId,
        data: {
          create: {
            workflowData: json({ ...options.workflowData, id: options.workflowId }),
            data: json({}),
            startData: json(startData),
          },
        },
      },
    });
    return execution.id;
  }

  private runInProcess(executionId: string, options: StartExecutionOptions): Promise<IRun> {
    const done = (async () => {
      const limit =
        options.mode === 'manual' ? undefined : options.workflowData.settings?.maxConcurrency;
      const release = limit
        ? await this.limiter.acquire(options.workflowId, limit)
        : () => undefined;
      try {
        return await this.execute(executionId, options);
      } finally {
        release();
      }
    })();
    done.catch((error: unknown) =>
      this.deps.logger.error({ err: error, executionId }, 'Execution failed to run'),
    );
    const tracked = done.finally(() => {
      this.pending.delete(executionId);
      this.cancelRequested.delete(executionId);
    });
    tracked.catch(() => undefined);
    this.pending.set(executionId, tracked);
    return done;
  }

  /** Worker entry point: run a queued execution by id. */
  async runQueued(executionId: string): Promise<void> {
    const row = await this.prisma.execution.findUnique({
      where: { id: executionId },
      include: { data: true },
    });
    if (!row?.data) {
      this.deps.logger.warn({ executionId }, 'Queued execution no longer exists');
      return;
    }
    if (row.status === 'canceled') return;
    const startData = (row.data.startData ?? {}) as StartData;
    await this.execute(executionId, {
      ...startData,
      userId: row.triggeredById,
      workflowId: row.workflowId,
      workflowData: row.data.workflowData as unknown as IWorkflowBase,
      mode: row.mode,
      retryOfId: row.retryOfId ?? undefined,
      parentExecutionId: row.parentExecutionId ?? undefined,
    });
  }

  /** Run an existing execution record and persist the result. */
  private async execute(executionId: string, options: StartExecutionOptions): Promise<IRun> {
    const { workflowId, workflowData } = options;
    const workflow = new Workflow({ ...workflowData, id: workflowId });
    const topics = [`workflow:${workflowId}`, `execution:${executionId}`];
    if (options.userId) topics.push(`user:${options.userId}`);

    const owner = await this.prisma.workflow
      .findUnique({
        where: { id: workflowId },
        select: { owner: { select: { id: true, role: true } } },
      })
      .then((w) => w?.owner ?? null);

    const startedAt = new Date();
    await this.prisma.execution.update({
      where: { id: executionId },
      data: { status: 'running', startedAt },
    });
    const push = this.deps.push;

    const executor = new WorkflowExecute(
      workflow,
      createAdditionalData({
        executionId,
        mode: options.mode,
        nodeTypes: this.deps.nodeTypes,
        codeSandbox: this.sandbox,
        logger: this.engineLogger,
        defaultTimezone: this.deps.config.DEFAULT_TIMEZONE,
        workflowActive: workflowData.active ?? false,
        variables: await this.deps.variables.all(),
        credentials: this.deps.credentials.helper(owner),
        publicUrl: this.deps.config.PUBLIC_URL,
        whatsapp: this.deps.whatsapp,
        sendWebhookResponse: options.sendWebhookResponse,
        executeWorkflow: (source, items, opts) =>
          this.executeSubWorkflow(source, items, opts, { executionId, workflowId, owner }),
        hooks: {
          nodeExecuteBefore: (nodeName) =>
            push.publish(topics, {
              type: 'nodeExecuteBefore',
              data: { executionId, workflowId, nodeName },
            }),
          nodeExecuteAfter: (nodeName, task, runIndex) =>
            push.publish(topics, {
              type: 'nodeExecuteAfter',
              data: { executionId, workflowId, nodeName, runIndex, ...summariseTask(task) },
            }),
        },
      }),
    );

    push.publish(topics, {
      type: 'executionStarted',
      data: { executionId, workflowId, mode: options.mode, startedAt: startedAt.toISOString() },
    });

    const done = executor
      .run({
        startNode: options.startNode,
        destinationNode: options.destinationNode,
        triggerItems: options.triggerItems,
        resumeFrom: options.resumeFrom,
        resumeData: options.resumeData,
        runData: options.runData,
        dirtyNodes: options.dirtyNodes,
      })
      .then(async (run) => {
        await this.persist(executionId, options, run);
        push.publish(topics, {
          type: 'executionFinished',
          data: {
            executionId,
            workflowId,
            status: run.status,
            stoppedAt: run.stoppedAt,
            errorMessage: run.data.resultData.error?.message,
          },
        });
        if ((run.status === 'error' || run.status === 'crashed') && options.mode !== 'manual') {
          await this.startErrorWorkflow(executionId, options, run).catch((error: unknown) =>
            this.deps.logger.error({ err: error }, 'Could not start the error workflow'),
          );
        }
        return run;
      })
      .catch(async (error: unknown) => {
        this.deps.logger.error({ err: error, executionId }, 'Execution crashed');
        await this.markCrashed(executionId, error);
        throw error;
      })
      .finally(() => this.active.delete(executionId));

    this.active.set(executionId, { executor, workflowId, done });
    if (this.cancelRequested.has(executionId)) executor.cancel('Execution was stopped by a user');
    return done;
  }

  private async persist(executionId: string, options: StartExecutionOptions, run: IRun) {
    const error = run.data.resultData.error;
    await this.prisma.$transaction([
      this.prisma.execution.update({
        where: { id: executionId },
        data: {
          status: run.status,
          stoppedAt: run.status === 'waiting' ? null : new Date(run.stoppedAt),
          waitTill:
            run.status === 'waiting' && run.data.waitTill ? new Date(run.data.waitTill) : null,
          lastNodeExecuted: run.data.resultData.lastNodeExecuted ?? null,
          errorMessage: error ? error.message.slice(0, 2000) : null,
        },
      }),
      this.prisma.executionData.update({
        where: { executionId },
        data: { data: json(run.data), startData: json({}) },
      }),
      ...(options.retryOfId && run.status === 'success'
        ? [
            this.prisma.execution.update({
              where: { id: options.retryOfId },
              data: { retrySuccessId: executionId },
            }),
          ]
        : []),
    ]);
  }

  private async markCrashed(executionId: string, error: unknown) {
    await this.prisma.execution
      .update({
        where: { id: executionId },
        data: {
          status: 'crashed',
          stoppedAt: new Date(),
          errorMessage: String((error as Error)?.message ?? error),
        },
      })
      .catch((e: unknown) =>
        this.deps.logger.error({ err: e }, 'Could not mark execution as crashed'),
      );
  }

  // -------------------------------------------------------------------------
  // Sub-workflows and error workflows
  // -------------------------------------------------------------------------

  private async executeSubWorkflow(
    source: IExecuteWorkflowSource,
    items: INodeExecutionData[],
    options: { waitForCompletion: boolean },
    parent: { executionId: string; workflowId: string; owner: { id: string; role: string } | null },
  ): Promise<IExecuteWorkflowResult> {
    const depth = await this.depthOf(parent.executionId);
    if (depth >= MAX_SUBWORKFLOW_DEPTH) {
      throw new Error(
        `Sub-workflows are nested more than ${MAX_SUBWORKFLOW_DEPTH} levels deep - is a workflow calling itself?`,
      );
    }

    let workflowId: string;
    let workflowData: IWorkflowBase;
    if (source.workflowId) {
      const row = await this.prisma.workflow.findUnique({ where: { id: source.workflowId } });
      if (!row) throw new Error(`Sub-workflow "${source.workflowId}" does not exist`);
      if (parent.owner?.role === 'member' && row.ownerId !== parent.owner.id) {
        throw new Error(`No access to sub-workflow "${row.name}"`);
      }
      workflowId = row.id;
      workflowData = toWorkflowDTO(row);
    } else if (source.workflowData) {
      // Inline workflow JSON: runs under the calling workflow's id.
      workflowId = parent.workflowId;
      workflowData = {
        ...source.workflowData,
        name: source.workflowData.name ?? 'Inline sub-workflow',
      };
    } else {
      throw new Error('No sub-workflow given');
    }

    const trigger = workflowData.nodes.find(
      (n) => n.type === 'flowforge.executeWorkflowTrigger' && !n.disabled,
    );
    if (!trigger) {
      throw new Error(
        `Sub-workflow "${workflowData.name}" needs an "Execute Workflow Trigger" node to receive items`,
      );
    }
    const startOptions: StartExecutionOptions = {
      userId: null,
      workflowId,
      workflowData,
      mode: 'internal',
      startNode: trigger.id,
      triggerItems: items.length ? items : [{ json: {} }],
      parentExecutionId: parent.executionId,
      inProcess: true,
    };
    if (!options.waitForCompletion) {
      const { executionId } = await this.start(startOptions);
      return { executionId, data: null };
    }
    const { executionId, run } = await this.runSync(startOptions);
    if (run.status !== 'success') {
      throw new Error(
        `Sub-workflow "${workflowData.name}" failed: ${run.data.resultData.error?.message ?? run.status}`,
      );
    }
    const last = run.data.resultData.lastNodeExecuted;
    const runs = last ? run.data.resultData.runData[last] : undefined;
    const data = runs?.[runs.length - 1]?.data?.main ?? null;
    return { executionId, data: data ? data.map((items) => items ?? []) : null };
  }

  /**
   * Run a saved workflow from its "Execute Workflow Trigger" with one item and return the last
   * node's output (AI agent tools). Recorded as an internal execution.
   */
  async runWorkflowTool(workflowId: string, input: IDataObject): Promise<IDataObject[]> {
    const row = await this.prisma.workflow.findUnique({ where: { id: workflowId } });
    if (!row) throw new Error('The workflow for this tool was deleted');
    const workflowData = toWorkflowDTO(row);
    const trigger = workflowData.nodes.find(
      (n) => n.type === 'flowforge.executeWorkflowTrigger' && !n.disabled,
    );
    if (!trigger)
      throw new Error(`Workflow "${row.name}" needs an "Execute Workflow Trigger" node`);
    const { run } = await this.runSync({
      userId: null,
      workflowId,
      workflowData,
      mode: 'internal',
      startNode: trigger.id,
      triggerItems: [{ json: input }],
      inProcess: true,
    });
    if (run.status !== 'success') {
      throw new Error(
        `Workflow "${row.name}" failed: ${run.data.resultData.error?.message ?? run.status}`,
      );
    }
    const last = run.data.resultData.lastNodeExecuted;
    const runs = last ? run.data.resultData.runData[last] : undefined;
    const items = runs?.[runs.length - 1]?.data?.main?.[0] ?? [];
    return items.map((item) => item.json);
  }

  private async depthOf(executionId: string): Promise<number> {
    let depth = 0;
    let current: string | null = executionId;
    while (current && depth <= MAX_SUBWORKFLOW_DEPTH) {
      const row: { parentExecutionId: string | null } | null =
        await this.prisma.execution.findUnique({
          where: { id: current },
          select: { parentExecutionId: true },
        });
      current = row?.parentExecutionId ?? null;
      if (current) depth++;
    }
    return depth;
  }

  private async startErrorWorkflow(executionId: string, options: StartExecutionOptions, run: IRun) {
    const errorWorkflowId = options.workflowData.settings?.errorWorkflow;
    if (!errorWorkflowId || errorWorkflowId === options.workflowId) return;
    const row = await this.prisma.workflow.findUnique({ where: { id: errorWorkflowId } });
    if (!row) {
      this.deps.logger.warn({ errorWorkflowId }, 'Error workflow does not exist');
      return;
    }
    const errorWorkflow = toWorkflowDTO(row);
    const trigger = errorWorkflow.nodes.find(
      (n) => n.type === 'flowforge.errorTrigger' && !n.disabled,
    );
    if (!trigger) {
      this.deps.logger.warn({ errorWorkflowId }, 'Error workflow has no Error Trigger node');
      return;
    }
    const error = run.data.resultData.error;
    await this.start({
      userId: null,
      workflowId: errorWorkflow.id,
      workflowData: errorWorkflow,
      mode: 'error',
      startNode: trigger.id,
      triggerItems: [
        {
          json: {
            execution: {
              id: executionId,
              url: `${this.deps.config.PUBLIC_URL.replace(/\/+$/, '')}/workflow/${options.workflowId}/executions/${executionId}`,
              error: {
                message: error?.message,
                description: error?.description,
                node: error?.node,
                name: error?.name,
              },
              lastNodeExecuted: run.data.resultData.lastNodeExecuted,
              mode: options.mode,
              ...(options.retryOfId ? { retryOf: options.retryOfId } : {}),
            },
            workflow: { id: options.workflowId, name: options.workflowData.name },
          },
        },
      ],
    });
  }

  // -------------------------------------------------------------------------
  // Waiting executions
  // -------------------------------------------------------------------------

  /**
   * Continue an execution paused by a Wait node. Returns false if it is not
   * waiting any more (already resumed, cancelled, …).
   */
  async resume(executionId: string, resumeData?: INodeExecutionData[]): Promise<boolean> {
    // Atomically claim the execution so it can't be resumed twice.
    const { count } = await this.prisma.execution.updateMany({
      where: { id: executionId, status: 'waiting' },
      data: { status: 'new', waitTill: null },
    });
    if (count === 0) return false;
    const row = await this.prisma.execution.findUniqueOrThrow({
      where: { id: executionId },
      include: { data: true },
    });
    const startData: StartData = {
      resumeFrom: row.data!.data as unknown as IRunExecutionData,
      ...(resumeData ? { resumeData } : {}),
    };
    await this.prisma.executionData.update({
      where: { executionId },
      data: { startData: json(startData) },
    });
    const options: StartExecutionOptions = {
      ...startData,
      userId: row.triggeredById,
      workflowId: row.workflowId,
      workflowData: row.data!.workflowData as unknown as IWorkflowBase,
      mode: row.mode,
    };
    if (this.queued && row.mode !== 'manual') {
      await this.deps.queue!.enqueue({
        executionId,
        workflowId: row.workflowId,
        maxConcurrency: options.workflowData.settings?.maxConcurrency,
      });
    } else {
      this.runInProcess(executionId, options);
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Control
  // -------------------------------------------------------------------------

  async waitFor(executionId: string): Promise<IRun | undefined> {
    return (this.pending.get(executionId) ?? this.active.get(executionId)?.done)?.catch(
      () => undefined,
    );
  }

  isRunning(executionId: string) {
    return this.pending.has(executionId) || this.active.has(executionId);
  }

  /** Cancel an execution running in this process. */
  cancelLocal(executionId: string, reason = 'Execution was stopped by a user'): boolean {
    const active = this.active.get(executionId);
    if (active) {
      active.executor.cancel(reason);
      return true;
    }
    if (this.pending.has(executionId)) {
      this.cancelRequested.add(executionId);
      return true;
    }
    return false;
  }

  async stop(user: AuthUser, executionId: string) {
    const execution = await this.getRow(user, executionId);
    if (this.cancelLocal(execution.id)) {
      await this.waitFor(execution.id);
      return { stopped: true };
    }
    if (execution.status === 'waiting' || execution.status === 'new') {
      if (execution.status === 'new' && this.deps.queue)
        await this.deps.queue.removeWaiting(execution.id);
      await this.prisma.execution.update({
        where: { id: execution.id },
        data: {
          status: 'canceled',
          stoppedAt: new Date(),
          waitTill: null,
          errorMessage: 'Execution was stopped by a user',
        },
      });
      return { stopped: true };
    }
    if (execution.status === 'running' && this.deps.queue) {
      this.deps.queue.sendCommand({ type: 'cancel', executionId: execution.id });
      return { stopped: true };
    }
    throw conflict('This execution is not running');
  }

  /** Retry a failed execution, either with the workflow as it was or as it is now. */
  async retry(user: AuthUser, executionId: string, useCurrentWorkflow: boolean) {
    const execution = await this.getRow(user, executionId);
    if (
      execution.status !== 'error' &&
      execution.status !== 'crashed' &&
      execution.status !== 'canceled'
    ) {
      throw badRequest('Only failed, crashed or cancelled executions can be retried');
    }
    const stored = await this.prisma.executionData.findUnique({ where: { executionId } });
    if (!stored) throw badRequest('This execution has no saved data to retry from');

    const workflowData: IWorkflowBase = useCurrentWorkflow
      ? toWorkflowDTO(await this.deps.workflows.get(user, execution.workflowId))
      : (stored.workflowData as unknown as IWorkflowBase);
    const data = stored.data as unknown as IRunExecutionData;

    return this.start({
      userId: user.id,
      workflowId: execution.workflowId,
      workflowData,
      mode: 'retry',
      // Executions that crashed before saving any state are run from the start.
      ...(data?.executionData?.nodeExecutionStack?.length ? { resumeFrom: data } : {}),
      retryOfId: execution.id,
    });
  }

  private async getRow(user: AuthUser, executionId: string) {
    const execution = await this.prisma.execution.findFirst({
      where: { id: executionId, workflow: this.deps.workflows.scope(user) },
    });
    if (!execution) throw notFound('Execution');
    return execution;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  async list(
    user: AuthUser,
    query: { workflowId?: string; status?: string[]; limit: number; cursor?: string },
  ) {
    const where: Prisma.ExecutionWhereInput = {
      workflow: this.deps.workflows.scope(user),
      ...(query.workflowId ? { workflowId: query.workflowId } : {}),
      ...(query.status?.length ? { status: { in: query.status as never } } : {}),
    };
    const rows = await this.prisma.execution.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      include: { workflow: { select: { name: true } } },
    });
    const hasMore = rows.length > query.limit;
    const page = rows.slice(0, query.limit);
    return {
      data: page.map((row) => ({
        id: row.id,
        workflowId: row.workflowId,
        workflowName: row.workflow.name,
        status: row.status,
        mode: row.mode,
        startedAt: row.startedAt?.toISOString() ?? null,
        stoppedAt: row.stoppedAt?.toISOString() ?? null,
        durationMs:
          row.startedAt && row.stoppedAt ? row.stoppedAt.getTime() - row.startedAt.getTime() : null,
        lastNodeExecuted: row.lastNodeExecuted,
        errorMessage: row.errorMessage,
        retryOfId: row.retryOfId,
        retrySuccessId: row.retrySuccessId,
        waitTill: row.waitTill?.toISOString() ?? null,
        parentExecutionId: row.parentExecutionId,
      })),
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    };
  }

  async get(user: AuthUser, executionId: string) {
    const row = await this.prisma.execution.findFirst({
      where: { id: executionId, workflow: this.deps.workflows.scope(user) },
      include: { data: true, workflow: { select: { name: true } } },
    });
    if (!row) throw notFound('Execution');
    return {
      id: row.id,
      workflowId: row.workflowId,
      workflowName: row.workflow.name,
      status: row.status,
      mode: row.mode,
      startedAt: row.startedAt?.toISOString() ?? null,
      stoppedAt: row.stoppedAt?.toISOString() ?? null,
      lastNodeExecuted: row.lastNodeExecuted,
      errorMessage: row.errorMessage,
      retryOfId: row.retryOfId,
      retrySuccessId: row.retrySuccessId,
      waitTill: row.waitTill?.toISOString() ?? null,
      parentExecutionId: row.parentExecutionId,
      running: this.isRunning(row.id) || row.status === 'running' || row.status === 'new',
      workflowData: row.data?.workflowData ?? null,
      data: row.data?.data ?? null,
    };
  }

  async remove(user: AuthUser, ids: string[]) {
    const running = ids.filter((id) => this.isRunning(id));
    if (running.length) throw conflict('Stop running executions before deleting them');
    const { count } = await this.prisma.execution.deleteMany({
      where: { id: { in: ids }, workflow: this.deps.workflows.scope(user) },
    });
    return { deleted: count };
  }

  /** Executions left "running" by a previous process can never finish (regular mode only). */
  async recoverCrashed() {
    if (this.deps.queue) return; // in queue mode workers own running executions; BullMQ re-runs stalled jobs
    const { count } = await this.prisma.execution.updateMany({
      where: { status: { in: ['running', 'new'] } },
      data: {
        status: 'crashed',
        stoppedAt: new Date(),
        errorMessage: 'The server stopped while this execution was running',
      },
    });
    if (count) this.deps.logger.warn(`Marked ${count} interrupted execution(s) as crashed`);
  }

  /** Cancel everything on shutdown and wait for results to be stored. */
  async shutdown() {
    for (const id of this.pending.keys()) this.cancelLocal(id, 'The server is shutting down');
    await Promise.allSettled([...this.pending.values()]);
  }
}
