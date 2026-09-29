import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { jobIdempotencyKey } from '../../jobs/jobKinds.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import {
  beginFirmResearch,
  ensureResearchCalling,
  finishFirmResearch,
  RESEARCH_FIRM_MAX_RESERVATIONS,
} from '../../research/enrichment.ts';
import type { ExtractionProvider, PageFetchProvider } from '../../research/providers.ts';
import {
  markCalling,
  readAttempt,
  reserveAttempt,
  settleAttempt,
} from '../../research/reservations.ts';
import { completeRun, finaliseAbandonedRuns, refuseRun } from '../../research/runs.ts';

/**
 * The abandonment race, at the interleaving that lost money.
 *
 * The sweep read a reservation's state, a live claim marked that row `calling`, and the
 * sweep's later write released the cents — so chunk 3 made a paid call against an
 * authorization that had already been handed back, and nothing anywhere recorded a
 * charge. Three rules close it and each is proved below on **two real sessions**, with
 * one of them holding an uncommitted chunk 2 while the other sweeps:
 *
 *   1. the run row is locked by chunk 2, by chunk 3 and by the sweep, so exactly one of
 *      them decides about a run's money at a time (`lockRun`);
 *   2. `released` is permitted only from `reserved`; from `calling` the settlements are
 *      `settled`, `estimated`, and `released_not_called` for the claim that marked the
 *      row itself (`settleAttempt`);
 *   3. a run whose `research.firm` job still holds a live lease is not abandoned,
 *      whatever its age (`finaliseAbandonedRuns`).
 *
 * No socket is opened: both ports are fakes.
 */

const HOME = '<p>We manage residential property for owners.</p><p>Our maintenance team takes work orders.</p>';
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const hashOf = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const delay = async (milliseconds: number): Promise<void> =>
  await new Promise(resolve => {
    setTimeout(resolve, milliseconds);
  });

/** One page for whichever URL the policy asked for first. */
function fakeFetch(at: string): PageFetchProvider {
  return {
    providerKey: 'company_page',
    fetchPages: async request => ({
      ok: true,
      costCents: 0,
      value: {
        pages: request.urls.slice(0, 1).map(url => ({
          url,
          contentHash: hashOf(HOME),
          contentType: 'text/html; charset=utf-8',
          body: bytes(HOME),
          retrievedAt: at,
          firstParty: true,
        })),
        skipped: {},
      },
    }),
  };
}

function countingExtraction(): ExtractionProvider & { calls: number } {
  const state = {
    calls: 0,
    providerKey: 'anthropic_extraction',
    countInputTokens: async (): Promise<number> => 100,
    extract: async () => {
      state.calls += 1;
      return {
        ok: true as const,
        costCents: 1,
        value: {
          selections: [],
          questions: null,
          opening: null,
          modelName: 'claude-haiku-4-5',
          inputTokens: 4_000,
          outputTokens: 200,
        },
      };
    },
  };
  return state as unknown as ExtractionProvider & { calls: number };
}

let database: TestDatabase;
/** The sweep's session. */
let alpha: SessionQueryable;
/** The worker's session: a second backend connection, so a lock is a real lock. */
let beta: SessionQueryable;
let seeded: TwoWorkspaces;
let crm: SeededCrm;
let sweepContext: RepositoryContext;
let workerContext: RepositoryContext;
let now = '';
/** Thirty-one minutes after `now`: what the sweep is looking for. */
let later = '';

beforeAll(async () => {
  database = await createTestDatabase();
  alpha = database.session;
  beta = await database.appRuntimeSession();
  seeded = await seedTwoWorkspaces(alpha);
  crm = await seedCrm(alpha, seeded);
  const scope = workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' });
  sweepContext = repositoryContext(scope, alpha);
  workerContext = repositoryContext(scope, beta);
});

afterAll(async () => {
  await database.drop();
});

beforeEach(async () => {
  // A test that left a transaction open — a lock timeout, a failed expectation between
  // BEGIN and COMMIT — must not poison the next one.
  await alpha.query('ROLLBACK');
  await beta.query('ROLLBACK');
  await alpha.query('DELETE FROM firm_judgments');
  await alpha.query('DELETE FROM firm_facts');
  await alpha.query('DELETE FROM research_runs');
  await alpha.query('DELETE FROM evidence_items');
  await alpha.query('DELETE FROM provider_reservations');
  await alpha.query('DELETE FROM provider_ledger');
  await alpha.query('DELETE FROM daily_counters');
  await alpha.query('DELETE FROM jobs');
  await alpha.query('DELETE FROM funnel_facts');
  await alpha.query('DELETE FROM research_settings');
  const clock = await alpha.query<{ now: Date; later: Date }>(
    "SELECT now() AS now, now() + interval '31 minutes' AS later",
  );
  now = (clock.rows[0]?.now ?? new Date()).toISOString();
  later = (clock.rows[0]?.later ?? new Date()).toISOString();
});

