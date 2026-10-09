import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auth, createTestApp, prisma, resetDb, setupOwner } from './helpers';

/** Phase 6 - team, API keys, dashboard and templates. */
let app: FastifyInstance;
let owner: string;

beforeAll(async () => {
  app = await createTestApp({ PUBLIC_URL: 'https://flow.example.com' });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
  owner = await setupOwner(app);
});

const call = (
  method: string,
  url: string,
  token: string | Record<string, string>,
  payload?: unknown,
) =>
  app.inject({
    method: method as 'GET',
    url,
    headers: typeof token === 'string' ? auth(token) : token,
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

/** Invite someone and accept the invitation; returns their session token. */
async function join(by: string, email: string, role: 'owner' | 'admin' | 'member') {
  const invite = await call('POST', '/api/users', by, { email, name: email.split('@')[0], role });
  expect(invite.statusCode, invite.body).toBe(201);
  const token = invite.json().inviteUrl.split('/invite/')[1];
  const accept = await app.inject({
    method: 'POST',
    url: `/api/auth/invite/${token}`,
    payload: { password: 'Passw0rd-123' },
  });
  expect(accept.statusCode, accept.body).toBe(200);
  return { session: accept.json().token as string, id: invite.json().user.id as string };
}

describe('team', () => {
  it('invites people, who set their own password; roles limit what they can do', async () => {
    const invite = await call('POST', '/api/users', owner, {
      email: 'Ravi@Example.com',
      name: 'Ravi',
      role: 'admin',
    });
    expect(invite.statusCode, invite.body).toBe(201);
    expect(invite.json().user).toMatchObject({
      email: 'ravi@example.com',
      role: 'admin',
      status: 'invited',
    });
    const url: string = invite.json().inviteUrl;
    expect(url).toMatch(/^https:\/\/flow\.example\.com\/invite\/[\w-]{20,}$/);
    const token = url.split('/invite/')[1]!;

    // Can't sign in before accepting.
    const early = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ravi@example.com', password: 'anything' },
    });
    expect(early.statusCode).toBe(401);

    const info = await app.inject({ method: 'GET', url: `/api/auth/invite/${token}` });
    expect(info.json()).toEqual({ email: 'ravi@example.com', name: 'Ravi', role: 'admin' });
    const weak = await app.inject({
      method: 'POST',
      url: `/api/auth/invite/${token}`,
      payload: { password: 'short' },
    });
    expect(weak.statusCode).toBe(400);
    const accepted = await app.inject({
      method: 'POST',
      url: `/api/auth/invite/${token}`,
      payload: { password: 'Passw0rd-123', name: 'Ravi K' },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const admin = accepted.json().token as string;
    expect(accepted.json().user).toMatchObject({ name: 'Ravi K', role: 'admin' });
    // The link works once.
    expect((await app.inject({ method: 'GET', url: `/api/auth/invite/${token}` })).statusCode).toBe(
      404,
    );

    // Admins manage members and admins, not owners.
    expect(
      (
        await call('POST', '/api/users', admin, {
          email: 'o2@example.com',
          name: 'O',
          role: 'owner',
        })
      ).statusCode,
    ).toBe(403);
    const member = await join(admin, 'meera@example.com', 'member');
    const ownerRow = await prisma.user.findFirstOrThrow({ where: { role: 'owner' } });
    expect(
      (await call('PATCH', `/api/users/${ownerRow.id}`, admin, { role: 'member' })).statusCode,
    ).toBe(403);
    expect((await call('DELETE', `/api/users/${ownerRow.id}`, admin)).statusCode).toBe(403);

    // Members can't manage the team (or AI keys), but can see it.
    expect((await call('GET', '/api/users', member.session)).statusCode).toBe(200);
    expect(
      (await call('POST', '/api/users', member.session, { email: 'x@example.com', name: 'X' }))
        .statusCode,
    ).toBe(403);
    expect(
      (await call('PUT', '/api/ai/providers', member.session, { openai: 'sk-xxxxxxxxxxxx' }))
        .statusCode,
    ).toBe(403);

    // Role changes apply at once.
    expect(
      (await call('PATCH', `/api/users/${member.id}`, admin, { role: 'admin' })).statusCode,
    ).toBe(200);
    expect(
      (await call('POST', '/api/users', member.session, { email: 'y@example.com', name: 'Y' }))
        .statusCode,
    ).toBe(201);

    // The last owner stays; removing someone keeps their workflows.
    expect(
      (await call('PATCH', `/api/users/${ownerRow.id}`, owner, { role: 'admin' })).statusCode,
    ).toBe(400);
    const wf = await call('POST', '/api/workflows', member.session, {
      name: 'Meera flow',
      nodes: [],
      connections: [],
    });
    expect(wf.statusCode).toBe(201);
    expect((await call('DELETE', `/api/users/${member.id}`, admin)).statusCode).toBe(204);
    const kept = await prisma.workflow.findUniqueOrThrow({ where: { id: wf.json().id } });
    const adminRow = await prisma.user.findUniqueOrThrow({ where: { email: 'ravi@example.com' } });
    expect(kept.ownerId).toBe(adminRow.id);
    expect((await call('GET', '/api/workflows', member.session)).statusCode).toBe(401);

    const list = (await call('GET', '/api/users', owner)).json().data;
    expect(list.map((u: { email: string; status: string }) => [u.email, u.status])).toEqual([
      ['owner@example.com', 'active'],
      ['ravi@example.com', 'active'],
      ['y@example.com', 'invited'],
    ]);
  });

  it('changes your own name and password', async () => {
    const wrong = await call('PATCH', '/api/auth/me', owner, {
      currentPassword: 'nope',
      newPassword: 'NewPassw0rd!',
    });
    expect(wrong.statusCode).toBe(400);
    const ok = await call('PATCH', '/api/auth/me', owner, {
      name: 'Boss',
      currentPassword: 'Sup3rSecret!',
      newPassword: 'NewPassw0rd!',
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().user.name).toBe('Boss');
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'owner@example.com', password: 'NewPassw0rd!' },
    });
    expect(login.statusCode).toBe(200);
  });
});

