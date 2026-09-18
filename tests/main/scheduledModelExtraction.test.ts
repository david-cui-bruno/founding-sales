import { describe, expect, it, vi } from 'vitest';
import { createCompanyPageProvider } from '../../src/main/research/companyPageProvider';
import { createFetchedReceiptPolicy } from '../../src/main/research/companySourcePolicy';
import { companyFactCostMicros, companyFactKeys, requestCompanyFacts, type CompanyFactExtractor, type CompanyFactUsage } from '../../src/main/research/companyFactExtraction';
import { createCompanyResearchWorker } from '../../src/main/research/companyResearchWorker';
import { rankAccount } from '../../src/shared/accounts/accountRanking';
import { accountClaimSchema, type AccountEvidenceBatch, type AccountEvidenceSnapshot } from '../../src/shared/contracts/accountContract';
import { researchReviewedCapabilitySchema, RESEARCH_REVIEW_MAX_DAYS } from '../../src/shared/contracts/researchSetupContract';
import type { AccountResearchStore, CompanyPagePort, ResearchJob } from '../../src/main/research/companyResearchTypes';

const snapshot: AccountEvidenceSnapshot = { account: { id: 'places-account', name: 'Fictional PM', domain: 'alpha-pm.example', version: 1 }, claims: [], routes: [], portfolio: [], unknowns: [], conflicts: [], fingerprint: 'fixture' };
const capability = { version: 1 as const, model: 'fictional-reviewed-model', maxCostMicros: 10000, maxOutputTokens: 512, maxInputBytes: 20000, inputMicrosPerMillionTokens: 400000, outputMicrosPerMillionTokens: 1600000 };
const limits = { maxCompanies: 20, maxPages: 1, maxBytes: 50000, maxCostMicros: 10000 };
const html = '<p>We manage 120 residential units.</p><p>Business phone: +1 401 555 0101</p><p>Our owner is a licensed broker.</p>';
function provider(extractFacts: CompanyFactExtractor, onOutcome = vi.fn()) {
  const http = vi.fn(async () => new Response(html, { headers: { 'content-type': 'text/html' } }));
  return { onOutcome, http, provider: createCompanyPageProvider({ receipts: createFetchedReceiptPolicy(), clock: { now: () => '2026-09-17T12:00:00.000Z' },
    permitted: url => url === 'https://alpha-pm.example/', http, resolve: async () => ['93.184.216.34'], modelExtraction: { capability, extractFacts, onOutcome } }) };
}
const research = (f: ReturnType<typeof provider>) => f.provider.research(snapshot, limits, new AbortController().signal);

