import { describe, expect, it, vi } from 'vitest';
import { createCompanyPageProvider } from '../../src/main/research/companyPageProvider';
import { createFetchedReceiptPolicy } from '../../src/main/research/companySourcePolicy';
import type { CompanyFactExtractor } from '../../src/main/research/companyFactExtraction';
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
