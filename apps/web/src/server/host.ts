import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { readBody } from '../../../api/src/bootstrap/requestBody.ts';
import { MAX_REQUEST_BYTES } from '../../../api/src/limits.ts';
import { BROWSER_PATHS, browserApiPathAllowed } from '../shared/browserContract.ts';
import { createBrowserHandler } from './browser.ts';
import type { BrowserHostOptions, BrowserStaticAsset } from './hostContract.ts';
import { BROWSER_SECURITY_HEADERS, BROWSER_REFUSAL_BODY, BROWSER_JSON_CONTENT_TYPE } from './httpPolicy.ts';
class Refusal extends Error {
  constructor(readonly status: number) { super('browser_request_refused'); }
}

function pathOf(target: string): { path: string; query: URLSearchParams } {
  if (target.length > 32768) throw new Refusal(400);
  const separator = target.indexOf('?');
  const path = separator < 0 ? target : target.slice(0, separator);
  const query = separator < 0 ? '' : target.slice(separator + 1);
  // Validate the unnormalized target. URL parsing alone silently removes dot segments.
  if (!target.startsWith('/') || target.startsWith('//') || /[\\#\s]/u.test(target) || [...target].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    || !/^\/[a-zA-Z0-9/_.-]*$/u.test(path) || path.includes('//')
    || path.split('/').some(segment => segment === '.' || segment === '..')
    || query.length > 16384) throw new Refusal(400);
  return { path, query: new URLSearchParams(query) };
}

function headersOf(request: IncomingMessage, host: string): Record<string, string> {
  const headers = Object.create(null) as Record<string, string>;
  // Do not let Node's duplicate-header joining select an ambiguous authority.
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]!.toLowerCase();
    if (Object.hasOwn(headers, name)) throw new Refusal(400);
    headers[name] = request.rawHeaders[index + 1]!;
  }
  if (headers['host'] !== host) throw new Refusal(400);
  if (headers['content-encoding'] !== undefined || headers['expect'] !== undefined) throw new Refusal(415);
  const length = headers['content-length'];
  if (length !== undefined && !/^(?:0|[1-9][0-9]*)$/u.test(length)) throw new Refusal(400);
  if (length !== undefined && (!Number.isSafeInteger(Number(length)) || Number(length) > MAX_REQUEST_BYTES)) throw new Refusal(413);
  if (headers['transfer-encoding'] !== undefined && (headers['transfer-encoding'] !== 'chunked' || length !== undefined)) throw new Refusal(400);
  return headers;
}

async function bodyOf(request: IncomingMessage, post: boolean, timeoutMs: number): Promise<unknown> {
  let disconnected = false;
  let rejectUpload: (error: Refusal) => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => { rejectUpload = reject; });
  const abort = (): void => { disconnected = true; rejectUpload(new Refusal(400)); };
  const close = (): void => { if (!request.complete) abort(); };
  request.once('aborted', abort);
  request.once('error', abort);
  request.once('close', close);
  const timer = setTimeout(() => rejectUpload(new Refusal(408)), timeoutMs);
  timer.unref();
  try {
    // Leaving iteration must not destroy the socket before a fixed refusal is sent.
    const outcome = await Promise.race([readBody(request.iterator({ destroyOnReturn: false }), post ? MAX_REQUEST_BYTES : 0), stopped]);
    if (disconnected || request.aborted) throw new Refusal(400);
    if (!outcome.accepted) throw new Refusal(outcome.code === 'payload_too_large' && post ? 413 : 400);
    return post ? outcome.body : undefined;
  } finally {
    clearTimeout(timer);
    request.off('aborted', abort);
    request.off('error', abort);
    request.off('close', close);
  }
}

function send(response: ServerResponse, status: number, body: Buffer, head: boolean, headers: Record<string, string | readonly string[]> = {}): void {
  if (response.destroyed) return;
  response.statusCode = status;
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, typeof value === 'string' ? value : [...value]);
  for (const [name, value] of Object.entries(BROWSER_SECURITY_HEADERS)) response.setHeader(name, value);
  response.setHeader('content-length', body.byteLength);
  response.end(head ? undefined : body);
}

