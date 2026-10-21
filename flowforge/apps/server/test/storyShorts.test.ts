import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Workflow,
  type IDataObject,
  type IHttpRequestOptions,
  type IHttpResponse,
  type IApprovalRequest,
  type INode,
  type IRun,
} from '@flowforge/workflow';
import {
  CodeSandbox,
  WorkflowExecute,
  createAdditionalData,
  type IApprovalService,
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
   * `videoStatus` turns the status sent with the upload into what YouTube reports afterwards
   * (by default: still processing, with the requested privacy and publish time).
   */
  function fakeWorld(
    reviews: IDataObject[],
    {
      emptySheet = false,
      videoStatus = (sent: IDataObject): IDataObject | null => ({
        uploadStatus: 'uploaded',
        privacyStatus: sent.privacyStatus,
        ...(sent.publishAt ? { publishAt: sent.publishAt } : {}),
      }),
    } = {},
  ) {
    let progress = 40;
    let drafts = 0;
    let sentStatus: IDataObject = {};
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
      if (url === 'https://www.googleapis.com/youtube/v3/videos' && r.qs?.chart)
        return ok({
          items: [{ snippet: { title: 'Top song' } }, { snippet: { title: 'Funny cat' } }],
        });
      if (url === 'https://www.googleapis.com/youtube/v3/videos' && r.qs?.id === 'VID123') {
        const status = videoStatus(sentStatus);
        return ok({ items: status ? [{ id: 'VID123', status }] : [] });
      }
      if (url.includes('sheets.googleapis.com') && r.method === 'GET' && url.includes('1%3A1'))
        return ok({ values: [['title', 'trend_used', 'video_id', 'date', 'attempt']] });
      if (url.includes('sheets.googleapis.com') && r.method === 'GET')
        return ok(emptySheet ? {} : { values: [['title'], ['Old story 1'], ['Old story 2']] });
      // New column names (publish_mode, publish_time) are added to the header row.
      if (url.includes('sheets.googleapis.com') && r.method === 'PUT')
        return ok({ updatedCells: 2 });
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
      if (url === 'https://www.googleapis.com/upload/youtube/v3/videos') {
        sentStatus = (r.body as IDataObject).status as IDataObject;
        return ok(undefined, { headers: { location: 'https://upload.example/s/1' } });
      }
      if (url === 'https://upload.example/s/1') return ok({ id: 'VID123', status: sentStatus });
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
    const mails = () => calls.filter((c) => c.url.endsWith('/messages/send'));
    const upload = () =>
      calls.find((c) => c.url === 'https://www.googleapis.com/upload/youtube/v3/videos')!;
    const decode = (mail: IHttpRequestOptions) => {
      const message = Buffer.from((mail.body as { raw: string }).raw, 'base64url').toString();
      const body = Buffer.from(
        message.split('\r\n\r\n')[1]!.replace(/\r\n/g, ''),
        'base64',
      ).toString();
      const subject = message.match(/^Subject: (.*)$/m)![1]!;
      return { message, subject, body };
    };
    const isApprovalMail = (mail: IHttpRequestOptions) =>
      decode(mail).subject.startsWith('Approve your new Short');
    /** The approval request email. */
    const approvalMail = () => {
      const found = mails().filter(isApprovalMail);
      expect(found).toHaveLength(1);
      return decode(found[0]!);
    };
    /** The one email after the upload (Notify Me or Upload Problem). */
    const mailBody = () => {
      const after = mails().filter((m) => !isApprovalMail(m));
      expect(after).toHaveLength(1);
      return decode(after[0]!);
    };
    const loggedRow = () =>
      (calls.find((c) => c.url.includes(':append'))!.body as { values: unknown[][] }).values[0]!;
    return { calls, httpRequest, prompts, mails, upload, mailBody, approvalMail, loggedRow };
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

  /**
   * Runs the template as if every credential were connected, resuming each Wait. `answer` is what
   * you do on the approval page ("timeout": nothing within 24 hours).
   */
  async function runTemplate(
    httpRequest: (r: IHttpRequestOptions) => Promise<IHttpResponse>,
    settings: Record<string, string> = {},
    answer: 'approve' | 'reject' | 'timeout' = 'approve',
  ) {
    const saved = new Map<string, { data: Buffer; mimeType: string }>();
    const approvals: IApprovalService = {
      create: async (owner, request) => {
        expect(owner.executionId).toBe('shorts');
        const id = `approval-${saved.size + 1}`;
        saved.set(id, { data: request.media!.data, mimeType: request.media!.mimeType });
        approvalRequests.push(request);
        return {
          id,
          url: `https://quiet-lamp-1234.trycloudflare.com/approve/${id}`,
          localUrl: `http://localhost:5678/approve/${id}`,
          expiresAt: request.expiresAt.toISOString(),
        };
      },
      media: async (id) => saved.get(id)!,
    };
    const approvalRequests: IApprovalRequest[] = [];
    const nodes = template.nodes.map(({ credentialTypes, ...n }) => ({
      ...n,
      ...(credentialTypes
        ? { credentials: Object.fromEntries(credentialTypes.map((t) => [t, { id: t, name: t }])) }
        : {}),
      parameters: {
        ...n.parameters,
        ...(n.type === 'flowforge.googleSheets' ? { documentId: 'SHEET-ID' } : {}),
        ...(n.type === 'flowforge.gmail' ? { sendTo: 'me@example.com' } : {}),
        ...(n.name === 'Publish Settings'
          ? {
              assignments: {
                assignments: (
                  n.parameters.assignments as {
                    assignments: Array<{ name: string; value: string }>;
                  }
                ).assignments.map((a) => ({ ...a, value: settings[a.name] ?? a.value })),
              },
            }
          : {}),
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
          approvals,
        }),
      ).run(options);
    let run: IRun = await execute({ startNode: 'Every day 18:00', triggerItems: [{ json: {} }] });
    let waits = 0;
    while (run.status === 'waiting') {
      waits++;
      const waited = new Date(run.data.waitTill!).getTime() - Date.now();
      if (run.data.waitingNode === 'Wait for Approval') {
        // Waits up to 24 hours for the answer from the approval page.
        expect(waited).toBeGreaterThan(23 * 3_600_000);
        run = await execute(
          answer === 'timeout'
            ? { resumeFrom: run.data }
            : {
                resumeFrom: run.data,
                resumeData: [
                  { json: { approved: answer === 'approve', approval_id: 'approval-1' } },
                ],
              },
        );
        continue;
      }
      if (run.data.waitingNode === 'Wait 5 Minutes') expect(waited).toBeGreaterThan(4 * 60_000);
      else {
        expect(run.data.waitingNode).toBe('Wait for Processing');
        expect(waited).toBeGreaterThan(60_000);
      }
      run = await execute({ resumeFrom: run.data });
    }
    const runData = run.data.resultData.runData;
    const out = (name: string, i = -1) => runData[name]?.at(i)?.data?.main[0]?.map((x) => x.json);
    return { run, waits, runData, out, approvalRequests };
  }

  it('makes, uploads, logs and announces a Short (with the wait loop)', async () => {
    const world = fakeWorld([approve]);
    const { run, waits, runData, out, approvalRequests } = await runTemplate(world.httpRequest);
    expect(run.data.resultData.error).toBeUndefined();
    expect(run.status).toBe('success');
    // Not ready at the first check, ready at the second; your approval; YouTube's processing.
    expect(waits).toBe(4);

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

    const upload = world.upload();
    expect(upload.body).toEqual({
      snippet: {
        title: story.title,
        description: story.description,
        categoryId: '24',
        tags: story.tags,
      },
      status: {
        privacyStatus: 'private',
        selfDeclaredMadeForKids: false,
        publishAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T14:30:00Z$/),
        containsSyntheticMedia: true,
      },
    });
    // Scheduled (the default): 20:00 India time = 14:30 UTC, today or - when that has passed - tomorrow.
    const publishAt = new Date((upload.body as { status: { publishAt: string } }).status.publishAt);
    expect(publishAt.getTime()).toBeGreaterThan(Date.now());
    expect(publishAt.getTime() - Date.now()).toBeLessThanOrEqual(24 * 3_600_000);
    expect(upload.qs).toMatchObject({ notifySubscribers: true });
    expect(out('Decide Publishing')?.[0]).toEqual({
      requested_mode: 'scheduled',
      mode: 'scheduled',
      review_reason: '',
    });

    const status = world.calls.find((c) => c.qs?.id === 'VID123')!;
    expect(status.qs).toMatchObject({ part: 'status,processingDetails' });
    expect(out('Read Status')?.[0]).toMatchObject({ upload_status: 'uploaded', problem: '' });

    const row = world.loggedRow();
    expect(row.slice(0, 3)).toEqual([story.title, story.trend_used, 'VID123']);
    expect(row[3]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(row[4]).toBe(1);
    expect(row[5]).toBe('scheduled');
    expect(row[6]).toMatch(/^\d{4}-\d{2}-\d{2} 20:00$/);

    const { subject, body } = world.mailBody();
    expect(subject).toMatch(/^Going live (tomorrow )?at 8 PM: The Lamp That Remembered$/);
    expect(body).toMatch(/is scheduled to go public (tomorrow )?at 8 PM\./);
    expect(body).toContain('https://studio.youtube.com/video/VID123/edit');
    expect(body).toContain('To stop it, open the link and set it to Private before 8 PM.');
    expect(body).toContain('Attempt: 1 of 2');
    expect(body).toContain('Quality check: hook 8, clarity 9, originality 8, safety 10');
    expect(body).not.toContain('rejected');

    // You were asked first: the video, with the link that opens it on your phone.
    expect(approvalRequests).toHaveLength(1);
    expect(approvalRequests[0]).toMatchObject({ title: story.title });
    expect(approvalRequests[0]!.media!.data.toString()).toBe('mp4 bytes');
    expect(approvalRequests[0]!.description).toContain('Quality check: hook 8, clarity 9');
    expect(approvalRequests[0]!.description).toContain('If you approve: goes public at 20:00');
    const asked = world.approvalMail();
    expect(asked.subject).toBe(`Approve your new Short: ${story.title}`);
    expect(asked.body).toContain('https://quiet-lamp-1234.trycloudflare.com/approve/approval-1');
    // The approved video (loaded back from the approval) is what gets uploaded.
    expect(out('Load Approved Video')?.[0]).toMatchObject({ approval_id: 'approval-1' });
    const putVideo = world.calls.find((c) => c.url === 'https://upload.example/s/1')!;
    expect(Buffer.from(putVideo.body as Uint8Array).toString()).toBe('mp4 bytes');
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
    expect(row[5]).toBe('private (review)');
    expect(row[6]).toBe('');
    // Safety gate: a second try is never published automatically.
    const sent = world.upload();
    expect((sent.body as IDataObject).status).toEqual({
      privacyStatus: 'private',
      selfDeclaredMadeForKids: false,
      containsSyntheticMedia: true,
    });
    expect(sent.qs).toMatchObject({ notifySubscribers: false });
    const { subject, body } = world.mailBody();
    expect(subject).toBe(`New Short ready: ${story.title} 2`);
    expect(body).toContain(
      'is uploaded as Private.\nIt was kept Private for manual review because the story needed a second try.',
    );
    expect(body).toContain('Review it and publish it in YouTube Studio:');
    expect(body).not.toContain('To stop it');
    expect(body).toContain('Attempt: 2 of 2 (the first story was rejected: The hook is weak)');
  });

  it('keeps it private for review when a score is below 8', async () => {
    const world = fakeWorld([{ ...approve, hook: 7 }]);
    const { run, out } = await runTemplate(world.httpRequest);
    expect(run.status).toBe('success');
    expect(out('Decide Publishing')?.[0]).toEqual({
      requested_mode: 'scheduled',
      mode: 'private',
      review_reason: 'scores below 8: hook 7',
    });
    expect(((world.upload().body as IDataObject).status as IDataObject).publishAt).toBeUndefined();
    const { subject, body } = world.mailBody();
    expect(subject).toBe(`New Short ready: ${story.title}`);
    expect(body).toContain('kept Private for manual review because scores below 8: hook 7.');
    expect(body).toContain('Quality check: hook 7, clarity 9, originality 8, safety 10');
  });

  it('publishes right away in "public" mode', async () => {
    const world = fakeWorld([approve]);
    const { run } = await runTemplate(world.httpRequest, { publish_mode: 'public' });
    expect(run.status).toBe('success');
    const sent = world.upload();
    expect(((sent.body as IDataObject).status as IDataObject).privacyStatus).toBe('public');
    expect(((sent.body as IDataObject).status as IDataObject).publishAt).toBeUndefined();
    expect(sent.qs).toMatchObject({ notifySubscribers: true });
    expect(world.loggedRow()[5]).toBe('public');
    const { subject, body } = world.mailBody();
    expect(subject).toBe(`Now live: ${story.title}`);
    expect(body).toContain('is live: https://youtube.com/shorts/VID123');
  });

  it('keeps the old behaviour in "private" mode, and treats unknown modes as private', async () => {
    for (const [mode, reason] of [
      ['private', ''],
      ['sheduled', 'publish_mode "sheduled" is not scheduled, public or private'],
    ]) {
      const world = fakeWorld([approve]);
      const { run, out } = await runTemplate(world.httpRequest, { publish_mode: mode! });
      expect(run.status).toBe('success');
      expect(out('Decide Publishing')?.[0]).toMatchObject({
        mode: 'private',
        review_reason: reason,
      });
      expect(((world.upload().body as IDataObject).status as IDataObject).privacyStatus).toBe(
        'private',
      );
      expect(world.upload().qs).toMatchObject({ notifySubscribers: false });
      expect(world.mailBody().subject).toBe(`New Short ready: ${story.title}`);
    }
  });

  it('sends "Upload problem" when YouTube locks the video as private', async () => {
    // An unaudited API project: YouTube keeps the upload private and drops the publish time.
    const world = fakeWorld([approve], {
      videoStatus: () => ({ uploadStatus: 'processed', privacyStatus: 'private' }),
    });
    const { run, runData } = await runTemplate(world.httpRequest);
    expect(run.status).toBe('success');
    expect(runData['Notify Me']).toBeUndefined();
    expect(world.loggedRow()[0]).toBe(story.title); // still logged
    const { subject, body } = world.mailBody();
    expect(subject).toBe(`Upload problem: ${story.title}`);
    expect(body).toContain(
      'Problem: Locked as private: YouTube dropped the scheduled publish time, so it will not go public.',
    );
    expect(body).toContain('- Upload status: processed');
    expect(body).toContain('https://studio.youtube.com/video/VID123/edit');
    expect(body).toContain('https://support.google.com/youtube/contact/yt_api_form');
  });

  it('sends "Upload problem" when YouTube rejects the video', async () => {
    const world = fakeWorld([approve], {
      videoStatus: () => ({
        uploadStatus: 'rejected',
        rejectionReason: 'duplicate',
        privacyStatus: 'private',
      }),
    });
    const { run } = await runTemplate(world.httpRequest);
    expect(run.status).toBe('success');
    const { subject, body } = world.mailBody();
    expect(subject).toBe(`Upload problem: ${story.title}`);
    expect(body).toContain('Problem: YouTube rejected the video: duplicate');
    expect(body).toContain('- Rejection reason: duplicate');
    expect(body).not.toContain('yt_api_form');
  });

  it('uploads nothing when you reject the video or do not answer', async () => {
    for (const answer of ['reject', 'timeout'] as const) {
      const world = fakeWorld([approve]);
      const { run, runData } = await runTemplate(world.httpRequest, {}, answer);
      expect(run.status, answer).toBe('success');
      expect(runData['Not Approved'], answer).toHaveLength(1);
      expect(runData['YouTube Upload'], answer).toBeUndefined();
      expect(
        world.calls.some((c) => c.url.includes('/upload/youtube/')),
        answer,
      ).toBe(false);
      expect(
        world.calls.some((c) => c.url.includes(':append')),
        answer,
      ).toBe(false);
      // Only the approval request was emailed.
      expect(world.mails(), answer).toHaveLength(1);
      expect(world.approvalMail().subject).toContain('Approve your new Short');
    }
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
