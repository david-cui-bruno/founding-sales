import { z } from 'zod';
import { parseCompanyPageText } from './companyPageText';
import { validateCompanyFacts, type CompanyFactExtractor, type PageFactInput } from './companyFactExtraction';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request, type RequestOptions } from 'node:https';
import { accountEvidenceBatchSchema, type AccountClaim, type AccountSource, type AccountEvidenceBatch } from '../../shared/contracts/accountContract';
import { companySourcePolicy, publicResearchAddress, type FetchedReceiptPolicy } from './companySourcePolicy';
import { researchLimitsSchema, type CompanyPagePort } from './companyResearchTypes';
import { CompanyResearchError, annotateCompanyResearchError, type CompanyResearchStage } from './companyResearchFailure';
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
      if (size > maxBytes) { res.destroy(); req.destroy(new CompanyResearchError('page_http', 'bytes_exceeded')); return; }
      chunks.push(chunk);
    });
    res.on('error', reject);
    res.on('end', () => {
      try {
        const headers = new Headers();
        for (const [key, value] of Object.entries(res.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(',') : value);
        const status = res.statusCode ?? 502;
        resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
      } catch { reject(new CompanyResearchError('page_http', 'http_response_invalid')); }
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
  if (!response.body) throw new CompanyResearchError('page_response', 'empty_page');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await bounded(reader.read(), signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) throw new CompanyResearchError('page_response', 'bytes_exceeded');
      chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } finally { void reader.cancel().catch((): undefined => undefined); reader.releaseLock(); }
}
/** Tokenize only complete markup. A truncated tag or quoted attribute stays
 * markup through end-of-input; it can never become supporting text. This is a
 * conservative lexical extractor, not a browser/CSS visibility renderer. */
function htmlText(excerpt: string): { text: string; linkedInTargets: string[] } {
  let text = ''; let position = 0;
  const linkedInTargets: string[] = []; let businessPublication = true;
  while (position < excerpt.length) {
    if (excerpt[position] !== '<') { text += excerpt[position]; position++; continue; }
    if (excerpt.startsWith('<!--', position)) {
      const end = excerpt.indexOf('-->', position + 4);
      if (end < 0) break;
      position = end + 3; continue;
    }
    let end = position + 1; let quote: string | null = null;
    for (; end < excerpt.length; end++) {
      const char = excerpt[end];
      if (quote !== null) { if (char === quote) quote = null; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (end === excerpt.length) break;
    const markup = excerpt.slice(position, end + 1);
    const tag = /^<\s*(\/?)\s*([a-z][a-z0-9:-]*)/i.exec(markup);
    const name = tag?.[2]?.toLowerCase();
    position = end + 1;
    // Conservative publication subset: no testimonial/article attribution, even
    // after their closing tag. Unsupported markup remains unknown, not a person.
    if (name && ['article', 'blockquote', 'plaintext', 'noscript'].includes(name)) businessPublication = false;
    if (businessPublication && name === 'a' && !tag?.[1]) {
      // Only an actual sole, quoted href attribute and a complete plain-text
      // business-labelled anchor qualify. Never mine arbitrary attributes or URLs.
      const href = /^<a[\t\n\f\r ]+href[\t\n\f\r ]*=[\t\n\f\r ]*(["'])(https:\/\/www\.linkedin\.com\/in\/[A-Za-z0-9_-]+\/?)\1[\t\n\f\r ]*>$/i.exec(markup)?.[2];
      const label = /^([^<>]{1,160})<\/a[\t\n\f\r ]*>/i.exec(excerpt.slice(position))?.[1]?.trim();
      if (href && /^https:\/\/www\.linkedin\.com\/in\/[A-Za-z0-9_-]+\/?$/.test(href) && label && /^(?:Business(?: team)?|Company|Our team|Team) LinkedIn (?:profile|contact)$/i.test(label)) {
        linkedInTargets.push(href.replace(/\/$/, ''));
      }
    }
    // Inline published contact text remains one line; attributes are still discarded.
    if (!name || !['a', 'span', 'b', 'strong', 'i', 'em', 'small'].includes(name)) text += '\n';
    // Template contents are not rendered; conservatively stop rather than guess
    // nested template state. Raw-text containers cannot contribute account facts.
    if (!tag?.[1] && name === 'template') break;
    if (!tag?.[1] && name && ['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes'].includes(name)) {
      // No whitespace after '</'; only HTML ASCII whitespace may follow the name.
      const closing = new RegExp(`</${name}[\\t\\n\\f\\r ]*>`, 'ig');
      closing.lastIndex = position;
      const match = closing.exec(excerpt);
      if (!match) break;
      position = closing.lastIndex;
    }
  }
  return { text, linkedInTargets };
}
function normalizedPublishedPhone(raw: string): string | null {
  const parentheses = raw.replace(/[^()]/g, '');
  const value = raw.replace(/[ ()-]/g, '');
  return (parentheses === '' || parentheses === '()') && /^\+[1-9]\d{6,14}$/.test(value) ? value : null;
}
function normalizedPublishedEmail(raw: string): string | null {
  const value = raw.toLowerCase();
  return value.length <= 254 && z.email().safeParse(value).success ? value : null;
}
/** Internal-only negative evidence; it never grants authority or widens the batch schema. */
function withheldContactTargets(lines: readonly string[]): string[] {
  const targets = new Set<string>();
  for (const line of lines) {
    if (!/emergency|tenant|after.hours/i.test(line)) continue;
    for (const raw of line.match(/\+[1-9][0-9 ()-]{6,40}/g) ?? []) {
      const value = normalizedPublishedPhone(raw.trim());
      if (value) targets.add(`phone:${value}`);
    }
    for (const raw of line.match(/[^\s<>()",;:]+@[^\s<>()",;:]+/g) ?? []) {
      // A sentence-ending period is not part of the published mailbox.
      const value = normalizedPublishedEmail(raw.replace(/[.!?]+$/, ''));
      if (value) targets.add(`email:${value}`);
    }
  }
  return [...targets];
}
/** Conservative deterministic extraction. Advertisements remain advertised facts,
 * never prospect-stated pain or execution routes. Unsupported knowledge stays unknown. */
function extract(excerpt: string, sourceId: string, accountId: string, linkedInPublicationAllowed: boolean): Pick<AccountEvidenceBatch, 'claims' | 'routes'> & { withheldTargets: string[]; qualifiedPhoneLines: string[] } {
  const { text, linkedInTargets } = htmlText(excerpt);
  const claims: AccountClaim[] = [];
  for (const match of text.matchAll(/(?:^|\n)\s*We (manage|own) ([0-9][0-9,]*) (residential )?(units|buildings|properties)\./g)) {
    const countText = match[2];
    if (countText === undefined) continue;
    const count = Number(countText.replace(/,/g, ''));
    if (!Number.isSafeInteger(count)) continue;
    claims.push({ key: 'portfolio', kind: 'fact', value: { count, measure: match[4] as 'units' | 'buildings' | 'properties', scope: match[1] === 'manage' ? 'managed' : 'owned' }, evidenceIds: [sourceId] });
    if (match[3]) claims.push({ key: 'residential_scope', kind: 'fact', value: 'Company advertises a residential portfolio.', evidenceIds: [sourceId] });
  }
  if (/(?:^|\n)\s*24\/7 emergency maintenance\./.test(text)) claims.push({ key: 'maintenance_workflow', kind: 'fact', value: 'Company advertises 24/7 emergency maintenance.', evidenceIds: [sourceId] });
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^We are a (?:regional|local)(?: residential)? property management company\.$/i.test(line)
      || /^Operating footprint:[ \t]+[A-Za-z][A-Za-z0-9 ,.'()-]{0,199}$/.test(line)) {
      claims.push({ key: 'operating_footprint', kind: 'fact', value: line, evidenceIds: [sourceId] });
    }
  }
  const routes: AccountEvidenceBatch['routes'] = [];
  const withheldTargets = withheldContactTargets(lines);
  const add = (channel: 'phone' | 'email' | 'linkedin', value: string) => {
    // An explicit emergency/tenant qualifier for this target is never promoted
    // to a prospecting route, even if another line also uses a business label.
    if (withheldTargets.includes(`${channel}:${value}`)) return;
    if (routes.some(route => route.channel === channel && route.value === value)) return;
    routes.push({ id: randomUUID(), accountId, personId: null, channel, value, purpose: 'business',
      verification: 'published', evidenceIds: [sourceId] });
  };
  for (const line of lines) {
    const phone = /^(?:Business switchboard|Business phone|Main office phone):[ \t]*(\+[1-9][0-9 ()-]{6,40})$/i.exec(line)?.[1];
    if (phone) {
      const value = normalizedPublishedPhone(phone);
      if (value) add('phone', value);
    }
    const email = /^(?:Team|Business) email:[ \t]*([^\s]+)$/i.exec(line)?.[1]?.toLowerCase();
    const mailbox = email ? normalizedPublishedEmail(email) : null;
    if (mailbox) add('email', mailbox);
  }
  if (linkedInPublicationAllowed) for (const target of linkedInTargets) add('linkedin', target);
  return { claims, routes, withheldTargets, qualifiedPhoneLines: lines.filter(line => /emergency|tenant|after.hours/i.test(line)) };
}
export function createCompanyPageProvider(options: { receipts: FetchedReceiptPolicy; clock: { now(): string };
  /** Trusted operator/source-policy decision. Omission denies all fetching. */
  permitted?: (url: string, accountId: string) => boolean;
  /** Trusted persistence adapter only, invoked after protected fetch and proof issuance. */
  onFetched?: (source: Readonly<AccountSource>, accountId: string) => void | Promise<void>;
  /** Explicit approved entry URLs for opt-in known-company mode; never discovered or guessed. */
  sourceUrls?: readonly string[]; extractFacts?: CompanyFactExtractor;
  resolve?: (hostname: string) => Promise<string[]>; http?: PageHttp; timeoutMs?: number }): CompanyPagePort {
  const sourceUrls = [...new Set(options.sourceUrls ?? [])];
  const resolve = options.resolve ?? (async hostname => (await lookup(hostname, { all: true, family: 4 })).map(r => r.address));
  const http = options.http ?? createPinnedPageHttp();
  return { async research(snapshot, rawLimits, callerSignal) {
    let stage: CompanyResearchStage = 'source_policy';
    let signal: AbortSignal | undefined;
    try {
    const limits = researchLimitsSchema.parse(rawLimits);
    callerSignal.throwIfAborted();
    if (!snapshot.account.domain || !options.permitted) throw new CompanyResearchError(stage, 'source_required');
    const known = limits.knownCompanyExtraction;
    if (known && (!options.extractFacts || !sourceUrls.length)) throw new CompanyResearchError(stage, 'extraction_unavailable');
    const modelSources: PageFactInput['sources'] = [];
    signal = AbortSignal.any([callerSignal, AbortSignal.timeout(options.timeoutMs ?? 30000)]);
    const sources = []; const claims: AccountClaim[] = []; const routes: AccountEvidenceBatch['routes'] = [];
    const withheldTargets = new Set<string>(); const qualifiedPhoneLines: string[] = []; let bytes = 0; let requests = 0;
    const urls = known ? sourceUrls.filter(url => companySourcePolicy(url) === 'candidate'
      && new URL(url).hostname === snapshot.account.domain).slice(0, limits.maxPages)
      : ['/', '/services', '/team', '/careers'].slice(0, limits.maxPages).map(path => `https://${snapshot.account.domain}${path}`);
    if (!urls.length) throw new CompanyResearchError(stage, 'source_required');
    for (let url of urls) {
      if (requests >= limits.maxPages) break;
      for (;;) {
        stage = 'source_policy';
        signal.throwIfAborted();
        if (companySourcePolicy(url) !== 'candidate') throw new CompanyResearchError(stage, 'source_blocked');
        const parsed = new URL(url);
        if (!(known ? parsed.hostname === snapshot.account.domain : [snapshot.account.domain, `www.${snapshot.account.domain}`].includes(parsed.hostname)) || !options.permitted(url, snapshot.account.id)) throw new CompanyResearchError(stage, 'source_required');
        if (requests >= limits.maxPages) throw new CompanyResearchError(stage, 'page_budget');
        if (bytes >= limits.maxBytes) throw new CompanyResearchError(stage, 'bytes_exceeded');
        stage = 'dns';
        const addresses = await bounded(resolve(parsed.hostname), signal);
        const address = addresses[0];
        if (address === undefined || addresses.some(address => !publicResearchAddress(address))) throw new CompanyResearchError(stage, 'private_address');
        signal.throwIfAborted(); requests++;
        stage = 'page_http';
        const response = await bounded(http({ url, address, maxBytes: limits.maxBytes - bytes, signal }), signal);
        stage = 'page_response';
        const body = await readBytes(response, limits.maxBytes - bytes, signal); bytes += body.byteLength;
        if (response.status >= 300 && response.status < 400) {
          void response.body?.cancel().catch((): undefined => undefined);
          const location = response.headers.get('location');
          if (!location) throw new CompanyResearchError(stage, 'redirect_invalid');
          url = new URL(location, url).href; continue;
        }
        if (response.status === 404) { void response.body?.cancel().catch((): undefined => undefined); break; }
        if (response.status !== 200 || !/^(text\/html|text\/plain)(;|$)/i.test(response.headers.get('content-type') ?? '')
          || (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity')) {
          void response.body?.cancel().catch((): undefined => undefined); throw new CompanyResearchError(stage, 'page_response_rejected', response.status);
        }
        signal.throwIfAborted();
        stage = 'page_parse';
        const parsedPage = known ? parseCompanyPageText(body, response.headers.get('content-type') ?? '') : null;
        const excerpt = parsedPage?.text ?? body.toString('utf8').slice(0, 12000);
        if (!excerpt.trim()) throw new CompanyResearchError(stage, 'empty_page');
        stage = 'source_receipt';
        const source = known ? options.receipts.recordParsedFetched({ accountId: snapshot.account.id, url, fetchedAt: options.clock.now(), body, contentType: response.headers.get('content-type') ?? '' })
          : options.receipts.recordFetched({ accountId: snapshot.account.id, url, fetchedAt: options.clock.now(), body, excerpt });
        if (options.onFetched) await bounded(Promise.resolve(options.onFetched(Object.freeze({ ...source }), snapshot.account.id)), signal);
        signal.throwIfAborted();
        if (parsedPage) {
          sources.push(source); modelSources.push({ sourceId: source.id, blocks: parsedPage.blocks });
          break;
        }
        stage = 'page_parse';
        const extracted = extract(excerpt, source.id, snapshot.account.id,
          /^text\/html(?:;|$)/i.test(response.headers.get('content-type') ?? '')
          && /^\/(?:team\/?|contact\/?)?$/.test(new URL(url).pathname));
        sources.push(source); claims.push(...extracted.claims);
        qualifiedPhoneLines.push(...extracted.qualifiedPhoneLines);
        for (const target of extracted.withheldTargets) withheldTargets.add(target);
        for (const route of extracted.routes) {
          const previous = routes.find(existing => existing.channel === route.channel && existing.value === route.value);
          if (previous) previous.evidenceIds.push(source.id);
          else routes.push(route);
        }
        break;
      }
    }
    if (!sources.length) throw new CompanyResearchError('page_response', 'no_permitted_pages');
    if (known) {
      signal.throwIfAborted();
      const input: PageFactInput = { capability: known, sources: modelSources };
      // Preserve independent expected bytes even when an injected adapter mutates its input.
      stage = 'model_request';
      const extractedFacts = await bounded(options.extractFacts!(structuredClone(input), signal), signal);
      stage = 'fact_validation';
      const facts = validateCompanyFacts(extractedFacts, input);
      signal.throwIfAborted();
      if (!facts.length) throw new CompanyResearchError(stage, 'no_supported_facts');
      for (const fact of facts) claims.push({ key: fact.key, kind: 'fact', value: fact.quote, evidenceIds: [fact.sourceId] });
    }
    // Negative evidence from any bounded page wins, regardless of fetch order.
    const eligibleRoutes = routes.filter(route => {
      if (withheldTargets.has(`${route.channel}:${route.value}`)) return false;
      if (route.channel !== 'phone') return true;
      // Match the already normalized business target, not a greedy guessed phone
      // token: numeric prose such as '(24/7)' must not erase negative evidence.
      const target = new RegExp(`\\+${route.value.slice(1).split('').join('[ ()-]*')}(?![0-9])`);
      return !qualifiedPhoneLines.some(line => target.test(line));
    });
    stage = 'evidence_batch';
    return accountEvidenceBatchSchema.parse({ commandId: randomUUID(), accountId: snapshot.account.id, expectedVersion: snapshot.account.version, sources, claims, routes: eligibleRoutes });
    } catch (error) {
      if (callerSignal.aborted || signal?.aborted) throw annotateCompanyResearchError(error, stage, callerSignal.aborted ? 'cancelled' : 'timeout');
      throw annotateCompanyResearchError(error, stage);
    }
  } };
}
