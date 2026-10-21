import { describe, expect, it } from 'vitest';
import type { IDataObject, IHttpRequestOptions, IHttpResponse } from '@flowforge/workflow';
import type { ICredentialsHelper } from '@flowforge/engine';
import { errorOf, runGraph, runNode } from './harness';
import { parseFeed } from '../src/nodes/RssFeedRead';
import { spreadsheetId } from '../src/nodes/GoogleSheets';
import { buildRawMessage } from '../src/nodes/Gmail';
import {
  extractJson,
  missingKeys,
  isModelUnavailable,
  pickGeminiModel,
  rankGeminiModels,
  schemaFromExample,
} from '../src/nodes/LlmChain';

type Route = (request: IHttpRequestOptions) => Partial<IHttpResponse> | undefined;

/** A fake internet: each request goes to the first route that answers it. */
function fakeHttp(...routes: Route[]) {
  const calls: IHttpRequestOptions[] = [];
  const httpRequest = async (request: IHttpRequestOptions): Promise<IHttpResponse> => {
    calls.push(request);
    for (const route of routes) {
      const answer = route(request);
      if (answer)
        return { statusCode: 200, statusMessage: 'OK', headers: {}, body: undefined, ...answer };
    }
    return {
      statusCode: 404,
      statusMessage: 'Not Found',
      headers: {},
      body: { error: 'no route' },
    };
  };
  return { calls, httpRequest };
}

/** Credentials helper that signs requests like the server does (bearer token / API key). */
const credentials: ICredentialsHelper = {
  getDecrypted: async (_node, type) =>
    type === 'googlePalmApi'
      ? { host: 'https://generativelanguage.googleapis.com', apiKey: 'gem-key' }
      : {},
  authenticateRequest: async (_node, type, options) => ({
    ...options,
    headers: {
      ...(options.headers ?? {}),
      ...(type === 'googlePalmApi'
        ? { 'x-goog-api-key': 'gem-key' }
        : { authorization: `Bearer token-${type}` }),
    },
  }),
};

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:ht="https://trends.google.com/trending/rss">
  <channel>
    <title>Daily Search Trends</title>
    <item>
      <title>Cricket &amp; World Cup</title>
      <ht:approx_traffic>500+</ht:approx_traffic>
      <link>https://trends.google.com/trending/rss?geo=IN</link>
      <pubDate>Tue, 21 Oct 2026 10:40:00 -0700</pubDate>
      <ht:news_item>
        <ht:news_item_title><![CDATA[India <b>wins</b>]]></ht:news_item_title>
      </ht:news_item>
      <ht:news_item>
        <ht:news_item_title>Second story</ht:news_item_title>
      </ht:news_item>
    </item>
    <item><title><![CDATA[Diwali 2026]]></title><description>Lights &lt;b&gt;everywhere&lt;/b&gt;</description></item>
  </channel>
</rss>`;

describe('RSS Read', () => {
  it('parses RSS items with CDATA, entities and nested elements', () => {
    const items = parseFeed(RSS);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: 'Cricket & World Cup',
      'ht:approx_traffic': '500+',
      link: 'https://trends.google.com/trending/rss?geo=IN',
      isoDate: '2026-10-21T17:40:00.000Z',
    });
    expect(items[0]!['ht:news_item']).toEqual([
      { 'ht:news_item_title': 'India <b>wins</b>' },
      { 'ht:news_item_title': 'Second story' },
    ]);
    expect(items[1]).toMatchObject({
      title: 'Diwali 2026',
      content: 'Lights <b>everywhere</b>',
      contentSnippet: 'Lights everywhere',
    });
  });

  it('parses Atom entries', () => {
    const items = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom">
      <entry><title type="text">Hello</title><id>urn:1</id>
        <link rel="alternate" href="https://example.com/1"/><updated>2026-01-02T03:04:05Z</updated>
        <author><name>Asha</name></author><summary>Short</summary></entry></feed>`);
    expect(items).toEqual([
      expect.objectContaining({
        title: 'Hello',
        guid: 'urn:1',
        link: 'https://example.com/1',
        isoDate: '2026-01-02T03:04:05.000Z',
        creator: 'Asha',
        content: 'Short',
      }),
    ]);
  });

  it('reads a feed URL into one item per entry', async () => {
    const http = fakeHttp((r) =>
      r.url.startsWith('https://trends.google.com/') ? { body: RSS } : undefined,
    );
    const { output } = await runNode(
      'flowforge.rssFeedRead',
      { url: 'https://trends.google.com/trending/rss?geo=IN' },
      [{}],
      {},
      { httpRequest: http.httpRequest },
    );
    expect(output()?.map((i) => i.title)).toEqual(['Cricket & World Cup', 'Diwali 2026']);
    expect(http.calls[0]!.responseType).toBe('text');
  });
});

