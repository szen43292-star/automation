import type { FastifyBaseLogger } from 'fastify';
import type { Prisma, PrismaClient, ExecutionMode } from '@prisma/client';
import {
  Workflow,
  summariseTask,
  type ILogger,
  type INodeExecutionData,
  type INodeTypes,
  type IRun,
  type IRunExecutionData,
  type IWorkflowBase,
} from '@flowforge/workflow';
import { CodeSandbox, WorkflowExecute, createAdditionalData } from '@flowforge/engine';
import type { AuthUser } from '../auth/auth';
import type { Config } from '../config';
import { badRequest, conflict, notFound } from '../lib/errors';
import type { PushHub } from '../push/PushHub';
import { toWorkflowDTO, type WorkflowService } from '../workflows/WorkflowService';

export interface StartExecutionOptions {
  user: AuthUser | null;
  workflowId: string;
  workflowData: IWorkflowBase;
  mode: ExecutionMode;
  startNode?: string;
  destinationNode?: string;
  triggerItems?: INodeExecutionData[];
  resumeFrom?: IRunExecutionData;
  retryOfId?: string;
}

interface ActiveExecution {
  executor: WorkflowExecute;
  workflowId: string;
  done: Promise<IRun>;
}

const json = (value: unknown) => value as Prisma.InputJsonValue;

/**
 * Runs workflows in-process and persists the results.
 * (Phase 2 moves non-manual executions onto a BullMQ queue + worker processes;
 * the persistence and push logic here is shared by both paths.)
 */
