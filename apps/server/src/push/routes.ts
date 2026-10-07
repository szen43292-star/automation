import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { toAuthUser, type AuthUser } from '../auth/auth';

const messageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), topic: z.string().regex(/^(workflow|execution):[\w-]+$/) }),
  z.object({ type: z.literal('unsubscribe'), topic: z.string() }),
  z.object({ type: z.literal('ping') }),
]);

/**
 * WebSocket push channel: `GET /api/push?token=<jwt>`.
 * Browsers cannot set headers on WebSockets, so the token travels in the query string.
 */
export async function pushRoutes(app: FastifyInstance) {
  app.get('/api/push', { websocket: true }, async (socket, request) => {
    const token = (request.query as { token?: string }).token ?? '';
    let user: AuthUser;
    try {
      const { sub } = app.jwt.verify<{ sub: string }>(token);
      const row = await app.prisma.user.findUnique({ where: { id: sub } });
      if (!row) throw new Error('unknown user');
      user = toAuthUser(row);
    } catch {
      socket.close(4401, 'Unauthorized');
      return;
    }

    /** Only allow topics for workflows / executions the user can see. */
    const canAccess = async (topic: string) => {
      const [kind, id] = topic.split(':') as [string, string];
      const scope = app.services.workflows.scope(user);
      if (kind === 'workflow') return (await app.prisma.workflow.count({ where: { id, ...scope } })) > 0;
      return (await app.prisma.execution.count({ where: { id, workflow: scope } })) > 0;
    };

    const client = app.push.add(socket, user.id);
    socket.on('message', async (raw) => {
      let message: z.infer<typeof messageSchema>;
      try {
        message = messageSchema.parse(JSON.parse(raw.toString()));
      } catch {
        socket.send(JSON.stringify({ type: 'error', data: { message: 'Invalid message' } }));
        return;
      }
      if (message.type === 'subscribe') {
        if (await canAccess(message.topic)) app.push.subscribe(client, message.topic);
        else socket.send(JSON.stringify({ type: 'error', data: { message: `Cannot subscribe to ${message.topic}` } }));
      }
      else if (message.type === 'unsubscribe') app.push.unsubscribe(client, message.topic);
      else socket.send(JSON.stringify({ type: 'pong' }));
    });
    socket.send(JSON.stringify({ type: 'connected', data: { userId: user.id } }));
  });
}
