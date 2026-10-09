import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  getPath,
  type IDataObject,
  type INode,
  type INodeExecutionData,
  type IRun,
  type IWebhookFunctions,
  type IWebhookRequest,
  type IWorkflowBase,
  resolveParameterValue,
} from '@flowforge/workflow';
import { IsolatedExpressionEvaluator, prepareBinaryData } from '@flowforge/engine';
import type { Config } from '../config';
import type { StartExecutionOptions } from '../executions/types';
import { toWorkflowDTO } from '../workflows/WorkflowService';
import { normalisePath } from '../triggers/ActiveWorkflowManager';

interface TestListener {
  workflowId: string;
  nodeId: string;
  userId: string;
  workflowData: IWorkflowBase;
  method: string;
  path: string;
  timer: NodeJS.Timeout;
}

/** Editor "Listen for test event" registrations (in memory, 2 minutes). */
export class TestWebhooks {
  private readonly listeners = new Map<string, TestListener>();

  key(method: string, path: string) {
    return `${method.toUpperCase()} ${normalisePath(path)}`;
  }

  register(listener: Omit<TestListener, 'timer'>, ttlMs = 120_000) {
    this.cancelForWorkflow(listener.workflowId);
    const key = this.key(listener.method, listener.path);
    const timer = setTimeout(() => this.listeners.delete(key), ttlMs);
    timer.unref();
    this.listeners.set(key, { ...listener, timer });
  }

  take(method: string, path: string): TestListener | undefined {
    const key = this.key(method, path);
    const listener = this.listeners.get(key);
    if (listener) {
      clearTimeout(listener.timer);
      this.listeners.delete(key);
    }
    return listener;
  }

  cancelForWorkflow(workflowId: string) {
    for (const [key, l] of this.listeners) {
      if (l.workflowId === workflowId) {
        clearTimeout(l.timer);
        this.listeners.delete(key);
      }
    }
  }
}

function parseBody(request: FastifyRequest): { body: unknown; rawBody?: Buffer } {
  const raw = request.body as Buffer | undefined;
  if (!raw || raw.length === 0) return { body: {} };
  const type = String(request.headers['content-type'] ?? '').toLowerCase();
  if (type.includes('json')) {
    try {
      return { body: JSON.parse(raw.toString('utf8')), rawBody: raw };
    } catch {
      throw Object.assign(new Error('The request body is not valid JSON'), { statusCode: 400 });
    }
  }
  if (type.includes('application/x-www-form-urlencoded')) {
    const out: IDataObject = {};
    for (const [k, v] of new URLSearchParams(raw.toString('utf8'))) {
      const existing = out[k];
      out[k] =
        existing === undefined
          ? v
          : Array.isArray(existing)
            ? [...existing, v]
            : [existing as string, v];
    }
    return { body: out, rawBody: raw };
  }
  if (type.startsWith('text/') || type.includes('xml'))
    return { body: { data: raw.toString('utf8') }, rawBody: raw };
  return { body: raw, rawBody: raw };
}

function lastNodeOutput(run: IRun): INodeExecutionData[] {
  const last = run.data.resultData.lastNodeExecuted;
  const runs = last ? run.data.resultData.runData[last] : undefined;
  return runs?.[runs.length - 1]?.data?.main[0] ?? [];
}