describe('API keys', () => {
  it('act as their user, are shown once, stored hashed, and can be revoked', async () => {
    const created = await call('POST', '/api/api-keys', owner, { name: 'CRM' });
    expect(created.statusCode, created.body).toBe(201);
    const { key, id, prefix } = created.json();
    expect(key).toMatch(/^ff_[\w-]{40}$/);
    expect(key.startsWith(prefix)).toBe(true);
    const row = await prisma.apiKey.findUniqueOrThrow({ where: { id } });
    expect(row.hash).not.toContain(key);
    expect(JSON.stringify((await call('GET', '/api/api-keys', owner)).json())).not.toContain(key);

    // Both header styles work on the whole API.
    expect((await call('GET', '/api/workflows', { 'x-api-key': key })).statusCode).toBe(200);
    expect(
      (await call('GET', '/api/auth/me', { authorization: `Bearer ${key}` })).json().user.email,
    ).toBe('owner@example.com');
    const run = await call(
      'POST',
      '/api/workflows',
      { 'x-api-key': key },
      { name: 'From the API', nodes: [], connections: [] },
    );
    expect(run.statusCode).toBe(201);
    await new Promise((r) => setTimeout(r, 50));
    expect((await prisma.apiKey.findUniqueOrThrow({ where: { id } })).lastUsedAt).not.toBeNull();

    // A member's key has the member's rights.
    const member = await join(owner, 'm@example.com', 'member');
    const memberKey = (
      await call('POST', '/api/api-keys', member.session, { name: 'Zapier' })
    ).json().key;
    expect(
      (
        await call(
          'POST',
          '/api/users',
          { 'x-api-key': memberKey },
          { email: 'z@example.com', name: 'Z' },
        )
      ).statusCode,
    ).toBe(403);
    // Owners see and can revoke everyone's keys; members only their own.
    expect((await call('GET', '/api/api-keys', owner)).json().data).toHaveLength(2);
    expect((await call('GET', '/api/api-keys', member.session)).json().data).toHaveLength(1);
    expect((await call('DELETE', `/api/api-keys/${id}`, member.session)).statusCode).toBe(403);

    expect((await call('DELETE', `/api/api-keys/${id}`, owner)).statusCode).toBe(204);
    const revoked = await call('GET', '/api/workflows', { 'x-api-key': key });
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json().message).toContain('API key');
    expect((await call('GET', '/api/workflows', { 'x-api-key': 'ff_madeup' })).statusCode).toBe(
      401,
    );

    const expiring = (
      await call('POST', '/api/api-keys', owner, { name: 'Temp', expiresInDays: 1 })
    ).json();
    await prisma.apiKey.update({
      where: { id: expiring.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await call('GET', '/api/workflows', { 'x-api-key': expiring.key })).statusCode).toBe(
      401,
    );
  });
});

