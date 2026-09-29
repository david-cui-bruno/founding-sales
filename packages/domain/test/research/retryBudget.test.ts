import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { claimResearchClearance, RESEARCH_FIRM_MAX_RESERVATIONS } from '../../research/ceilings.ts';
import { beginFirmResearch, ensureResearchCalling } from '../../research/enrichment.ts';
import { recordProviderCall } from '../../research/ledger.ts';
import { worstCaseRunCents } from '../../research/pricing.ts';
import { updateResearchSettings } from '../../research/settings.ts';

/**
 * Every reservation goes through one clearance, retries included.
 *
 * The fourth review's second P0. A retry's row was inserted in chunk 2 with no money
 * check at all, and the three-row cap that was supposed to bound a firm was counted per
 * *run* — so at the defaults sixteen runs held 48 of the day's 50 cents and one retry
 * took it to 51, two same-day revisions of one firm bought six paid calls rather than
 * three, and a settings change that made a row dearer was never compared with the cents
 * still available.
 *
 * Nothing here opens a socket or calls a provider: a clearance is decided before any
 * port is touched, which is the whole point of it.
 */

const AT = '2026-09-28T14:00:00.000Z';
const ZONE = 'America/New_York';

let database: TestDatabase;
let session: SessionQueryable;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
let context: RepositoryContext;
let admin: RepositoryContext;

/** The reservation size at the defaults: three cents. */
const DEFAULT_WORST_CASE = worstCaseRunCents({
  modelName: 'claude-haiku-4-5',
  maxPagesPerFirm: 4,
  maxPageBytes: 1_000_000,
});
/** And at eight pages a firm, which is the dearest the settings may be set to. */
const WIDEST_WORST_CASE = worstCaseRunCents({
  modelName: 'claude-haiku-4-5',
  maxPagesPerFirm: 8,
  maxPageBytes: 1_000_000,
});

beforeAll(async () => {
  database = await createTestDatabase();
  session = database.session;
  seeded = await seedTwoWorkspaces(session);
  crm = await seedCrm(session, seeded);
  context = repositoryContext(
    workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }),
    session,
  );
  admin = repositoryContext(
    workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
    session,
  );
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  await session.query('DELETE FROM firm_judgments');
  await session.query('DELETE FROM firm_facts');
  await session.query('DELETE FROM research_runs');
  await session.query('DELETE FROM provider_reservations');
  await session.query('DELETE FROM provider_ledger');
  await session.query('DELETE FROM daily_counters');
  await session.query('DELETE FROM funnel_facts');
  await session.query('DELETE FROM research_settings');
});

const reservations = async (): Promise<readonly { attempt: number; state: string; cents: number }[]> => {
  const { rows } = await session.query<{ attempt: number; state: string; cents: number }>(
    `SELECT p.attempt, p.state, p.cents FROM provider_reservations p ORDER BY p.subject_id, p.attempt`,
  );
  return rows;
};

const runOutcomes = async (): Promise<readonly { revision: number; outcome: string; refusal: string | null }[]> => {
  const { rows } = await session.query<{ revision: number; outcome: string; refusal: string | null }>(
    'SELECT revision, outcome, refusal_code AS refusal FROM research_runs ORDER BY revision',
  );
  return rows;
};

/** Chunk 1 of one revision. */
const chunkOne = async (revision: number): Promise<string | null> => {
  const started = await beginFirmResearch(context, {
    firmId: crm.alpha.firmId,
    revision,
    trigger: 'sweep',
    at: AT,
  });
  return started.ok && started.value.kind === 'reserved' ? started.value.runId : null;
};

/** Chunk 2, with the real bound. Each call after the first opens the next attempt. */
const chunkTwo = async (runId: string): Promise<'calling' | 'closed'> =>
  (await ensureResearchCalling(context, { runId, at: AT, maxReservations: RESEARCH_FIRM_MAX_RESERVATIONS })).kind;

