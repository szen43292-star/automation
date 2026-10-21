import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IDataObject } from '@flowforge/workflow';
import type { Config } from '../config';
import { badRequest, parse } from '../lib/errors';
import { buildAuthorizationUrl, exchangeCode, pkcePair, type OAuth2Settings } from './oauth2';

const dataSchema = z.record(z.string(), z.unknown());
const createSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(128),
  type: z.string().min(1),
  data: dataSchema.default({}),
});
const updateSchema = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  data: dataSchema.optional(),
});
const testSchema = z.object({
  type: z.string().min(1),
  data: dataSchema.default({}),
  id: z.string().optional(),
});
const idParams = z.object({ id: z.string().min(1) });

export const oauthCallbackPath = '/rest/oauth2-credential/callback';
export const oauthRedirectUri = (config: Config) =>
  `${config.PUBLIC_URL.replace(/\/+$/, '')}${oauthCallbackPath}`;

/** Authenticated credential API. */
export async function credentialRoutes(app: FastifyInstance, opts: { config: Config }) {
  const { credentials } = app.services;

  app.get('/api/credential-types', async () => ({ data: credentials.types.getAll() }));

  app.get('/api/credentials', async (request) => {
    const { type } = parse(z.object({ type: z.string().optional() }), request.query);
    return { data: await credentials.list(request.currentUser, type) };
  });

  app.get('/api/credentials/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    return credentials.get(request.currentUser, id);
  });

  app.post('/api/credentials', async (request, reply) => {
    const body = parse(createSchema, request.body);
    return reply
      .status(201)
      .send(
        await credentials.create(request.currentUser, { ...body, data: body.data as IDataObject }),
      );
  });

  app.patch('/api/credentials/:id', async (request) => {
    const { id } = parse(idParams, request.params);
    const body = parse(updateSchema, request.body);
    return credentials.update(request.currentUser, id, {
      name: body.name,
      data: body.data as IDataObject | undefined,
    });
  });

  app.delete('/api/credentials/:id', async (request, reply) => {
    const { id } = parse(idParams, request.params);
    await credentials.remove(request.currentUser, id);
    return reply.status(204).send();
  });

  app.post('/api/credentials/test', async (request) => {
    const body = parse(testSchema, request.body);
    return credentials.test(request.currentUser, { ...body, data: body.data as IDataObject });
  });

  /** Start the OAuth2 authorization-code flow: the editor opens the returned URL in a popup. */
  app.get('/api/credentials/:id/oauth2/auth-url', async (request) => {
    const { id } = parse(idParams, request.params);
    const row = await credentials.getRow(request.currentUser, id);
    if (!credentials.types.get(row.type)?.oauth2)
      throw badRequest('This is not an OAuth2 credential');
    const { data } = await credentials.decrypt(id);
    const settings = data as unknown as OAuth2Settings;
    if (settings.grantType === 'clientCredentials')
      throw badRequest('Client-credentials grants need no browser authorization');
    const { verifier, challenge } = pkcePair();
    const state = app.jwt.sign({ sub: request.currentUser.id, cid: id, v: verifier } as never, {
      expiresIn: '10m',
    });
    return {
      url: buildAuthorizationUrl(settings, oauthRedirectUri(opts.config), state, challenge),
      redirectUri: oauthRedirectUri(opts.config),
    };
  });
}

function callbackPage(ok: boolean, message: string) {
  const escaped = message.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
  );
  return `<!doctype html><html><head><meta charset="utf-8"><title>AutoForge</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f6f8;color:#1b1f27}
div{background:#fff;padding:32px 40px;border-radius:12px;box-shadow:0 4px 24px rgb(0 0 0/8%);text-align:center;max-width:420px}
h1{font-size:18px;margin:0 0 8px;color:${ok ? '#16a34a' : '#dc2626'}}</style></head>
<body><div><h1>${ok ? 'Connected' : 'Connection failed'}</h1><p>${escaped}</p><p>You can close this window.</p></div>
<script>try{window.opener&&window.opener.postMessage(${JSON.stringify({ type: 'flowforge-oauth2', ok })},'*')}catch(e){}${ok ? 'setTimeout(function(){window.close()},1500)' : ''}</script>
</body></html>`;
}

/** Public OAuth2 redirect target (authenticated through the signed `state`). */
export async function oauthCallbackRoutes(app: FastifyInstance, opts: { config: Config }) {
  app.get(oauthCallbackPath, async (request, reply) => {
    const query = request.query as {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };
    reply.type('text/html');
    if (query.error) return callbackPage(false, query.error_description ?? query.error);
    if (!query.code || !query.state)
      return reply.status(400).send(callbackPage(false, 'Missing code or state'));
    let state: { sub: string; cid: string; v: string };
    try {
      state = app.jwt.verify(query.state);
    } catch {
      return reply
        .status(400)
        .send(callbackPage(false, 'The authorization link expired - try connecting again'));
    }
    try {
      const { data } = await app.services.credentials.decrypt(state.cid);
      const token = await exchangeCode(
        data as unknown as OAuth2Settings,
        query.code,
        oauthRedirectUri(opts.config),
        state.v,
      );
      await app.services.credentials.storeData(state.cid, { ...data, oauthTokenData: token });
      return callbackPage(true, 'The credential is connected and ready to use.');
    } catch (error) {
      return reply.status(400).send(callbackPage(false, (error as Error).message));
    }
  });
}
