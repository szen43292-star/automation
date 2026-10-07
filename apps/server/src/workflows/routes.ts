import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  workflowCreateSchema,
  workflowImportSchema,
  workflowUpdateSchema,
  type INodeExecutionData,
  type IRunData,
  type IWorkflowBase,
} from '@flowforge/workflow';
import type { Config } from '../config';
import { badRequest, parse } from '../lib/errors';
import { toWorkflowDTO } from './WorkflowService';

const idParams = z.object({ id: z.string().min(1) });

const listQuery = z.object({
  search: z.string().trim().max(200).optional(),
  active: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(250).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const itemsSchema = z
  .array(z.object({ json: z.record(z.string(), z.unknown()) }).passthrough())
  .max(10_000)
  .optional();

const runSchema = z.object({
  /** Unsaved workflow from the editor. Defaults to the stored version. */
  workflowData: workflowUpdateSchema.omit({ versionId: true, active: true }).optional(),
  startNode: z.string().optional(),
  /** "Execute step": run only up to this node. */
  destinationNode: z.string().optional(),
  triggerItems: itemsSchema,
  /** Partial execution: outputs of the editor's last run, reused instead of re-running nodes. */
  runData: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))).optional(),
  /** Nodes changed since that run (they and their children run again). */
  dirtyNodes: z.array(z.string()).max(2000).optional(),
});

const listenSchema = z.object({
  nodeId: z.string().min(1),
  workflowData: workflowUpdateSchema.omit({ versionId: true, active: true }).optional(),
});

export async function workflowRoutes(app: FastifyInstance, opts: { config: Config }) {
  const { config } = opts;
  const { workflows, executions } = app.services;

  app.get('/api/workflows', async (request) => {
    return workflows.list(request.currentUser, parse(listQuery, request.query));
  });

  app.post('/api/workflows', async (request, reply) => {
    const row = await workflows.create(
      request.currentUser,
      parse(workflowCreateSchema, request.body),
    );
    return reply.status(201).send(toWorkflowDTO(row));
  });

  /** Import exported workflow JSON (ids are regenerated). */
  app.post('/api/workflows/import', async (request, reply) => {
    const { id: _id, versionId: _v, ...data } = parse(workflowImportSchema, request.body);
    const row = await workflows.create(request.currentUser, { ...data, active: false });
    return reply.status(201).send(toWorkflowDTO(row));
  });

  app.get('/api/workflows/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    return toWorkflowDTO(await workflows.get(request.currentUser, id));
  });

  app.patch('/api/workflows/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    const row = await workflows.update(
      request.currentUser,
      id,
      parse(workflowUpdateSchema, request.body),
    );
    app.push.publish([`workflow:${id}`], {
      type: 'workflowUpdated',
      data: { workflowId: id, active: row.active, versionId: row.versionId },
    });
    return toWorkflowDTO(row);
  });

  app.delete('/api/workflows/:id', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    await workflows.remove(request.currentUser, id);
    return reply.status(204).send();
  });

  /** Export as portable JSON (no ids/owner). */
  app.get('/api/workflows/:id/export', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const wf = toWorkflowDTO(await workflows.get(request.currentUser, id));
    const body = {
      name: wf.name,
      nodes: wf.nodes,
      connections: wf.connections,
      settings: wf.settings,
      pinData: wf.pinData,
    };
    const fileName = `${wf.name.replace(/[^\w\- ]+/g, '').trim() || 'workflow'}.json`;
    return reply.header('content-disposition', `attachment; filename="${fileName}"`).send(body);
  });

  app.get('/api/workflows/:id/versions', async (request) => {
    const { id } = parse(idParams, request.params);
    return { data: await workflows.versions(request.currentUser, id) };
  });

  app.get('/api/workflows/:id/versions/:versionId', async (request) => {
    const { id, versionId } = parse(
      idParams.extend({ versionId: z.string().min(1) }),
      request.params,
    );
    return workflows.version(request.currentUser, id, versionId);
  });

  /** Manual run from the editor. Returns immediately; progress is pushed over WebSocket. */
  app.post('/api/workflows/:id/run', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const body = parse(runSchema, request.body ?? {});
    const stored = toWorkflowDTO(await workflows.get(request.currentUser, id));
    const workflowData: IWorkflowBase = {
      name: body.workflowData?.name ?? stored.name,
      nodes: (body.workflowData?.nodes ?? stored.nodes) as IWorkflowBase['nodes'],
      connections: body.workflowData?.connections ?? stored.connections,
      settings: body.workflowData?.settings ?? stored.settings,
      pinData: body.workflowData?.pinData ?? stored.pinData,
      active: stored.active,
    };
    const result = await executions.start({
      userId: request.currentUser.id,
      workflowId: id,
      workflowData,
      mode: 'manual',
      startNode: body.startNode,
      destinationNode: body.destinationNode,
      triggerItems: body.triggerItems as INodeExecutionData[] | undefined,
      ...(body.runData && body.destinationNode
        ? { runData: body.runData as unknown as IRunData, dirtyNodes: body.dirtyNodes }
        : {}),
    });
    return reply.status(202).send(result);
  });

  /** "Listen for test event": accept one request on /webhook-test/<path> for 2 minutes. */
  app.post('/api/workflows/:id/webhook-test', async (request) => {
    const { id } = parse(idParams, request.params);
    const body = parse(listenSchema, request.body);
    const stored = toWorkflowDTO(await workflows.get(request.currentUser, id));
    const workflowData: IWorkflowBase = {
      name: body.workflowData?.name ?? stored.name,
      nodes: (body.workflowData?.nodes ?? stored.nodes) as IWorkflowBase['nodes'],
      connections: body.workflowData?.connections ?? stored.connections,
      settings: body.workflowData?.settings ?? stored.settings,
      pinData: body.workflowData?.pinData ?? stored.pinData,
      active: stored.active,
    };
    const hook = app.services.activeWorkflows
      .webhooksOf(workflowData.nodes)
      .find((h) => h.nodeId === body.nodeId);
    if (!hook) throw badRequest('This node does not receive webhooks');
    if (!hook.path) throw badRequest('Set a path on the Webhook node first');
    app.testWebhooks.register({
      workflowId: id,
      nodeId: body.nodeId,
      userId: request.currentUser.id,
      workflowData,
      method: hook.method,
      path: hook.path,
    });
    const base = config.PUBLIC_URL.replace(/\/+$/, '');
    return {
      testUrl: `${base}/webhook-test/${hook.path}`,
      method: hook.method,
      expiresInSeconds: 120,
    };
  });

  app.delete('/api/workflows/:id/webhook-test', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    await workflows.get(request.currentUser, id);
    app.testWebhooks.cancelForWorkflow(id);
    return reply.status(204).send();
  });

  /** Options for parameters with typeOptions.loadOptionsMethod. */
  app.get('/api/node-options/:method', async (request) => {
    const { method } = parse(z.object({ method: z.string() }), request.params);
    if (method === 'workflows') {
      const { data } = await workflows.list(request.currentUser, { limit: 250, offset: 0 });
      return { data: data.map((w) => ({ name: w.name, value: w.id })) };
    }
    throw badRequest(`Unknown options method "${method}"`);
  });
}
