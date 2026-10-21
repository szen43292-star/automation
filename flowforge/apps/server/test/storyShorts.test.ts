import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Workflow,
  type IDataObject,
  type IHttpRequestOptions,
  type IHttpResponse,
  type INode,
  type IRun,
} from '@flowforge/workflow';
import {
  CodeSandbox,
  WorkflowExecute,
  createAdditionalData,
  type ICredentialsHelper,
  type WorkflowRunOptions,
} from '@flowforge/engine';
import { createNodeTypes } from '@flowforge/nodes';
import { TEMPLATES } from '../src/templates/templates';
import { auth, createTestApp, prisma, resetDb, setupOwner } from './helpers';

/** "AI Story Shorts – Daily": the template, the Google credentials and a full run with fakes. */
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

const call = (method: string, url: string, payload?: unknown) =>
  app.inject({
    method: method as 'GET',
    url,
    headers: auth(owner),
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

const template = TEMPLATES.find((t) => t.id === 'ai-story-shorts-daily')!;

describe('Google credentials', () => {
  it('only need the client ID and secret; the Google settings are built in', async () => {
    const created = await call('POST', '/api/credentials', {
      name: 'My YouTube',
      type: 'youTubeOAuth2Api',
      data: { clientId: 'client-123', clientSecret: 'shh' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const { url } = (
      await call('GET', `/api/credentials/${created.json().id}/oauth2/auth-url`)
    ).json();
    const auth = new URL(url);
    expect(auth.origin + auth.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(auth.searchParams.get('client_id')).toBe('client-123');
    expect(auth.searchParams.get('scope')).toContain(
      'https://www.googleapis.com/auth/youtube.upload',
    );
    expect(auth.searchParams.get('access_type')).toBe('offline');
    expect(auth.searchParams.get('prompt')).toBe('consent');
    // The secret never comes back.
    const read = (await call('GET', `/api/credentials/${created.json().id}`)).json();
    expect(read.data.clientSecret).not.toBe('shh');
  });
});

describe('AI Story Shorts – Daily template', () => {
  it('uses the credentials you have, reports the missing ones and stays inactive', async () => {
    const gemini = (
      await call('POST', '/api/credentials', {
        name: 'Gemini',
        type: 'googlePalmApi',
        data: { apiKey: 'AIza-test' },
      })
    ).json();
    const youtube = (
      await call('POST', '/api/credentials', {
        name: 'YouTube',
        type: 'youTubeOAuth2Api',
        data: { clientId: 'a', clientSecret: 'b' },
      })
    ).json();

    const used = await call('POST', '/api/templates/ai-story-shorts-daily/use');
    expect(used.statusCode, used.body).toBe(201);
    expect(used.json().missingCredentials).toEqual([
      'Google Sheets OAuth2 API',
      'Gmail OAuth2 API',
    ]);
    const wf = (await call('GET', `/api/workflows/${used.json().id}`)).json();
    expect(wf.name).toBe('AI Story Shorts – Daily');
    expect(wf.active).toBe(false);
    expect(wf.settings.timezone).toBe('Asia/Kolkata');
    const byName = new Map<string, INode>(wf.nodes.map((n: INode) => [n.name, n]));
    expect(byName.get('Write Story')!.credentials).toEqual({
      googlePalmApi: { id: gemini.id, name: 'Gemini' },
    });
    expect(byName.get('YouTube Trending')!.credentials).toEqual({
      youTubeOAuth2Api: { id: youtube.id, name: 'YouTube' },
    });
    expect(byName.get('Get Past Titles')!.credentials).toBeUndefined();
    expect(byName.get('Get Past Titles')!.alwaysOutputData).toBe(true);
    // No secrets in the workflow itself.
    expect(JSON.stringify(wf)).not.toContain('AIza-test');
  });

  it('makes, uploads, logs and announces a Short (with the wait loop)', async () => {
    const story = {
      trend_used: 'Diwali 2026',
      title: 'The Lamp That Remembered',
      script: 'A small lamp wakes up every Diwali. '.repeat(10).trim(),
      description:
        'A lamp with a memory.\nOne night only.\nStory written and narrated with AI assistance.\n#shorts #diwali #story',
      tags: ['story', 'diwali', 'shorts', 'lamp', 'india', 'festival', 'twist', 'ai'],
      search_terms: ['diwali lamp', 'night city', 'old house', 'child smiling', 'fireworks'],
    };
    const review = {
      hook: 8,
      clarity: 9,
      originality: 8,
      safety: 10,
      approve: true,
      reason: 'Good',
    };
    let progress = 40;
    const calls: IHttpRequestOptions[] = [];
    const ok = (body: unknown, extra: Partial<IHttpResponse> = {}): IHttpResponse => ({
      statusCode: 200,
      statusMessage: 'OK',
      headers: { 'content-type': 'application/json' },
      body,
      ...extra,
    });
    const httpRequest = async (r: IHttpRequestOptions): Promise<IHttpResponse> => {
      calls.push(r);
      const url = r.url;
      if (url.startsWith('https://trends.google.com/'))
        return ok(
          '<rss><channel><item><title>Diwali 2026</title></item><item><title>Cricket final</title></item></channel></rss>',
        );
      if (url === 'https://www.googleapis.com/youtube/v3/videos')
        return ok({
          items: [{ snippet: { title: 'Top song' } }, { snippet: { title: 'Funny cat' } }],
        });
      if (url.includes('sheets.googleapis.com') && r.method === 'GET' && url.includes('1%3A1'))
        return ok({ values: [['title', 'trend_used', 'video_id', 'date']] });
      if (url.includes('sheets.googleapis.com') && r.method === 'GET')
        return ok({ values: [['title'], ['Old story 1'], ['Old story 2']] });
      if (url.includes(':append')) return ok({ updates: { updatedRows: 1 } });
      if (url.endsWith('/v1beta/models'))
        return ok({
          models: [
            { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
          ],
        });
      if (url.includes(':generateContent')) {
        const prompt = JSON.stringify((r.body as IDataObject).contents);
        const answer = prompt.includes('strict YouTube Shorts editor') ? review : story;
        return ok({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] });
      }
      if (url === 'http://127.0.0.1:8080/api/v1/videos')
        return ok({ status: 200, message: 'success', data: { task_id: 'task-42' } });
      if (url === 'http://127.0.0.1:8080/api/v1/tasks/task-42') {
        const now = progress;
        progress = 100;
        return ok({
          status: 200,
          data: {
            state: now === 100 ? 1 : 4,
            progress: now,
            videos: now === 100 ? ['http://127.0.0.1:8080/tasks/task-42/final-1.mp4'] : [],
          },
        });
      }
      if (url.endsWith('final-1.mp4'))
        return ok(undefined, {
          headers: { 'content-type': 'video/mp4' },
          binary: Buffer.from('mp4 bytes'),
        });
      if (url === 'https://www.googleapis.com/upload/youtube/v3/videos')
        return ok(undefined, { headers: { location: 'https://upload.example/s/1' } });
      if (url === 'https://upload.example/s/1')
        return ok({ id: 'VID123', snippet: { title: story.title } });
      if (url.endsWith('/messages/send')) return ok({ id: 'mail-1' });
      return {
        statusCode: 404,
        statusMessage: 'Not Found',
        headers: {},
        body: { error: `no fake for ${url}` },
      };
    };
    const credentials: ICredentialsHelper = {
      getDecrypted: async (_node, type) =>
        type === 'googlePalmApi'
          ? { host: 'https://generativelanguage.googleapis.com', apiKey: 'k' }
          : {},
      authenticateRequest: async (_node, type, options) => ({
        ...options,
        headers: { ...(options.headers ?? {}), authorization: `Bearer ${type}` },
      }),
    };

    // Every credential type the template needs, as if the user had connected them all.
    const nodes = template.nodes.map(({ credentialTypes, ...n }) => ({
      ...n,
      ...(credentialTypes
        ? { credentials: Object.fromEntries(credentialTypes.map((t) => [t, { id: t, name: t }])) }
        : {}),
      parameters: {
        ...n.parameters,
        ...(n.type === 'flowforge.googleSheets' ? { documentId: 'SHEET-ID' } : {}),
        ...(n.type === 'flowforge.gmail' ? { sendTo: 'me@example.com' } : {}),
      },
    })) as INode[];
    const workflow = new Workflow({
      name: template.name,
      nodes,
      connections: template.connections,
      settings: template.settings,
    });
    const nodeTypes = createNodeTypes();
    const codeSandbox = new CodeSandbox({ timeoutMs: 3_000 });
    const execute = (options: WorkflowRunOptions) =>
      new WorkflowExecute(
        workflow,
        createAdditionalData({
          executionId: 'shorts',
          mode: 'trigger',
          nodeTypes,
          codeSandbox,
          httpRequest,
          credentials,
        }),
      ).run(options);

    let run: IRun = await execute({
      startNode: 'Every day 18:00',
      triggerItems: [{ json: {} }],
    });
    let waits = 0;
    while (run.status === 'waiting') {
      waits++;
      expect(run.data.waitingNode).toBe('Wait 5 Minutes');
      const until = new Date(run.data.waitTill!).getTime() - Date.now();
      expect(until).toBeGreaterThan(4 * 60_000);
      run = await execute({ resumeFrom: run.data });
    }
    expect(run.data.resultData.error).toBeUndefined();
    expect(run.status).toBe('success');
    expect(waits).toBe(2); // not ready at the first check, ready at the second

    const runData = run.data.resultData.runData;
    const out = (name: string, i = -1) => runData[name]?.at(i)?.data?.main[0]?.map((x) => x.json);
    expect(out('Aggregate Trends')?.[0]).toEqual({
      trends: ['Diwali 2026', 'Cricket final', 'Top song', 'Funny cat'],
    });
    expect(out('Aggregate Past Titles')?.[0]).toEqual({
      past_titles: ['Old story 1', 'Old story 2'],
    });
    expect(out('Count Tries')?.[0]).toMatchObject({ tries: 1 });

    const writePrompt = calls.find((c) => c.url.includes(':generateContent'))!;
    const promptText = JSON.stringify((writePrompt.body as IDataObject).contents);
    expect(promptText).toContain('Diwali 2026 | Cricket final | Top song | Funny cat');
    expect(promptText).toContain('Old story 1 | Old story 2');

    const make = calls.find((c) => c.url === 'http://127.0.0.1:8080/api/v1/videos')!;
    expect(make.body).toEqual({
      video_subject: story.title,
      video_script: story.script,
      video_terms: story.search_terms,
      video_aspect: '9:16',
      video_source: 'pexels',
      video_clip_duration: 3,
      video_count: 1,
      voice_name: 'en-US-AndrewNeural-Male',
      voice_rate: 1.1,
      bgm_type: 'random',
      bgm_volume: 0.2,
      subtitle_enabled: true,
      subtitle_position: 'bottom',
    });

    const upload = calls.find(
      (c) => c.url === 'https://www.googleapis.com/upload/youtube/v3/videos',
    )!;
    expect(upload.body).toEqual({
      snippet: {
        title: story.title,
        description: story.description,
        categoryId: '24',
        tags: story.tags,
      },
      status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
    });

    const append = calls.find((c) => c.url.includes(':append'))!;
    const [row] = (append.body as { values: string[][] }).values;
    expect(row!.slice(0, 3)).toEqual([story.title, story.trend_used, 'VID123']);
    expect(row![3]).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const mail = calls.find((c) => c.url.endsWith('/messages/send'))!;
    const message = Buffer.from((mail.body as { raw: string }).raw, 'base64url').toString();
    expect(message).toContain('Subject: New Short ready: The Lamp That Remembered');
    const body = Buffer.from(
      message.split('\r\n\r\n')[1]!.replace(/\r\n/g, ''),
      'base64',
    ).toString();
    expect(body).toContain('https://studio.youtube.com/video/VID123/edit');
  });

  it('stops with the reason when the editor rejects the story', async () => {
    const httpRequest = async (r: IHttpRequestOptions): Promise<IHttpResponse> => {
      const ok = (body: unknown): IHttpResponse => ({
        statusCode: 200,
        statusMessage: 'OK',
        headers: {},
        body,
      });
      if (r.url.startsWith('https://trends.google.com/'))
        return ok('<rss><channel><item><title>X</title></item></channel></rss>');
      if (r.url.includes('youtube/v3/videos')) return ok({ items: [] });
      if (r.url.includes('sheets.googleapis.com')) return ok({}); // empty sheet
      if (r.url.endsWith('/v1beta/models')) return ok({ models: [] });
      const prompt = JSON.stringify((r.body as IDataObject).contents);
      const answer = prompt.includes('strict YouTube Shorts editor')
        ? {
            hook: 4,
            clarity: 8,
            originality: 5,
            safety: 9,
            approve: false,
            reason: 'The hook is weak',
          }
        : {
            trend_used: 'X',
            title: 'T',
            script: 'S',
            description: 'D',
            tags: ['a'],
            search_terms: ['b'],
          };
      return ok({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] });
    };
    const nodes = template.nodes.map(({ credentialTypes, ...n }) => ({
      ...n,
      ...(credentialTypes
        ? { credentials: Object.fromEntries(credentialTypes.map((t) => [t, { id: t, name: t }])) }
        : {}),
      parameters: {
        ...n.parameters,
        ...(n.type === 'flowforge.googleSheets' ? { documentId: 'SHEET-ID' } : {}),
      },
    })) as INode[];
    const run = await new WorkflowExecute(
      new Workflow({
        name: 't',
        nodes,
        connections: template.connections,
        settings: template.settings,
      }),
      createAdditionalData({
        executionId: 'rejected',
        mode: 'trigger',
        nodeTypes: createNodeTypes(),
        codeSandbox: new CodeSandbox({ timeoutMs: 3_000 }),
        httpRequest,
        credentials: {
          getDecrypted: async () => ({ apiKey: 'k' }),
          authenticateRequest: async (_n, _t, o) => o,
        },
      }),
    ).run({ startNode: 'Every day 18:00', triggerItems: [{ json: {} }] });
    expect(run.status).toBe('error');
    expect(run.data.resultData.error?.message).toBe('Rejected: The hook is weak');
    // An empty sheet still reaches the writer (Always Output Data).
    const past =
      run.data.resultData.runData['Aggregate Past Titles']?.[0]?.data?.main[0]?.[0]?.json;
    expect(past).toEqual({ past_titles: [] });
  });
});
