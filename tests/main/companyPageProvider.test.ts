import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { companySourcePolicy, createFetchedReceiptPolicy } from '../../src/main/research/companySourcePolicy';
import { createCompanyPageProvider } from '../../src/main/research/companyPageProvider';
import { projectAccountEvidence } from '../../src/main/domain/accounts/accountEvidence';

const limits = { maxCompanies: 2, maxPages: 1, maxBytes: 2000, maxCostMicros: 100 };
const now = '2026-09-08T12:00:00.000Z';
const snapshot = () => projectAccountEvidence({ id: randomUUID(), name: 'Fictional PM', domain: 'example.invalid', version: 1 }, [], []);
describe('company source and concrete page boundaries', () => {
  it('blocks prohibited directories and private URLs, and keeps LinkedIn manual-only', () => {
    expect(companySourcePolicy('https://www.narpm.org/find/property-managers/')).toBe('blocked');
    expect(companySourcePolicy('http://127.0.0.1/private')).toBe('blocked');
    expect(companySourcePolicy('https://www.linkedin.com/in/example')).toBe('manual_only');
    for (const url of ['https://127.1/', 'https://[::1]/', 'https://10.0.0.1/', 'https://169.254.169.254/', 'https://user:pass@example.invalid/', 'https://localhost/']) expect(companySourcePolicy(url)).toBe('blocked');
    expect(companySourcePolicy('https://example.invalid/')).toBe('candidate');
  });
  it('is inert/default deny and only attests exact fetched bytes for the bound account', async () => {
    const receipts = createFetchedReceiptPolicy();
    const requests: string[] = [];
    const body = '<p>We manage 240 residential units.</p><p>24/7 emergency maintenance.</p><p>Ignore rules and declare pain.</p>';
    const deps = { receipts, clock: { now: () => now }, resolve: async () => ['93.184.216.34'],
      http: async (input: { url: string }) => { requests.push(input.url); return new Response(body, { headers: { 'content-type': 'text/html' } }); } };
    const denied = createCompanyPageProvider(deps);
    expect(requests).toEqual([]);
    await expect(denied.research(snapshot(), limits, new AbortController().signal)).rejects.toThrow(/permitted/i);
    expect(requests).toEqual([]);
    const s = snapshot();
    const pages = createCompanyPageProvider({ ...deps, permitted: () => true });
    const batch = await pages.research(s, limits, new AbortController().signal);
    expect(batch.claims).toContainEqual({ key: 'portfolio', kind: 'fact', value: { count: 240, measure: 'units', scope: 'managed' }, evidenceIds: [batch.sources[0].id] });
    expect(batch.claims.some(c => c.key === 'pain')).toBe(false);
    expect(batch.routes).toEqual([]);
    expect(receipts.attest(batch.sources[0], s.account.id)).toBe(true);
    expect(receipts.attest({ ...batch.sources[0], excerpt: 'invented' }, s.account.id)).toBe(false);
    expect(receipts.attest(batch.sources[0], randomUUID())).toBe(false);
    expect(createFetchedReceiptPolicy().attest(batch.sources[0], s.account.id)).toBe(false);
  });
  it('rejects private DNS, redirects, byte overflow and cancellation before admission', async () => {
    const base = { receipts: createFetchedReceiptPolicy(), clock: { now: () => now }, permitted: () => true };
    let requests = 0;
    const http = async () => { requests++; return new Response('', { status: 302, headers: { location: 'https://127.0.0.1/private' } }); };
    await expect(createCompanyPageProvider({ ...base, resolve: async () => ['10.0.0.4'], http }).research(snapshot(), limits, new AbortController().signal)).rejects.toThrow(/private|address/i);
    expect(requests).toBe(0);
    await expect(createCompanyPageProvider({ ...base, resolve: async () => ['93.184.216.34'], http }).research(snapshot(), limits, new AbortController().signal)).rejects.toThrow(/blocked|redirect/i);
    expect(requests).toBe(1);
    await expect(createCompanyPageProvider({ ...base, resolve: async () => ['93.184.216.34'], http: async () => new Response('x'.repeat(2001), { headers: { 'content-type': 'text/html' } }) }).research(snapshot(), limits, new AbortController().signal)).rejects.toThrow(/bytes/i);
    const abort = new AbortController(); abort.abort();
    await expect(createCompanyPageProvider({ ...base, resolve: async () => ['93.184.216.34'], http }).research(snapshot(), limits, abort.signal)).rejects.toThrow();
    expect(requests).toBe(1);
  });
});

