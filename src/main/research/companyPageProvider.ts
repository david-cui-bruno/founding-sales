import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request, type RequestOptions } from 'node:https';
import { accountEvidenceBatchSchema, type AccountClaim, type AccountSource } from '../../shared/contracts/accountContract';
import { companySourcePolicy, publicResearchAddress, type FetchedReceiptPolicy } from './companySourcePolicy';
import { researchLimitsSchema, type CompanyPagePort } from './companyResearchTypes';
export type PageHttp = (input: { url: string; address: string; maxBytes: number; signal: AbortSignal }) => Promise<Response>;
/** TLS keeps the original hostname/SNI. DNS is pinned to the prechecked address,
 * no proxy/cookies/session/automatic redirects or connection pool reuse. */
export function createPinnedPageHttp(requester: typeof request = request): PageHttp {
  return ({ url, address, maxBytes, signal }) => new Promise((resolve, reject) => {
  const requestOptions: RequestOptions & { autoSelectFamily: boolean } = { method: 'GET', agent: false, family: 4, autoSelectFamily: false, signal, headers: { Accept: 'text/html,text/plain', 'User-Agent': 'CompanyResearch/1.0' },
    lookup: (_host, _options, callback) => callback(null, address, 4) };
  const req = requester(url, requestOptions, res => {
    const chunks: Buffer[] = []; let size = 0;
    res.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) { res.destroy(); req.destroy(new Error('Research bytes exceeded')); return; }
      chunks.push(chunk);
    });
    res.on('error', reject);
    res.on('end', () => {
      try {
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(',') : value);
        const status = res.statusCode ?? 502;
        resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
      } catch { reject(new Error('Research HTTP response invalid')); }
    });
  });
  req.on('error', reject); req.end();
  });
}
async function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('Research cancelled or timed out'));
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
async function readBytes(response: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  if (!response.body) throw new Error('Research empty page');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await bounded(reader.read(), signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) throw new Error('Research bytes exceeded');
      chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } finally { void reader.cancel().catch((): undefined => undefined); reader.releaseLock(); }
}
/** Conservative deterministic extraction. Advertisements remain advertised facts,
 * never prospect-stated pain or execution routes. Unsupported knowledge stays unknown. */
function extract(excerpt: string, sourceId: string): AccountClaim[] {
  const text = excerpt.replace(/<script\b[^>]*>[\s\S]*?(?:<\/script>|$)/gi, '').replace(/<style\b[^>]*>[\s\S]*?(?:<\/style>|$)/gi, '')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(/<[^>]*>/g, '\n');
  const claims: AccountClaim[] = [];
  for (const match of text.matchAll(/(?:^|\n)\s*We (manage|own) ([0-9][0-9,]*) (residential )?(units|buildings|properties)\./g)) {
    const count = Number(match[2].replace(/,/g, ''));
    if (!Number.isSafeInteger(count)) continue;
    claims.push({ key: 'portfolio', kind: 'fact', value: { count, measure: match[4] as 'units' | 'buildings' | 'properties', scope: match[1] === 'manage' ? 'managed' : 'owned' }, evidenceIds: [sourceId] });
    if (match[3]) claims.push({ key: 'residential_scope', kind: 'fact', value: 'Company advertises a residential portfolio.', evidenceIds: [sourceId] });
  }
  if (/(?:^|\n)\s*24\/7 emergency maintenance\./.test(text)) claims.push({ key: 'maintenance_workflow', kind: 'fact', value: 'Company advertises 24/7 emergency maintenance.', evidenceIds: [sourceId] });
  return claims;
}
export function createCompanyPageProvider(options: { receipts: FetchedReceiptPolicy; clock: { now(): string };
  /** Trusted operator/source-policy decision. Omission denies all fetching. */
  permitted?: (url: string, accountId: string) => boolean;
  /** Trusted persistence adapter only, invoked after protected fetch and proof issuance. */
  onFetched?: (source: Readonly<AccountSource>, accountId: string) => void | Promise<void>;
  resolve?: (hostname: string) => Promise<string[]>; http?: PageHttp; timeoutMs?: number }): CompanyPagePort {
  const resolve = options.resolve ?? (async hostname => (await lookup(hostname, { all: true, family: 4 })).map(r => r.address));
  const http = options.http ?? createPinnedPageHttp();
  return { async research(snapshot, rawLimits, callerSignal) {
    const limits = researchLimitsSchema.parse(rawLimits);
    callerSignal.throwIfAborted();
    if (!snapshot.account.domain || !options.permitted) throw new Error('Research permitted source required');
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(options.timeoutMs ?? 30000)]);
    const sources = []; const claims: AccountClaim[] = []; let bytes = 0; let requests = 0;
    const urls = ['/', '/services', '/team', '/careers'].slice(0, limits.maxPages).map(path => `https://${snapshot.account.domain}${path}`);
    for (let url of urls) {
      if (requests >= limits.maxPages) break;
      for (;;) {
        signal.throwIfAborted();
        if (companySourcePolicy(url) !== 'candidate') throw new Error('Research blocked redirect or source');
        const parsed = new URL(url);
        if (![snapshot.account.domain, `www.${snapshot.account.domain}`].includes(parsed.hostname) || !options.permitted(url, snapshot.account.id)) throw new Error('Research permitted source required');
        if (requests >= limits.maxPages) throw new Error('Research page budget exceeded');
        if (bytes >= limits.maxBytes) throw new Error('Research bytes exceeded');
        const addresses = await bounded(resolve(parsed.hostname), signal);
        if (!addresses.length || addresses.some(address => !publicResearchAddress(address))) throw new Error('Research private address rejected');
        signal.throwIfAborted(); requests++;
        const response = await bounded(http({ url, address: addresses[0], maxBytes: limits.maxBytes - bytes, signal }), signal);
        const body = await readBytes(response, limits.maxBytes - bytes, signal); bytes += body.byteLength;
        if (response.status >= 300 && response.status < 400) {
          void response.body?.cancel().catch((): undefined => undefined);
          const location = response.headers.get('location');
          if (!location) throw new Error('Research redirect invalid');
          url = new URL(location, url).href; continue;
        }
        if (response.status === 404) { void response.body?.cancel().catch((): undefined => undefined); break; }
        if (response.status !== 200 || !/^(text\/html|text\/plain)(;|$)/i.test(response.headers.get('content-type') ?? '')
          || (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity')) {
          void response.body?.cancel().catch((): undefined => undefined); throw new Error('Research page response rejected');
        }
        signal.throwIfAborted();
        const excerpt = body.toString('utf8').slice(0, 12000);
        if (!excerpt.trim()) throw new Error('Research empty page');
        const source = options.receipts.recordFetched({ accountId: snapshot.account.id, url, fetchedAt: options.clock.now(), body, excerpt });
        if (options.onFetched) await bounded(Promise.resolve(options.onFetched(Object.freeze({ ...source }), snapshot.account.id)), signal);
        signal.throwIfAborted();
        sources.push(source); claims.push(...extract(excerpt, source.id)); break;
      }
    }
    if (!sources.length) throw new Error('Research no permitted pages');
    return accountEvidenceBatchSchema.parse({ commandId: randomUUID(), accountId: snapshot.account.id, expectedVersion: snapshot.account.version, sources, claims, routes: [] });
  } };
}