describe('Google Sheets', () => {
  it('takes the ID from a spreadsheet link', () => {
    expect(spreadsheetId('https://docs.google.com/spreadsheets/d/1AbC-_9/edit#gid=0')).toBe(
      '1AbC-_9',
    );
    expect(spreadsheetId(' 1AbC ')).toBe('1AbC');
  });

  it('gets rows as items, keeping only the asked columns', async () => {
    const http = fakeHttp((r) =>
      r.url.includes('/values/')
        ? {
            body: {
              values: [['title', 'trend_used'], ['First', 'a'], [], ['Second', 'b']],
            },
          }
        : undefined,
    );
    const { output } = await runNode(
      'flowforge.googleSheets',
      { operation: 'read', documentId: 'SHEET', sheetName: 'Posted', returnColumns: 'title' },
      [{}],
      { credentials: { googleSheetsOAuth2Api: { id: 'c', name: 'Sheets' } } },
      { httpRequest: http.httpRequest, credentials },
    );
    expect(output()).toEqual([
      { row_number: 2, title: 'First' },
      { row_number: 4, title: 'Second' },
    ]);
    expect(http.calls[0]!.url).toBe(
      `https://sheets.googleapis.com/v4/spreadsheets/SHEET/values/${encodeURIComponent("'Posted'")}`,
    );
    expect(http.calls[0]!.headers?.authorization).toBe('Bearer token-googleSheetsOAuth2Api');
  });

  it('appends a row and writes the column names into an empty sheet', async () => {
    const http = fakeHttp((r) => {
      if (r.method === 'GET') return { body: { range: "'Posted'!A1:Z1" } }; // empty sheet
      if (r.method === 'PUT') return { body: { updatedCells: 4 } };
      if (r.url.endsWith(':append')) return { body: { updates: { updatedRows: 1 } } };
      return undefined;
    });
    const { output, run } = await runNode(
      'flowforge.googleSheets',
      {
        operation: 'append',
        documentId: 'SHEET',
        sheetName: 'Posted',
        columnsMode: 'defineBelow',
        fieldsUi: {
          values: [
            { column: 'title', value: '={{ $json.title }}' },
            { column: 'video_id', value: 'abc123' },
          ],
        },
      },
      [{ title: 'My story' }],
      { credentials: { googleSheetsOAuth2Api: { id: 'c', name: 'Sheets' } } },
      { httpRequest: http.httpRequest, credentials },
    );
    expect(errorOf(run)).toBeUndefined();
    expect(http.calls.map((c) => c.method)).toEqual(['GET', 'PUT', 'POST']);
    expect(http.calls[1]!.body).toEqual({ values: [['title', 'video_id']] });
    expect(http.calls[2]!.body).toEqual({ values: [['My story', 'abc123']] });
    expect(http.calls[2]!.qs).toMatchObject({ valueInputOption: 'USER_ENTERED' });
    expect(output()).toEqual([{ title: 'My story', video_id: 'abc123' }]);
  });

  it('appends in the order of the existing columns', async () => {
    const http = fakeHttp((r) => {
      if (r.method === 'GET') return { body: { values: [['date', 'title']] } };
      if (r.url.endsWith(':append')) return { body: {} };
      return undefined;
    });
    await runNode(
      'flowforge.googleSheets',
      {
        operation: 'append',
        documentId: 'S',
        sheetName: 'Posted',
        columnsMode: 'autoMapInputData',
      },
      [
        { title: 'A', date: '2026-10-21' },
        { title: 'B', date: '2026-10-22' },
      ],
      { credentials: { googleSheetsOAuth2Api: { id: 'c', name: 'Sheets' } } },
      { httpRequest: http.httpRequest, credentials },
    );
    expect(http.calls.map((c) => c.method)).toEqual(['GET', 'POST']);
    expect(http.calls[1]!.body).toEqual({
      values: [
        ['2026-10-21', 'A'],
        ['2026-10-22', 'B'],
      ],
    });
  });

  it('reports Google errors with their message', async () => {
    const http = fakeHttp(() => ({
      statusCode: 404,
      body: { error: { code: 404, message: 'Requested entity was not found.' } },
    }));
    const { run } = await runNode(
      'flowforge.googleSheets',
      { operation: 'read', documentId: 'WRONG', sheetName: 'Posted' },
      [{}],
      { credentials: { googleSheetsOAuth2Api: { id: 'c', name: 'Sheets' } } },
      { httpRequest: http.httpRequest, credentials },
    );
    expect(errorOf(run)?.message).toContain('Requested entity was not found.');
  });
});