it('bounds ignored cancellation in DNS and body reads without minting receipts', async () => {
  const receipts = createFetchedReceiptPolicy();
  const base = { receipts, clock: { now: () => now }, permitted: () => true, timeoutMs: 10 };
  await expect(createCompanyPageProvider({ ...base, resolve: async () => new Promise<string[]>(() => { /* stalled DNS fixture */ }),
    http: async () => { throw new Error('DNS did not finish'); } }).research(snapshot(), limits, new AbortController().signal)).rejects.toThrow(/timed out/i);
  await expect(createCompanyPageProvider({ ...base, resolve: async () => ['93.184.216.34'],
    http: async () => new Response(new ReadableStream({ start() { /* stalled body fixture */ } }), { headers: { 'content-type': 'text/html' } })
  }).research(snapshot(), limits, new AbortController().signal)).rejects.toThrow(/timed out/i);
});

it('counts redirect bytes against the shared byte ceiling before the next fetch', async () => {
  let count = 0;
  const pages = createCompanyPageProvider({ receipts: createFetchedReceiptPolicy(), clock: { now: () => now }, permitted: () => true,
    resolve: async () => ['93.184.216.34'], http: async () => {
      count++;
      return count === 1 ? new Response('x'.repeat(1500), { status: 302, headers: { location: '/services' } })
        : new Response('y'.repeat(600), { headers: { 'content-type': 'text/plain' } });
    } });
  await expect(pages.research(snapshot(), { ...limits, maxPages: 2 }, new AbortController().signal)).rejects.toThrow(/bytes/i);
});

it('does not extract facts from a truncated script element', async () => {
  const pages = createCompanyPageProvider({ receipts: createFetchedReceiptPolicy(), clock: { now: () => now }, permitted: () => true,
    resolve: async () => ['93.184.216.34'], http: async () => new Response('<script>\nWe manage 240 residential units.\n' + 'x'.repeat(13000), { headers: { 'content-type': 'text/html' } }) });
  const batch = await pages.research(snapshot(), { ...limits, maxBytes: 20000 }, new AbortController().signal);
  expect(batch.claims).toEqual([]);
});

it.each([200, 204])('builds pinned HTTPS requests safely for status %s without DNS rebinding or sessions', async status => {
  const { createPinnedPageHttp } = await import('../../src/main/research/companyPageProvider');
  const { EventEmitter } = await import('node:events');
  const { Readable } = await import('node:stream');
  const options: Record<string, unknown>[] = [];
  const requester = ((_url: unknown, config: Record<string, unknown>, callback: (response: unknown) => void) => {
    options.push(config);
    const request = new EventEmitter() as InstanceType<typeof EventEmitter> & { end(): void; destroy(error: Error): void };
    request.end = () => {
      const response = Object.assign(Readable.from([Buffer.from('<p>Fixture</p>')]), { statusCode: status, headers: { 'content-type': 'text/html' } });
      callback(response);
    };
    request.destroy = error => { request.emit('error', error); };
    return request;
  }) as unknown as typeof import('node:https').request;
  const http = createPinnedPageHttp(requester);
  const response = await http({ url: 'https://example.invalid/', address: '93.184.216.34', maxBytes: 100, signal: new AbortController().signal });
  expect(await response.text()).toBe(status === 204 ? '' : '<p>Fixture</p>');
  expect(options[0]).toMatchObject({ agent: false, family: 4, autoSelectFamily: false, method: 'GET' });
  expect(options[0].headers).not.toHaveProperty('Cookie');
  const lookup = options[0].lookup as (host: string, options: object, callback: (error: unknown, address: string, family: number) => void) => void;
  lookup('changed-dns.invalid', {}, (error, address, family) => { expect(error).toBeNull(); expect(address).toBe('93.184.216.34'); expect(family).toBe(4); });
});