export class ExecutionService {
  private readonly active = new Map<string, ActiveExecution>();
  private readonly sandbox: CodeSandbox;
  private readonly engineLogger: ILogger;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly nodeTypes: INodeTypes,
    private readonly workflows: WorkflowService,
    private readonly push: PushHub,
    private readonly config: Config,
    private readonly logger: FastifyBaseLogger,
  ) {
    this.sandbox = new CodeSandbox({ timeoutMs: config.CODE_TIMEOUT_MS, memoryLimitMb: config.CODE_MEMORY_MB });
    this.engineLogger = {
      debug: (msg, meta) => logger.debug(meta ?? {}, msg),
      info: (msg, meta) => logger.info(meta ?? {}, msg),
      warn: (msg, meta) => logger.warn(meta ?? {}, msg),
      error: (msg, meta) => logger.error(meta ?? {}, msg),
    };
  }

  /** Create the execution record and run it in the background. Returns immediately. */
  async start(options: StartExecutionOptions): Promise<{ executionId: string }> {
    // Fail fast on obviously broken graphs (duplicate names etc.).
    let workflow: Workflow;
    try {
      workflow = new Workflow({ ...options.workflowData, id: options.workflowId });
    } catch (error) {
      throw badRequest((error as Error).message);
    }

    const execution = await this.prisma.execution.create({
      data: {
        workflowId: options.workflowId,
        mode: options.mode,
        status: 'running',
        startedAt: new Date(),
        retryOfId: options.retryOfId,
        triggeredById: options.user?.id,
      },
    });
    const executionId = execution.id;
    const topics = [`workflow:${options.workflowId}`, `execution:${executionId}`];
    if (options.user) topics.push(`user:${options.user.id}`);

    const executor = new WorkflowExecute(
      workflow,
      createAdditionalData({
        executionId,
        mode: options.mode,
        nodeTypes: this.nodeTypes,
        codeSandbox: this.sandbox,
        logger: this.engineLogger,
        defaultTimezone: this.config.DEFAULT_TIMEZONE,
        workflowActive: options.workflowData.active ?? false,
        hooks: {
          nodeExecuteBefore: (nodeName) =>
            this.push.publish(topics, {
              type: 'nodeExecuteBefore',
              data: { executionId, workflowId: options.workflowId, nodeName },
            }),
          nodeExecuteAfter: (nodeName, task, runIndex) =>
            this.push.publish(topics, {
              type: 'nodeExecuteAfter',
              data: { executionId, workflowId: options.workflowId, nodeName, runIndex, ...summariseTask(task) },
            }),
        },
      }),
    );

    this.push.publish(topics, {
      type: 'executionStarted',
      data: {
        executionId,
        workflowId: options.workflowId,
        mode: options.mode,
        startedAt: execution.startedAt!.toISOString(),
      },
    });

    const done = executor
      .run({
        startNode: options.startNode,
        destinationNode: options.destinationNode,
        triggerItems: options.triggerItems,
        resumeFrom: options.resumeFrom,
      })
      .then(async (run) => {
        await this.persist(executionId, options, run);
        this.push.publish(topics, {
          type: 'executionFinished',
          data: {
            executionId,
            workflowId: options.workflowId,
            status: run.status,
            stoppedAt: run.stoppedAt,
            errorMessage: run.data.resultData.error?.message,
          },
        });
        return run;
      })
      .catch((error: unknown) => {
        this.logger.error({ err: error, executionId }, 'Execution crashed');
        return this.markCrashed(executionId, error).then(() => {
          throw error;
        });
      })
      .finally(() => this.active.delete(executionId));

    done.catch(() => undefined);
    this.active.set(executionId, { executor, workflowId: options.workflowId, done });
    return { executionId };
  }

  private async persist(executionId: string, options: StartExecutionOptions, run: IRun) {
    const error = run.data.resultData.error;
    await this.prisma.$transaction([
      this.prisma.execution.update({
        where: { id: executionId },
        data: {
          status: run.status,
          stoppedAt: new Date(run.stoppedAt),
          lastNodeExecuted: run.data.resultData.lastNodeExecuted ?? null,
          errorMessage: error ? error.message.slice(0, 2000) : null,
        },
      }),
      this.prisma.executionData.create({
        data: {
          executionId,
          workflowData: json({ ...options.workflowData, id: options.workflowId }),
          data: json(run.data),
        },
      }),
      ...(options.retryOfId && run.status === 'success'
        ? [this.prisma.execution.update({ where: { id: options.retryOfId }, data: { retrySuccessId: executionId } })]
        : []),
    ]);
  }

  private async markCrashed(executionId: string, error: unknown) {
    await this.prisma.execution
      .update({
        where: { id: executionId },
        data: { status: 'crashed', stoppedAt: new Date(), errorMessage: String((error as Error)?.message ?? error) },
      })
      .catch((e: unknown) => this.logger.error({ err: e }, 'Could not mark execution as crashed'));
  }

  /** Wait for a running execution (used by tests and sync API calls). */
  async waitFor(executionId: string): Promise<IRun | undefined> {
    return this.active.get(executionId)?.done.catch(() => undefined);
  }

  isRunning(executionId: string) {
    return this.active.has(executionId);
  }

  async stop(user: AuthUser, executionId: string) {
    const execution = await this.getRow(user, executionId);
    const active = this.active.get(execution.id);
    if (!active) throw conflict('This execution is not running');
    active.executor.cancel('Execution was stopped by a user');
    await active.done.catch(() => undefined);
    return { stopped: true };
  }

  /** Retry a failed execution, either with the workflow as it was or as it is now. */
  async retry(user: AuthUser, executionId: string, useCurrentWorkflow: boolean) {
    const execution = await this.getRow(user, executionId);
    if (execution.status !== 'error' && execution.status !== 'crashed' && execution.status !== 'canceled') {
      throw badRequest('Only failed, crashed or cancelled executions can be retried');
    }
    const stored = await this.prisma.executionData.findUnique({ where: { executionId } });
    if (!stored) throw badRequest('This execution has no saved data to retry from');

    const workflowData: IWorkflowBase = useCurrentWorkflow
      ? toWorkflowDTO(await this.workflows.get(user, execution.workflowId))
      : (stored.workflowData as unknown as IWorkflowBase);

    return this.start({
      user,
      workflowId: execution.workflowId,
      workflowData,
      mode: 'retry',
      resumeFrom: stored.data as unknown as IRunExecutionData,
      retryOfId: execution.id,
    });
  }

  private async getRow(user: AuthUser, executionId: string) {
    const execution = await this.prisma.execution.findFirst({
      where: { id: executionId, workflow: this.workflows.scope(user) },
    });
    if (!execution) throw notFound('Execution');
    return execution;
  }

  async list(
    user: AuthUser,
    query: { workflowId?: string; status?: string[]; limit: number; cursor?: string },
  ) {
    const where: Prisma.ExecutionWhereInput = {
      workflow: this.workflows.scope(user),
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
        durationMs: row.startedAt && row.stoppedAt ? row.stoppedAt.getTime() - row.startedAt.getTime() : null,
        lastNodeExecuted: row.lastNodeExecuted,
        errorMessage: row.errorMessage,
        retryOfId: row.retryOfId,
        retrySuccessId: row.retrySuccessId,
      })),
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    };
  }

  async get(user: AuthUser, executionId: string) {
    const row = await this.prisma.execution.findFirst({
      where: { id: executionId, workflow: this.workflows.scope(user) },
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
      running: this.active.has(row.id),
      workflowData: row.data?.workflowData ?? null,
      data: row.data?.data ?? null,
    };
  }

  async remove(user: AuthUser, ids: string[]) {
    const running = ids.filter((id) => this.active.has(id));
    if (running.length) throw conflict('Stop running executions before deleting them');
    const { count } = await this.prisma.execution.deleteMany({
      where: { id: { in: ids }, workflow: this.workflows.scope(user) },
    });
    return { deleted: count };
  }

  /** Executions left "running" by a previous process can never finish. */
  async recoverCrashed() {
    const { count } = await this.prisma.execution.updateMany({
      where: { status: { in: ['running', 'new'] } },
      data: { status: 'crashed', stoppedAt: new Date(), errorMessage: 'The server stopped while this execution was running' },
    });
    if (count) this.logger.warn(`Marked ${count} interrupted execution(s) as crashed`);
  }

  /** Cancel everything on shutdown and wait for results to be stored. */
  async shutdown() {
    const pending = [...this.active.values()];
    pending.forEach((a) => a.executor.cancel('The server is shutting down'));
    await Promise.allSettled(pending.map((a) => a.done));
  }
}
