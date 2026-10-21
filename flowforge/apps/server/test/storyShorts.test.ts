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

  const story = {
    trend_used: 'Diwali 2026',
    title: 'The Lamp That Remembered',
    script: 'A small lamp wakes up every Diwali. '.repeat(10).trim(),
    description:
      'A lamp with a memory.\nOne night only.\nStory written and narrated with AI assistance.\n#shorts #diwali #story',
    tags: ['story', 'diwali', 'shorts', 'lamp', 'india', 'festival', 'twist', 'ai'],
    search_terms: ['diwali lamp', 'night city', 'old house', 'child smiling', 'fireworks'],
  };
  const approve = {
    hook: 8,
    clarity: 9,
    originality: 8,
    safety: 10,
    approve: true,
    reason: 'Good',
  };
  const reject = (reason: string) => ({
    hook: 4,
    clarity: 8,
    originality: 5,
    safety: 9,
    approve: false,
    reason,
  });

  /**
   * Fake Google, Gemini and MoneyPrinterTurbo. The editor answers with `reviews` in order; the
   * writer always answers with `story` (numbered by attempt, so the drafts can be told apart).
   */
  function fakeWorld(reviews: IDataObject[], { emptySheet = false } = {}) {
    let progress = 40;
    let drafts = 0;
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
        return ok({ values: [['title', 'trend_used', 'video_id', 'date', 'attempt']] });
      if (url.includes('sheets.googleapis.com') && r.method === 'GET')
        return ok(emptySheet ? {} : { values: [['title'], ['Old story 1'], ['Old story 2']] });
      if (url.includes(':append')) return ok({ updates: { updatedRows: 1 } });
      if (url.endsWith('/v1beta/models'))
        return ok({
          models: [
            { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
          ],
        });
      if (url.includes(':generateContent')) {
        const prompt = JSON.stringify((r.body as IDataObject).contents);
        const answer = prompt.includes('strict YouTube Shorts editor')
          ? (reviews.shift() ?? approve)
          : { ...story, title: ++drafts === 1 ? story.title : `${story.title} ${drafts}` };
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
            videos: now === 100 ? ['/tasks/task-42/final-1.mp4'] : [],
          },
        });
      }
      if (url === 'http://127.0.0.1:8080/tasks/task-42/final-1.mp4')
        return ok(undefined, {
          headers: { 'content-type': 'video/mp4' },
          binary: Buffer.from('mp4 bytes'),
        });
      if (url === 'https://www.googleapis.com/upload/youtube/v3/videos')
        return ok(undefined, { headers: { location: 'https://upload.example/s/1' } });
      if (url === 'https://upload.example/s/1') return ok({ id: 'VID123' });
      if (url.endsWith('/messages/send')) return ok({ id: 'mail-1' });
      return {
        statusCode: 404,
        statusMessage: 'Not Found',
        headers: {},
        body: { error: `no fake for ${url}` },
      };
    };
    const prompts = () =>
      calls
        .filter((c) => c.url.includes(':generateContent'))
        .map((c) => JSON.parse(JSON.stringify((c.body as IDataObject).contents))[0].parts[0].text)
        .filter((text: string) => !text.includes('strict YouTube Shorts editor')) as string[];
    const mailBody = () => {
      const mail = calls.find((c) => c.url.endsWith('/messages/send'))!;
      const message = Buffer.from((mail.body as { raw: string }).raw, 'base64url').toString();
      const body = Buffer.from(
        message.split('\r\n\r\n')[1]!.replace(/\r\n/g, ''),
        'base64',
      ).toString();
      return { message, body };
    };
    const loggedRow = () =>
      (calls.find((c) => c.url.includes(':append'))!.body as { values: unknown[][] }).values[0]!;
    return { calls, httpRequest, prompts, mailBody, loggedRow };
  }

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

  /** Runs the template as if every credential were connected, resuming each Wait. */
  async function runTemplate(httpRequest: (r: IHttpRequestOptions) => Promise<IHttpResponse>) {
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
    let run: IRun = await execute({ startNode: 'Every day 18:00', triggerItems: [{ json: {} }] });
    let waits = 0;
    while (run.status === 'waiting') {
      waits++;
      expect(run.data.waitingNode).toBe('Wait 5 Minutes');
      expect(new Date(run.data.waitTill!).getTime() - Date.now()).toBeGreaterThan(4 * 60_000);
      run = await execute({ resumeFrom: run.data });
    }
    const runData = run.data.resultData.runData;
    const out = (name: string, i = -1) => runData[name]?.at(i)?.data?.main[0]?.map((x) => x.json);
    return { run, waits, runData, out };
  }

  it('makes, uploads, logs and announces a Short (with the wait loop)', async () => {
    const world = fakeWorld([approve]);
    const { run, waits, runData, out } = await runTemplate(world.httpRequest);
    expect(run.data.resultData.error).toBeUndefined();
    expect(run.status).toBe('success');
    expect(waits).toBe(2); // not ready at the first check, ready at the second

    expect(out('Aggregate Trends')?.[0]).toEqual({
      trends: ['Diwali 2026', 'Cricket final', 'Top song', 'Funny cat'],
    });
    expect(out('Aggregate Past Titles')?.[0]).toEqual({
      past_titles: ['Old story 1', 'Old story 2'],
    });
    expect(out('Set Attempt')?.[0]).toEqual({
      past_titles: ['Old story 1', 'Old story 2'],
      attempt: 1,
      feedback: '',
    });
    expect(runData['Write Story']).toHaveLength(1);
    expect(runData['Retry With Feedback']).toBeUndefined();
    expect(out('Count Tries')?.[0]).toMatchObject({ tries: 1 });

    const [prompt] = world.prompts();
    expect(prompt).toContain('Diwali 2026 | Cricket final | Top song | Funny cat');
    expect(prompt).toContain('Old story 1 | Old story 2');
    // First pass: no feedback section at all.
    expect(prompt!.endsWith('Output only the JSON.')).toBe(true);
    expect(prompt).not.toContain('previous draft');

    const make = world.calls.find((c) => c.url === 'http://127.0.0.1:8080/api/v1/videos')!;
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

    const upload = world.calls.find(
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

    const row = world.loggedRow();
    expect(row.slice(0, 3)).toEqual([story.title, story.trend_used, 'VID123']);
    expect(row[3]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(row[4]).toBe(1);

    const { message, body } = world.mailBody();
    expect(message).toContain('Subject: New Short ready: The Lamp That Remembered');
    expect(body).toContain('https://studio.youtube.com/video/VID123/edit');
    expect(body).toContain('Attempt: 1 of 2');
    expect(body).not.toContain('rejected');
  });

  it('gives the writer one more try with the editor feedback', async () => {
    const world = fakeWorld([reject('The hook is weak'), approve]);
    const { run, runData, out } = await runTemplate(world.httpRequest);
    expect(run.data.resultData.error).toBeUndefined();
    expect(run.status).toBe('success');

    expect(runData['Write Story']).toHaveLength(2);
    expect(runData['Quality Check']).toHaveLength(2);
    expect(out('Set Attempt')?.[0]).toEqual({
      past_titles: ['Old story 1', 'Old story 2'],
      attempt: 2,
      feedback: 'The hook is weak',
    });
    // Trends and past titles are not fetched again.
    for (const fetched of ['Google Trends RSS', 'YouTube Trending', 'Get Past Titles'])
      expect(runData[fetched], fetched).toHaveLength(1);
    expect(world.calls.filter((c) => c.url.startsWith('https://trends.google.com/'))).toHaveLength(
      1,
    );

    const [first, second] = world.prompts();
    expect(first).not.toContain('previous draft');
    expect(second).toContain('Diwali 2026 | Cricket final | Top song | Funny cat');
    expect(second).toContain('Old story 1 | Old story 2');
    expect(
      second!.endsWith(
        'Output only the JSON.\n\nYour previous draft was rejected by the editor for this reason: The hook is weak\nWrite a completely new story that fixes this problem. You may choose a different trend.',
      ),
    ).toBe(true);

    // The second draft is the one that is made, uploaded and logged.
    const make = world.calls.find((c) => c.url === 'http://127.0.0.1:8080/api/v1/videos')!;
    expect((make.body as IDataObject).video_subject).toBe(`${story.title} 2`);
    const row = world.loggedRow();
    expect(row[0]).toBe(`${story.title} 2`);
    expect(row[4]).toBe(2);
    const { body } = world.mailBody();
    expect(body).toContain('Attempt: 2 of 2 (the first story was rejected: The hook is weak)');
  });

  it('stops with "Rejected twice" when the second draft is rejected too', async () => {
    const world = fakeWorld([reject('The hook is weak'), reject('Still too slow')], {
      emptySheet: true,
    });
    const { run, runData } = await runTemplate(world.httpRequest);
    expect(run.status).toBe('error');
    expect(run.data.resultData.error?.message).toBe('Rejected twice: Still too slow');
    expect(runData['Write Story']).toHaveLength(2);
    expect(runData['Make Video']).toBeUndefined();
    // An empty sheet still reaches the writer (Always Output Data), on both passes.
    expect(runData['Aggregate Past Titles']?.[0]?.data?.main[0]?.[0]?.json).toEqual({
      past_titles: [],
    });
    expect(world.prompts().every((p) => p.includes('none yet'))).toBe(true);
  });
});
