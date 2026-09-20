import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing';
import { repositoryContext, workspaceScope } from '@fss/domain/db';
import { HandlerRegistry, jobIdempotencyKey, runTwiceUnderStolenLease } from '@fss/domain/jobs';
import { MANUAL_SUPPRESSION_CORRECTION_SECONDS } from '@fss/contracts';
import {
  finalizeManualSuppression,
  isSuppressed,
  readFinalization,
  recordSuppression,
  recordingSuppressionJournal,
  suppressionFinalizeHandler,
} from '@fss/domain/suppression';
import { suppressionFinalizeJobHandler } from '../src/handlers/suppressionFinalize.ts';
import { runClaimedJob } from '../src/runner/jobRunner.ts';

/**
 * The `suppression.finalize` job (Appendix C, specification 10.2, Appendix G 2 and
 * 29).
 *
 * Two things are proved here and nowhere else.
 *
 * **The registry accepts it under Appendix C's protection and no other.** The table
 * says `business_uniqueness` for this kind, and `HandlerRegistry.register` refuses a
 * declaration that disagrees — so a later change to either has to change both.
 *
 * **It produces one effect under a real stolen lease.** `runTwiceUnderStolenLease`
 * expires the lease, reclaims the row, lets a second worker finish and then lets the
 * first wake up and try. `docs/greenfield/jobs.md` makes that probe mandatory for
 * every lane that registers a handler.
 */