export async function webhookRoutes(app: FastifyInstance, opts: { config: Config }) {
  const { config } = opts;
  const { executions, credentials } = app.services;
  const testWebhooks = app.testWebhooks;

  // Webhook bodies are parsed here (JSON, forms, text, binary) instead of by Fastify.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer', bodyLimit: config.WEBHOOK_MAX_BODY_MB * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );

  // HEAD is served by Fastify's automatic HEAD route for GET.
  const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

  async function handle(
    request: FastifyRequest,
    reply: FastifyReply,
    target: {
      workflowId: string;
      workflowData: IWorkflowBase;
      node: INode;
      userId: string | null;
      test: boolean;
    },
  ) {
    const { body, rawBody } = parseBody(request);
    const webhookRequest: IWebhookRequest = {
      method: request.method,
      path: (request.params as { '*': string })['*'] ?? '',
      headers: request.headers,
      query: request.query as Record<string, unknown>,
      body,
      rawBody,
      ip: request.ip,
    };
    const { node, workflowData, workflowId } = target;
    const nodeType = app.nodeTypes.get(node.type);
    if (!nodeType?.webhook)
      return reply.status(500).send({ message: `Node "${node.name}" cannot receive webhooks` });

    const owner = await app.prisma.workflow.findUnique({
      where: { id: workflowId },
      select: { owner: { select: { id: true, role: true } } },
    });
    const helper = credentials.helper(owner?.owner ?? null);
    const evaluator = new IsolatedExpressionEvaluator();
    const vars = await app.services.variables.all();
    const requestJson = {
      headers: webhookRequest.headers,
      query: webhookRequest.query,
      body: Buffer.isBuffer(body) ? {} : body,
    } as IDataObject;
    const ctx: IWebhookFunctions = {
      getRequest: () => webhookRequest,
      getNode: () => node,
      getNodeParameter: <T>(name: string, fallback?: T): T => {
        const raw = getPath(node.parameters, name);
        if (raw === undefined) return fallback as T;
        return resolveParameterValue(
          raw as never,
          {
            item: { json: requestJson },
            itemIndex: 0,
            runIndex: 0,
            inputItems: [{ json: requestJson }],
            getNodeOutput: () => undefined,
            workflow: { id: workflowId, name: workflowData.name, active: true },
            execution: { id: 'webhook', mode: 'webhook' },
            parameters: node.parameters as IDataObject,
            timezone: workflowData.settings?.timezone ?? config.DEFAULT_TIMEZONE,
            vars,
          },
          evaluator,
        ) as T;
      },
      getCredentials: async <T extends object>(type: string) =>
        (await helper.getDecrypted(node, type)) as T,
      getWorkflow: () => ({ id: workflowId, name: workflowData.name, active: !target.test }),
      getMode: () => (target.test ? 'manual' : 'webhook'),
      helpers: {
        prepareBinaryData,
        returnJsonArray: (d) => (Array.isArray(d) ? d : [d]).map((json) => ({ json })),
      },
    };

    let result;
    try {
      result = await nodeType.webhook.call(ctx);
    } catch (error) {
      return reply
        .status(500)
        .send({ message: 'Error in webhook node', error: (error as Error).message });
    } finally {
      evaluator.dispose();
    }
    if (result.response) {
      for (const [k, v] of Object.entries(result.response.headers ?? {})) reply.header(k, v);
      return reply.status(result.response.status).send(result.response.body ?? '');
    }

    const responseMode = String(node.parameters.responseMode ?? 'onReceived');
    const responseCode = Number(node.parameters.responseCode ?? 200);
    const base: StartExecutionOptions = {
      userId: target.userId,
      workflowId,
      workflowData,
      mode: target.test ? 'manual' : 'webhook',
      startNode: node.id,
      triggerItems: result.workflowData?.[0] ?? [{ json: {} }],
    };

    if (responseMode === 'onReceived') {
      const { executionId } = await executions.start(base);
      if (target.test)
        app.push.publish([`workflow:${workflowId}`], {
          type: 'testWebhookReceived',
          data: { workflowId, executionId, nodeId: node.id },
        });
      return reply.status(responseCode).send({ message: 'Workflow was started', executionId });
    }

    // Synchronous path: respond from the workflow.
    let responded = false;
    let respond!: (r: { status: number; body?: unknown; headers?: Record<string, string> }) => void;
    const nodeResponse = new Promise<{
      status: number;
      body?: unknown;
      headers?: Record<string, string>;
    }>((resolve) => (respond = resolve));
    const runPromise = executions.runSync({
      ...base,
      inProcess: true,
      ...(responseMode === 'responseNode'
        ? {
            sendWebhookResponse: (r) => {
              if (responded) return false;
              responded = true;
              respond(r);
              return true;
            },
          }
        : {}),
    });
    if (target.test) {
      void runPromise.then(({ executionId }) =>
        app.push.publish([`workflow:${workflowId}`], {
          type: 'testWebhookReceived',
          data: { workflowId, executionId, nodeId: node.id },
        }),
      );
    }
    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), config.WEBHOOK_TIMEOUT_MS).unref(),
    );
    const outcome = await Promise.race([
      nodeResponse.then((r) => ({ kind: 'response' as const, r })),
      runPromise.then((x) => ({ kind: 'run' as const, run: x.run })),
      timeout.then(() => ({ kind: 'timeout' as const })),
    ]);

    if (outcome.kind === 'timeout')
      return reply.status(504).send({ message: 'The workflow did not respond in time' });
    if (outcome.kind === 'response') {
      for (const [k, v] of Object.entries(outcome.r.headers ?? {})) reply.header(k, v);
      return reply.status(outcome.r.status).send(outcome.r.body ?? '');
    }
    const run = outcome.run;
    if (run.status !== 'success') {
      return reply.status(500).send({
        message: 'Error in workflow',
        error: run.data.resultData.error?.message ?? run.status,
      });
    }
    if (responseMode === 'responseNode') {
      return reply.status(500).send({
        message: 'The workflow finished without a "Respond to Webhook" node sending a response',
      });
    }
    const items = lastNodeOutput(run);
    const data = String(node.parameters.responseData ?? 'firstEntryJson');
    if (data === 'noData') return reply.status(responseCode).send('');
    if (data === 'allEntries') return reply.status(responseCode).send(items.map((i) => i.json));
    return reply.status(responseCode).send(items[0]?.json ?? {});
  }

  for (const method of methods) {
    app.route({
      method,
      url: '/webhook/*',
      handler: async (request, reply) => {
        const path = normalisePath((request.params as { '*': string })['*'] ?? '');
        const lookupMethod = method;
        const hook = await app.prisma.webhookEntity.findUnique({
          where: { method_path: { method: lookupMethod, path } },
          include: { workflow: true },
        });
        if (!hook || !hook.workflow.active) {
          const other = await app.prisma.webhookEntity.findFirst({ where: { path } });
          return reply.status(404).send({
            message: other
              ? `This webhook is registered for ${other.method}, not ${method}`
              : `No active workflow has a webhook at ${method} /webhook/${path}`,
            hint: 'Activate the workflow, or use the test URL (/webhook-test/...) while listening in the editor.',
          });
        }
        const workflowData = toWorkflowDTO(hook.workflow);
        const node = workflowData.nodes.find((n) => n.id === hook.nodeId);
        if (!node) return reply.status(404).send({ message: 'The webhook node no longer exists' });
        return handle(request, reply, {
          workflowId: hook.workflowId,
          workflowData,
          node,
          userId: null,
          test: false,
        });
      },
    });

    app.route({
      method,
      url: '/webhook-test/*',
      handler: async (request, reply) => {
        const path = (request.params as { '*': string })['*'] ?? '';
        const listener = testWebhooks.take(method, path);
        if (!listener) {
          return reply.status(404).send({
            message: `No test webhook is listening at ${method} /webhook-test/${normalisePath(path)}`,
            hint: 'Click "Listen for test event" on the Webhook node in the editor, then call this URL within 2 minutes.',
          });
        }
        const node = listener.workflowData.nodes.find((n) => n.id === listener.nodeId);
        if (!node) return reply.status(404).send({ message: 'The webhook node no longer exists' });
        return handle(request, reply, {
          workflowId: listener.workflowId,
          workflowData: listener.workflowData,
          node,
          userId: listener.userId,
          test: true,
        });
      },
    });
  }

  /** Resume an execution waiting in a Wait node set to "On Webhook Call". */
  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH'],
    url: '/webhook-waiting/:executionId',
    handler: async (request, reply) => {
      const { executionId } = request.params as { executionId: string };
      const row = await app.prisma.execution.findUnique({
        where: { id: executionId },
        include: { data: true },
      });
      if (!row || row.status !== 'waiting') {
        return reply.status(404).send({
          message: 'This execution is not waiting (it may have finished or already been resumed)',
        });
      }
      const data = row.data?.data as { waitingNode?: string } | undefined;
      const workflowData = row.data?.workflowData as unknown as IWorkflowBase;
      const waitNode = workflowData.nodes.find((n) => n.name === data?.waitingNode);
      if (!waitNode || waitNode.parameters.resume !== 'webhook') {
        return reply
          .status(409)
          .send({ message: 'This execution waits for a time, not for a webhook call' });
      }
      const { body } = parseBody(request);
      const resumed = await executions.resume(executionId, [
        {
          json: {
            headers: request.headers as IDataObject,
            query: request.query as IDataObject,
            body: Buffer.isBuffer(body) ? {} : (body as IDataObject),
          },
        },
      ]);
      if (!resumed)
        return reply.status(409).send({ message: 'This execution was already resumed' });
      return reply.send({ message: 'Workflow resumed', executionId });
    },
  });
}
