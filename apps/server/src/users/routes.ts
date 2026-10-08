import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Role, User } from '@prisma/client';
import { z } from 'zod';
import { authenticate, passwordSchema, requireRole, toAuthUser } from '../auth/auth';
import { hashPassword, verifyPassword } from '../auth/password';
import { HttpError, badRequest, conflict, forbidden, notFound, parse } from '../lib/errors';

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const INVITE_DAYS = 7;

const toUserDTO = (u: User) => ({
  ...toAuthUser(u),
  status: u.inviteTokenHash ? ('invited' as const) : ('active' as const),
  inviteExpiresAt: u.inviteExpiresAt?.toISOString() ?? null,
  lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
  createdAt: u.createdAt.toISOString(),
});

const idParams = z.object({ id: z.string().min(1) });
const roleSchema = z.enum(['owner', 'admin', 'member']);

/**
 * Team members (owner / admin / member), invitations and API keys.
 *
 * - owner: everything, incl. AI keys, the Meta app and other owners
 * - admin: manages workflows, numbers, agents and members/admins
 * - member: own workflows; answers calls; sees numbers, agents and the call log
 */
export async function userRoutes(app: FastifyInstance, opts: { publicUrl: string }) {
  const admin = { onRequest: requireRole('owner', 'admin') };
  const inviteUrl = (token: string) => `${opts.publicUrl.replace(/\/+$/, '')}/invite/${token}`;

  /** Admins can't touch owners or make anyone an owner. */
  const checkCanManage = (actor: { role: Role }, target: { role: Role } | null, newRole?: Role) => {
    if (actor.role === 'owner') return;
    if (target?.role === 'owner' || newRole === 'owner')
      throw forbidden('Only an owner can manage owners');
  };

  const newInvite = () => {
    const token = randomBytes(24).toString('base64url');
    return {
      token,
      inviteTokenHash: sha256(token),
      inviteExpiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000),
    };
  };

  app.get('/api/users', async () => {
    const users = await app.prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
    return { data: users.map(toUserDTO) };
  });

  /** Invite a team member: returns a link to send them (valid 7 days). */
  app.post('/api/users', admin, async (request, reply) => {
    const body = parse(
      z.object({
        email: z.string().trim().toLowerCase().email('Enter a valid email address'),
        name: z.string().trim().min(1).max(100),
        role: roleSchema.default('member'),
      }),
      request.body,
    );
    checkCanManage(request.currentUser, null, body.role);
    if (await app.prisma.user.findUnique({ where: { email: body.email } }))
      throw conflict('Someone with this email is already on the team');
    const invite = newInvite();
    const user = await app.prisma.user.create({
      data: {
        email: body.email,
        name: body.name,
        role: body.role,
        passwordHash: '',
        inviteTokenHash: invite.inviteTokenHash,
        inviteExpiresAt: invite.inviteExpiresAt,
      },
    });
    return reply.status(201).send({ user: toUserDTO(user), inviteUrl: inviteUrl(invite.token) });
  });

  /** A new invitation link (the old one stops working). */
  app.post('/api/users/:id/invite', admin, async (request) => {
    const { id } = parse(idParams, request.params);
    const target = await app.prisma.user.findUnique({ where: { id } });
    if (!target) throw notFound('User');
    checkCanManage(request.currentUser, target);
    if (!target.inviteTokenHash) throw badRequest('This person has already joined');
    const invite = newInvite();
    await app.prisma.user.update({
      where: { id },
      data: { inviteTokenHash: invite.inviteTokenHash, inviteExpiresAt: invite.inviteExpiresAt },
    });
    return { inviteUrl: inviteUrl(invite.token) };
  });

  app.patch('/api/users/:id', admin, async (request) => {
    const { id } = parse(idParams, request.params);
    const body = parse(
      z.object({ name: z.string().trim().min(1).max(100).optional(), role: roleSchema.optional() }),
      request.body,
    );
    const target = await app.prisma.user.findUnique({ where: { id } });
    if (!target) throw notFound('User');
    checkCanManage(request.currentUser, target, body.role);
    if (body.role && body.role !== 'owner' && target.role === 'owner') {
      const owners = await app.prisma.user.count({ where: { role: 'owner' } });
      if (owners <= 1) throw badRequest('There must always be at least one owner');
    }
    const user = await app.prisma.user.update({ where: { id }, data: body });
    return toUserDTO(user);
  });

  app.delete('/api/users/:id', admin, async (request, reply) => {
    const { id } = parse(idParams, request.params);
    if (id === request.currentUser.id) throw badRequest("You can't remove yourself");
    const target = await app.prisma.user.findUnique({ where: { id } });
    if (!target) throw notFound('User');
    checkCanManage(request.currentUser, target);
    if (target.role === 'owner' && (await app.prisma.user.count({ where: { role: 'owner' } })) <= 1)
      throw badRequest('There must always be at least one owner');
    // Their workflows and numbers stay; ownership moves to the person removing them.
    await app.prisma.$transaction([
      app.prisma.workflow.updateMany({
        where: { ownerId: id },
        data: { ownerId: request.currentUser.id },
      }),
      app.prisma.credential.updateMany({
        where: { ownerId: id },
        data: { ownerId: request.currentUser.id },
      }),
      app.prisma.user.delete({ where: { id } }),
    ]);
    return reply.status(204).send();
  });

  // ---- Your own account ---------------------------------------------------------------------------

  app.patch('/api/auth/me', async (request) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(100).optional(),
        currentPassword: z.string().max(256).optional(),
        newPassword: passwordSchema.optional(),
      }),
      request.body,
    );
    const me = await app.prisma.user.findUniqueOrThrow({ where: { id: request.currentUser.id } });
    const data: { name?: string; passwordHash?: string } = {};
    if (body.name) data.name = body.name;
    if (body.newPassword) {
      if (!body.currentPassword || !(await verifyPassword(body.currentPassword, me.passwordHash)))
        throw badRequest('Your current password is wrong');
      data.passwordHash = await hashPassword(body.newPassword);
    }
    const user = await app.prisma.user.update({ where: { id: me.id }, data });
    return { user: toAuthUser(user) };
  });

  // ---- API keys -----------------------------------------------------------------------------------

  const toKeyDTO = (k: {
    id: string;
    name: string;
    prefix: string;
    userId: string;
    lastUsedAt: Date | null;
    expiresAt: Date | null;
    createdAt: Date;
    user?: { name: string };
  }) => ({
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    userId: k.userId,
    userName: k.user?.name ?? null,
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    expiresAt: k.expiresAt?.toISOString() ?? null,
    createdAt: k.createdAt.toISOString(),
  });

  /** Your keys (the owner sees everyone's, to revoke them). */
  app.get('/api/api-keys', async (request) => {
    const keys = await app.prisma.apiKey.findMany({
      where: request.currentUser.role === 'owner' ? {} : { userId: request.currentUser.id },
      include: { user: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return { data: keys.map(toKeyDTO) };
  });

  /** The key is shown once; only its hash is stored. */
  app.post('/api/api-keys', async (request, reply) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(100),
        expiresInDays: z.number().int().min(1).max(3650).nullable().default(null),
      }),
      request.body,
    );
    const key = `ff_${randomBytes(30).toString('base64url')}`;
    const row = await app.prisma.apiKey.create({
      data: {
        name: body.name,
        prefix: key.slice(0, 10),
        hash: sha256(key),
        userId: request.currentUser.id,
        expiresAt: body.expiresInDays
          ? new Date(Date.now() + body.expiresInDays * 86_400_000)
          : null,
      },
    });
    return reply.status(201).send({ ...toKeyDTO(row), key });
  });

  app.delete('/api/api-keys/:id', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const key = await app.prisma.apiKey.findUnique({ where: { id } });
    if (!key) throw notFound('API key');
    if (key.userId !== request.currentUser.id && request.currentUser.role !== 'owner')
      throw forbidden();
    await app.prisma.apiKey.delete({ where: { id } });
    return reply.status(204).send();
  });
}