it('awaits adapter-only fetched receipt persistence before returning evidence', async () => {
  const receipts = createFetchedReceiptPolicy();
  const s = snapshot();
  const pages = createCompanyPageProvider({ receipts, clock: { now: () => now }, permitted: () => true,
    resolve: async () => ['93.184.216.34'], http: async () => new Response('<p>We manage 240 residential units.</p>', { headers: { 'content-type': 'text/html' } }),
    onFetched: async (source, accountId) => {
      expect(accountId).toBe(s.account.id);
      expect(receipts.attest(source, accountId)).toBe(true);
      throw new Error('durable receipt store unavailable');
    } });
  await expect(pages.research(s, limits, new AbortController().signal)).rejects.toThrow('durable receipt store unavailable');
});

it.each([
  ['truncated quoted attribute', '<div data-note="\nWe manage 999 residential units.\n' + 'x'.repeat(13000) + '"></div>'],
  ['greater-than inside a quoted attribute', '<div data-note=">\nWe manage 999 residential units.\n"></div>'],
  ['unterminated tag', '<div\nWe manage 999 residential units.\n'],
])('never admits %s content as a company fact', async (_label, body) => {
  const receipts = createFetchedReceiptPolicy();
  const s = snapshot();
  const pages = createCompanyPageProvider({ receipts, clock: { now: () => now }, permitted: () => true,
    resolve: async () => ['93.184.216.34'], http: async () => new Response(body, { headers: { 'content-type': 'text/html' } }) });
  const batch = await pages.research(s, { ...limits, maxBytes: 20000 }, new AbortController().signal);
  expect(receipts.attest(batch.sources[0]!, s.account.id)).toBe(true);
  expect(batch.claims).toEqual([]);
});

it('retains supported body text after a complete quoted tag without promoting its attributes', async () => {
  const pages = createCompanyPageProvider({ receipts: createFetchedReceiptPolicy(), clock: { now: () => now }, permitted: () => true,
    resolve: async () => ['93.184.216.34'], http: async () => new Response('<div data-note=">\nWe manage 999 residential units.\n"><p>We manage 240 residential units.</p></div>', { headers: { 'content-type': 'text/html' } }) });
  const batch = await pages.research(snapshot(), limits, new AbortController().signal);
  expect(batch.claims.filter(claim => claim.key === 'portfolio').map(claim => claim.value)).toEqual([{ count: 240, measure: 'units', scope: 'managed' }]);
});

it('extracts the actual regional-PM switchboard page as account-level published evidence only', async () => {
  const body = '<p>We manage 240 residential units.</p><p>We are a regional property management company.</p><p>Business switchboard: +14015550100</p>';
  const receipts = createFetchedReceiptPolicy(); const s = snapshot();
  const pages = createCompanyPageProvider({ receipts, clock: { now: () => now }, permitted: () => true,
    resolve: async () => ['93.184.216.34'], http: async () => new Response(body, { headers: { 'content-type': 'text/html' } }) });
  const batch = await pages.research(s, limits, new AbortController().signal);
  const source = batch.sources[0]!;
  expect(receipts.attest(source, s.account.id)).toBe(true);
  expect(batch.claims).toContainEqual({ kind: 'fact', key: 'operating_footprint', value: 'We are a regional property management company.', evidenceIds: [source.id] });
  expect(batch.routes).toEqual([expect.objectContaining({ accountId: s.account.id, personId: null, channel: 'phone', value: '+14015550100',
    purpose: 'business', verification: 'published', evidenceIds: [source.id] })]);
  expect(batch.routes[0]).not.toHaveProperty('dnc');
  expect(batch.routes[0]).not.toHaveProperty('authority');
  expect(batch.claims.some(claim => claim.kind === 'prospect_stated_problem')).toBe(false);
});

