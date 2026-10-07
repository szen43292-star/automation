import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  workflowCreateSchema,
  workflowImportSchema,
  workflowUpdateSchema,
  type INodeExecutionData,
  type IWorkflowBase,
} from '@flowforge/workflow';
import { parse } from '../lib/errors';
import { toWorkflowDTO } from './WorkflowService';

const idParams = z.object({ id: z.string().min(1) });

const listQuery = z.object({
  search: z.string().trim().max(200).optional(),
  active: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  limit: z.coerce.number().int().min(1).max(250).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const itemsSchema = z
  .array(z.object({ json: z.record(z.string(), z.unknown()) }).passthrough())
  .max(10_000)
  .optional();

const runSchema = z.object({
  /** Unsaved workflow from the editor. Defaults to the stored version. */
  workflowData: workflowCreateSchema.partial().optional(),
  startNode: z.string().optional(),
  /** "Execute step": run only up to this node. */
  destinationNode: z.string().optional(),
  triggerItems: itemsSchema,
});

export async function workflowRoutes(app: FastifyInstance) {
  const { workflows, executions } = app.services;

  app.get('/api/workflows', async (request) => {
    return workflows.list(request.currentUser, parse(listQuery, request.query));
  });

  app.post('/api/workflows', async (request, reply) => {
    const row = await workflows.create(request.currentUser, parse(workflowCreateSchema, request.body));
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
    const row = await workflows.update(request.currentUser, id, parse(workflowUpdateSchema, request.body));
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
    const body = { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings, pinData: wf.pinData };
    const fileName = `${wf.name.replace(/[^\w\- ]+/g, '').trim() || 'workflow'}.json`;
    return reply.header('content-disposition', `attachment; filename="${fileName}"`).send(body);
  });

  app.get('/api/workflows/:id/versions', async (request) => {
    const { id } = parse(idParams, request.params);
    return { data: await workflows.versions(request.currentUser, id) };
  });

  app.get('/api/workflows/:id/versions/:versionId', async (request) => {
    const { id, versionId } = parse(idParams.extend({ versionId: z.string().min(1) }), request.params);
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
      user: request.currentUser,
      workflowId: id,
      workflowData,
      mode: 'manual',
      startNode: body.startNode,
      destinationNode: body.destinationNode,
      triggerItems: body.triggerItems as INodeExecutionData[] | undefined,
    });
    return reply.status(202).send(result);
  });
}
