import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { IWorkflowBase } from '@flowforge/workflow';
import type { AuthUser } from '../auth/auth';
import type { ExecutionService } from '../executions/ExecutionService';
import { toWorkflowDTO, type WorkflowService } from '../workflows/WorkflowService';
import type { RemoteAccess } from '../remote/RemoteAccess';

const KEY = 'phone';

interface PhoneSettings {
  token: string;
  /** Runs started from the phone run as this user (who set the link up). */
  userId: string;
  workflowIds: string[];
}

export interface PhoneInfo {
  enabled: boolean;
  /** Opens from anywhere (through the tunnel) when remote access is on, else on this network. */
  url: string | null;
  localUrl: string | null;
  workflowIds: string[];
}

export interface PhoneWorkflow {
  id: string;
  name: string;
  last: { status: string; startedAt: string | null; stoppedAt: string | null } | null;
}

export interface PhoneRunResult {
  ok: boolean;
  message: string;
  executionId?: string;
}

/**
 * "Run from your phone": one secret link that lists the workflows you picked with a Run button,
 * their latest result and the videos waiting for your approval. Like approval links, the link
 * itself is the permission, so it opens in any phone browser without signing in.
 */
export class PhoneService {
  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      workflows: WorkflowService;
      executions: ExecutionService;
      publicUrl: string;
      remote: RemoteAccess | null;
    },
  ) {}

  private async load(): Promise<PhoneSettings | null> {
    const row = await this.deps.prisma.setting.findUnique({ where: { key: KEY } });
    return (row?.value as unknown as PhoneSettings | null) ?? null;
  }

  private async save(settings: PhoneSettings) {
    const value = settings as unknown as Prisma.InputJsonValue;
    await this.deps.prisma.setting.upsert({
      where: { key: KEY },
      create: { key: KEY, value },
      update: { value },
    });
  }

  async info(): Promise<PhoneInfo> {
    const settings = await this.load();
    if (!settings) return { enabled: false, url: null, localUrl: null, workflowIds: [] };
    const localUrl = `${this.deps.publicUrl.replace(/\/+$/, '')}/run/${settings.token}`;
    const remote = await this.deps.remote?.url().catch(() => null);
    return {
      enabled: true,
      url: remote ? `${remote}/run/${settings.token}` : localUrl,
      localUrl,
      workflowIds: settings.workflowIds,
    };
  }

  /** Turns the link on (or changes its workflows); only workflows this user can open count. */
  async update(user: AuthUser, workflowIds: string[]): Promise<PhoneInfo> {
    const allowed = await this.deps.prisma.workflow.findMany({
      where: { id: { in: workflowIds }, ...this.deps.workflows.scope(user) },
      select: { id: true },
    });
    const keep = new Set(allowed.map((w) => w.id));
    const current = await this.load();
    await this.save({
      token: current?.token ?? newToken(),
      userId: user.id,
      workflowIds: workflowIds.filter((id) => keep.has(id)),
    });
    return this.info();
  }

  /** A new secret link; the old one stops working. */
  async reset(user: AuthUser): Promise<PhoneInfo> {
    const current = await this.load();
    await this.save({
      token: newToken(),
      userId: user.id,
      workflowIds: current?.workflowIds ?? [],
    });
    return this.info();
  }

  async disable() {
    await this.deps.prisma.setting.deleteMany({ where: { key: KEY } });
  }

  /** The settings when the token is the current one. */
  async open(token: string): Promise<PhoneSettings | null> {
    if (!/^[\w-]{20,64}$/.test(token)) return null;
    const settings = await this.load();
    if (!settings) return null;
    const a = Buffer.from(token);
    const b = Buffer.from(settings.token);
    return a.length === b.length && timingSafeEqual(a, b) ? settings : null;
  }

  private async owner(settings: PhoneSettings): Promise<AuthUser | null> {
    const user = await this.deps.prisma.user.findUnique({
      where: { id: settings.userId },
      select: { id: true, email: true, name: true, role: true },
    });
    return (user as AuthUser | null) ?? null;
  }

  async workflows(settings: PhoneSettings): Promise<PhoneWorkflow[]> {
    const user = await this.owner(settings);
    if (!user || !settings.workflowIds.length) return [];
    const rows = await this.deps.prisma.workflow.findMany({
      where: { id: { in: settings.workflowIds }, ...this.deps.workflows.scope(user) },
      select: { id: true, name: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return Promise.all(
      settings.workflowIds
        .filter((id) => byId.has(id))
        .map(async (id) => {
          const last = await this.deps.prisma.execution.findFirst({
            where: { workflowId: id, parentExecutionId: null },
            orderBy: { createdAt: 'desc' },
            select: { status: true, startedAt: true, stoppedAt: true },
          });
          return {
            id,
            name: byId.get(id)!.name,
            last: last
              ? {
                  status: last.status,
                  startedAt: last.startedAt?.toISOString() ?? null,
                  stoppedAt: last.stoppedAt?.toISOString() ?? null,
                }
              : null,
          };
        }),
    );
  }

  async run(settings: PhoneSettings, workflowId: string): Promise<PhoneRunResult> {
    const user = await this.owner(settings);
    if (!user || !settings.workflowIds.includes(workflowId))
      return { ok: false, message: 'This workflow cannot be run from the phone.' };
    let row;
    try {
      row = await this.deps.workflows.get(user, workflowId);
    } catch {
      return { ok: false, message: 'This workflow no longer exists.' };
    }
    const running = await this.deps.prisma.execution.findFirst({
      where: { workflowId, status: { in: ['new', 'running'] }, parentExecutionId: null },
      select: { id: true },
    });
    if (running) return { ok: false, message: 'It is still running - wait for it to finish.' };
    const stored = toWorkflowDTO(row);
    // A real run: pinned test data is not used.
    const workflowData: IWorkflowBase = {
      name: stored.name,
      nodes: stored.nodes,
      connections: stored.connections,
      settings: stored.settings,
      active: stored.active,
    };
    try {
      const { executionId } = await this.deps.executions.start({
        userId: user.id,
        workflowId,
        workflowData,
        mode: 'manual',
      });
      return { ok: true, message: `Started "${stored.name}".`, executionId };
    } catch (error) {
      return { ok: false, message: `Could not start: ${(error as Error).message}` };
    }
  }
}

function newToken() {
  return randomBytes(24).toString('base64url');
}
