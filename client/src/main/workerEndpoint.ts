import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Where the worker is. The old app takes the endpoint from Settings at pairing time and validates it with
 * the same rule (https origin, no credentials, no path, query or fragment; see `endpointSchema` in
 * `src/main/delegation/pairingStore.ts`, which is module-private there). The thin client reads it from a
 * public configuration instead: `CALLIE_WORKER_ENDPOINT` while developing or testing (never when packaged),
 * otherwise `client/worker-endpoint.json` under userData holding `{ "endpoint": "https://..." }`. The
 * value is a public identifier; the only secret this Mac holds is the device token. Plain http is admitted
 * for the loopback interface alone, which is where the Playwright stub worker listens.
 */
export const WORKER_ENDPOINT_FILE = 'worker-endpoint.json';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

const isWorkerOrigin = (value: string): boolean => {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  const plainLoopback = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  return (url.protocol === 'https:' || plainLoopback)
    && url.username === '' && url.password === '' && url.search === '' && url.hash === '' && url.pathname === '/';
};

export const workerEndpointSchema = z.string().transform((value) => value.trim()).refine(isWorkerOrigin).transform((value) => new URL(value).origin);
const endpointFileSchema = z.strictObject({ endpoint: workerEndpointSchema });

export type EndpointResolution =
  | { endpoint: string; source: 'environment' | 'file' }
  | { endpoint: null; source: 'none'; problem: 'unconfigured' | 'invalid' };

const none = (problem: 'unconfigured' | 'invalid'): EndpointResolution => ({ endpoint: null, source: 'none', problem });

export function resolveWorkerEndpoint(input: { env: Record<string, string | undefined>; clientDirectory: string; isPackaged: boolean }): EndpointResolution {
  if (!input.isPackaged) {
    const raw = input.env.CALLIE_WORKER_ENDPOINT;
    if (raw !== undefined && raw.trim() !== '') {
      const parsed = workerEndpointSchema.safeParse(raw);
      return parsed.success ? { endpoint: parsed.data, source: 'environment' } : none('invalid');
    }
  }
  let text: string;
  try {
    text = readFileSync(join(input.clientDirectory, WORKER_ENDPOINT_FILE), 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' ? none('unconfigured') : none('invalid');
  }
  try {
    return { endpoint: endpointFileSchema.parse(JSON.parse(text)).endpoint, source: 'file' };
  } catch {
    return none('invalid');
  }
}