describe('scheduled model extraction beside regex facts', () => {
  it('adds quoted facts and the target_fit verdict to the regex claims and published routes, one model call per research', async () => {
    const extractFacts = vi.fn<CompanyFactExtractor>(async input => {
      const source = input.sources[0]!;
      expect(source.blocks.map(block => block.text)).toEqual(['We manage 120 residential units.', 'Business phone: +1 401 555 0101', 'Our owner is a licensed broker.']);
      return [{ key: 'target_fit', sourceId: source.sourceId, blockId: 'b1', quote: 'We manage 120 residential units.' }, { key: 'role', sourceId: source.sourceId, blockId: 'b3', quote: 'Our owner is a licensed broker.' }];
    });
    const f = provider(extractFacts);
    const batch: AccountEvidenceBatch = await research(f);
    expect(extractFacts).toHaveBeenCalledTimes(1); expect(f.http).toHaveBeenCalledTimes(1);
    expect(batch.claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'portfolio', kind: 'fact' }),
      expect.objectContaining({ key: 'residential_scope', kind: 'fact' }),
      { key: 'target_fit', kind: 'fact', value: 'yes', evidenceIds: [batch.sources[0]!.id] },
      { key: 'role', kind: 'fact', value: 'Our owner is a licensed broker.', evidenceIds: [batch.sources[0]!.id] }]));
    expect(batch.routes).toEqual([expect.objectContaining({ channel: 'phone', value: '+14015550101', verification: 'published' })]);
    expect(f.onOutcome).toHaveBeenCalledWith('facts');
    for (const claim of batch.claims) expect(accountClaimSchema.safeParse(claim).success).toBe(true);
  });
  it('keeps the regex result when the model call fails, returns nothing, or returns an unsupported quote', async () => {
    for (const [extractor, outcome] of [
      [async () => { throw new Error('PRIVATE model failure'); }, 'failed'],
      [async () => [], 'no_facts'],
      [async (input) => [{ key: 'not_target', sourceId: input.sources[0]!.sourceId, blockId: 'b1', quote: 'rewritten text' }], 'failed'],
    ] as [CompanyFactExtractor, string][]) {
      const f = provider(extractor);
      const batch = await research(f);
      expect(batch.claims.some(claim => claim.key === 'portfolio')).toBe(true);
      expect(batch.claims.some(claim => claim.key === 'target_fit')).toBe(false);
      expect(batch.routes).toHaveLength(1);
      expect(f.onOutcome).toHaveBeenCalledWith(outcome);
      expect(JSON.stringify(batch)).not.toContain('PRIVATE');
    }
  });
  it('never runs scheduled extraction under the known-company opt-in and never without the option', async () => {
    const extractFacts = vi.fn<CompanyFactExtractor>(async () => []);
    const plain = createCompanyPageProvider({ receipts: createFetchedReceiptPolicy(), clock: { now: () => '2026-09-17T12:00:00.000Z' }, permitted: () => true,
      http: async () => new Response(html, { headers: { 'content-type': 'text/html' } }), resolve: async () => ['93.184.216.34'] });
    await plain.research(snapshot, limits, new AbortController().signal);
    const f = provider(extractFacts);
    await expect(f.provider.research(snapshot, { ...limits, knownCompanyExtraction: capability }, new AbortController().signal)).rejects.toBeDefined();
    expect(extractFacts).not.toHaveBeenCalled();
  });
  it('prices provider usage at the reviewed per-million rates and reports it once, or null usage when input tokens are absent', async () => {
    expect(companyFactCostMicros({ inputTokens: 1000, outputTokens: 20 }, capability)).toBe(432);
    expect(companyFactCostMicros({ inputTokens: 1, outputTokens: 1 }, capability)).toBe(3);
    expect(companyFactCostMicros({ inputTokens: 0, outputTokens: 0 }, capability)).toBe(0);
    expect(companyFactKeys).toEqual(['ownership', 'portfolio_description', 'residential_scope', 'operating_footprint', 'maintenance_workflow', 'role', 'target_fit', 'not_target']);
    const input = { capability, sources: [{ sourceId: 'source', blocks: [{ id: 'b1', text: 'We manage 120 residential units.' }] }] };
    const envelope = (usage?: object) => Response.json({ status: 'completed', model: capability.model, output: [{ type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: JSON.stringify({ facts: [{ key: 'not_target', ref: 0 }] }) }] }], ...(usage ? { usage } : {}) });
    const usages: CompanyFactUsage[] = [];
    const facts = await requestCompanyFacts({ input, credentials: { apiKey: 'fictional', model: capability.model }, signal: new AbortController().signal,
      fetch: vi.fn().mockResolvedValue(envelope({ input_tokens: 1000, output_tokens: 20, total_tokens: 1020 })), onUsage: usage => usages.push(usage) });
    expect(facts).toEqual([{ key: 'not_target', sourceId: 'source', blockId: 'b1', quote: 'We manage 120 residential units.' }]);
    expect(usages).toEqual([{ inputTokens: 1000, outputTokens: 20, costMicros: 432 }]);
    const missing: CompanyFactUsage[] = [];
    await requestCompanyFacts({ input, credentials: { apiKey: 'fictional', model: capability.model }, signal: new AbortController().signal,
      fetch: vi.fn().mockResolvedValue(envelope({ output_tokens: 20 })), onUsage: usage => missing.push(usage) });
    expect(missing).toEqual([{ inputTokens: null, outputTokens: 20, costMicros: null }]);
    const throwing = await requestCompanyFacts({ input, credentials: { apiKey: 'fictional', model: capability.model }, signal: new AbortController().signal,
      fetch: vi.fn().mockResolvedValue(envelope({ input_tokens: 1, output_tokens: 1 })), onUsage: () => { throw new Error('observer'); } });
    expect(throwing).toHaveLength(1);
  });
  it('settles a completed job at the reported cost capped by its reservation, and keeps the reservation when no cost is known', async () => {
    const settled: unknown[] = [];
    const job: ResearchJob = { id: '11111111-1111-4111-8111-111111111111', accountId: 'places-account', limits, attempt: 1, claimToken: 'token', receiptCommandId: '22222222-2222-4222-8222-222222222222', receiptCommitted: false, costMicros: null };
    const store = (cost: number | null): AccountResearchStore => ({ create: () => { throw new Error('unused'); }, snapshot: () => snapshot, enqueue: () => undefined, claimNext: () => ({ ...job }),
      admitEvidence: () => ({ accountId: snapshot.account.id, version: 2, duplicate: false }), settle: value => { settled.push([cost, value.costMicros]); } });
    const pages: CompanyPagePort = { research: async () => ({ commandId: '33333333-3333-4333-8333-333333333333', accountId: snapshot.account.id, expectedVersion: 1, sources: [], claims: [], routes: [] }) };
    for (const cost of [432, 10000, 25000, null, -5]) {
      await createCompanyResearchWorker({ store: store(cost), pages, clock: { now: () => '2026-09-17T12:00:00.000Z' }, settledCost: () => cost }).runNext(new AbortController().signal);
    }
    expect(settled).toEqual([[432, 432], [10000, 10000], [25000, 10000], [null, null], [-5, null]]);
  });
});

