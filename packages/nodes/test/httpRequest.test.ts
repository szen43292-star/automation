import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorOf, runNode } from './harness';

let server: Server;
let base: string;
const received: Array<{ method?: string; url?: string; headers: IncomingMessage['headers']; body: string }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      const url = new URL(req.url!, 'http://x');
      if (url.pathname === '/orders') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify([{ id: 1, status: 'shipped' }, { id: 2, status: 'pending' }]));
      } else if (url.pathname === '/echo') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ method: req.method, query: Object.fromEntries(url.searchParams), body: body ? JSON.parse(body) : null }));
      } else if (url.pathname === '/text') {
        res.setHeader('content-type', 'text/plain');
        res.end('hello');
      } else if (url.pathname === '/file') {
        res.setHeader('content-type', 'image/png');
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      } else {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'no such order' }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('HTTP Request node', () => {
  it('splits JSON array responses into items', async () => {
    const { output, run } = await runNode('flowforge.httpRequest', { method: 'GET', url: `${base}/orders` });
    expect(run.status).toBe('success');
    expect(output()).toEqual([{ id: 1, status: 'shipped' }, { id: 2, status: 'pending' }]);
  });

  it('sends query, headers and JSON body built from expressions', async () => {
    const { output } = await runNode(
      'flowforge.httpRequest',
      {
        method: 'POST',
        url: `${base}/echo`,
        sendQuery: true,
        queryParameters: { parameters: [{ name: 'phone', value: '={{ $json.phone }}' }] },
        sendHeaders: true,
        headerParameters: { parameters: [{ name: 'X-Api-Key', value: 'secret' }] },
        sendBody: true,
        contentType: 'json',
        specifyBody: 'keypair',
        bodyParameters: { parameters: [{ name: 'name', value: '={{ $json.name }}' }] },
      },
      [{ phone: '+911234', name: 'Asha' }],
    );
    expect(output()).toEqual([{ method: 'POST', query: { phone: '+911234' }, body: { name: 'Asha' } }]);
    expect(received.at(-1)!.headers['x-api-key']).toBe('secret');
    expect(received.at(-1)!.headers['content-type']).toBe('application/json');
  });

  it('returns text and binary responses', async () => {
    const text = await runNode('flowforge.httpRequest', { url: `${base}/text` });
    expect(text.output()).toEqual([{ data: 'hello' }]);

    const file = await runNode('flowforge.httpRequest', { url: `${base}/file` });
    const binary = file.run.data.resultData.runData.Node![0]!.data!.main[0]![0]!.binary!.data!;
    expect(binary).toMatchObject({ mimeType: 'image/png', fileName: 'file', fileSize: 4 });
  });

  it('fails with a clear message on 404, unless neverError is set', async () => {
    const failed = await runNode('flowforge.httpRequest', { url: `${base}/orders/999` });
    expect(errorOf(failed.run)).toMatchObject({
      name: 'NodeApiError',
      message: 'The resource you are requesting could not be found',
      httpCode: 404,
      description: '{"error":"no such order"}',
    });

    const ok = await runNode('flowforge.httpRequest', {
      url: `${base}/orders/999`,
      options: { neverError: true, fullResponse: true },
    });
    expect(ok.output()![0]).toMatchObject({ statusCode: 404, body: { error: 'no such order' } });
  });

  it('explains network failures', async () => {
    // Grab a free port, then close it so nothing listens there.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const { run } = await runNode('flowforge.httpRequest', { url: `http://127.0.0.1:${port}/x` });
    expect(errorOf(run)?.message).toMatch(/refused the connection.*ECONNREFUSED/);
  });

  it('continues on fail with the error in the item', async () => {
    const { run, output } = await runNode(
      'flowforge.httpRequest',
      { url: `${base}/missing` },
      [{ id: 1 }],
      { onError: 'continueRegularOutput' },
    );
    expect(run.status).toBe('success');
    expect(output()).toEqual([{ id: 1, error: 'The resource you are requesting could not be found' }]);
  });
});
