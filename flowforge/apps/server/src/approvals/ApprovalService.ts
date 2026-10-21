import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Approval, PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import type { IApprovalCreated, IApprovalRequest, INodeExecutionData } from '@flowforge/workflow';
import type { IApprovalService } from '@flowforge/engine';
import type { RemoteAccess } from '../remote/RemoteAccess';

const EXTENSIONS: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

export type Decision = 'approved' | 'rejected';

export interface DecisionResult {
  ok: boolean;
  status: Approval['status'] | 'expired';
  message: string;
}

export interface ApprovalDTO {
  id: string;
  title: string;
  description: string;
  status: string;
  expired: boolean;
  hasMedia: boolean;
  mediaType: string | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
}

/**
 * Decisions asked from a person ("publish this video?"). The Ask for Approval node creates one and
 * sends its link; the page (or the app's Approvals screen) records the answer and continues the
 * execution that waits for it in a Wait node ("On Webhook Call").
 */
export class ApprovalService {
  /** Continues a waiting execution; set by the app once executions exist. */
  resume: ((executionId: string, data: INodeExecutionData[]) => Promise<boolean>) | null = null;

  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      dataDir: string;
      publicUrl: string;
      remote: RemoteAccess | null;
      logger: FastifyBaseLogger;
      /** How long to keep trying to resume (the Wait node may not have started yet). */
      resumeRetries?: number;
      resumeRetryMs?: number;
    },
  ) {}

  private get dir() {
    return join(this.deps.dataDir, 'approvals');
  }

  /** Engine-facing helper (Ask for Approval node). */
  helper(): IApprovalService {
    return {
      create: (owner, request) => this.create(owner, request),
      media: (id) => this.media(id),
    };
  }

  async create(
    owner: { executionId: string; workflowId?: string },
    request: IApprovalRequest,
  ): Promise<IApprovalCreated> {
    const id = randomBytes(24).toString('base64url');
    let mediaFile: string | null = null;
    if (request.media) {
      mkdirSync(this.dir, { recursive: true });
      mediaFile = `${id}${EXTENSIONS[request.media.mimeType] ?? '.bin'}`;
      writeFileSync(join(this.dir, mediaFile), request.media.data);
    }
    const row = await this.deps.prisma.approval.create({
      data: {
        id,
        executionId: owner.executionId,
        workflowId: owner.workflowId ?? null,
        title: request.title.slice(0, 500),
        description: (request.description ?? '').slice(0, 5000),
        mediaFile,
        mediaType: request.media?.mimeType ?? null,
        expiresAt: request.expiresAt,
      },
    });
    const local = `${this.deps.publicUrl.replace(/\/+$/, '')}/approve/${id}`;
    const remote = await this.deps.remote?.url().catch(() => null);
    return {
      id,
      url: remote ? `${remote}/approve/${id}` : local,
      localUrl: local,
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  async get(id: string): Promise<Approval | null> {
    if (!/^[\w-]{16,64}$/.test(id)) return null;
    return this.deps.prisma.approval.findUnique({ where: { id } });
  }

  /** The saved media file (for streaming) or null. */
  mediaPath(approval: Approval): string | null {
    if (!approval.mediaFile) return null;
    const path = join(this.dir, approval.mediaFile);
    try {
      return statSync(path).isFile() ? path : null;
    } catch {
      return null;
    }
  }

  async media(id: string): Promise<{ data: Buffer; mimeType: string; fileName?: string }> {
    const approval = await this.get(id);
    const path = approval ? this.mediaPath(approval) : null;
    if (!approval || !path) throw new Error('This approval has no saved video');
    return {
      data: readFileSync(path),
      mimeType: approval.mediaType ?? 'application/octet-stream',
      fileName: approval.mediaFile ?? undefined,
    };
  }

  toDTO(row: Approval): ApprovalDTO {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      expired: row.status === 'pending' && row.expiresAt.getTime() <= Date.now(),
      hasMedia: Boolean(row.mediaFile),
      mediaType: row.mediaType,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      decidedAt: row.decidedAt?.toISOString() ?? null,
    };
  }

  async list(options: { pendingOnly?: boolean; limit?: number } = {}): Promise<ApprovalDTO[]> {
    const rows = await this.deps.prisma.approval.findMany({
      where: options.pendingOnly ? { status: 'pending', expiresAt: { gt: new Date() } } : {},
      orderBy: { createdAt: 'desc' },
      take: options.limit ?? 50,
    });
    return rows.map((row) => this.toDTO(row));
  }

  /** Records the answer once and continues the waiting execution with { approved }. */
  async decide(id: string, decision: Decision): Promise<DecisionResult> {
    const approval = await this.get(id);
    if (!approval)
      return { ok: false, status: 'expired', message: 'This approval does not exist.' };
    if (approval.status !== 'pending')
      return {
        ok: false,
        status: approval.status,
        message: `This was already ${approval.status === 'approved' ? 'approved' : 'rejected'}.`,
      };
    if (approval.expiresAt.getTime() <= Date.now())
      return { ok: false, status: 'expired', message: 'This approval has expired.' };
    const decidedAt = new Date();
    // Only the first answer counts, also when two arrive at once.
    const { count } = await this.deps.prisma.approval.updateMany({
      where: { id, status: 'pending' },
      data: { status: decision, decidedAt },
    });
    if (!count) return this.decide(id, decision);

    const resumed = await this.resumeExecution(approval.executionId, [
      {
        json: {
          approved: decision === 'approved',
          decision,
          approval_id: id,
          decided_at: decidedAt.toISOString(),
        },
      },
    ]);
    if (!resumed)
      this.deps.logger.warn(
        { approvalId: id, executionId: approval.executionId },
        'Approval recorded, but its execution was not waiting',
      );
    // The video is not needed for a rejected approval any more.
    if (decision === 'rejected' && approval.mediaFile)
      rmSync(join(this.dir, approval.mediaFile), { force: true });
    return {
      ok: true,
      status: decision,
      message: resumed
        ? decision === 'approved'
          ? 'Approved - the workflow continues.'
          : 'Rejected - nothing will be published.'
        : 'Saved, but the workflow was no longer waiting for an answer.',
    };
  }

  /** The Wait node may still be starting when the answer comes in: try again for a moment. */
  private async resumeExecution(executionId: string, data: INodeExecutionData[]) {
    const tries = this.deps.resumeRetries ?? 10;
    for (let attempt = 0; attempt < tries; attempt++) {
      const row = await this.deps.prisma.execution.findUnique({
        where: { id: executionId },
        select: { status: true },
      });
      if (!row || ['success', 'error', 'canceled', 'crashed'].includes(row.status)) return false;
      if (row.status === 'waiting' && (await this.resume?.(executionId, data))) return true;
      await new Promise((resolve) => setTimeout(resolve, this.deps.resumeRetryMs ?? 500));
    }
    return false;
  }
}