describe('target_fit in ranking and the reviewed capability contract', () => {
  const asOf = '2026-09-17T12:00:00.000Z';
  const rank = (claims: AccountEvidenceSnapshot['claims']) => rankAccount({ ...snapshot, claims }, asOf);
  it('maps a lone target_fit no to not_target, a yes with residential support to supported, and a conflict to uncertain', () => {
    expect(rank([{ kind: 'fact', key: 'target_fit', value: 'no', evidenceIds: ['s'] }]).fit).toBe('not_target');
    expect(rank([{ kind: 'fact', key: 'target_fit', value: 'yes', evidenceIds: ['s'] }]).fit).toBe('uncertain');
    expect(rank([{ kind: 'fact', key: 'target_fit', value: 'yes', evidenceIds: ['s'] }, { kind: 'fact', key: 'residential_scope', value: 'Residential property management', evidenceIds: ['s'] }]).fit).toBe('supported');
    expect(rank([{ kind: 'fact', key: 'target_fit', value: 'no', evidenceIds: ['s'] }, { kind: 'fact', key: 'residential_scope', value: 'Residential property management', evidenceIds: ['s'] }]).fit).toBe('uncertain');
    expect(rank([{ kind: 'hypothesis', key: 'target_fit', value: 'no', evidenceIds: [] }]).fit).toBe('uncertain');
    expect(accountClaimSchema.safeParse({ kind: 'fact', key: 'target_fit', value: 'unclear', evidenceIds: ['s'] }).success).toBe(false);
  });
  it('caps a review window at 180 days and binds placesExtraction to the reservation and the reviewed model', () => {
    const base = { capability: { model: 'fictional-reviewed-model', webSearch: true, searchCostMicros: 40, modelCostMicros: 40 }, reviewedAt: '2026-09-17T00:00:00.000Z', provenance: 'Fictional review', researchReservationMicros: 10000, currency: 'USD' };
    const days = (count: number) => new Date(Date.parse(base.reviewedAt) + count * 86_400_000).toISOString();
    expect(RESEARCH_REVIEW_MAX_DAYS).toBe(180);
    expect(researchReviewedCapabilitySchema.safeParse({ ...base, expiresAt: days(180) }).success).toBe(true);
    expect(researchReviewedCapabilitySchema.safeParse({ ...base, expiresAt: days(181) }).success).toBe(false);
    expect(researchReviewedCapabilitySchema.safeParse({ ...base, expiresAt: '2099-01-01T00:00:00.000Z' }).success).toBe(false);
    expect(researchReviewedCapabilitySchema.safeParse({ ...base, expiresAt: days(90), placesExtraction: capability }).success).toBe(true);
    expect(researchReviewedCapabilitySchema.safeParse({ ...base, expiresAt: days(90), placesExtraction: { ...capability, maxCostMicros: 9000 } }).success).toBe(false);
    expect(researchReviewedCapabilitySchema.safeParse({ ...base, expiresAt: days(90), placesExtraction: { ...capability, model: 'another-model' } }).success).toBe(false);
    expect(researchReviewedCapabilitySchema.safeParse({ ...base, expiresAt: days(90), provenance: 'x'.repeat(501) }).success).toBe(false);
  });
});
