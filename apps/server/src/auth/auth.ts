import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Role, User } from '@prisma/client';
import { z } from 'zod';
import { forbidden, parse, unauthorized } from '../lib/errors';
import { hashPassword, verifyPassword } from './password';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    currentUser: AuthUser;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string };
    user: { sub: string };
  }
}

export const toAuthUser = (user: User): AuthUser => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
});

/** onRequest hook: verifies the bearer token and loads the user. */
export async function authenticate(request: FastifyRequest, _reply: FastifyReply) {
  try {
    await request.jwtVerify();
  } catch {
    throw unauthorized('Your session is invalid or has expired. Please sign in again.');
  }
  const user = await request.server.prisma.user.findUnique({ where: { id: request.user.sub } });
  if (!user) throw unauthorized('Your account no longer exists');
  request.currentUser = toAuthUser(user);
}

export function requireRole(...roles: Role[]) {
  return async (request: FastifyRequest) => {
    if (!roles.includes(request.currentUser.role)) throw forbidden();
  };
}

const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(256)
  .regex(/[A-Z]/, 'Password must contain an uppercase letter')
  .regex(/[0-9]/, 'Password must contain a number');

const setupSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  name: z.string().trim().min(1, 'Name is required').max(100),
  password: passwordSchema,
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required').max(256),
});

export async function authRoutes(app: FastifyInstance, opts: { rateLimit: number }) {
  const rateLimit = { max: opts.rateLimit, timeWindow: '1 minute' };
  // Verified against for unknown emails so response time does not reveal which emails exist.
  const dummyHash = hashPassword(crypto.randomUUID());
  const issue = (user: User) => ({
    token: app.jwt.sign({ sub: user.id }),
    user: toAuthUser(user),
  });

  app.get('/api/auth/status', async () => {
    const users = await app.prisma.user.count();
    return { setupRequired: users === 0, version: app.flowforgeVersion };
  });

  /** Create the instance owner. Only allowed while no user exists. */
  app.post('/api/auth/setup', { config: { rateLimit } }, async (request, reply) => {
    const body = parse(setupSchema, request.body);
    const user = await app.prisma.$transaction(async (tx) => {
      if ((await tx.user.count()) > 0) return null;
      return tx.user.create({
        data: {
          email: body.email,
          name: body.name,
          passwordHash: await hashPassword(body.password),
          role: 'owner',
        },
      });
    });
    if (!user) throw forbidden('This instance is already set up. Sign in instead.');
    return reply.status(201).send(issue(user));
  });

  app.post('/api/auth/login', { config: { rateLimit } }, async (request) => {
    const body = parse(loginSchema, request.body);
    const user = await app.prisma.user.findUnique({ where: { email: body.email } });
    const valid = user
      ? await verifyPassword(body.password, user.passwordHash)
      : await verifyPassword(body.password, await dummyHash).then(() => false);
    if (!user || !valid) throw unauthorized('Wrong email or password');
    return issue(user);
  });

  app.get('/api/auth/me', { onRequest: authenticate }, async (request) => ({
    user: request.currentUser,
  }));
}