describe('templates', () => {
  it('every template becomes a valid workflow', async () => {
    const list = (await call('GET', '/api/templates', owner)).json().data;
    expect(list.length).toBeGreaterThanOrEqual(6);
    for (const template of list) {
      const used = await call('POST', `/api/templates/${template.id}/use`, owner);
      expect(used.statusCode, `${template.id}: ${used.body}`).toBe(201);
      expect(used.json().setup.length).toBeGreaterThan(0);
      const wf = (await call('GET', `/api/workflows/${used.json().id}`, owner)).json();
      expect(wf.nodes.length).toBeGreaterThanOrEqual(2);
      expect(wf.name).toBe(template.name);
    }
  });

  it('the agent booking tool template runs and returns a booking', async () => {
    const used = (await call('POST', '/api/templates/agent-booking-tool/use', owner)).json();
    const result = await app.services.executions.runWorkflowTool(used.id, {
      day: 'Friday',
      time: '5 pm',
      service: 'haircut',
      caller: { name: 'Ravi' },
    });
    expect(result[0]).toMatchObject({
      booked: true,
      day: 'Friday',
      name: 'Ravi',
      reference: expect.stringMatching(/^B-/),
    });
  });
});

describe('dashboard', () => {
  it('counts calls, messages and runs per day in the chosen timezone', async () => {
    const account = (await call('POST', '/api/whatsapp/accounts/simulator', owner, {})).json();
    const agent = (await call('POST', '/api/agents', owner, { name: 'Desk' })).json();
    const now = Date.now();
    const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000);
    await prisma.call.createMany({
      data: [
        {
          accountId: account.id,
          direction: 'inbound',
          contact: '911',
          contactName: 'Asha',
          status: 'ended',
          handledBy: 'ai',
          agentId: agent.id,
          durationSeconds: 120,
          startedAt: at(1),
        },
        {
          accountId: account.id,
          direction: 'inbound',
          contact: '911',
          contactName: 'Asha',
          status: 'ended',
          handledBy: 'person',
          durationSeconds: 60,
          startedAt: at(2),
        },
        {
          accountId: account.id,
          direction: 'inbound',
          contact: '922',
          status: 'missed',
          startedAt: at(3),
        },
        {
          accountId: account.id,
          direction: 'inbound',
          contact: '933',
          status: 'ended',
          handledBy: 'voicemail',
          durationSeconds: 30,
          startedAt: at(30),
        },
        {
          accountId: account.id,
          direction: 'inbound',
          contact: '944',
          status: 'ended',
          startedAt: at(24 * 40),
        }, // outside
      ],
    });
    await prisma.whatsAppMessage.createMany({
      data: [
        {
          accountId: account.id,
          direction: 'inbound',
          contact: '911',
          type: 'text',
          text: 'hi',
          payload: {},
          status: 'received',
          timestamp: at(1),
        },
        {
          accountId: account.id,
          direction: 'outbound',
          contact: '911',
          type: 'text',
          text: 'hello',
          payload: {},
          status: 'sent',
          timestamp: at(1),
        },
      ],
    });

    const res = await call('GET', '/api/dashboard?days=7&timezone=Asia/Kolkata', owner);
    expect(res.statusCode, res.body).toBe(200);
    const d = res.json();
    expect(d.timezone).toBe('Asia/Kolkata');
    expect(d.series.calls).toHaveLength(7);
    expect(d.totals).toMatchObject({
      calls: 4,
      answered: 3,
      missed: 1,
      answerRate: 0.75,
      handledByAi: 1,
      handledByPeople: 1,
      voicemail: 1,
      averageCallSeconds: 70,
      messagesReceived: 1,
      messagesSent: 1,
    });
    expect(d.topCallers[0]).toEqual({ contact: '911', contactName: 'Asha', calls: 2 });
    expect(d.agents).toEqual([{ agentId: agent.id, name: 'Desk', calls: 1, averageSeconds: 120 }]);
    expect(d.recentMissed).toEqual([expect.objectContaining({ contact: '922', status: 'missed' })]);
    expect(d.busiestHours).toHaveLength(24);

    const bad = await call('GET', "/api/dashboard?timezone=UTC'; DROP TABLE x;--", owner);
    expect(bad.statusCode).toBe(200);
    expect(bad.json().timezone).toBe('UTC');
  });
});

describe('editor links on Vercel', () => {
  it('point at the editor path on the project domain', async () => {
    const { loadConfig } = await import('../src/config');
    const base = {
      DATABASE_URL: 'postgresql://x',
      JWT_SECRET: 'test-secret-test-secret-test-secret-123',
    };
    const vercel = loadConfig({
      ...base,
      EDITOR_BASE_PATH: '/app',
      VERCEL_PROJECT_PRODUCTION_URL: 'flowforge.vercel.app',
    });
    expect(vercel.PUBLIC_URL).toBe('https://flowforge.vercel.app');
    expect(vercel.editorUrl).toBe('https://flowforge.vercel.app/app');
    expect(loadConfig({ ...base, PUBLIC_URL: 'https://flow.example.com/' }).editorUrl).toBe(
      'https://flow.example.com',
    );
    expect(() => loadConfig({ ...base, EDITOR_BASE_PATH: 'app/' })).toThrow(/EDITOR_BASE_PATH/);
  });
});
