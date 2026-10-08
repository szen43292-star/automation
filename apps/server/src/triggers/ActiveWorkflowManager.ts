import { Cron } from 'croner';
import type { FastifyBaseLogger } from 'fastify';
import type { PrismaClient, Workflow as WorkflowRow } from '@prisma/client';
import {
  matchesSubscription,
  type IDataObject,
  type IEventSubscription,
  type INode,
  type INodeTypes,
  type ITriggerEvent,
  type IWorkflowBase,
} from '@flowforge/workflow';
import type { PushPublisher } from '../executions/types';
import { badRequest } from '../lib/errors';
import type { ExecutionService } from '../executions/ExecutionService';
import { toWorkflowDTO } from '../workflows/WorkflowService';

export const normalisePath = (path: string) => path.trim().replace(/^\/+|\/+$/g, '');
const PATH_RE = /^[A-Za-z0-9_\-/.:]+$/;

export interface WebhookRegistration {
  nodeId: string;
  method: string;
  path: string;
}

export interface EventRegistration {
  nodeId: string;
  subscription: IEventSubscription;
}

interface EventTestListener extends EventRegistration {
  workflowId: string;
  userId: string;
  workflowData: IWorkflowBase;
  timer: NodeJS.Timeout;
}

/** Checks a subscription of one event source (e.g. that a WhatsApp number exists). */
export type EventSourceValidator = (subscription: IEventSubscription, node: INode) => Promise<void>;

/**
 * Keeps production triggers of active workflows running: webhooks (stored in the database, served
 * by /webhook/*), schedules (cron jobs) and event triggers (e.g. WhatsApp messages).
 */
