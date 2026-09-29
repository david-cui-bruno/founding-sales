import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '@fss/domain/db/workspaceScope.ts';
import { runTwiceUnderStolenLease } from '@fss/domain/jobs/atLeastOnce.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { jobIdempotencyKey } from '@fss/domain/jobs/jobKinds.ts';
import { requeueDeadJob } from '@fss/domain/jobs/jobStore.ts';
import type { QueryOutcome, QueryResultRowLike, SessionQueryable } from '@fss/domain/db/queryable.ts';
import type { ExtractionProvider, PageFetchProvider } from '@fss/domain/research/providers.ts';
import { enqueueJob } from '@fss/domain/jobs/jobStore.ts';
import { runClaimedJob, runOnce } from '../src/runner/jobRunner.ts';
import { runSchedulerPass } from '../src/scheduler/schedulerPass.ts';
import {
  parseResearchFirmPayload,
  researchFirmJobHandler,
  researchSweepJobHandler,
  researchSweepSource,
} from '../src/handlers/research.ts';
import { composeResearch, describeResearch } from '../src/bootstrap/main.ts';

/**
 * The two research jobs as the worker runs them (specification 13.1, 13.2,
 * Appendix G 1 and 2).
 *
 * Three things are proved here and nowhere else: the registry accepts both kinds
 * under the protection `jobKinds.ts` names; the pass materializes one sweep per
 * workspace per business date however many times it runs; and the firm run produces
 * one set of effects under a real stolen lease, which `docs/greenfield/jobs.md`
 * makes mandatory for every lane that registers a handler.
 *
 * The stolen-lease probe matters here because the effect costs money. A handler that
 * ran twice would call the model twice for one firm at one revision, and
 * `research_runs_one_per_revision` is what stops it — proved rather than asserted.
 *
 * No socket is opened: both ports are fakes. `example.test` is reserved by RFC 6761.
 */

const HOME = '<p>We manage residential property for owners.</p><p>Our maintenance team handles work orders.</p>';
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const hashOf = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function countingFetch(): PageFetchProvider & { calls: number } {
  const state = {
    calls: 0,
    providerKey: 'company_page',
    fetchPages: async (input: { readonly urls: readonly string[] }) => {
      state.calls += 1;
      return {
        ok: true as const,
        costCents: 0,
        value: {
          pages: input.urls.includes('https://alpha.example.test/')
            ? [
                {
                  url: 'https://alpha.example.test/',
                  contentHash: hashOf(HOME),
                  contentType: 'text/html',
                  body: bytes(HOME),
                  retrievedAt: new Date().toISOString(),
                  firstParty: true,
                },
              ]
            : [],
          skipped: {},
        },
      };
    },
  };
  return state as unknown as PageFetchProvider & { calls: number };
}

function countingExtraction(): ExtractionProvider & { calls: number } {
  const state = {
    calls: 0,
    providerKey: 'anthropic_extraction',
    extract: async () => {
      state.calls += 1;
      return {
        ok: true as const,
        costCents: 1,
        value: {
          selections: [{ key: 'target_fit', sourceReference: 'https://alpha.example.test/', blockId: 'b1' }],
          questions: ['How do you take work orders?', 'Who handles them?'] as const,
          opening: 'I saw your maintenance page.',
          modelName: 'claude-haiku-4-5',
          inputTokens: 4_000,
          outputTokens: 200,
        },
      };
    },
  };
  return state as unknown as ExtractionProvider & { calls: number };
}

/** A fetch that throws rather than returning a failure. The adapter's worst day. */
const throwingFetch: PageFetchProvider = {
  providerKey: 'company_page',
  fetchPages: async () => {
    throw new Error('ECONNRESET');
  },
};

/** An extraction that throws *after* the fetch has already recorded evidence. */
const throwingExtraction: ExtractionProvider = {
  providerKey: 'anthropic_extraction',
  extract: async () => {
    throw new Error('socket hang up');
  },
};

