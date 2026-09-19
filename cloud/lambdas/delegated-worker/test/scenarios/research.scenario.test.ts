import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ownerResearchSourceKey } from '../../../../../src/shared/contracts/ownerCommandContract';
import { listAttempts } from '../../src/v1/attempts';
import { deriveStateAndZone, evidenceKey, evidenceRecordSchema, evidenceSummaryLine, EVIDENCE_EXCERPT_MAX, EVIDENCE_MAX_SOURCES,
  readEvidence, writeEvidence } from '../../src/v1/evidence';
import { poolCounterKey, poolCounterSchema, readPoolCounter, readResearchCounter, readResearchSettings, researchCounterKey,
  RESEARCH_DAILY_BUDGET_CEILING, RESEARCH_DAILY_BUDGET_DEFAULT, RESEARCH_SETTINGS_KEY, spendResearch, writePoolCounter } from '../../src/v1/pool';
import { firmRecord } from './firmFixtures';
import { v1Fixture } from './v1Fixture';

/**
 * Research on the queue (FSS target design sections 2 and 4; slice S4), on the real store adapter with the
 * in-memory harness. Every provider call goes through an injected fetch; nothing here reaches Places, a web
 * page or a mailbox, and nothing dials, sends or books.
 */

const START = '2026-09-18T12:00:00.000Z';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const source = (n: number, excerpt: string) => ({ url: `https://firm-${n}.example/page`, fetchedAt: START, sha256: sha(excerpt), excerpt });

describe('EVIDENCE#<firmId>: the sources split off the firm record', () => {
  it('writes the sources, the extraction and the business email finding under one revision', async () => {
    const f = v1Fixture(START);
    const written = await writeEvidence(f.store, { firmId: 'account-ri-1', revision: 1,
      sources: [source(1, 'We manage 120 residential units in Providence.')],
      extraction: { facts: [{ key: 'portfolio_description', sourceId: 'page-1', quote: 'We manage 120 residential units' }], at: START },
      businessEmailFinding: { email: 'info@firm-1.example', sourceId: 'page-1', selection: 'role_mailbox',
        considered: ['info@firm-1.example'], refused: { free_mail: 1, off_domain: 0, withheld_contact: 0, unparsable: 0 } } });
    expect(written).toEqual({ written: true, revision: 1 });

    const stored = evidenceRecordSchema.parse(f.db.inspect(evidenceKey('account-ri-1')));
    expect(stored.sources).toHaveLength(1);
    expect(stored.businessEmailFinding?.email).toBe('info@firm-1.example');
    expect((await readEvidence(f.store, 'account-ri-1'))?.record.revision).toBe(1);
  });

  it('refuses a write over the store size limit rather than truncating, and records it as a research attempt', async () => {
    const f = v1Fixture(START);
    // Forty sources at the excerpt ceiling is past the item limit the store refuses at; nothing is cut to fit.
    const sources = Array.from({ length: EVIDENCE_MAX_SOURCES }, (_, n) => source(n, 'x'.repeat(EVIDENCE_EXCERPT_MAX)));
    const written = await writeEvidence(f.store, { firmId: 'account-ri-2', revision: 1, sources, extraction: null, businessEmailFinding: null });
    expect(written).toEqual({ written: false, reason: 'evidence_too_large' });
    expect(f.db.inspect(evidenceKey('account-ri-2'))).toBeUndefined();

    const attempts = await listAttempts(f.store, { kind: 'research' });
    expect(attempts[0]).toMatchObject({ kind: 'research', outcome: 'failed', reason: 'evidence_too_large',
      detail: { code: 'evidence_too_large', firmId: 'account-ri-2' } });
  });

  it('derives state and zone here, as the one implementation the firm adapter also calls', () => {
    const providence = deriveStateAndZone(firmRecord({ id: 'account-ri-3', name: 'Firm', address: '3 Hope St, Providence, RI 02906, USA', researchedAt: START }));
    expect(providence).toMatchObject({ city: 'Providence', state: 'RI', timeZone: 'America/New_York', hold: null });
    const unknown = deriveStateAndZone(firmRecord({ id: 'account-xx-1', name: 'Firm', address: null, researchedAt: START }));
    expect(unknown.state).toBeNull();
    expect(unknown.hold).toEqual({ reason: 'state_not_cleared', code: 'state_unknown' });
  });

  it('summarises the evidence in one line short enough for the firm record', () => {
    const line = evidenceSummaryLine({ sources: 4, businessEmail: 'info@firm.example', facts: 2, researchedAt: START });
    expect(line).toContain('4 sources');
    expect(line).toContain('business email');
    expect(line.length).toBeLessThanOrEqual(400);
  });
});

