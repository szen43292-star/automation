import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, endpoints } from '../src/lib/api';

const answer = (body: string, init: ResponseInit) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body, init)),
  );

afterEach(() => vi.unstubAllGlobals());

describe('api', () => {
  it('rejects a web page where data was expected (no server address set in the phone app)', async () => {
    answer('<!doctype html><div id="root"></div>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    const call = endpoints.approvals();
    await expect(call).rejects.toBeInstanceOf(ApiError);
    await expect(endpoints.approvals()).rejects.toThrow('is not an AutoForge server');
  });

  it('returns JSON answers and keeps error messages from the server', async () => {
    answer(JSON.stringify({ data: [] }), { status: 200 });
    await expect(endpoints.approvals()).resolves.toEqual({ data: [] });
    answer('Bad gateway', { status: 502 });
    await expect(endpoints.approvals()).rejects.toThrow('Bad gateway');
  });
});