/**
 * A session that throws once, on the first statement matching `pattern`.
 *
 * Used to break chunk 2 *after* a successful extraction, which is the failure the two
 * chunks exist for: the money is spent and the transaction that would have recorded the
 * result cannot commit. Everything chunk 1 wrote has to survive it.
 */
function failingOnce(session: SessionQueryable, pattern: RegExp): SessionQueryable {
  let armed = true;
  return {
    query: async <Row extends QueryResultRowLike>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryOutcome<Row>> => {
      if (armed && pattern.test(text)) {
        armed = false;
        throw Object.assign(new Error('the fact insert failed'), { code: '40001' });
      }
      return await session.query<Row>(text, values);
    },
  };
}

const NO_BACKOFF = { baseSeconds: 0, factor: 1, maximumSeconds: 0, jitterFraction: 0 };

describe('the research jobs', () => {
  let database: TestDatabase;
  let workspaceId = '';
  let firmId = '';
  let adminUserId = '';
  let now = '';

  const context = (): RepositoryContext =>
    repositoryContext(workspaceScope(workspaceId, { kind: 'system', component: 'worker' }), database.session);

  beforeAll(async () => {
    database = await createTestDatabase();
    const workspace = await database.session.query<{ id: string }>(
      "INSERT INTO workspaces (slug, display_name) VALUES ('alpha', 'Alpha') RETURNING id",
    );
    workspaceId = workspace.rows[0]?.id ?? '';
    const firm = await database.session.query<{ id: string }>(
      "INSERT INTO firms (workspace_id, name, website) VALUES ($1, 'Alpha Holdings', 'https://alpha.example.test/') RETURNING id",
      [workspaceId],
    );
    firmId = firm.rows[0]?.id ?? '';
    // An admin membership, for the audited requeue `requeueDeadJob` asks for.
    const user = await database.session.query<{ id: string }>(
      `INSERT INTO users (google_sub, email, display_name)
       VALUES ('research-handlers-admin', 'admin@alpha.example.test', 'Alpha Admin') RETURNING id`,
    );
    adminUserId = user.rows[0]?.id ?? '';
    await database.session.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'admin')",
      [workspaceId, adminUserId],
    );
    const clock = await database.session.query<{ now: Date }>('SELECT now() AS now');
    now = (clock.rows[0]?.now ?? new Date()).toISOString();
  });

  afterAll(async () => {
    await database.drop();
  });

  beforeEach(async () => {
    await database.session.query('DELETE FROM firm_judgments');
    await database.session.query('DELETE FROM firm_facts');
    await database.session.query('DELETE FROM research_runs');
    await database.session.query('DELETE FROM evidence_items');
    await database.session.query('DELETE FROM provider_ledger');
    await database.session.query('DELETE FROM daily_counters');
    await database.session.query('DELETE FROM jobs');
    await database.session.query('DELETE FROM research_settings');
  });

  it('registers both kinds under Appendix C’s protection, and no other', () => {
    const options = { pageFetch: countingFetch() };
    const registry = new HandlerRegistry().register(researchFirmJobHandler(options)).register(researchSweepJobHandler(options));
    expect(registry.get('research.firm')?.protection).toBe('business_uniqueness');
    expect(registry.get('research.sweep')?.protection).toBe('business_uniqueness');
    // Chunked, and the boundary is where the money is: chunk 1 opens the run, consumes
    // the day's count and reserves the worst case; chunk 2 makes the calls. Before the
    // split, a lease reclaimed during the extraction rolled back the accounting of a
    // call that had already been billed.
    expect(registry.get('research.firm')?.chunked).toBe(true);
    // The sweep is one bounded pass and stays unchunked.
    expect(registry.get('research.sweep')?.chunked).toBeUndefined();
  });

  it('refuses a payload that names no firm, no revision or a trigger that is not one', () => {
    expect(parseResearchFirmPayload({})).toBeNull();
    expect(parseResearchFirmPayload({ firmId, revision: 0, trigger: 'sweep' })).toBeNull();
    expect(parseResearchFirmPayload({ firmId, revision: 1, trigger: 'guesswork' })).toBeNull();
    expect(parseResearchFirmPayload({ firmId, revision: 1, trigger: 'sweep' })).toEqual({
      firmId,
      revision: 1,
      trigger: 'sweep',
    });
  });

  it('calls each provider once for one firm at one revision, under a stolen lease', async () => {
    const pageFetch = countingFetch();
    const extraction = countingExtraction();
    const registry = new HandlerRegistry().register(researchFirmJobHandler({ pageFetch, extraction }));
    const countFacts = async (): Promise<number> => {
      const { rows } = await database.session.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM firm_facts WHERE workspace_id = $1',
        [workspaceId],
      );
      return rows[0]?.count ?? 0;
    };

    const report = await runTwiceUnderStolenLease({
      session: database.session,
      registry,
      run: runClaimedJob,
      workspaceId,
      kind: 'research.firm',
      idempotencyKey: jobIdempotencyKey.researchFirm(firmId, 1),
      payload: { firmId, revision: 1, trigger: 'sweep' },
      countEffects: countFacts,
    });

    expect(report.freshOutcome).toBe('completed');
    expect(report.staleOutcome).toBe('lease_lost');
    expect(report.effectsAfter - report.effectsBefore).toBe(1);
    expect(report.freshFencingToken).not.toBe(report.staleFencingToken);

    const counts = await database.session.query<{ runs: number; evidence: number }>(
      `SELECT (SELECT count(*) FROM research_runs)::int AS runs,
              (SELECT count(*) FROM evidence_items)::int AS evidence`,
    );
    expect(counts.rows[0]).toEqual({ runs: 1, evidence: 1 });
    // The stolen worker's whole transaction rolled back, so the model was asked once
    // *for an effect*. The second attempt spent no cents that survived.
    const ledger = await database.session.query<{ cost: number; reserved: number }>(
      `SELECT coalesce(sum(cost_cents), 0)::int AS cost,
              coalesce(sum(reserved_cents), 0)::int AS reserved FROM provider_ledger`,
    );
    // Ends at the invoiced figure with nothing still held: the happy path settles the
    // reservation rather than leaving the month over-counted.
    expect(ledger.rows[0]).toEqual({ cost: 1, reserved: 0 });
  });

  it('commits a failed run and completes the job, so a paid call keeps its accounting', async () => {
    // The rule the whole arrangement exists for. The runner wraps one job in one
    // transaction and the run's paid calls happen inside it, so a throw would roll back
    // the run row, the evidence, the ledger cents *and* the consumed daily count while
    // the money stayed spent at the provider — and then the ladder would call again
    // against a budget with no record of the first attempt.
    const cases = [
      {
        name: 'the extraction throws after the fetch succeeded',
        options: { pageFetch: countingFetch(), extraction: throwingExtraction },
        evidence: 1,
        // Two providers were asked, so there are two ledger rows and one failure.
        ledger: 2,
      },
      {
        // Two rows here as well: the extraction's row exists from chunk 1's
        // reservation, even though the fetch never got far enough to ask it anything.
        // Its reserved cents went back; the row stays, because a ledger row is the
        // record that a run was authorized against this provider today.
        name: 'the fetch itself throws',
        options: { pageFetch: throwingFetch },
        evidence: 0,
        ledger: 2,
      },
    ] as const;

    for (const scenario of cases) {
      await database.session.query('DELETE FROM firm_judgments');
      await database.session.query('DELETE FROM firm_facts');
      await database.session.query('DELETE FROM research_runs');
      await database.session.query('DELETE FROM evidence_items');
      await database.session.query('DELETE FROM provider_ledger');
      await database.session.query('DELETE FROM daily_counters');
      await database.session.query('DELETE FROM jobs');

      const registry = new HandlerRegistry().register(researchFirmJobHandler(scenario.options));
      const key = jobIdempotencyKey.researchFirm(firmId, 1);
      await enqueueJob(database.session, {
        workspaceId,
        kind: 'research.firm',
        idempotencyKey: key,
        payload: { firmId, revision: 1, trigger: 'sweep' },
        maxAttempts: 3,
      });

      const report = await runOnce(database.session, { registry, owner: 'worker-research-failure', limit: 5 });
      // The job is done. There is no ladder for a provider failure, because a retry has
      // to be a new revision with a new clearance — which is the sweep's business.
      expect(report.completed, scenario.name).toBe(1);
      expect(report.failed, scenario.name).toBe(0);

      const state = await database.session.query<{
        runs: number;
        outcome: string | null;
        refusal: string | null;
        evidence: number;
        ledger: number;
        failures: number;
        counters: number;
        counter_value: number | null;
        job_status: string | null;
      }>(
        `SELECT (SELECT count(*) FROM research_runs)::int AS runs,
                (SELECT outcome FROM research_runs LIMIT 1) AS outcome,
                (SELECT refusal_code FROM research_runs LIMIT 1) AS refusal,
                (SELECT count(*) FROM evidence_items)::int AS evidence,
                (SELECT count(*) FROM provider_ledger)::int AS ledger,
                (SELECT coalesce(sum(failures), 0) FROM provider_ledger)::int AS failures,
                (SELECT count(*) FROM daily_counters)::int AS counters,
                (SELECT max(count) FROM daily_counters)::int AS counter_value,
                (SELECT state FROM jobs WHERE idempotency_key = $1) AS job_status`,
        [key],
      );
      expect(state.rows[0], scenario.name).toEqual({
        runs: 1,
        outcome: 'failed',
        refusal: 'provider_failure',
        // The pages the fetch did record are kept: a page the firm published is worth
        // keeping whatever a model later failed to say about it.
        evidence: scenario.evidence,
        // The ledger rows exist and count the failure, which is what says the attempt
        // happened at all.
        ledger: scenario.ledger,
        failures: 1,
        // And the day's count is still spent, so three failures are three units rather
        // than an unbounded loop.
        counters: 1,
        counter_value: 1,
        job_status: 'done',
      });

      // A second claim of the same job key does nothing: the key is taken and the
      // revision's run row is already there.
      const again = await enqueueJob(database.session, {
        workspaceId,
        kind: 'research.firm',
        idempotencyKey: key,
        payload: { firmId, revision: 1, trigger: 'sweep' },
        maxAttempts: 3,
      });
      expect(again.inserted, scenario.name).toBe(false);
      const second = await runOnce(database.session, { registry, owner: 'worker-research-failure', limit: 5 });
      expect(second.completed + second.failed, scenario.name).toBe(0);
      const after = await database.session.query<{ runs: number }>('SELECT count(*)::int AS runs FROM research_runs');
      expect(after.rows[0]?.runs, scenario.name).toBe(1);
    }
  });

  it('keeps the run, the reservation and the count when chunk 2 rolls back, and resumes from the cursor', async () => {
    const pageFetch = countingFetch();
    const extraction = countingExtraction();
    const registry = new HandlerRegistry().register(researchFirmJobHandler({ pageFetch, extraction }));
    const key = jobIdempotencyKey.researchFirm(firmId, 1);
    await enqueueJob(database.session, {
      workspaceId,
      kind: 'research.firm',
      idempotencyKey: key,
      payload: { firmId, revision: 1, trigger: 'sweep' },
      maxAttempts: 3,
    });

    // Chunk 1 commits; the extraction answers; and then the fact insert fails, which
    // rolls chunk 2 back. Before the split this rolled back the run row, the ledger and
    // the counter too, while the model call stayed billed.
    const broken = failingOnce(database.session, /INSERT INTO firm_facts/iu);
    const first = await runOnce(broken, { registry, owner: 'worker-chunk-rollback', limit: 5, backoff: NO_BACKOFF, random: () => 0 });
    expect(first.failed).toBe(1);
    expect(extraction.calls).toBe(1);

    const after = await database.session.query<{
      runs: number;
      outcome: string | null;
      facts: number;
      counter: number | null;
      reserved: number;
      total: number;
      progress: string | null;
    }>(
      `SELECT (SELECT count(*) FROM research_runs)::int AS runs,
              (SELECT outcome FROM research_runs LIMIT 1) AS outcome,
              (SELECT count(*) FROM firm_facts)::int AS facts,
              (SELECT max(count) FROM daily_counters)::int AS counter,
              (SELECT coalesce(sum(reserved_cents), 0) FROM provider_ledger)::int AS reserved,
              (SELECT coalesce(sum(cost_cents + reserved_cents), 0) FROM provider_ledger)::int AS total,
              (SELECT payload->'progress'->>'runId' FROM jobs WHERE idempotency_key = $1) AS progress`,
      [key],
    );
    // The run row and its reservation survived; the facts did not, because that is the
    // work chunk 2 was rolled back for.
    expect(after.rows[0]).toMatchObject({ runs: 1, outcome: 'running', facts: 0, counter: 1, reserved: 3 });
    // The ledger never drops below what was reserved, whatever chunk 2 did.
    expect(after.rows[0]?.total).toBeGreaterThanOrEqual(3);
    // And the cursor is still there, naming the run chunk 2 must resume.
    expect(after.rows[0]?.progress).toEqual(expect.any(String));

    // The second claim resumes at chunk 2: no second run row, no second unit of the
    // day's count, and the reservation turns into the invoiced figure.
    const second = await runOnce(database.session, { registry, owner: 'worker-chunk-resume', limit: 5, backoff: NO_BACKOFF, random: () => 0 });
    expect(second.completed).toBe(1);
    expect(extraction.calls).toBe(2);
    const settled = await database.session.query<{
      runs: number;
      outcome: string | null;
      counter: number | null;
      reserved: number;
      cost: number;
    }>(
      `SELECT (SELECT count(*) FROM research_runs)::int AS runs,
              (SELECT outcome FROM research_runs LIMIT 1) AS outcome,
              (SELECT max(count) FROM daily_counters)::int AS counter,
              (SELECT coalesce(sum(reserved_cents), 0) FROM provider_ledger)::int AS reserved,
              (SELECT coalesce(sum(cost_cents), 0) FROM provider_ledger)::int AS cost`,
    );
    expect(settled.rows[0]).toEqual({ runs: 1, outcome: 'completed', counter: 1, reserved: 0, cost: 1 });
  });

  it('finalises a run abandoned between the chunks as lease_lost, keeping its reservation as the cost', async () => {
    // A worker that disappears after chunk 1 — a pause past its lease, a container
    // replaced, a failover — leaves a row `running` with cents held against it, and
    // `run_in_progress` refuses the firm a new revision while it sits there.
    const handler = researchFirmJobHandler({ pageFetch: countingFetch(), extraction: countingExtraction() });
    const chunkOne = await handler.handle({
      session: database.session,
      scope: workspaceScope(workspaceId, { kind: 'system', component: 'worker' }),
      job: {
        id: '00000000-0000-4000-8000-00000000000a',
        workspaceId,
        kind: 'research.firm',
        idempotencyKey: jobIdempotencyKey.researchFirm(firmId, 1),
        payload: { firmId, revision: 1, trigger: 'sweep' },
        attempt: 1,
        maxAttempts: 3,
        fencingToken: '1',
        leaseOwner: 'test',
        leaseExpiresAt: now,
      },
    });
    expect(chunkOne).toMatchObject({ done: false });
    // Thirty-one minutes ago, which is what the sweep is looking for.
    await database.session.query("UPDATE research_runs SET started_at = now() - interval '31 minutes'");

    const sweep = researchSweepJobHandler({ pageFetch: countingFetch() });
    await sweep.handle({
      session: database.session,
      scope: workspaceScope(workspaceId, { kind: 'system', component: 'worker' }),
      job: {
        id: '00000000-0000-4000-8000-00000000000b',
        workspaceId,
        kind: 'research.sweep',
        idempotencyKey: 'research-sweep:alpha:2026-09-28',
        payload: { businessDate: '2026-09-28' },
        attempt: 1,
        maxAttempts: 2,
        fencingToken: '1',
        leaseOwner: 'test',
        leaseExpiresAt: now,
      },
    });

    const closed = await database.session.query<{
      outcome: string;
      refusal: string | null;
      estimated: boolean;
      reserved: number;
    }>(
      `SELECT (SELECT outcome FROM research_runs LIMIT 1) AS outcome,
              (SELECT refusal_code FROM research_runs LIMIT 1) AS refusal,
              (SELECT cost_estimated FROM research_runs LIMIT 1) AS estimated,
              (SELECT coalesce(sum(reserved_cents), 0) FROM provider_ledger)::int AS reserved`,
    );
    // The reservation **stays**: the last thing that worker did before disappearing may
    // well have been to make the call, and releasing it would be claiming it did not.
    expect(closed.rows[0]).toEqual({ outcome: 'failed', refusal: 'lease_lost', estimated: true, reserved: 3 });
  });

  it('resumes at chunk 2 after an admin requeue, without reserving twice', async () => {
    const pageFetch = countingFetch();
    const extraction = countingExtraction();
    const registry = new HandlerRegistry().register(
      // One attempt, so the rolled-back chunk 2 buries the job at once.
      researchFirmJobHandler({ pageFetch, extraction, maxAttempts: 1 }),
    );
    const key = jobIdempotencyKey.researchFirm(firmId, 1);
    await enqueueJob(database.session, {
      workspaceId,
      kind: 'research.firm',
      idempotencyKey: key,
      payload: { firmId, revision: 1, trigger: 'sweep' },
      maxAttempts: 1,
    });
    const broken = failingOnce(database.session, /INSERT INTO firm_facts/iu);
    await runOnce(broken, { registry, owner: 'worker-requeue', limit: 5, backoff: NO_BACKOFF, random: () => 0 });

    const dead = await database.session.query<{ id: string; state: string }>(
      'SELECT id, state FROM jobs WHERE idempotency_key = $1',
      [key],
    );
    expect(dead.rows[0]?.state).toBe('dead');

    // `requeueDeadJob` clears the chunk budget and keeps the cursor, which is exactly
    // what stops a requeue from opening a second run and reserving a second time.
    const admin = repositoryContext(
      workspaceScope(workspaceId, { kind: 'user', userId: adminUserId, role: 'admin' }),
      database.session,
    );
    expect(await requeueDeadJob(admin, { jobId: dead.rows[0]?.id ?? '', reason: 'test' })).toMatchObject({
      requeued: true,
    });

    await runOnce(database.session, { registry, owner: 'worker-requeued', limit: 5, backoff: NO_BACKOFF, random: () => 0 });
    const settled = await database.session.query<{
      runs: number;
      outcome: string | null;
      counter: number | null;
      reserved: number;
      cost: number;
    }>(
      `SELECT (SELECT count(*) FROM research_runs)::int AS runs,
              (SELECT outcome FROM research_runs LIMIT 1) AS outcome,
              (SELECT max(count) FROM daily_counters)::int AS counter,
              (SELECT coalesce(sum(reserved_cents), 0) FROM provider_ledger)::int AS reserved,
              (SELECT coalesce(sum(cost_cents), 0) FROM provider_ledger)::int AS cost`,
    );
    // One run, one unit of the day's count, nothing still reserved, one invoice.
    expect(settled.rows[0]).toEqual({ runs: 1, outcome: 'completed', counter: 1, reserved: 0, cost: 1 });
  });

  it('materializes one sweep per workspace per business date, however many passes run', async () => {
    const report = await runSchedulerPass(database.session, { sources: [researchSweepSource()], now });
    expect(report.inserted).toBe(1);
    const second = await runSchedulerPass(database.session, { sources: [researchSweepSource()], now });
    expect(second.inserted).toBe(0);

    const { rows } = await database.session.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM jobs WHERE kind = 'research.sweep'",
    );
    expect(rows[0]?.count).toBe(1);
  });

  it('inserts no sweep for a workspace that turned research off', async () => {
    await database.session.query(
      'INSERT INTO research_settings (workspace_id, enabled) VALUES ($1, false)',
      [workspaceId],
    );
    const report = await runSchedulerPass(database.session, { sources: [researchSweepSource()], now });
    expect(report.inserted).toBe(0);
  });

  it('enqueues a firm run from the sweep, bounded by the day’s firm ceiling', async () => {
    await database.session.query(
      'INSERT INTO research_settings (workspace_id, daily_firm_ceiling) VALUES ($1, 5)',
      [workspaceId],
    );
    const handler = researchSweepJobHandler({ pageFetch: countingFetch() });
    await handler.handle({
      session: database.session,
      scope: workspaceScope(workspaceId, { kind: 'system', component: 'worker' }),
      job: {
        id: '00000000-0000-4000-8000-000000000000',
        workspaceId,
        kind: 'research.sweep',
        idempotencyKey: 'research-sweep:alpha:2026-09-28',
        payload: { businessDate: '2026-09-28' },
        attempt: 1,
        maxAttempts: 2,
        fencingToken: '1',
        leaseOwner: 'test',
        leaseExpiresAt: now,
      },
    });
    const { rows } = await database.session.query<{ idempotency_key: string }>(
      "SELECT idempotency_key FROM jobs WHERE kind = 'research.firm'",
    );
    expect(rows.map(row => row.idempotency_key)).toEqual([jobIdempotencyKey.researchFirm(firmId, 1)]);
  });

  it('records the pages and completes when the deployment has no model key', async () => {
    const pageFetch = countingFetch();
    const handler = researchFirmJobHandler({ pageFetch });
    const claimed = {
      id: '00000000-0000-4000-8000-000000000001',
      workspaceId,
      kind: 'research.firm' as const,
      idempotencyKey: jobIdempotencyKey.researchFirm(firmId, 1),
      payload: { firmId, revision: 1, trigger: 'sweep' } as Readonly<Record<string, unknown>>,
      attempt: 1,
      maxAttempts: 3,
      fencingToken: '1',
      leaseOwner: 'test',
      leaseExpiresAt: now,
    };
    const scope = workspaceScope(workspaceId, { kind: 'system', component: 'worker' });

    // Chunk 1: the run row, the day's count and the reservation. No provider yet.
    const first = await handler.handle({ session: database.session, scope, job: claimed });
    expect(first).toEqual({ progress: { runId: expect.any(String), reservedCents: 3, step: 'reserved' }, done: false });
    expect(pageFetch.calls).toBe(0);

    // Chunk 2, from the cursor the runner would have carried in `payload.progress`.
    const second = await handler.handle({
      session: database.session,
      scope,
      job: { ...claimed, payload: { ...claimed.payload, progress: (first as { progress: unknown }).progress } },
    });
    expect(second).toMatchObject({ done: true });

    const counts = await database.session.query<{
      evidence: number;
      facts: number;
      fit: string | null;
      extraction: string | null;
      reserved: number;
    }>(
      `SELECT (SELECT count(*) FROM evidence_items)::int AS evidence,
              (SELECT count(*) FROM firm_facts)::int AS facts,
              (SELECT fit FROM firm_judgments LIMIT 1) AS fit,
              (SELECT extraction FROM research_runs LIMIT 1) AS extraction,
              (SELECT coalesce(sum(reserved_cents), 0) FROM provider_ledger)::int AS reserved`,
    );
    // `unconfigured` rather than a null model name, so the sweep can tell this apart
    // from a firm whose pages could not be read — and the reservation came back,
    // because nothing was asked of a model.
    expect(counts.rows[0]).toEqual({ evidence: 1, facts: 0, fit: 'unknown', extraction: 'unconfigured', reserved: 0 });
    expect(context().scope.workspaceId).toBe(workspaceId);
  });
});

describe('what the worker composes', () => {
  it('has the page fetch always, and the extraction only with the classifier transport', () => {
    const withoutKey = composeResearch(undefined);
    expect(withoutKey.pageFetch.providerKey).toBe('company_page');
    expect(withoutKey.extraction).toBeUndefined();
    expect(describeResearch(withoutKey)).toEqual({ research_extraction_configured: false });

    const transport = { create: async () => ({}) };
    const withKey = composeResearch({ transport, processEnabled: true });
    expect(withKey.extraction?.providerKey).toBe('anthropic_extraction');
    expect(describeResearch(withKey)).toEqual({ research_extraction_configured: true });
  });
});