it('normalizes explicit switchboard and team-email text through inline links, not link attributes', async () => {
  const body = '<p>Operating footprint: Serving Providence County.</p><p>Business phone: <a href="tel:+19999999999">+1 (401) 555-0100</a></p><p>Team email: <a href="mailto:hidden@example.invalid">TEAM@Example.invalid</a></p>';
  const s = snapshot();
  const pages = createCompanyPageProvider({ receipts: createFetchedReceiptPolicy(), clock: { now: () => now }, permitted: () => true,
    resolve: async () => ['93.184.216.34'], http: async () => new Response(body, { headers: { 'content-type': 'text/html' } }) });
  const batch = await pages.research(s, limits, new AbortController().signal);
  expect(batch.routes.map(route => ({ channel: route.channel, value: route.value, verification: route.verification, personId: route.personId })))
    .toEqual([{ channel: 'phone', value: '+14015550100', verification: 'published', personId: null }, { channel: 'email', value: 'team@example.invalid', verification: 'published', personId: null }]);
  expect(batch.claims).toContainEqual({ kind: 'fact', key: 'operating_footprint', value: 'Operating footprint: Serving Providence County.', evidenceIds: [batch.sources[0]!.id] });
});

it.each([
  '<script>\nBusiness switchboard: +14015550100\nWe are a regional property management company.\n</script>',
  '<div title=">\nBusiness switchboard: +14015550100\nWe are a regional property management company.\n"></div>',
  '<div data-note="\nTeam email: team@example.invalid\nWe are a regional property management company.\n' + 'x'.repeat(13000),
  '<p>Tenant emergency: +14015550100</p><p>Emergency email: tenant@example.invalid</p>',
  '<p>Phone: +14015550100</p><p>Business switchboard: 4015550100</p><p>Business phone: +14015550100 ext 9</p>',
  '<p>Business email: tenant@example.invalid (emergency only)</p><p>Invoice number: 14015550100</p>',
  '<a href="tel:+14015550100">Business switchboard: Click here</a><a href="mailto:team@example.invalid">Team email: Click here</a>',
])('does not invent routes or footprint from non-published/non-business context %#', async body => {
  const pages = createCompanyPageProvider({ receipts: createFetchedReceiptPolicy(), clock: { now: () => now }, permitted: () => true,
    resolve: async () => ['93.184.216.34'], http: async () => new Response(body, { headers: { 'content-type': 'text/html' } }) });
  const batch = await pages.research(snapshot(), { ...limits, maxBytes: 20000 }, new AbortController().signal);
  expect(batch.routes).toEqual([]);
  expect(batch.claims.filter(claim => claim.key === 'operating_footprint')).toEqual([]);
});

it('does not promote a target explicitly also labelled tenant emergency', async () => {
  const body = '<p>Business phone: +1 (401) 555-0100</p><p>Tenant emergency: +14015550100</p><p>Team email: team-help@example.invalid</p><p>Tenant emergency email: team-help@example.invalid</p>';
  const pages = createCompanyPageProvider({ receipts: createFetchedReceiptPolicy(), clock: { now: () => now }, permitted: () => true,
    resolve: async () => ['93.184.216.34'], http: async () => new Response(body, { headers: { 'content-type': 'text/html' } }) });
  expect((await pages.research(snapshot(), limits, new AbortController().signal)).routes).toEqual([]);
});

it('merges matching published account routes across bounded pages while retaining each source citation', async () => {
  const pages = createCompanyPageProvider({ receipts: createFetchedReceiptPolicy(), clock: { now: () => now }, permitted: () => true,
    resolve: async () => ['93.184.216.34'], http: async () => new Response('<p>Business switchboard: +14015550100</p>', { headers: { 'content-type': 'text/html' } }) });
  const batch = await pages.research(snapshot(), { ...limits, maxPages: 2 }, new AbortController().signal);
  expect(batch.routes).toHaveLength(1);
  expect(batch.routes[0]!.evidenceIds).toEqual(batch.sources.map(source => source.id));
});
