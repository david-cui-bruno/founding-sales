/**
 * One bounded HTTP exchange with the worker. Fifteen seconds per attempt, one retry when the request
 * itself fails (a network error or the timeout), never a retry once the worker has answered, whatever the
 * status. The caller decides what a status means; this module only carries bytes and refuses to read an
 * answer larger than the worker's own page cap.
 */
export const REQUEST_TIMEOUT_MS = 15_000;
export const MAX_RESPONSE_BYTES = 1_048_576;

export type WorkerRequest = {
  endpoint: string;
  path: string;
  method: 'GET' | 'POST';
  token?: string;
  body?: unknown;
  query?: Record<string, string>;
};

export type WorkerFailure = 'timeout' | 'network' | 'response_too_large';
/** An answer carries its status; `body` is undefined when the worker sent nothing or something that is not JSON. */
export type WorkerReply =
  | { kind: 'reply'; status: number; body: unknown; attempts: number }
  | { kind: 'failed'; reason: WorkerFailure; attempts: number };

type Dependencies = { fetch?: typeof globalThis.fetch; timeoutMs?: number };

class ResponseTooLarge extends Error {}

const isTimeout = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'TimeoutError';

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    void response.body?.cancel().catch((): undefined => undefined);
    throw new ResponseTooLarge();
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch((): undefined => undefined);
        throw new ResponseTooLarge();
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export async function requestWorker(request: WorkerRequest, dependencies: Dependencies = {}): Promise<WorkerReply> {
  const http = dependencies.fetch ?? globalThis.fetch;
  const timeoutMs = dependencies.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const url = new URL(request.path, request.endpoint);
  for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (request.token !== undefined) headers.authorization = `Bearer ${request.token}`;
  if (request.body !== undefined) headers['content-type'] = 'application/json';
  const init: RequestInit = {
    method: request.method,
    headers,
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    redirect: 'error',
    cache: 'no-store',
  };

  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await http(url.toString(), { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (attempt >= 2) return { kind: 'failed', reason: isTimeout(error) ? 'timeout' : 'network', attempts: attempt };
      continue;
    }
    let text: string;
    try {
      text = await readBounded(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      if (error instanceof ResponseTooLarge) return { kind: 'failed', reason: 'response_too_large', attempts: attempt };
      text = '';
    }
    let body: unknown;
    try {
      body = text.length === 0 ? undefined : (JSON.parse(text) as unknown);
    } catch {
      body = undefined;
    }
    return { kind: 'reply', status: response.status, body, attempts: attempt };
  }
}