describe('YouTube upload', () => {
  it('uploads the binary through a resumable session', async () => {
    const video = Buffer.from('fake mp4 bytes');
    const http = fakeHttp(
      (r) =>
        r.url.endsWith('final-1.mp4')
          ? { headers: { 'content-type': 'video/mp4' }, binary: video }
          : undefined,
      (r) =>
        r.url === 'https://www.googleapis.com/upload/youtube/v3/videos'
          ? { headers: { location: 'https://upload.example/session/1' } }
          : undefined,
      (r) =>
        r.url === 'https://upload.example/session/1'
          ? { body: { id: 'VIDEO123', status: { uploadStatus: 'uploaded' } } }
          : undefined,
    );
    const { output, run } = await runGraph(
      [
        { name: 'Trigger', type: 'flowforge.manualTrigger', parameters: {} },
        {
          name: 'File',
          type: 'flowforge.httpRequest',
          parameters: {
            method: 'GET',
            url: 'http://127.0.0.1:8080/tasks/t1/final-1.mp4',
            options: { responseFormat: 'binary' },
          },
        },
        {
          name: 'Upload',
          type: 'flowforge.youTube',
          credentials: { youTubeOAuth2Api: { id: 'yt', name: 'YouTube' } },
          parameters: {
            title: 'A short story',
            regionCode: 'IN',
            categoryId: '24',
            binaryPropertyName: 'data',
            options: {
              description: 'Story written and narrated with AI assistance.',
              tags: '={{ ["one", "two"] }}',
              privacyStatus: 'private',
              selfDeclaredMadeForKids: false,
            },
          },
        },
      ],
      [
        ['Trigger', 'File'],
        ['File', 'Upload'],
      ],
      {},
      { httpRequest: http.httpRequest, credentials },
    );
    expect(errorOf(run)).toBeUndefined();
    expect(output('Upload')).toEqual([{ id: 'VIDEO123', status: { uploadStatus: 'uploaded' } }]);
    const [, start, put] = http.calls;
    expect(start!.qs).toMatchObject({ uploadType: 'resumable', part: 'snippet,status' });
    expect(start!.headers).toMatchObject({
      authorization: 'Bearer token-youTubeOAuth2Api',
      'x-upload-content-type': 'video/mp4',
      'x-upload-content-length': String(video.length),
    });
    expect(start!.body).toEqual({
      snippet: {
        title: 'A short story',
        description: 'Story written and narrated with AI assistance.',
        categoryId: '24',
        tags: ['one', 'two'],
      },
      status: { privacyStatus: 'private', selfDeclaredMadeForKids: false },
    });
    expect(put!.method).toBe('PUT');
    expect(Buffer.from(put!.body as Uint8Array).toString()).toBe('fake mp4 bytes');
  });

  /** Download a fake MP4, then upload it with the given YouTube options. */
  async function upload(options: Record<string, string | boolean>) {
    const http = fakeHttp(
      (r) =>
        r.url.endsWith('final-1.mp4')
          ? { headers: { 'content-type': 'video/mp4' }, binary: Buffer.from('mp4') }
          : undefined,
      (r) =>
        r.url === 'https://www.googleapis.com/upload/youtube/v3/videos'
          ? { headers: { location: 'https://upload.example/session/2' } }
          : undefined,
      (r) => (r.url === 'https://upload.example/session/2' ? { body: { id: 'V2' } } : undefined),
    );
    const { run } = await runGraph(
      [
        { name: 'Trigger', type: 'flowforge.manualTrigger', parameters: {} },
        {
          name: 'File',
          type: 'flowforge.httpRequest',
          parameters: {
            method: 'GET',
            url: 'http://x/final-1.mp4',
            options: { responseFormat: 'binary' },
          },
        },
        {
          name: 'Upload',
          type: 'flowforge.youTube',
          credentials: { youTubeOAuth2Api: { id: 'yt', name: 'YouTube' } },
          parameters: { title: 'T', binaryPropertyName: 'data', options },
        },
      ],
      [
        ['Trigger', 'File'],
        ['File', 'Upload'],
      ],
      {},
      { httpRequest: http.httpRequest, credentials },
    );
    const start = http.calls.find((c) => c.url.includes('/upload/youtube/'));
    return { run, start };
  }

  it('schedules publishing and declares synthetic content', async () => {
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const { run, start } = await upload({
      privacyStatus: 'private',
      publishAt: at,
      containsSyntheticMedia: true,
      notifySubscribers: true,
    });
    expect(errorOf(run)).toBeUndefined();
    expect((start!.body as IDataObject).status).toEqual({
      privacyStatus: 'private',
      selfDeclaredMadeForKids: false,
      publishAt: at,
      containsSyntheticMedia: true,
    });
    expect(start!.qs).toMatchObject({ notifySubscribers: true });
  });

  it('refuses a publish time that YouTube would reject', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    for (const [options, message] of [
      [{ privacyStatus: 'public', publishAt: future }, 'Publish At needs Privacy Status "Private"'],
      [{ privacyStatus: 'private', publishAt: '2001-01-01T00:00:00Z' }, 'must be in the future'],
      [{ privacyStatus: 'private', publishAt: 'tonight' }, 'is not a valid Publish At time'],
    ] as const) {
      const { run, start } = await upload(options);
      expect(errorOf(run)?.message).toContain(message);
      expect(start).toBeUndefined(); // nothing was sent to YouTube
    }
  });

  it('fails clearly without a video file', async () => {
    const { run } = await runNode(
      'flowforge.youTube',
      { title: 'x', binaryPropertyName: 'data' },
      [{}],
      { credentials: { youTubeOAuth2Api: { id: 'yt', name: 'YouTube' } } },
      { credentials },
    );
    expect(errorOf(run)?.message).toContain('no binary field "data"');
  });
});

