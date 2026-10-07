import { z } from 'zod';

/**
 * Zod schemas for everything that crosses an API boundary.
 * The server validates all input with these; the editor reuses them on import.
 */

const parameterValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(parameterValue),
    z.record(z.string(), parameterValue),
  ]),
);

export const nodeSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1, 'Node name is required').max(128),
  type: z.string().min(1).max(200),
  typeVersion: z.number().int().positive().default(1),
  position: z.tuple([z.number(), z.number()]),
  parameters: z.record(z.string(), parameterValue).default({}),
  disabled: z.boolean().optional(),
  notes: z.string().max(10_000).optional(),
  credentials: z.record(z.string(), z.object({ id: z.string(), name: z.string() })).optional(),
  retryOnFail: z.boolean().optional(),
  maxTries: z.number().int().min(2).max(10).optional(),
  waitBetweenTries: z.number().int().min(0).max(300_000).optional(),
  onError: z.enum(['stopWorkflow', 'continueRegularOutput', 'continueErrorOutput']).optional(),
  alwaysOutputData: z.boolean().optional(),
  executeOnce: z.boolean().optional(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
});

export const connectionSchema = z.object({
  source: z.string().min(1),
  sourceOutput: z.number().int().min(0),
  target: z.string().min(1),
  targetInput: z.number().int().min(0),
});

export const workflowSettingsSchema = z
  .object({
    timezone: z.string().max(64).optional(),
    executionTimeout: z.number().int().positive().max(86_400).optional(),
    saveManualExecutions: z.boolean().optional(),
    saveDataSuccessExecution: z.enum(['all', 'none']).optional(),
    saveDataErrorExecution: z.enum(['all', 'none']).optional(),
    errorWorkflow: z.string().optional(),
  })
  .strict();

const itemSchema = z.object({
  json: z.record(z.string(), z.unknown()),
  binary: z
    .record(
      z.string(),
      z.object({
        data: z.string(),
        mimeType: z.string(),
        fileName: z.string().optional(),
        fileExtension: z.string().optional(),
        fileSize: z.number().optional(),
      }),
    )
    .optional(),
});

export const pinDataSchema = z.record(z.string(), z.array(itemSchema));

/** Validates graph integrity on top of the shape. */
export const workflowGraphSchema = z
  .object({
    nodes: z.array(nodeSchema).max(2000),
    connections: z.array(connectionSchema).max(10_000),
  })
  .superRefine((graph, ctx) => {
    const ids = new Set<string>();
    const names = new Set<string>();
    graph.nodes.forEach((node, i) => {
      if (ids.has(node.id)) {
        ctx.addIssue({ code: 'custom', path: ['nodes', i, 'id'], message: `Duplicate node id "${node.id}"` });
      }
      if (names.has(node.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['nodes', i, 'name'],
          message: `Duplicate node name "${node.name}" - node names must be unique`,
        });
      }
      ids.add(node.id);
      names.add(node.name);
    });
    graph.connections.forEach((conn, i) => {
      if (!ids.has(conn.source) || !ids.has(conn.target)) {
        ctx.addIssue({
          code: 'custom',
          path: ['connections', i],
          message: 'Connection references a node that does not exist',
        });
      }
    });
  });

export const workflowCreateSchema = z.object({
  name: z.string().trim().min(1, 'Workflow name is required').max(128),
  nodes: z.array(nodeSchema).max(2000).default([]),
  connections: z.array(connectionSchema).max(10_000).default([]),
  settings: workflowSettingsSchema.default({}),
  pinData: pinDataSchema.optional(),
  active: z.boolean().optional(),
});

export const workflowUpdateSchema = workflowCreateSchema.partial().extend({
  /** Optimistic concurrency: the versionId the client last loaded. */
  versionId: z.string().optional(),
});

/** Shape accepted when importing workflow JSON exported from FlowForge. */
export const workflowImportSchema = workflowCreateSchema.extend({
  id: z.string().optional(),
  versionId: z.string().optional(),
});

export type WorkflowCreateInput = z.infer<typeof workflowCreateSchema>;
export type WorkflowUpdateInput = z.infer<typeof workflowUpdateSchema>;