/** Accepting an invitation (no sign-in yet). */
export async function inviteRoutes(app: FastifyInstance, opts: { rateLimit: number }) {
  const rateLimit = { max: opts.rateLimit, timeWindow: '1 minute' };
  const find = async (token: string) => {
    const user = await app.prisma.user.findUnique({ where: { inviteTokenHash: sha256(token) } });
    if (!user || !user.inviteExpiresAt || user.inviteExpiresAt < new Date())
      throw new HttpError(
        404,
        'This invitation link is invalid or has expired. Ask for a new one.',
        'NotFound',
      );
    return user;
  };

  app.get('/api/auth/invite/:token', { config: { rateLimit } }, async (request) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(200) }), request.params);
    const user = await find(token);
    return { email: user.email, name: user.name, role: user.role };
  });

  app.post('/api/auth/invite/:token', { config: { rateLimit } }, async (request) => {
    const { token } = parse(z.object({ token: z.string().min(10).max(200) }), request.params);
    const body = parse(
      z.object({ password: passwordSchema, name: z.string().trim().min(1).max(100).optional() }),
      request.body,
    );
    const invited = await find(token);
    const user = await app.prisma.user.update({
      where: { id: invited.id },
      data: {
        passwordHash: await hashPassword(body.password),
        ...(body.name ? { name: body.name } : {}),
        inviteTokenHash: null,
        inviteExpiresAt: null,
        lastLoginAt: new Date(),
      },
    });
    return { token: app.jwt.sign({ sub: user.id }), user: toAuthUser(user) };
  });
}

export { authenticate };