/** HTTP transport only. The existing browser adapter retains all identity authority. */
export function createBrowserHostHandler(options: BrowserHostOptions): RequestListener {
  const timeoutMs = options.bodyTimeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) throw new Error('Invalid browser host configuration');
  const browser = createBrowserHandler(options.runtime);
  const host = new URL(options.runtime.origin).host;
  const assets = new Map<string, BrowserStaticAsset>();
  for (const [path, asset] of options.assets) {
    if (pathOf(path).path !== path || path === '/browser' || path.startsWith('/browser/')
      || !['text/html; charset=utf-8', 'text/javascript; charset=utf-8', 'text/css; charset=utf-8'].includes(asset.contentType)) throw new Error('Invalid browser host configuration');
    assets.set(path, { body: Buffer.from(asset.body), contentType: asset.contentType });
  }
  return (request, response) => {
    void (async () => {
      try {
        const { path, query } = pathOf(request.url ?? '');
        const headers = headersOf(request, host);
        const method = request.method ?? '';
        const isBrowser = path === '/browser' || path.startsWith('/browser/');
        const asset = assets.get(path);
        if (!isBrowser && asset === undefined) throw new Refusal(404);
        if (!isBrowser && method !== 'GET' && method !== 'HEAD') throw new Refusal(405);
        if (isBrowser) {
          if (method !== 'GET' && method !== 'POST') throw new Refusal(405);
          const api = path.startsWith(`${BROWSER_PATHS.apiPrefix}/`) ? path.slice(BROWSER_PATHS.apiPrefix.length) : null;
          if (api !== null ? !browserApiPathAllowed(method, api) : !Object.values(BROWSER_PATHS).some(value => value === path) || path === BROWSER_PATHS.apiPrefix) throw new Refusal(404);
          if (api === null && method !== (path === BROWSER_PATHS.session || path === BROWSER_PATHS.callback ? 'GET' : 'POST')) throw new Refusal(405);
        }
        const post = method === 'POST';
        if (isBrowser) {
          // Cheap transport-origin checks precede uploads. The adapter independently
          // retains these checks plus cookie, CSRF, revision and identity authority.
          if (path === BROWSER_PATHS.callback && method === 'GET') {
            if ((headers['sec-fetch-mode'] !== undefined && headers['sec-fetch-mode'] !== 'navigate')
              || (headers['sec-fetch-dest'] !== undefined && headers['sec-fetch-dest'] !== 'document')) throw new Refusal(403);
          } else if ((headers['sec-fetch-site'] !== undefined && headers['sec-fetch-site'] !== 'same-origin')
            || (headers['origin'] !== undefined && headers['origin'] !== options.runtime.origin)
            || (post && headers['origin'] !== options.runtime.origin)) throw new Refusal(403);
        }
        if (!post && (headers['transfer-encoding'] !== undefined || Number(headers['content-length'] ?? 0) !== 0)) throw new Refusal(400);
        if (post && !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(headers['content-type'] ?? '')) throw new Refusal(415);
        const body = await bodyOf(request, post, timeoutMs);
        if (response.destroyed || request.aborted) return;
        if (asset !== undefined) {
          send(response, 200, Buffer.from(asset.body), method === 'HEAD', { 'content-type': asset.contentType });
          return;
        }
        const result = await browser({ method, path, query, headers, body });
        if (result === null) throw new Refusal(404);
        send(response, result.status, Buffer.from(JSON.stringify(result.body)), false, { ...result.headers, 'content-type': BROWSER_JSON_CONTENT_TYPE });
      } catch (error) {
        // Close refused uploads instead of retaining unread bytes on a reusable socket.
        response.setHeader('connection', 'close');
        send(response, error instanceof Refusal ? error.status : 503, Buffer.from(BROWSER_REFUSAL_BODY), request.method === 'HEAD', { 'content-type': BROWSER_JSON_CONTENT_TYPE });
      }
    })();
  };
}