export class ActiveWorkflowManager {
  private readonly crons = new Map<string, Cron[]>();
  private readonly events = new Map<string, EventRegistration[]>();
  private readonly eventTests = new Map<string, EventTestListener>();
  readonly eventValidators = new Map<string, EventSourceValidator>();
  /** Used to tell the editor a test event arrived. */
  push?: PushPublisher;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly nodeTypes: INodeTypes,
    private readonly executions: ExecutionService,
    private readonly logger: FastifyBaseLogger,
    private readonly defaultTimezone: string,
  ) {}

  /** Webhook routes declared by a workflow's enabled trigger nodes. */
  webhooksOf(nodes: INode[]): WebhookRegistration[] {
    const out: WebhookRegistration[] = [];
    for (const node of nodes) {
      if (node.disabled) continue;
      const spec = this.nodeTypes.getDescription(node.type)?.webhook;
      if (!spec) continue;
      const path = normalisePath(String(node.parameters[spec.pathParameter] ?? ''));
      const method = String(
        (spec.methodParameter ? node.parameters[spec.methodParameter] : spec.method) ?? 'POST',
      ).toUpperCase();
      out.push({ nodeId: node.id, method, path });
    }
    return out;
  }

  /** Event subscriptions declared by a workflow's enabled event trigger nodes. */
  eventsOf(nodes: INode[]): EventRegistration[] {
    const out: EventRegistration[] = [];
    for (const node of nodes) {
      if (node.disabled) continue;
      const type = this.nodeTypes.get(node.type);
      if (type?.description.triggerKind === 'event' && type.eventSubscription) {
        out.push({ nodeId: node.id, subscription: type.eventSubscription(node.parameters) });
      }
    }
    return out;
  }

  private cronsOf(workflow: IWorkflowBase): Array<{ node: INode; expressions: string[] }> {
    const out: Array<{ node: INode; expressions: string[] }> = [];
    for (const node of workflow.nodes) {
      if (node.disabled) continue;
      const type = this.nodeTypes.get(node.type);
      if (type?.description.triggerKind === 'schedule' && type.cronExpressions) {
        out.push({ node, expressions: type.cronExpressions(node.parameters) });
      }
    }
    return out;
  }

  /** Throws a user-facing error if the workflow cannot be activated. */
  async validate(workflowId: string, workflow: IWorkflowBase) {
    const activatable = workflow.nodes.filter((n) => {
      const kind = this.nodeTypes.getDescription(n.type)?.triggerKind;
      return !n.disabled && (kind === 'webhook' || kind === 'schedule' || kind === 'event');
    });
    if (activatable.length === 0) {
      throw badRequest(
        'This workflow has no trigger that can start it automatically. "Manual Trigger" only runs from the editor - ' +
          'add a Webhook, Schedule or WhatsApp trigger to activate it.',
      );
    }
    const hooks = this.webhooksOf(workflow.nodes);
    const seen = new Set<string>();
    for (const hook of hooks) {
      if (!hook.path) throw badRequest('A Webhook node has an empty path');
      if (!PATH_RE.test(hook.path))
        throw badRequest(
          `Webhook path "${hook.path}" may only contain letters, numbers and - _ / . :`,
        );
      const key = `${hook.method} ${hook.path}`;
      if (seen.has(key)) throw badRequest(`Two Webhook nodes use ${key}`);
      seen.add(key);
      const clash = await this.prisma.webhookEntity.findFirst({
        where: { method: hook.method, path: hook.path, NOT: { workflowId } },
        include: { workflow: { select: { name: true } } },
      });
      if (clash)
        throw badRequest(
          `The webhook ${key} is already used by the active workflow "${clash.workflow.name}"`,
        );
    }
    for (const { nodeId, subscription } of this.eventsOf(workflow.nodes)) {
      const node = workflow.nodes.find((n) => n.id === nodeId)!;
      if (!subscription.events.length) throw badRequest(`"${node.name}" listens to no events`);
      await this.eventValidators.get(subscription.source)?.(subscription, node);
    }
    for (const { node, expressions } of this.cronsOf(workflow)) {
      if (expressions.length === 0) throw badRequest(`"${node.name}" has no schedule rules`);
      for (const expression of expressions) {
        try {
          new Cron(expression, { paused: true }).stop();
        } catch (error) {
          throw badRequest(
            `"${node.name}": invalid schedule "${expression}" - ${(error as Error).message}`,
          );
        }
      }
    }
  }

  async activate(row: WorkflowRow) {
    const workflow = toWorkflowDTO(row);
    await this.validate(row.id, workflow);
    await this.deactivate(row.id);
    const hooks = this.webhooksOf(workflow.nodes);
    if (hooks.length) {
      await this.prisma.webhookEntity.createMany({
        data: hooks.map((h) => ({
          workflowId: row.id,
          nodeId: h.nodeId,
          method: h.method,
          path: h.path,
        })),
      });
    }
    const timezone = workflow.settings?.timezone ?? this.defaultTimezone;
    const jobs: Cron[] = [];
    for (const { node, expressions } of this.cronsOf(workflow)) {
      for (const expression of expressions) {
        jobs.push(
          new Cron(expression, { timezone, protect: true }, () => {
            void this.fire(row.id, node.id).catch((error: unknown) =>
              this.logger.error(
                { err: error, workflowId: row.id },
                'Scheduled execution failed to start',
              ),
            );
          }),
        );
      }
    }
    if (jobs.length) this.crons.set(row.id, jobs);
    const events = this.eventsOf(workflow.nodes);
    if (events.length) this.events.set(row.id, events);
    this.logger.info(
      { workflowId: row.id, webhooks: hooks.length, schedules: jobs.length, events: events.length },
      'Workflow activated',
    );
  }

  /** Start every active workflow (and pending "listen for test event") that subscribes to the event. */
  async dispatchEvent(event: ITriggerEvent, item: IDataObject): Promise<number> {
    let started = 0;
    for (const [workflowId, registrations] of this.events) {
      for (const { nodeId, subscription } of registrations) {
        if (!matchesSubscription(subscription, event)) continue;
        try {
          await this.fire(workflowId, nodeId, [{ json: item }]);
          started++;
        } catch (error) {
          this.logger.error(
            { err: error, workflowId },
            'Event-triggered execution failed to start',
          );
        }
      }
    }
    for (const [workflowId, listener] of this.eventTests) {
      if (!matchesSubscription(listener.subscription, event)) continue;
      this.cancelEventTest(workflowId);
      const { executionId } = await this.executions.start({
        userId: listener.userId,
        workflowId,
        workflowData: listener.workflowData,
        mode: 'manual',
        startNode: listener.nodeId,
        triggerItems: [{ json: item }],
      });
      this.push?.publish([`workflow:${workflowId}`], {
        type: 'testWebhookReceived',
        data: { workflowId, executionId, nodeId: listener.nodeId },
      });
      started++;
    }
    return started;
  }

  /** Editor "Listen for test event" on an event trigger: the next matching event runs the editor's workflow. */
  listenForEvent(
    listener: Omit<EventTestListener, 'timer' | 'subscription'> & {
      subscription?: IEventSubscription;
    },
    ttlMs = 120_000,
  ): EventRegistration {
    const registration = this.eventsOf(listener.workflowData.nodes).find(
      (r) => r.nodeId === listener.nodeId,
    );
    if (!registration) throw badRequest('This node does not listen to events');
    this.cancelEventTest(listener.workflowId);
    const timer = setTimeout(() => this.eventTests.delete(listener.workflowId), ttlMs);
    timer.unref();
    this.eventTests.set(listener.workflowId, {
      ...listener,
      subscription: registration.subscription,
      timer,
    });
    return registration;
  }

  cancelEventTest(workflowId: string) {
    const listener = this.eventTests.get(workflowId);
    if (listener) clearTimeout(listener.timer);
    this.eventTests.delete(workflowId);
  }

  /** Active workflows listening to an event source (for the WhatsApp setup checklist). */
  eventWorkflowIds(source: string): string[] {
    return [...this.events]
      .filter(([, registrations]) => registrations.some((r) => r.subscription.source === source))
      .map(([id]) => id);
  }

  /** Start a scheduled or event execution with the latest saved version of the workflow. */
  private async fire(
    workflowId: string,
    nodeId: string,
    triggerItems?: Array<{ json: IDataObject }>,
  ) {
    const row = await this.prisma.workflow.findUnique({ where: { id: workflowId } });
    if (!row?.active) return;
    await this.executions.start({
      userId: null,
      workflowId,
      workflowData: toWorkflowDTO(row),
      mode: 'trigger',
      startNode: nodeId,
      ...(triggerItems ? { triggerItems } : {}),
    });
  }

  async deactivate(workflowId: string) {
    this.crons.get(workflowId)?.forEach((job) => job.stop());
    this.crons.delete(workflowId);
    this.events.delete(workflowId);
    await this.prisma.webhookEntity.deleteMany({ where: { workflowId } });
  }

  /** Activate every active workflow at startup; broken ones are logged and skipped. */
  async init() {
    const rows = await this.prisma.workflow.findMany({ where: { active: true } });
    for (const row of rows) {
      try {
        await this.activate(row);
      } catch (error) {
        this.logger.error(
          { err: error, workflowId: row.id },
          `Could not activate workflow "${row.name}"`,
        );
      }
    }
  }

  scheduleCount(workflowId: string): number {
    return this.crons.get(workflowId)?.length ?? 0;
  }

  shutdown() {
    for (const jobs of this.crons.values()) jobs.forEach((j) => j.stop());
    this.crons.clear();
    this.events.clear();
    for (const workflowId of [...this.eventTests.keys()]) this.cancelEventTest(workflowId);
  }
}

/** Resumes executions paused by Wait nodes when their time comes. */
export class WaitTracker {
  private timer?: NodeJS.Timeout;
  private readonly scheduled = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly executions: ExecutionService,
    private readonly logger: FastifyBaseLogger,
    private readonly intervalMs = 5_000,
  ) {}

  start() {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs);
  }

  async poll() {
    const horizon = new Date(Date.now() + this.intervalMs + 1_000);
    const due = await this.prisma.execution
      .findMany({
        where: { status: 'waiting', waitTill: { lte: horizon } },
        select: { id: true, waitTill: true },
        take: 500,
      })
      .catch(() => []);
    for (const { id, waitTill } of due) {
      if (this.scheduled.has(id) || !waitTill) continue;
      const delay = Math.max(0, waitTill.getTime() - Date.now());
      this.scheduled.set(
        id,
        setTimeout(() => {
          this.scheduled.delete(id);
          void this.executions
            .resume(id)
            .catch((error: unknown) =>
              this.logger.error({ err: error, executionId: id }, 'Resume failed'),
            );
        }, delay),
      );
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    for (const t of this.scheduled.values()) clearTimeout(t);
    this.scheduled.clear();
  }
}
