import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { httpRequest, requestTimeout } from '../src/http';

describe('httpRequest', () => {
  it('keeps timeouts in the range timers accept', () => {
    expect(requestTimeout(undefined)).toBe(300_000);
    expect(requestTimeout(0)).toBe(300_000);
    expect(requestTimeout(-5)).toBe(300_000);
    expect(requestTimeout('abc')).toBe(300_000);
    expect(requestTimeout(120_000)).toBe(120_000);
    // 100 billion ms (about 3 years) used to fail with "The value of "delay" is out of range".
    expect(requestTimeout(100_000_000_000)).toBe(2_147_483_647);
  });

  it('accepts a huge timeout instead of failing', async () => {
    const server = createServer((socket) =>
      socket.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok'),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    try {
      const response = await httpRequest({
        url: `http://127.0.0.1:${port}/`,
        timeout: 100_000_000_000,
        responseType: 'text',
      });
      expect(response.statusCode).toBe(200);
    } finally {
      server.close();
    }
  });

  it('says when nothing is running at a local address', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(httpRequest({ url: `http://127.0.0.1:${port}/api/v1/videos` })).rejects.toThrow(
      `Nothing is running at this address on this computer - start the program that should answer here (ECONNREFUSED 127.0.0.1:${port})`,
    );
  });
});
