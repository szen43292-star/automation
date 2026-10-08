import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireRole } from '../auth/auth';
import { parse } from '../lib/errors';
import { callSettingsSchema } from './settings';

const idParams = z.object({ id: z.string().min(1) });
const sdpBody = z.object({ sdp: z.string().min(20).max(20_000) });

/** Call log, answering calls in the app, and per-number call settings (inside the /api scope). */
export async function callRoutes(app: FastifyInstance) {
  const { calls } = app;
  const admin = { onRequest: requireRole('owner', 'admin') };

  app.get('/api/calls', async (request) => {
    const query = parse(
      z.object({
        accountId: z.string().optional(),
        status: z
          .string()
          .optional()
          .transform((v) => (v ? v.split(',') : []))
          .pipe(z.array(z.enum(['ringing', 'answered', 'ended', 'missed', 'rejected', 'failed']))),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        before: z.iso.datetime().optional(),
      }),
      request.query,
    );
    return { data: await calls.list(query) };
  });

  app.get('/api/calls/active', async () => ({ data: await calls.activeCalls() }));

  app.get('/api/calls/:id', async (request) => calls.get(parse(idParams, request.params).id));

  app.get('/api/calls/:id/recording', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const wav = await calls.recording(id);
    return reply
      .type('audio/wav')
      .header('content-disposition', `inline; filename="call-${id}.wav"`)
      .header('cache-control', 'private, max-age=3600')
      .send(wav);
  });

  app.delete('/api/calls/:id/recording', admin, async (request, reply) => {
    await calls.deleteRecording(parse(idParams, request.params).id);
    return reply.status(204).send();
  });

  /** Pick up a ringing call in the app: send the app's WebRTC offer, get the answer. */
  app.post('/api/calls/:id/answer', async (request) => {
    const { id } = parse(idParams, request.params);
    const { sdp } = parse(sdpBody, request.body);
    return calls.answerInApp(id, request.currentUser, sdp);
  });

  app.post('/api/calls/:id/decline', async (request, reply) => {
    await calls.declineInApp(parse(idParams, request.params).id);
    return reply.status(204).send();
  });

  app.post('/api/calls/:id/hangup', async (request, reply) => {
    await calls.hangup(parse(idParams, request.params).id);
    return reply.status(204).send();
  });

  // Per-number call settings
  app.get('/api/whatsapp/accounts/:id/calling', async (request) =>
    calls.getSettings(parse(idParams, request.params).id),
  );

  app.put('/api/whatsapp/accounts/:id/calling', admin, async (request) => {
    const { id } = parse(idParams, request.params);
    return calls.saveSettings(id, parse(callSettingsSchema, request.body));
  });

  app.post('/api/whatsapp/accounts/:id/calling/enable', admin, async (request) =>
    calls.enableCalling(parse(idParams, request.params).id),
  );

  /** Upload (base64 WAV) or remove (null) the voicemail greeting. */
  app.put('/api/whatsapp/accounts/:id/calling/greeting', admin, async (request, reply) => {
    const { id } = parse(idParams, request.params);
    const { base64 } = parse(
      z.object({ base64: z.string().max(16_000_000).nullable() }),
      request.body,
    );
    await calls.setGreetingAudio(id, base64 ? Buffer.from(base64, 'base64') : null);
    return reply.status(204).send();
  });

  // Test numbers: the browser plays the caller.
  app.post('/api/whatsapp/accounts/:id/simulate-call', async (request) => {
    const { id } = parse(idParams, request.params);
    const body = parse(
      z.object({
        from: z.string().min(5).max(32),
        name: z.string().max(100).optional(),
        sdp: z.string().min(20).max(20_000),
      }),
      request.body,
    );
    return calls.simulateCall(id, body);
  });

  app.post('/api/whatsapp/accounts/:id/simulate-call/:waCallId/hangup', async (request, reply) => {
    const { id, waCallId } = parse(
      z.object({ id: z.string(), waCallId: z.string() }),
      request.params,
    );
    await calls.simulateHangup(id, waCallId);
    return reply.status(204).send();
  });
}