describe('the suppression finalizer as a job', () => {
  let database: TestDatabase;
  let workspaceId: string;
  let userId: string;
  let firmId: string;

  beforeAll(async () => {
    database = await createTestDatabase();
    const workspace = await database.session.query<{ id: string }>(
      "INSERT INTO workspaces (slug, display_name) VALUES ('alpha', 'Alpha') RETURNING id",
    );
    workspaceId = workspace.rows[0]?.id ?? '';
    const user = await database.session.query<{ id: string }>(
      "INSERT INTO users (google_sub, email, display_name) VALUES ('sub-finalize', 'finalize@example.test', 'Finalize') RETURNING id",
    );
    userId = user.rows[0]?.id ?? '';
    await database.session.query(
      "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'salesperson')",
      [workspaceId, userId],
    );
    const firm = await database.session.query<{ id: string }>(
      `INSERT INTO firms (workspace_id, name, assigned_user_id, region_code) VALUES ($1, 'Northwind Test Holdings', $2, 'RI')
       RETURNING id`,
      [workspaceId, userId],
    );
    firmId = firm.rows[0]?.id ?? '';
  });

  afterAll(async () => {
    await database.drop();
  });

  const context = () =>
    repositoryContext(workspaceScope(workspaceId, { kind: 'user', userId, role: 'salesperson' }), database.session);
  const workerContext = () =>
    repositoryContext(workspaceScope(workspaceId, { kind: 'system', component: 'worker' }), database.session);

  it('registers under the protection Appendix C names, and refuses any other', () => {
    const registry = new HandlerRegistry().register(suppressionFinalizeJobHandler());
    expect(registry.kinds()).toContain('suppression.finalize');
    expect(registry.get('suppression.finalize')?.protection).toBe('business_uniqueness');
    expect(() =>
      new HandlerRegistry().register({ ...suppressionFinalizeHandler(), protection: 'outbound_fence' }),
    ).toThrow(/business_uniqueness/);
  });

  it('is enqueued by the suppression itself, at the ten-minute deadline', async () => {
    const recorded = await recordSuppression(context(), {
      scope: 'handle',
      value: '+14015550210',
      firmId,
      source: 'salesperson_manual',
      commandId: 'cmd-enqueue',
      journal: recordingSuppressionJournal(),
    });
    if (!recorded.ok) throw new Error(`expected an event, got ${recorded.reason}`);

    const { rows } = await database.session.query<{ idempotency_key: string; run_at: Date; payload: { eventId: string } }>(
      "SELECT idempotency_key, run_at, payload FROM jobs WHERE workspace_id = $1 AND kind = 'suppression.finalize'",
      [workspaceId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.idempotency_key).toBe(jobIdempotencyKey.suppressionFinalize(recorded.value.eventId));
    expect(rows[0]?.payload.eventId).toBe(recorded.value.eventId);
    const runAt = rows[0]?.run_at;
    expect(runAt).toBeDefined();
    expect((runAt?.getTime() ?? 0) - Date.parse(recorded.value.recordedAt)).toBe(
      MANUAL_SUPPRESSION_CORRECTION_SECONDS * 1000,
    );

    // Run before the deadline: nothing happens, and the window is still open.
    expect(await finalizeManualSuppression(workerContext(), { eventId: recorded.value.eventId })).toBe('not_due');
    expect(await readFinalization(workerContext(), recorded.value.eventId)).toBeNull();
    // And the suppression is effective throughout, which is the point of the window.
    expect(await isSuppressed(context(), { scope: 'handle', canonicalKey: '+14015550210' })).not.toBeNull();
  });

  it('records one effect when a stolen lease makes it run twice', async () => {
    const recorded = await recordSuppression(context(), {
      scope: 'handle',
      value: '+14015550211',
      firmId,
      source: 'salesperson_manual',
      commandId: 'cmd-stolen-lease',
      journal: recordingSuppressionJournal(),
    });
    if (!recorded.ok) throw new Error(`expected an event, got ${recorded.reason}`);

    // The harness enqueues its own job, so the command's one is moved out of its way
    // and the event is backdated past its deadline: the probe is about the lease,
    // not about the clock.
    await database.session.query("DELETE FROM jobs WHERE workspace_id = $1 AND kind = 'suppression.finalize'", [
      workspaceId,
    ]);
    await database.session.query(
      "UPDATE suppression_events SET recorded_at = now() - INTERVAL '20 minutes' WHERE workspace_id = $1 AND event_id = $2",
      [workspaceId, recorded.value.eventId],
    );

    const registry = new HandlerRegistry().register(suppressionFinalizeJobHandler());
    const report = await runTwiceUnderStolenLease({
      session: database.session,
      registry,
      run: runClaimedJob,
      workspaceId,
      kind: 'suppression.finalize',
      idempotencyKey: jobIdempotencyKey.suppressionFinalize(recorded.value.eventId),
      payload: { eventId: recorded.value.eventId },
      countEffects: async () => {
        const { rows } = await database.session.query<{ count: string }>(
          'SELECT count(*) AS count FROM suppression_finalizations WHERE workspace_id = $1',
          [workspaceId],
        );
        return Number(rows[0]?.count);
      },
    });

    expect(report.freshOutcome).toBe('completed');
    expect(report.staleOutcome).toBe('lease_lost');
    expect(report.effectsAfter - report.effectsBefore).toBe(1);
    expect(report.freshFencingToken).not.toBe(report.staleFencingToken);

    expect(await readFinalization(workerContext(), recorded.value.eventId)).toMatchObject({ outcome: 'finalized' });
    // Terminal, and the suppression outlives its own review hold.
    expect(await isSuppressed(context(), { scope: 'handle', canonicalKey: '+14015550211' })).not.toBeNull();
    const holds = await database.session.query<{ released_at: Date | null }>(
      "SELECT released_at FROM active_holds WHERE workspace_id = $1 AND source_event_id = $2 AND reason_code = 'manual_suppression_review'",
      [workspaceId, recorded.value.eventId],
    );
    expect(holds.rows.every(row => row.released_at !== null)).toBe(true);
  });

  it('fails rather than silently completing when the payload names another workspace event', async () => {
    const registry = new HandlerRegistry().register(suppressionFinalizeJobHandler());
    const handler = registry.get('suppression.finalize');
    expect(handler).toBeDefined();
    await expect(
      handler?.handle({
        session: database.session,
        scope: workspaceScope(workspaceId, { kind: 'system', component: 'worker' }),
        job: {
          id: '00000000-0000-4000-8000-000000000000',
          workspaceId,
          kind: 'suppression.finalize',
          idempotencyKey: 'suppression-finalize:nowhere',
          payload: { eventId: 'nowhere' },
          attempt: 1,
          maxAttempts: 4,
          fencingToken: '1',
          leaseOwner: 'test',
          leaseExpiresAt: new Date().toISOString(),
        },
      }),
    ).rejects.toThrow(/no such event/);
  });
});