describe('a retry is cleared like a first attempt', () => {
  it('refuses the retry that would take the day past its cents', async () => {
    // The review's arithmetic: sixteen runs at three cents is 48 of the day's 50, and a
    // retry needs three more. Fifteen of them are already invoiced here and the
    // sixteenth is this firm's own open reservation — the same 48 cents, in the two
    // forms `readSpend` adds together.
    await recordProviderCall(context, {
      providerKey: 'anthropic_extraction',
      at: AT,
      businessTimeZone: ZONE,
      costCents: DEFAULT_WORST_CASE * 15,
    });
    const runId = await chunkOne(1);
    expect(runId).not.toBeNull();
    expect(await chunkTwo(runId ?? '')).toBe('calling');
    expect((await reservations()).length).toBe(1);

    // The retry. Before the fix this was an unchecked insert, and the day spent 51 of
    // its 50 cents.
    expect(await chunkTwo(runId ?? '')).toBe('closed');
    expect((await reservations()).map(row => row.attempt)).toEqual([1]);
    expect(await runOutcomes()).toEqual([{ revision: 1, outcome: 'refused', refusal: 'daily_cost_ceiling' }]);
  });

  it('holds one firm to three paid attempts a day across every one of its runs', async () => {
    // Revision 1 spends the firm's three reservations: attempt 1, and two retries whose
    // predecessors were ambiguous.
    const first = await chunkOne(1);
    expect(first).not.toBeNull();
    for (let attempt = 1; attempt <= RESEARCH_FIRM_MAX_RESERVATIONS; attempt += 1) {
      expect(await chunkTwo(first ?? ''), `attempt ${String(attempt)}`).toBe('calling');
    }
    expect((await reservations()).map(row => row.attempt)).toEqual([1, 2, 3]);

    // A second revision of the same firm on the same day. It is a different run, which
    // is exactly why a per-run cap enforced nothing: this used to open a fourth
    // reservation and call the model a fourth time for one firm.
    const second = await chunkOne(2);
    expect(second).toBeNull();
    expect((await reservations()).map(row => row.attempt)).toEqual([1, 2, 3]);
    expect(await runOutcomes()).toEqual([
      { revision: 1, outcome: 'running', refusal: null },
      { revision: 2, outcome: 'refused', refusal: 'over_budget' },
    ]);
  });

  it('counts the firm’s rows on their own business date, so tomorrow starts again', async () => {
    const first = await chunkOne(1);
    for (let attempt = 1; attempt <= RESEARCH_FIRM_MAX_RESERVATIONS; attempt += 1) {
      await chunkTwo(first ?? '');
    }
    // The next business day in the workspace's zone. The rows above are dated 28
    // September; these cents and this count are the 29th's.
    const tomorrow = '2026-09-29T14:00:00.000Z';
    const clearance = await claimResearchClearance(context, {
      firmId: crm.alpha.firmId,
      at: tomorrow,
      attemptKind: 'first',
    });
    expect(clearance.ok).toBe(true);
  });

  it('does not let a settings change make a row dearer than the cents that are left', async () => {
    // Six cents a day, and a run at the default four pages is three. Attempt 1 clears.
    await updateResearchSettings(admin, { dailyCostCeilingCents: WIDEST_WORST_CASE });
    const runId = await chunkOne(1);
    expect(runId).not.toBeNull();
    expect(await chunkTwo(runId ?? '')).toBe('calling');

    // Now somebody widens the pages, which makes a reservation dearer than the day has
    // left: the first three cents are still held by attempt 1.
    await updateResearchSettings(admin, { maxPagesPerFirm: 8 });
    expect(WIDEST_WORST_CASE).toBeGreaterThan(DEFAULT_WORST_CASE);
    expect(await chunkTwo(runId ?? '')).toBe('closed');
    expect((await reservations()).map(row => row.cents)).toEqual([DEFAULT_WORST_CASE]);
    expect(await runOutcomes()).toEqual([{ revision: 1, outcome: 'refused', refusal: 'daily_cost_ceiling' }]);
  });

  it('spends one unit of the day’s firm count for a run, however many attempts it makes', async () => {
    const runId = await chunkOne(1);
    for (let attempt = 1; attempt <= RESEARCH_FIRM_MAX_RESERVATIONS; attempt += 1) {
      await chunkTwo(runId ?? '');
    }
    const { rows } = await session.query<{ count: number }>(
      "SELECT count FROM daily_counters WHERE counter_kind = 'research_firm_runs'",
    );
    // Three reservations, one firm, one unit. The count is of firms looked at, and the
    // bound on attempts is the three rows above.
    expect(rows.map(row => Number(row.count))).toEqual([1]);
  });
});
