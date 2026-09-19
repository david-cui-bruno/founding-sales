import { describe, expect, it, vi } from 'vitest';
import { MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_MS, requestWorker } from './workerClient';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const networkError = () => Promise.reject(new TypeError('fetch failed'));
const endpoint = 'https://worker.example.test';

describe('requestWorker', () => {
  it('uses a 15 second budget by default', () => {
    expect(REQUEST_TIMEOUT_MS).toBe(15_000);
  });

  it('sends the bearer token, a JSON body, no-store and refuses redirects', async () => {
    const fetch = vi.fn().mockResolvedValue(json(200, { ok: true }));
    const reply = await requestWorker({ endpoint, path: '/v1/commands', method: 'POST', token: 'a'.repeat(43), body: { kind: 'x' } }, { fetch });
    expect(reply).toEqual({ kind: 'reply', status: 200, body: { ok: true }, attempts: 1 });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${endpoint}/v1/commands`);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.cache).toBe('no-store');
    expect(init.body).toBe(JSON.stringify({ kind: 'x' }));
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${'a'.repeat(43)}`);
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('appends the query and sends no body or bearer for an unauthenticated GET', async () => {
    const fetch = vi.fn().mockResolvedValue(json(200, {}));
    await requestWorker({ endpoint, path: '/v1/diagnostics', method: 'GET', query: { kind: 'command' } }, { fetch });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${endpoint}/v1/diagnostics?kind=command`);
    expect(init.body).toBeUndefined();
    expect(new Headers(init.headers).has('authorization')).toBe(false);
  });

  it('retries exactly once on a network error and then succeeds', async () => {
    const fetch = vi.fn().mockImplementationOnce(networkError).mockResolvedValueOnce(json(200, { second: true }));
    const reply = await requestWorker({ endpoint, path: '/v1/diagnostics', method: 'GET' }, { fetch });
    expect(reply).toEqual({ kind: 'reply', status: 200, body: { second: true }, attempts: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('gives up after the second network failure', async () => {
    const fetch = vi.fn().mockImplementation(networkError);
    const reply = await requestWorker({ endpoint, path: '/v1/diagnostics', method: 'GET' }, { fetch });
    expect(reply).toEqual({ kind: 'failed', reason: 'network', attempts: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reports a timeout as timeout after one retry', async () => {
    const fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const reply = await requestWorker({ endpoint, path: '/v1/diagnostics', method: 'GET' }, { fetch, timeoutMs: 20 });
    expect(reply).toEqual({ kind: 'failed', reason: 'timeout', attempts: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 404, 429, 500, 503])('never retries an HTTP %i response', async (status) => {
    const fetch = vi.fn().mockResolvedValue(json(status, { error: 'x' }));
    const reply = await requestWorker({ endpoint, path: '/v1/diagnostics', method: 'GET' }, { fetch });
    expect(reply).toEqual({ kind: 'reply', status, body: { error: 'x' }, attempts: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('carries the status of a non-JSON answer with no body and no retry', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('<html>', { status: 502 }));
    const reply = await requestWorker({ endpoint, path: '/v1/diagnostics', method: 'GET' }, { fetch });
    expect(reply).toEqual({ kind: 'reply', status: 502, body: undefined, attempts: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses an oversized answer without reading it', async () => {
    const fetch = vi.fn().mockResolvedValue(json(200, {}, { 'content-length': String(MAX_RESPONSE_BYTES + 1) }));
    const reply = await requestWorker({ endpoint, path: '/v1/diagnostics', method: 'GET' }, { fetch });
    expect(reply).toEqual({ kind: 'failed', reason: 'response_too_large', attempts: 1 });
  });

  it('treats an empty body as an absent body', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const reply = await requestWorker({ endpoint, path: '/v1/diagnostics', method: 'GET' }, { fetch });
    expect(reply).toEqual({ kind: 'reply', status: 204, body: undefined, attempts: 1 });
  });
});
