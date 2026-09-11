import { fail, ProviderError, safeError } from './providerValidation';

export type JsonReply = { status: number; data: unknown };

/** Calls fetch synchronously in this stack. Exactly one invocation, no redirects
 * or retries. Bounds headers+body time even for a port ignoring AbortSignal.
 */
export function requestJsonOnce(input: {
  fetch: typeof globalThis.fetch; url: string; init: RequestInit;
  signal: AbortSignal; timeoutMs?: number; maxBytes?: number;
}): Promise<JsonReply> {
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  const timeoutMs = input.timeoutMs ?? 30_000;
  const maxBytes = input.maxBytes ?? 128 * 1024;
  return new Promise((resolve, reject) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    const finish = (error: unknown, result?: JsonReply) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error) { controller.abort(); reject(safeError(error, 'network_uncertain')); }
      else resolve(result!);
    };
    const abort = () => finish(new ProviderError('network_uncertain'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    timer = setTimeout(abort, timeoutMs);
    try {
      const pending = input.fetch(input.url, { ...input.init, redirect: 'error', signal });
      Promise.resolve(pending).then(async (response) => {
        if (finished) { void response.body?.cancel().catch((): undefined => undefined); return; }
        if (response.status < 200 || response.status >= 300) {
          void response.body?.cancel().catch((): undefined => undefined);
          finish(null, { status: response.status, data: null });
          return;
        }
        try { finish(null, { status: response.status, data: await boundedJson(response, maxBytes, signal) }); }
        catch (error) { finish(error); }
      }, finish).catch(finish);
    } catch (error) { finish(error); }
  });
}

async function boundedJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    void response.body?.cancel().catch((): undefined => undefined);
    fail('provider_response_invalid');
  }
  if (response.body === null) fail('provider_response_invalid');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch((): undefined => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      if (signal.aborted) fail('network_uncertain');
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) fail('provider_response_invalid');
      chunks.push(chunk.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { fail('provider_response_invalid'); }
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
  }
}