describe('COUNTER#pool and COUNTER#<date>#research: what is available and what is left to spend', () => {
  it('keeps the pool counts under one key and reads them back', async () => {
    const f = v1Fixture(START);
    expect(await readPoolCounter(f.store)).toEqual({ researched: 0, unlisted: 0, postureCleared: 0, updatedAt: null });
    await writePoolCounter(f.store, { researched: 31, unlisted: 12, postureCleared: 9 });
    expect(await readPoolCounter(f.store)).toMatchObject({ researched: 31, unlisted: 12, postureCleared: 9 });
    expect(poolCounterSchema.parse(f.db.inspect(poolCounterKey())).unlisted).toBe(12);
  });

  it("spends today's research counter against the budget and says budget_exhausted at the ceiling", async () => {
    const f = v1Fixture(START);
    // 12:00 UTC on 18 September 2026 is 08:00 Eastern; the counter is named by the Eastern date.
    const first = await spendResearch(f.store, { units: 2 });
    expect(first).toMatchObject({ spent: 2, budget: RESEARCH_DAILY_BUDGET_DEFAULT, exhausted: false });
    expect(f.db.inspect(researchCounterKey('2026-09-18'))).toBeDefined();

    const filled = await spendResearch(f.store, { units: RESEARCH_DAILY_BUDGET_DEFAULT });
    expect(filled.exhausted).toBe(true);
    expect((await readResearchCounter(f.store, '2026-09-18'))?.spent).toBe(RESEARCH_DAILY_BUDGET_DEFAULT + 2);
    // A counter that has run out refuses more spend rather than going further past the budget.
    expect(await spendResearch(f.store, { units: 1 })).toMatchObject({ exhausted: true, reason: 'budget_exhausted' });
  });

  it('migrates the queries out of the old research configuration on first read, without deleting it', async () => {
    const f = v1Fixture(START);
    await f.store.transact([f.store.put(ownerResearchSourceKey(), { version: 1, workspaceId: 'ws', pairingId: 'fictional-pairing', revision: 1, state: 'active',
      research: { workspaceId: 'ws', budgetId: 'places-territory-v1',
        audience: { residential: true, regions: ['Providence, RI', 'Boston, MA'], terms: ['property management company'] },
        audienceRevision: 1, sourceRevision: 1, budgetRevision: 1,
        discoveryLimits: { maxCompanies: 20, maxPages: 1, maxBytes: 10000, maxCostMicros: 35000 },
        researchLimits: { maxCompanies: 20, maxPages: 4, maxBytes: 200000, maxCostMicros: 1000 },
        capability: { model: 'fictional-reviewed-model', webSearch: true, searchCostMicros: 35000, modelCostMicros: 1000 }, maxAccountBudgetMicros: 1000,
        permittedSources: [], preparationCommandId: '00000000-0000-4000-8000-000000000001', discoveryProvider: 'places' } }, null)]);

    const settings = await readResearchSettings(f.store);
    expect(settings.record.queries).toEqual(['property management company in Providence, RI', 'property management company in Boston, MA']);
    expect(settings.record.dailyBudget).toBe(RESEARCH_DAILY_BUDGET_DEFAULT);
    expect(settings.record.descriptor).toBeNull();
    // The old item is still there: the migration reads it, it never consumes it.
    expect(f.db.inspect(ownerResearchSourceKey())).toBeDefined();
    expect(f.db.inspect(RESEARCH_SETTINGS_KEY)).toBeDefined();
    // A second read is the stored record, not a second migration.
    expect((await readResearchSettings(f.store)).record.revision).toBe(settings.record.revision);
  });

  it('narrows or replaces the configuration through set_research_config, and refuses a budget past the ceiling', async () => {
    const f = v1Fixture(START);
    const { bearer } = await f.pairDevice();
    const send = (body: Record<string, unknown>) => f.request('POST', '/v1/commands', { authorization: bearer,
      body: { commandId: randomUUID(), kind: 'set_research_config', ...body } });

    // The first read migrates the configuration into existence at revision 1; a client always reads before it writes.
    const before = await readResearchSettings(f.store);
    const applied = f.json(await send({ expectedRevision: before.record.revision, queries: ['property manager in Providence, RI'], dailyBudget: 12 }));
    expect(applied).toMatchObject({ outcome: 'applied', reason: null });
    const after = await readResearchSettings(f.store);
    expect(after.record.queries).toEqual(['property manager in Providence, RI']);
    expect(after.record.dailyBudget).toBe(12);

    const refused = f.json(await send({ expectedRevision: after.record.revision, dailyBudget: RESEARCH_DAILY_BUDGET_CEILING + 1 }));
    expect(refused).toMatchObject({ outcome: 'refused', reason: 'budget_above_ceiling' });
    expect((await readResearchSettings(f.store)).record.dailyBudget).toBe(12);

    const stale = f.json(await send({ expectedRevision: 0, dailyBudget: 5 }));
    expect(stale).toMatchObject({ outcome: 'refused', reason: 'revision_stale' });
  });
});
