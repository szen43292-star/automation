import type { FastifyError, FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { ZodError, type ZodType, type z } from 'zod';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code = 'Error',
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, message, 'BadRequest', details);
export const unauthorized = (message = 'Authentication required') =>
  new HttpError(401, message, 'Unauthorized');
export const forbidden = (message = 'You do not have permission to do this') =>
  new HttpError(403, message, 'Forbidden');
export const notFound = (what = 'Resource') => new HttpError(404, `${what} not found`, 'NotFound');
export const conflict = (message: string) => new HttpError(409, message, 'Conflict');

/** Parse request input with Zod; failures become 400 responses with per-field messages. */
export function parse<T extends ZodType>(schema: T, data: unknown): z.infer<T> {
  return schema.parse(data);
}

function formatZod(error: ZodError) {
  const issues = error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
  const first = issues[0];
  return {
    message: first
      ? first.path
        ? `${first.path}: ${first.message}`
        : first.message
      : 'Invalid input',
    issues,
  };
}

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    if (error instanceof ZodError) {
      const { message, issues } = formatZod(error);
      return reply.status(400).send({ error: 'ValidationError', message, issues });
    }
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({
        error: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2025')
        return reply.status(404).send({ error: 'NotFound', message: 'Resource not found' });
      if (error.code === 'P2002') {
        return reply
          .status(409)
          .send({ error: 'Conflict', message: 'A record with these values already exists' });
      }
    }
    // Meta (WhatsApp) rejected a request: show its message and our explanation.
    if (error.name === 'GraphApiError') {
      const { description } = error as Error & { description?: string };
      return reply.status(502).send({
        error: 'WhatsAppError',
        message: error.message,
        ...(description ? { description } : {}),
      });
    }
    const fastifyError = error as FastifyError;
    if (fastifyError.validation || (fastifyError.statusCode && fastifyError.statusCode < 500)) {
      const status = fastifyError.statusCode ?? 400;
      const label =
        status === 429
          ? 'TooManyRequests'
          : status === 413
            ? 'PayloadTooLarge'
            : (fastifyError.code ?? 'BadRequest');
      return reply.status(status).send({ error: label, message: fastifyError.message });
    }
    request.log.error({ err: error }, 'Unhandled error');
    return reply
      .status(500)
      .send({ error: 'InternalServerError', message: 'Something went wrong on the server' });
  });
}