/** Every reservation of this workspace, oldest attempt first. */
const reservations = async (): Promise<readonly { attempt: number; state: string; cents: number; settled: number }[]> => {
  const { rows } = await alpha.query<{ attempt: number; state: string; cents: number; settled: number }>(
    `SELECT attempt, state, cents, settled_cents AS settled FROM provider_reservations
      WHERE workspace_id = $1 ORDER BY attempt`,
    [seeded.alpha.workspaceId],
  );
  return rows;
};

const runRow = async (): Promise<{ outcome: string; refusal: string | null; cost: number; estimated: boolean }> => {
  const { rows } = await alpha.query<{ outcome: string; refusal: string | null; cost: number; estimated: boolean }>(
    `SELECT outcome, refusal_code AS refusal, cost_cents::int AS cost, cost_estimated AS estimated
       FROM research_runs WHERE workspace_id = $1`,
    [seeded.alpha.workspaceId],
  );
  return rows[0] ?? { outcome: 'missing', refusal: null, cost: -1, estimated: false };
};

/** Chunk 1, on the worker's session. Returns the run id. */
const chunkOne = async (revision = 1): Promise<string> => {
  const started = await beginFirmResearch(workerContext, {
    firmId: crm.alpha.firmId,
    revision,
    trigger: 'sweep',
    at: now,
  });
  if (!started.ok || started.value.kind !== 'reserved') throw new Error('chunk 1 did not reserve');
  return started.value.runId;
};

/**
 * The job row of this run, as the queue holds it mid-claim.
 *
 * `leaseInterval` is how long from now the claim's lease runs: an hour is a worker that
 * is alive, minus a second is one that is gone.
 */
const claimJobRow = async (revision: number, leaseInterval: string): Promise<void> => {
  await alpha.query(
    `INSERT INTO jobs (workspace_id, kind, payload, idempotency_key, state, lease_owner, lease_expires_at)
     VALUES ($1, 'research.firm', $2::jsonb, $3, 'running', 'worker-beta', now() + $4::interval)`,
    [
      seeded.alpha.workspaceId,
      JSON.stringify({ firmId: crm.alpha.firmId, revision, trigger: 'sweep' }),
      jobIdempotencyKey.researchFirm(crm.alpha.firmId, revision),
      leaseInterval,
    ],
  );
};