describe('Gmail', () => {
  it('builds a UTF-8 message', () => {
    const raw = buildRawMessage({
      to: ['me@example.com'],
      subject: 'New Short ready: नमस्ते',
      body: 'Hello\nhttps://studio.youtube.com/video/abc/edit',
      html: false,
    });
    const message = Buffer.from(raw, 'base64url').toString('utf8');
    expect(message).toContain('To: me@example.com\r\n');
    expect(message).toContain(
      `Subject: =?UTF-8?B?${Buffer.from('New Short ready: नमस्ते').toString('base64')}?=`,
    );
    const body = message.split('\r\n\r\n')[1]!.replace(/\r\n/g, '');
    expect(Buffer.from(body, 'base64').toString('utf8')).toContain('studio.youtube.com/video/abc');
  });

  it('keeps line breaks out of headers', () => {
    const message = Buffer.from(
      buildRawMessage({ to: ['a@b.c'], subject: 'Hi\r\nBcc: evil@x.y', body: '', html: false }),
      'base64url',
    ).toString();
    expect(message).not.toMatch(/\r\nBcc:/);
  });

  it('sends through the Gmail API', async () => {
    const http = fakeHttp((r) =>
      r.url.endsWith('/messages/send') ? { body: { id: 'm1', threadId: 't1' } } : undefined,
    );
    const { output } = await runNode(
      'flowforge.gmail',
      { sendTo: 'me@example.com', subject: 'Hi', message: 'Body' },
      [{}],
      { credentials: { gmailOAuth2: { id: 'g', name: 'Gmail' } } },
      { httpRequest: http.httpRequest, credentials },
    );
    expect(output()).toEqual([{ id: 'm1', threadId: 't1' }]);
    expect(typeof (http.calls[0]!.body as IDataObject).raw).toBe('string');
  });

  it('asks for the address when it is empty', async () => {
    const { run } = await runNode(
      'flowforge.gmail',
      { sendTo: '', subject: 'Hi', message: 'Body' },
      [{}],
      { credentials: { gmailOAuth2: { id: 'g', name: 'Gmail' } } },
      { credentials },
    );
    expect(errorOf(run)?.message).toContain('email address');
  });
});

