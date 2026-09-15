import { describe, expect, it, vi } from 'vitest';
import { createCompanyPageProvider } from '../../src/main/research/companyPageProvider';
import { createFetchedReceiptPolicy } from '../../src/main/research/companySourcePolicy';
import { CompanyFactExtractionError, requestCompanyFacts, type CompanyFactExtractor } from '../../src/main/research/companyFactExtraction';
import { companyResearchDiagnostic } from '../../src/main/research/companyResearchFailure';
import type { AccountEvidenceSnapshot } from '../../src/shared/contracts/accountContract';

const snapshot: AccountEvidenceSnapshot = { account: { id: 'known-account', name: 'Fictional PM', domain: 'example.invalid', version: 1 }, claims: [], routes: [], portfolio: [], unknowns: [], conflicts: [], fingerprint: 'fixture' };
const capability = { version: 1 as const, model: 'fictional-reviewed-model', maxCostMicros: 100, maxOutputTokens: 512, maxInputBytes: 20000, inputMicrosPerMillionTokens: 1000, outputMicrosPerMillionTokens: 2000 };
const limits = { maxCompanies: 1, maxPages: 1, maxBytes: 50000, maxCostMicros: 100, knownCompanyExtraction: capability };
const html = '<div>We manage over 250 residential units &amp; serve Fictional City.</div>';
const quote = 'We manage over 250 residential units & serve Fictional City.';
const facts: CompanyFactExtractor = async input => [{ key: 'portfolio_description', sourceId: input.sources[0]!.sourceId, blockId: input.sources[0]!.blocks[0]!.id, quote }];
function fixture(overrides: Partial<Parameters<typeof createCompanyPageProvider>[0]> = {}) {
  const receipts = createFetchedReceiptPolicy();
  const http = vi.fn(async () => new Response(html, { headers: { 'content-type': 'text/html' } }));
  const resolve = vi.fn(async () => ['93.184.216.34']);
  const extractFacts = vi.fn(facts);
  const provider = createCompanyPageProvider({ receipts, clock: { now: () => '2026-09-15T00:00:00.000Z' }, sourceUrls: ['https://example.invalid/about'], permitted: url => url === 'https://example.invalid/about', http, resolve, extractFacts, ...overrides });
  return { provider, http, resolve, extractFacts, receipts };
}
describe('known-company protected page composition', () => {
  async function diagnostic(overrides: Parameters<typeof fixture>[0], signal = new AbortController().signal) {
    const f = fixture(overrides);
    const result = await f.provider.research(snapshot, limits, signal).then(() => { throw new Error('Expected rejection'); }, (value: unknown) => companyResearchDiagnostic(value, 'page'));
    return { diagnostic: result, f };
  }
  it('distinguishes page HTTP rejection from actual model HTTP rejection without body diagnostics', async () => {
    const page = await diagnostic({ http: async () => new Response('PRIVATE page body', { status: 503 }) });
    expect(page.diagnostic).toEqual({ stage: 'page_response', reason: 'page_response_rejected', httpStatus: 503 });
    expect(page.f.extractFacts).not.toHaveBeenCalled();
    const model = await diagnostic({ extractFacts: (input, signal) => requestCompanyFacts({ input, signal,
      credentials: { apiKey: 'fictional-key', model: capability.model }, fetch: vi.fn().mockResolvedValue(new Response('PRIVATE provider body', { status: 429 })) }) });
    expect(model.diagnostic).toEqual({ stage: 'model_request', reason: 'provider_rejected', httpStatus: 429 });
    expect(JSON.stringify([page.diagnostic, model.diagnostic])).not.toContain('PRIVATE');
  });
  it('preserves model subreason but independently labels invalid injected facts', async () => {
    const rejected = new CompanyFactExtractionError('envelope');
    Object.assign(rejected, { reason: 'PRIVATE', message: 'PRIVATE', stack: 'PRIVATE' });
    expect((await diagnostic({ extractFacts: async () => { throw rejected; } })).diagnostic).toEqual({ stage: 'model_request', reason: 'envelope' });
    expect((await diagnostic({ extractFacts: async () => [{ key: 'ownership', sourceId: 'forged', blockId: 'forged', quote }] })).diagnostic).toEqual({ stage: 'fact_validation', reason: 'quote' });
  });
  it('distinguishes no supported facts, caller cancellation and a timed-out model', async () => {
    expect((await diagnostic({ extractFacts: async () => [] })).diagnostic).toEqual({ stage: 'fact_validation', reason: 'no_supported_facts' });
    const controller = new AbortController();
    expect((await diagnostic({ extractFacts: async () => { controller.abort(new Error('PRIVATE')); return []; } }, controller.signal)).diagnostic).toEqual({ stage: 'model_request', reason: 'cancelled' });
    expect((await diagnostic({ timeoutMs: 20, extractFacts: async () => new Promise(() => undefined) })).diagnostic).toEqual({ stage: 'model_request', reason: 'timeout' });
  });
  it('annotates hostile DNS, HTTP and receipt failures without trusting thrown fields', async () => {
    const hostile = new Proxy({}, { get() { throw new Error('PRIVATE'); }, getPrototypeOf() { throw new Error('PRIVATE'); } });
    for (const [stage, overrides] of [
      ['dns', { resolve: async () => { throw hostile; } }],
      ['page_http', { http: async () => { throw hostile; } }],
      ['source_receipt', { onFetched: async () => { throw hostile; } }],
    ] as const) expect((await diagnostic(overrides)).diagnostic).toEqual({ stage, reason: 'unknown' });
  });
  it('preserves pre-aborted custom rejection identity', async () => {
    const original = new Error('PRIVATE custom cancellation');
    const controller = new AbortController(); controller.abort(original);
    const f = fixture();
    await expect(f.provider.research(snapshot, limits, controller.signal)).rejects.toBe(original);
    expect(companyResearchDiagnostic(original, 'page').reason).toBe('cancelled');
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.http).not.toHaveBeenCalled();
  });
  it('preserves primitive DNS rejections without retaining their payloads', async () => {
    for (const original of ['PRIVATE rejection', null, undefined, 42, Symbol('PRIVATE')]) {
      const f = fixture({ resolve: async () => { throw original; } });
      await expect(f.provider.research(snapshot, limits, new AbortController().signal)).rejects.toBe(original);
      expect(companyResearchDiagnostic(original, 'page')).toEqual({ stage: 'page', reason: 'unknown' });
      expect(f.http).not.toHaveBeenCalled();
    }
  });
  it('reads an explicitly approved about URL and preserves exact parsed quotes without numeric or contact promotion', async () => {
    const f = fixture();
    const batch = await f.provider.research(snapshot, limits, new AbortController().signal);
    expect(f.http).toHaveBeenCalledTimes(1); expect(f.extractFacts).toHaveBeenCalledTimes(1);
    expect(f.http.mock.calls[0]).toEqual([expect.objectContaining({ url: 'https://example.invalid/about', address: '93.184.216.34' })]);
    expect(batch.claims).toEqual([{ key: 'portfolio_description', kind: 'fact', value: quote, evidenceIds: [batch.sources[0]!.id] }]);
    expect(batch.routes).toEqual([]); expect(batch.sources[0]!.excerpt).toContain(quote);
    expect(f.receipts.attest(batch.sources[0]!, snapshot.account.id)).toBe(true);
    expect(f.receipts.attest({ ...batch.sources[0]!, excerpt: 'Different evidence' }, snapshot.account.id)).toBe(false);
  });
  it('composes ref-only HTTP selections with exact canonical provenance and receipt binding', async () => {
    const model = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const source = JSON.parse(body.input).sources[0];
      expect(source.blocks[0].text).toBe(quote);
      expect(source.blocks[0].ref).toBe(0);
      return new Response(JSON.stringify({ status: 'completed', model: capability.model, output: [{
        type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: JSON.stringify({ facts: [{ key: 'portfolio_description', ref: source.blocks[0].ref }] }) }],
      }] }));
    });
    const f = fixture({ extractFacts: (input, signal) => requestCompanyFacts({ input, signal,
      credentials: { apiKey: 'fictional-key', model: capability.model }, fetch: model }) });
    const batch = await f.provider.research(snapshot, limits, new AbortController().signal);
    expect(model).toHaveBeenCalledTimes(1);
    expect(batch.claims).toEqual([{ key: 'portfolio_description', kind: 'fact', value: quote, evidenceIds: [batch.sources[0]!.id] }]);
    expect(batch.routes).toEqual([]);
    expect(f.receipts.attest(batch.sources[0]!, snapshot.account.id)).toBe(true);
    expect(f.receipts.attest({ ...batch.sources[0]!, excerpt: 'Changed source' }, snapshot.account.id)).toBe(false);
  });
  it('reports no supported facts for all-overlong context without model HTTP', async () => {
    const model = vi.fn<typeof globalThis.fetch>();
    const result = await diagnostic({ http: async () => new Response(`<p>${'x'.repeat(2001)}</p>`, { headers: { 'content-type': 'text/html' } }),
      extractFacts: (input, signal) => requestCompanyFacts({ input, signal,
        credentials: { apiKey: 'fictional-key', model: capability.model }, fetch: model }) });
    expect(result.diagnostic).toEqual({ stage: 'fact_validation', reason: 'no_supported_facts' });
    expect(model).not.toHaveBeenCalled();
  });
  it('does not silently invoke a model for existing limits', async () => {
    const f = fixture({ sourceUrls: ['https://example.invalid/'], permitted: () => true });
    const { knownCompanyExtraction: _unused, ...legacy } = limits; void _unused;
    await f.provider.research(snapshot, legacy, new AbortController().signal);
    expect(f.extractFacts).not.toHaveBeenCalled();
  });
  it('rejects a model ceiling above the durable reservation before any IO', async () => {
    const f = fixture();
    await expect(f.provider.research(snapshot, { ...limits, maxCostMicros: 99 }, new AbortController().signal)).rejects.toThrow();
    expect(f.http).not.toHaveBeenCalled(); expect(f.resolve).not.toHaveBeenCalled(); expect(f.extractFacts).not.toHaveBeenCalled();
  });
  it('refuses absent adapters and exact-host mismatches before fetching', async () => {
    const cases: Partial<Parameters<typeof createCompanyPageProvider>[0]>[] = [{ extractFacts: undefined }, { sourceUrls: ['https://www.example.invalid/about'] }];
    for (const overrides of cases) {
      const f = fixture(overrides);
      await expect(f.provider.research(snapshot, limits, new AbortController().signal)).rejects.toThrow();
      expect(f.http).not.toHaveBeenCalled(); expect(f.resolve).not.toHaveBeenCalled();
    }
  });
  it('retains DNS and redirect restrictions before model use', async () => {
    const privateDns = fixture({ resolve: async () => ['127.0.0.1'] });
    await expect(privateDns.provider.research(snapshot, limits, new AbortController().signal)).rejects.toThrow();
    expect(privateDns.http).not.toHaveBeenCalled(); expect(privateDns.extractFacts).not.toHaveBeenCalled();
    const redirected = fixture({ http: async () => new Response(null, { status: 302, headers: { location: 'https://other.invalid/' } }) });
    await expect(redirected.provider.research(snapshot, limits, new AbortController().signal)).rejects.toThrow();
    expect(redirected.extractFacts).not.toHaveBeenCalled();
  });
  it('independently rejects forged output even if an injected extractor mutates its input', async () => {
    const f = fixture({ extractFacts: async input => {
      input.sources[0]!.blocks[0]!.text = 'Invented company claim';
      return [{ key: 'ownership', sourceId: input.sources[0]!.sourceId, blockId: input.sources[0]!.blocks[0]!.id, quote: 'Invented company claim' }];
    } });
    await expect(f.provider.research(snapshot, limits, new AbortController().signal)).rejects.toThrow();
  });
  it('does not return evidence as a successful result when extraction is empty or cancelled', async () => {
    const empty = fixture({ extractFacts: async () => [] });
    await expect(empty.provider.research(snapshot, limits, new AbortController().signal)).rejects.toThrow();
    const controller = new AbortController();
    const cancelled = fixture({ extractFacts: async input => { controller.abort(); return facts(input, controller.signal); } });
    await expect(cancelled.provider.research(snapshot, limits, controller.signal)).rejects.toThrow();
  });
});
