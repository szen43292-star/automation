import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, Workflow as WorkflowRow } from '@prisma/client';
import {
  workflowGraphSchema,
  type IConnection,
  type INode,
  type INodeTypes,
  type IPinData,
  type IWorkflowBase,
  type IWorkflowSettings,
  type WorkflowCreateInput,
  type WorkflowUpdateInput,
} from '@flowforge/workflow';
import type { AuthUser } from '../auth/auth';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';

export interface WorkflowDTO extends IWorkflowBase {
  id: string;
  active: boolean;
  versionId: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

export function toWorkflowDTO(row: WorkflowRow): WorkflowDTO {
  return {
    id: row.id,
    name: row.name,
    active: row.active,
    nodes: row.nodes as unknown as INode[],
    connections: row.connections as unknown as IConnection[],
    settings: row.settings as IWorkflowSettings,
    pinData: (row.pinData as IPinData | null) ?? undefined,
    versionId: row.versionId,
    ownerId: row.ownerId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const json = (value: unknown) => value as Prisma.InputJsonValue;

/** Node types that start an execution on their own (i.e. can be "activated"). */
function isActivatableTrigger(nodeTypes: INodeTypes, type: string): boolean {
  const description = nodeTypes.getDescription(type);
  return Boolean(description?.group.includes('trigger') && type !== 'flowforge.manualTrigger');
}

export class WorkflowService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly nodeTypes: INodeTypes,
  ) {}

  /** Members only see their own workflows; owners and admins see everything. */
  scope(user: AuthUser): Prisma.WorkflowWhereInput {
    return user.role === 'member' ? { ownerId: user.id } : {};
  }

  async get(user: AuthUser, id: string): Promise<WorkflowRow> {
    const row = await this.prisma.workflow.findFirst({ where: { id, ...this.scope(user) } });
    if (!row) throw notFound('Workflow');
    return row;
  }

  async list(
    user: AuthUser,
    query: { search?: string; active?: boolean; limit: number; offset: number },
  ) {
    const where: Prisma.WorkflowWhereInput = {
      ...this.scope(user),
      ...(query.search ? { name: { contains: query.search, mode: 'insensitive' } } : {}),
      ...(query.active !== undefined ? { active: query.active } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.workflow.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take: query.limit,
        skip: query.offset,
        select: {
          id: true,
          name: true,
          active: true,
          nodes: true,
          createdAt: true,
          updatedAt: true,
          versionId: true,
          owner: { select: { id: true, name: true } },
        },
      }),
      this.prisma.workflow.count({ where }),
    ]);
    return {
      total,
      data: rows.map((row) => {
        const nodes = row.nodes as unknown as INode[];
        return {
          id: row.id,
          name: row.name,
          active: row.active,
          versionId: row.versionId,
          owner: row.owner,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          nodeCount: nodes.length,
          nodeTypes: [...new Set(nodes.map((n) => n.type))].slice(0, 8),
        };
      }),
    };
  }

  private validateGraph(nodes: INode[], connections: IConnection[]) {
    workflowGraphSchema.parse({ nodes, connections });
    for (const node of nodes) {
      const max = this.nodeTypes.getDescription(node.type)?.maxNodes;
      if (max && nodes.filter((n) => n.type === node.type).length > max) {
        throw badRequest(`Only ${max} "${node.type}" node(s) allowed per workflow`);
      }
    }
  }

  async create(user: AuthUser, input: WorkflowCreateInput): Promise<WorkflowRow> {
    this.validateGraph(input.nodes as INode[], input.connections);
    const versionId = randomUUID();
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.workflow.create({
        data: {
          name: input.name,
          nodes: json(input.nodes),
          connections: json(input.connections),
          settings: json(input.settings),
          pinData: input.pinData ? json(input.pinData) : undefined,
          versionId,
          active: false,
          ownerId: user.id,
        },
      });
      await tx.workflowVersion.create({
        data: {
          versionId,
          workflowId: row.id,
          name: row.name,
          nodes: json(input.nodes),
          connections: json(input.connections),
          settings: json(input.settings),
          authorId: user.id,
        },
      });
      return row;
    });
  }

  async update(user: AuthUser, id: string, input: WorkflowUpdateInput): Promise<WorkflowRow> {
    const current = await this.get(user, id);
    if (input.versionId && input.versionId !== current.versionId) {
      throw conflict(
        'This workflow was changed somewhere else (another tab or user) since you opened it. Reload to get the latest version.',
      );
    }
    const nodes = (input.nodes ?? current.nodes) as unknown as INode[];
    const connections = (input.connections ?? current.connections) as unknown as IConnection[];
    if (input.nodes || input.connections) this.validateGraph(nodes, connections);

    const graphChanged =
      input.nodes !== undefined ||
      input.connections !== undefined ||
      input.settings !== undefined ||
      (input.name !== undefined && input.name !== current.name);
    const versionId = graphChanged ? randomUUID() : current.versionId;

    const active = input.active ?? current.active;
    if (active) this.assertActivatable(nodes);

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.workflow.update({
        where: { id },
        data: {
          name: input.name,
          nodes: input.nodes ? json(input.nodes) : undefined,
          connections: input.connections ? json(input.connections) : undefined,
          settings: input.settings ? json(input.settings) : undefined,
          pinData: input.pinData !== undefined ? json(input.pinData) : undefined,
          active,
          versionId,
        },
      });
      if (graphChanged) {
        await tx.workflowVersion.create({
          data: {
            versionId,
            workflowId: id,
            name: row.name,
            nodes: json(row.nodes),
            connections: json(row.connections),
            settings: json(row.settings),
            authorId: user.id,
          },
        });
      }
      return row;
    });
  }

  assertActivatable(nodes: INode[]) {
    const triggers = nodes.filter(
      (n) => !n.disabled && isActivatableTrigger(this.nodeTypes, n.type),
    );
    if (triggers.length === 0) {
      throw badRequest(
        'This workflow has no trigger that can start it automatically. "Manual Trigger" only runs from the editor - ' +
          'add a trigger such as Webhook, Schedule or a WhatsApp trigger to activate it.',
      );
    }
  }

  async remove(user: AuthUser, id: string) {
    const row = await this.get(user, id);
    if (user.role === 'member' && row.ownerId !== user.id) throw forbidden();
    await this.prisma.workflow.delete({ where: { id } });
  }

  async versions(user: AuthUser, id: string) {
    await this.get(user, id);
    const rows = await this.prisma.workflowVersion.findMany({
      where: { workflowId: id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        versionId: true,
        name: true,
        createdAt: true,
        author: { select: { id: true, name: true } },
      },
    });
    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
  }

  async version(user: AuthUser, id: string, versionId: string) {
    await this.get(user, id);
    const row = await this.prisma.workflowVersion.findFirst({
      where: { workflowId: id, versionId },
    });
    if (!row) throw notFound('Version');
    return {
      versionId: row.versionId,
      name: row.name,
      nodes: row.nodes,
      connections: row.connections,
      settings: row.settings,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