describe('a reservation is never released under a live paid call', () => {
  it('leaves a calling row alone when a third party asks to release it', async () => {
    const runId = await chunkOne();
    const reserved = await readAttempt(workerContext, {
      subjectKind: 'research_run',
      subjectId: runId,
      attempt: 1,
    });
    expect(reserved?.state).toBe('reserved');
    expect(await markCalling(workerContext, reserved?.id ?? '')).toBe(true);

    // The sweep's release, on a row that says a call may be in flight. Nothing moves:
    // "no call happened" is a fact about a `reserved` row and a guess about this one.
    expect(await settleAttempt(sweepContext, { reservationId: reserved?.id ?? '', at: now, outcome: { kind: 'released' } })).toBeNull();
    expect(await reservations()).toEqual([{ attempt: 1, state: 'calling', cents: 3, settled: 0 }]);

    // The claim that marked it may, because it is the one that knows it did not call.
    expect(
      await settleAttempt(workerContext, {
        reservationId: reserved?.id ?? '',
        at: now,
        outcome: { kind: 'released_not_called' },
      }),
    ).toEqual({ recordedCents: 0, state: 'released' });
    expect(await reservations()).toEqual([{ attempt: 1, state: 'released', cents: 3, settled: 0 }]);
  });

  it('does not abandon a run whose job still holds its lease, and the call settles', async () => {
    const runId = await chunkOne();
    // A claim that is alive: the lease runs an hour past the instant the sweep is asking
    // about. Thirty minutes of `running` is not evidence of a crash on its own.
    await claimJobRow(1, '1 hour');

    // Chunk 2 commits on the worker's session, in its own transaction as the runner
    // would. The barrier: the sweep asks while this transaction is still open.
    await beta.query('BEGIN');
    const permission = await ensureResearchCalling(workerContext, {
      runId,
      at: now,
      maxReservations: RESEARCH_FIRM_MAX_RESERVATIONS,
      hasExtraction: true,
    });
    expect(permission.kind).toBe('calling');

    await alpha.query('BEGIN');
    await alpha.query("SET LOCAL lock_timeout = '20s'");
    const sweeping = finaliseAbandonedRuns(sweepContext, { at: later });
    await delay(150);
    await beta.query('COMMIT');
    // Nothing was abandoned: the job is live, so the run is somebody's work in progress.
    expect(await sweeping).toBe(0);
    await alpha.query('COMMIT');
    expect(await reservations()).toEqual([{ attempt: 1, state: 'calling', cents: 3, settled: 0 }]);

    // And chunk 3 makes its call against an authorization that is still there.
    const extraction = countingExtraction();
    const finished = await finishFirmResearch(workerContext, {
      runId,
      firmId: crm.alpha.firmId,
      revision: 1,
      at: now,
      attempt: permission.kind === 'calling' ? permission.attempt : 1,
      mayCall: true,
      pageFetch: fakeFetch(now),
      extraction,
    });
    expect(finished.ok).toBe(true);
    expect(extraction.calls).toBe(1);
    // Settled by id at the figure the provider reported: one call, one charge.
    expect(await reservations()).toEqual([{ attempt: 1, state: 'settled', cents: 3, settled: 1 }]);
    expect(await runRow()).toEqual({ outcome: 'completed', refusal: null, cost: 1, estimated: false });
  });

  it('charges rather than releases when the sweep wins the lock and the lease had expired', async () => {
    const runId = await chunkOne();
    // The other arm of the brief's assertion: no live claim, so this run really is
    // abandoned — and the sweep still may not *release* a row marked `calling`.
    await claimJobRow(1, '-1 second');

    await beta.query('BEGIN');
    const permission = await ensureResearchCalling(workerContext, {
      runId,
      at: now,
      maxReservations: RESEARCH_FIRM_MAX_RESERVATIONS,
      hasExtraction: true,
    });
    expect(permission.kind).toBe('calling');

    // The sweep now blocks on the run row this chunk holds, rather than reading a state
    // that is about to change under it.
    await alpha.query('BEGIN');
    await alpha.query("SET LOCAL lock_timeout = '20s'");
    const sweeping = finaliseAbandonedRuns(sweepContext, { at: later });
    // Nothing is asked of the sweep's session while it waits: one connection runs one
    // statement at a time, so a read here would queue behind the lock it is blocked on.
    await delay(150);
    await beta.query('COMMIT');
    expect(await sweeping).toBe(1);
    await alpha.query('COMMIT');

    // The cents are charged, not handed back: nobody can know whether the vanished
    // worker made the call, and zero is the one answer that is certainly wrong.
    expect(await reservations()).toEqual([{ attempt: 1, state: 'estimated', cents: 3, settled: 3 }]);
    expect(await runRow()).toEqual({ outcome: 'failed', refusal: 'lease_lost', cost: 3, estimated: true });

    // And chunk 3, arriving late with its cursor, refuses to call at all.
    const extraction = countingExtraction();
    const finished = await finishFirmResearch(workerContext, {
      runId,
      firmId: crm.alpha.firmId,
      revision: 1,
      at: now,
      attempt: permission.kind === 'calling' ? permission.attempt : 1,
      mayCall: true,
      pageFetch: fakeFetch(now),
      extraction,
    });
    expect(finished.ok).toBe(true);
    expect(extraction.calls).toBe(0);
    // The sweep's terminal row is untouched: one run, one outcome, one cost.
    expect(await runRow()).toEqual({ outcome: 'failed', refusal: 'lease_lost', cost: 3, estimated: true });
    expect(await reservations()).toEqual([{ attempt: 1, state: 'estimated', cents: 3, settled: 3 }]);
  });

  it('refuses to close a run somebody else has already closed', async () => {
    const runId = await chunkOne();
    // The terminal guard. Without `WHERE outcome = 'running'` a claim returning from a
    // call would overwrite the sweep's outcome, its refusal code and its estimated cents
    // with a cheaper story of its own.
    expect(await refuseRun(sweepContext, { runId, at: now, refusalCode: 'lease_lost', costCents: 3, costEstimated: true })).toBe(true);
    expect(
      await completeRun(workerContext, {
        runId,
        at: now,
        pagesFetched: 1,
        factsRecorded: 0,
        extraction: 'used',
        modelName: 'claude-haiku-4-5',
        costCents: 1,
      }),
    ).toBe(false);
    expect(await runRow()).toEqual({ outcome: 'refused', refusal: 'lease_lost', cost: 3, estimated: true });
    expect(await refuseRun(workerContext, { runId, at: now, refusalCode: 'no_sources' })).toBe(false);
    expect(await runRow()).toEqual({ outcome: 'refused', refusal: 'lease_lost', cost: 3, estimated: true });
  });

  it('keeps a reservation that was never marked as the releasable one', async () => {
    // The ordinary `reserved → released`, which nothing about the new rule narrows: a
    // run that asked no provider anything hands its cents back to the day's budget.
    const runId = await chunkOne();
    const second = await reserveAttempt(workerContext, {
      providerKey: 'anthropic_extraction',
      subjectKind: 'research_run',
      subjectId: runId,
      attempt: 2,
      at: now,
      businessTimeZone: 'America/New_York',
      cents: 3,
      modelName: 'claude-haiku-4-5',
      maxInputTokens: 24_000,
      maxOutputTokens: 600,
    });
    expect(await settleAttempt(sweepContext, { reservationId: second.id, at: now, outcome: { kind: 'released' } })).toEqual({
      recordedCents: 0,
      state: 'released',
    });
  });
});