describe('Basic LLM Chain', () => {
  const example = { title: '', score: 0, ok: true, tags: [''] };

  it('turns a JSON example into a Gemini response schema', () => {
    expect(schemaFromExample(example)).toEqual({
      type: 'OBJECT',
      properties: {
        title: { type: 'STRING' },
        score: { type: 'NUMBER' },
        ok: { type: 'BOOLEAN' },
        tags: { type: 'ARRAY', items: { type: 'STRING' } },
      },
      required: ['title', 'score', 'ok', 'tags'],
      propertyOrdering: ['title', 'score', 'ok', 'tags'],
    });
  });

  it('reads JSON in fences and finds missing keys', () => {
    expect(extractJson('Sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here: {"a":[1]} done')).toEqual({ a: [1] });
    expect(missingKeys(example, { title: 'x', ok: true })).toEqual(['score', 'tags']);
  });

  it('picks a model the key can use', () => {
    expect(pickGeminiModel(['gemini-2.0-flash', 'gemini-2.5-flash'], '')).toBe('gemini-2.5-flash');
    expect(pickGeminiModel(['gemini-2.0-flash'], 'gemini-9-ultra')).toBe('gemini-2.0-flash');
    expect(pickGeminiModel(['gemini-2.5-pro'], 'models/gemini-2.5-pro')).toBe('gemini-2.5-pro');
    expect(pickGeminiModel(['embedding-001', 'gemini-3.1-flash'], '')).toBe('gemini-3.1-flash');
    expect(pickGeminiModel(null, '')).toBe('gemini-flash-latest');
    expect(pickGeminiModel(null, 'gemini-3.8-flash')).toBe('gemini-3.8-flash');
  });

  it('ranks the newest stable Flash first, previews and other families after', () => {
    expect(
      rankGeminiModels(
        [
          'gemini-2.5-flash',
          'gemini-3.8-flash-preview-09-2026',
          'gemini-2.5-pro',
          'gemini-3.8-flash',
          'gemini-3.8-flash-lite',
          'text-embedding-004',
          'gemini-2.5-flash-preview-tts',
          'gemini-3.5-pro',
          'gemini-2.0-flash-001',
        ],
        '',
      ),
    ).toEqual([
      'gemini-3.8-flash',
      'gemini-2.5-flash',
      'gemini-2.0-flash-001',
      'gemini-3.8-flash-preview-09-2026',
      'gemini-3.5-pro',
      'gemini-2.5-pro',
      'gemini-3.8-flash-lite',
    ]);
    // The "-latest" alias follows Google's newest model, so it goes first.
    expect(rankGeminiModels(['gemini-3.8-flash', 'gemini-flash-latest'], '')[0]).toBe(
      'gemini-flash-latest',
    );
    // The model asked for comes first when the key has it.
    expect(rankGeminiModels(['gemini-3.8-flash', 'gemini-2.5-pro'], 'gemini-2.5-pro')[0]).toBe(
      'gemini-2.5-pro',
    );
  });

  it('tells a refused model apart from other errors', () => {
    const retired =
      'This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash';
    expect(isModelUnavailable(400, retired)).toBe(true);
    expect(isModelUnavailable(404, 'models/gemini-x is not found')).toBe(true);
    expect(isModelUnavailable(400, 'API key not valid. Please pass a valid API key.')).toBe(false);
    expect(isModelUnavailable(429, 'Quota exceeded')).toBe(false);
  });

  it('moves on to the model Google suggests when one is retired', async () => {
    const http = fakeHttp(
      (r) =>
        r.url.endsWith('/v1beta/models')
          ? {
              body: {
                models: ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-3.8-flash-lite'].map(
                  (name) => ({
                    name: `models/${name}`,
                    supportedGenerationMethods: ['generateContent'],
                  }),
                ),
              },
            }
          : undefined,
      (r) =>
        r.url.includes('/gemini-2.5-flash:')
          ? {
              statusCode: 400,
              body: {
                error: {
                  code: 400,
                  message:
                    'This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash for the latest features and improvements.',
                },
              },
            }
          : undefined,
      (r) =>
        r.url.includes('/gemini-3.8-flash:')
          ? { body: { candidates: [{ content: { parts: [{ text: 'Hi' }] } }] } }
          : undefined,
    );
    const { output, run } = await runNode(
      'flowforge.chainLlm',
      { text: 'Say hi' },
      [{}, {}],
      { credentials: { googlePalmApi: { id: 'k', name: 'Gemini' } } },
      { httpRequest: http.httpRequest, credentials },
    );
    expect(errorOf(run)).toBeUndefined();
    expect(output()).toEqual([{ text: 'Hi' }, { text: 'Hi' }]);
    // The retired model is tried once; afterwards the suggested one is used straight away.
    expect(
      http.calls
        .filter((c) => c.url.includes(':generateContent'))
        .map((c) => c.url.split('/').pop()),
    ).toEqual([
      'gemini-2.5-flash:generateContent',
      'gemini-3.8-flash:generateContent',
      'gemini-3.8-flash:generateContent',
    ]);
  });

  it('says which models were tried when none answers', async () => {
    const http = fakeHttp(
      (r) =>
        r.url.endsWith('/v1beta/models')
          ? { body: { models: [{ name: 'models/gemini-2.5-flash' }] } }
          : undefined,
      (r) =>
        r.url.includes(':generateContent')
          ? { statusCode: 404, body: { error: { message: 'Model not found' } } }
          : undefined,
    );
    const { run } = await runNode(
      'flowforge.chainLlm',
      { text: 'Go' },
      [{}],
      { credentials: { googlePalmApi: { id: 'k', name: 'Gemini' } } },
      { httpRequest: http.httpRequest, credentials },
    );
    expect(errorOf(run)?.message).toContain('none of the models this key can use answered');
    expect(errorOf(run)?.description).toContain('gemini-2.5-flash: Model not found');
  });

  function gemini(answers: string[]) {
    return fakeHttp(
      (r) =>
        r.url.endsWith('/v1beta/models')
          ? {
              body: {
                models: [
                  {
                    name: 'models/text-embedding-004',
                    supportedGenerationMethods: ['embedContent'],
                  },
                  {
                    name: 'models/gemini-2.0-flash',
                    supportedGenerationMethods: ['generateContent'],
                  },
                ],
              },
            }
          : undefined,
      (r) =>
        r.url.includes(':generateContent')
          ? {
              body: {
                candidates: [
                  { content: { parts: [{ text: answers.shift() ?? '' }] }, finishReason: 'STOP' },
                ],
              },
            }
          : undefined,
    );
  }

  it('returns structured output in "output"', async () => {
    const http = gemini([JSON.stringify({ title: 'T', score: 8, ok: true, tags: ['a'] })]);
    const { output, run } = await runNode(
      'flowforge.chainLlm',
      {
        model: 'gemini-1.0-pro',
        text: '=Trends: {{ $json.trends.join(", ") }}',
        hasOutputParser: true,
        jsonSchemaExample: JSON.stringify(example),
      },
      [{ trends: ['a', 'b'] }],
      { credentials: { googlePalmApi: { id: 'k', name: 'Gemini' } } },
      { httpRequest: http.httpRequest, credentials },
    );
    expect(errorOf(run)).toBeUndefined();
    expect(output()).toEqual([{ output: { title: 'T', score: 8, ok: true, tags: ['a'] } }]);
    const call = http.calls[1]!;
    // The model the key cannot use is replaced by one it can.
    expect(call.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
    );
    expect(call.headers?.['x-goog-api-key']).toBe('gem-key');
    const body = call.body as IDataObject;
    expect((body.contents as IDataObject[])[0]).toEqual({
      role: 'user',
      parts: [{ text: 'Trends: a, b' }],
    });
    expect(body.generationConfig).toMatchObject({ responseMimeType: 'application/json' });
  });

  it('asks once more when the answer does not fit', async () => {
    const http = gemini(['not json', '{"title":"T","score":1,"ok":false,"tags":[]}']);
    const { output } = await runNode(
      'flowforge.chainLlm',
      { text: 'Go', hasOutputParser: true, jsonSchemaExample: JSON.stringify(example) },
      [{}],
      { credentials: { googlePalmApi: { id: 'k', name: 'Gemini' } } },
      { httpRequest: http.httpRequest, credentials },
    );
    expect(output()).toEqual([{ output: { title: 'T', score: 1, ok: false, tags: [] } }]);
    expect(http.calls.filter((c) => c.url.includes(':generateContent'))).toHaveLength(2);
  });

  it('returns plain text in "text" without an output format', async () => {
    const http = gemini(['Hello there']);
    const { output } = await runNode(
      'flowforge.chainLlm',
      { text: 'Say hello' },
      [{}],
      { credentials: { googlePalmApi: { id: 'k', name: 'Gemini' } } },
      { httpRequest: http.httpRequest, credentials },
    );
    expect(output()).toEqual([{ text: 'Hello there' }]);
  });

  it('explains quota errors', async () => {
    const http = fakeHttp((r) =>
      r.url.includes(':generateContent')
        ? { statusCode: 429, body: { error: { message: 'Quota exceeded' } } }
        : undefined,
    );
    const { run } = await runNode(
      'flowforge.chainLlm',
      { text: 'Go' },
      [{}],
      { credentials: { googlePalmApi: { id: 'k', name: 'Gemini' } } },
      { httpRequest: http.httpRequest, credentials },
    );
    expect(errorOf(run)?.message).toContain('Quota exceeded');
  });
});

describe('HTTP Request with a predefined credential', () => {
  it('signs the request with the chosen app credential', async () => {
    const http = fakeHttp((r) =>
      r.url.startsWith('https://www.googleapis.com/youtube/v3/videos')
        ? { body: { items: [{ snippet: { title: 'Trending 1' } }] } }
        : undefined,
    );
    const { output } = await runNode(
      'flowforge.httpRequest',
      {
        method: 'GET',
        url: 'https://www.googleapis.com/youtube/v3/videos',
        authentication: 'predefinedCredentialType',
        nodeCredentialType: 'youTubeOAuth2Api',
        sendQuery: true,
        queryParameters: { parameters: [{ name: 'chart', value: 'mostPopular' }] },
      },
      [{}],
      { credentials: { youTubeOAuth2Api: { id: 'yt', name: 'YouTube' } } },
      { httpRequest: http.httpRequest, credentials },
    );
    expect(output()).toEqual([{ items: [{ snippet: { title: 'Trending 1' } }] }]);
    expect(http.calls[0]!.headers?.authorization).toBe('Bearer token-youTubeOAuth2Api');
    expect(http.calls[0]!.qs).toEqual({ chart: 'mostPopular' });
  });
});
