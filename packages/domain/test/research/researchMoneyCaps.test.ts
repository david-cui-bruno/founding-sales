import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { withTransaction } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { claimResearchClearance, researchClearanceAvailable } from '../../research/ceilings.ts';
import { beginFirmResearch, ensureResearchCalling } from '../../research/enrichment.ts';
import { reserveAttempt, settleAttempt } from '../../research/reservations.ts';
import { readResearchSpend, recordProviderCall } from '../../research/ledger.ts';
import { worstCaseRunCents } from '../../research/pricing.ts';

const AT = '2026-10-15T14:00:00Z';
const ZONE = 'America/New_York';
const KEY = 'aws_bedrock.extraction';
const CENTS = worstCaseRunCents({ modelName: 'claude-haiku-4-5', maxPagesPerFirm: 4, maxPageBytes: 1_000_000, transport: 'bedrock' });
let database: TestDatabase;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
let context: RepositoryContext;
const tx = <T>(work: () => Promise<T>) => withTransaction(database.session, work);
const preview = () => researchClearanceAvailable(context, { at: AT, providerKey: KEY });
const clearance = (attemptKind: 'first' | 'retry' = 'retry') => tx(() => claimResearchClearance(context, { at: AT, providerKey: KEY, firmId: crm.alpha.firmId, attemptKind }));
const cost = (cents: number, at = AT, providerKey = KEY) => tx(() => recordProviderCall(context, { at, providerKey, costCents: cents, businessTimeZone: ZONE }));
async function reservation(): Promise<string> {
  return (await tx(() => reserveAttempt(context, {
    providerKey: KEY, subjectKind: 'research_run', subjectId: randomUUID(), attempt: 1,
    at: AT, businessTimeZone: ZONE, cents: CENTS, modelName: 'claude-haiku-4-5', maxInputTokens: 100, maxOutputTokens: 100,
  }))).id;
}
beforeAll(async () => {
  database = await createTestDatabase(); seeded = await seedTwoWorkspaces(database.session); crm = await seedCrm(database.session, seeded);
  context = repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), database.session);
});
afterAll(async () => { await database.drop(); });
beforeEach(async () => {
  for (const table of ['research_runs', 'provider_reservations', 'provider_ledger', 'daily_counters', 'research_settings', 'workspace_settings']) await database.session.query(`DELETE FROM ${table}`);
});

describe('research ceilings are cumulative across funding, including Bedrock retries and preview', () => {
  it('the actual Bedrock retry closes refused instead of opening a fourth cent beyond the daily cap', async () => {
    const started = await tx(() => beginFirmResearch(context, { firmId: crm.alpha.firmId, revision: 1, trigger: 'sweep', at: AT, providerKey: KEY }));
    if (!started.ok || started.value.kind !== 'reserved') throw new Error('run not reserved');
    const runId = started.value.runId;
    const rows = await database.session.query<{ id: string }>('SELECT id FROM provider_reservations WHERE subject_id=$1', [runId]);
    const id = rows.rows[0]?.id; if (!id) throw new Error('reservation missing');
    await tx(() => settleAttempt(context, { reservationId: id, at: AT, outcome: { kind: 'estimated' } }));
    await cost(50 - CENTS);
    expect(await tx(() => ensureResearchCalling(context, { runId, at: AT, maxReservations: 3, hasExtraction: true, providerKey: KEY }))).toEqual({ kind: 'closed' });
    expect((await database.session.query('SELECT outcome,refusal_code FROM research_runs WHERE id=$1', [runId])).rows).toEqual([{ outcome: 'refused', refusal_code: 'daily_cost_ceiling' }]);
    expect((await database.session.query('SELECT attempt,state FROM provider_reservations WHERE subject_id=$1', [runId])).rows).toEqual([{ attempt: 1, state: 'estimated' }]);
  });

  it.each(['reserved', 'estimated', 'settled', 'released'] as const)('counts %s exactly once against the daily cap', async state => {
    await cost(50 - CENTS);
    const id = await reservation();
    if (state !== 'reserved') await tx(() => settleAttempt(context, { reservationId: id, at: AT, outcome: state === 'settled' ? { kind: 'settled', cents: CENTS } : { kind: state } }));
    const expected = state === 'released' ? 50 - CENTS : 50;
    expect((await readResearchSpend(context, { at: AT, businessTimeZone: ZONE })).todayCents).toBe(expected);
    for (const attempt of ['first', 'retry'] as const) {
      const result = await clearance(attempt);
      expect(result.ok).toBe(state === 'released');
      if (!result.ok) expect(result.reason).toBe('daily_cost_ceiling');
    }
    expect((await preview()).ok).toBe(state === 'released');
  });

  it('refuses monthly credit spend independently of today, while the cash ceiling remains separate', async () => {
    await cost(1000, '2026-10-01T14:00:00Z');
    expect(await preview()).toEqual({ ok: false, reason: 'monthly_cost_ceiling' });
    expect(await clearance()).toEqual({ ok: false, reason: 'monthly_cost_ceiling' });
  });

  it('excludes last month and respects the workspace midnight rather than UTC midnight', async () => {
    await cost(1000, '2026-10-01T03:59:00Z'); // September 30 in New York.
    expect((await preview()).ok).toBe(true);
    expect((await clearance()).ok).toBe(true);
    await cost(50, '2026-10-16T03:59:00Z'); // Still October 15 in New York.
    expect(await preview()).toEqual({ ok: false, reason: 'daily_cost_ceiling' });
  });

  it('uses the Bedrock worst case in preview and bypasses only the independent cash cap', async () => {
    await database.session.query(`INSERT INTO workspace_settings(workspace_id,setting_key,version,value,changed_by_user_id)
      VALUES($1,'monthly_cash_ceiling_cents',1,'{"cents":0}',$2)`, [seeded.alpha.workspaceId, seeded.alpha.admin.userId]);
    expect((await preview()).ok).toBe(true);
    expect((await clearance()).ok).toBe(true);
    expect(await researchClearanceAvailable(context, { at: AT })).toEqual({ ok: false, reason: 'monthly_cash_ceiling' });
    await cost(50 - CENTS + 1);
    expect(await preview()).toEqual({ ok: false, reason: 'daily_cost_ceiling' });
    expect(await clearance()).toEqual({ ok: false, reason: 'daily_cost_ceiling' });
  });

  it('includes historical cash costs, not reclassified as credits, and sees lowered research limits', async () => {
    await cost(20, AT, 'anthropic_extraction');
    await cost(20);
    await database.session.query('INSERT INTO research_settings(workspace_id,daily_cost_ceiling_cents) VALUES($1,40)', [seeded.alpha.workspaceId]);
    expect(await preview()).toEqual({ ok: false, reason: 'daily_cost_ceiling' });
    expect(await clearance()).toEqual({ ok: false, reason: 'daily_cost_ceiling' });
  });
});
