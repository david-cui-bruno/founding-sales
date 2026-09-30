import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consumeCallSession, createCallSession } from '@fss/domain/calls/sessions.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { runTwiceUnderStolenLease } from '@fss/domain/jobs/atLeastOnce.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { JOB_KIND_CLASS, jobIdempotencyKey, quarterHourOf } from '@fss/domain/jobs/jobKinds.ts';
import { seedCrm, type SeededCrm } from '@fss/domain/test/db/support/crmFixtures.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '@fss/domain/test/db/support/fixtures.ts';
import { seedPolicy, type SeededPolicy } from '@fss/domain/test/db/support/policyFixtures.ts';
import { registerHandlers, workerDueWorkSources } from '../src/bootstrap/main.ts';
import { telephonySweepJobHandler, telephonySweepSource } from '../src/handlers/telephonySweep.ts';
import { runClaimedJob } from '../src/runner/jobRunner.ts';

/**
 * The telephony reservations' backstop, scheduled (call-to-booking slice W, review fold
 * 1, finding 5): the source is registered and names a workspace only when it owes a
 * sweep, the handler is registered in the bootstrap's own registry, and the job
 * releases an unused session's reservation and estimates a placed call whose final
 * callback never came — once, under a real stolen lease (`docs/greenfield/jobs.md`).
 */
describe('the telephony.sweep job and its source', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;
  let policy: SeededPolicy;
  let counter = 0;

  async function session(): Promise<string> {
    counter += 1;
    const created = await withTransaction(database.session, async () =>
      await createCallSession(
        repositoryContext(
          workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.salesperson.userId, role: 'salesperson' }),
          database.session,
        ),
        {
          firmId: crm.alpha.firmId,
          routeId: policy.alpha.phoneRouteId,
          routeVersion: policy.alpha.phoneRouteVersion,
          callingIdentityId: policy.alpha.callingIdentityId,
          deviceId: seeded.alpha.salesperson.deviceId,
          commandId: `sweep-${String(counter)}`,
          configuredCallerIdE164: '+14015550100',
          at: policy.insideWindow,
        },
      ),
    );
    if (!created.ok) throw new Error(created.reason);
    return created.value.sessionId;
  }

  async function reservationState(sessionId: string): Promise<{ state: string; settled_cents: number | null; cents: number }> {
    const { rows } = await database.session.query<{ state: string; settled_cents: number | null; cents: number }>(
      `SELECT r.state, r.settled_cents, r.cents FROM call_sessions s
         JOIN provider_reservations r ON r.workspace_id = s.workspace_id AND r.id = s.reservation_id
        WHERE s.id = $1`,
      [sessionId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error('no reservation');
    return row;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
    crm = await seedCrm(database.session, seeded);
    policy = await seedPolicy(database.session, seeded, crm);
    await database.session.query(
      `INSERT INTO workspace_settings (workspace_id, setting_key, version, value, changed_by_user_id)
       VALUES ($1, 'telephony_budget', 1, $2::jsonb, $3)`,
      [
        seeded.alpha.workspaceId,
        JSON.stringify({ dailyCeilingCents: 1000, maxMinutesPerCall: 30, unitPriceMicros: 14_000 }),
        seeded.alpha.admin.userId,
      ],
    );
  });

  afterAll(async () => {
    await database.drop();
  });

  it('is registered: a documented source in the pass, and a handler in the bootstrap registry', () => {
    expect(workerDueWorkSources().map(source => source.name)).toContain('telephony-sweep');
    const registry = registerHandlers(new HandlerRegistry(), {} as Parameters<typeof registerHandlers>[1]);
    expect(registry.get('telephony.sweep')?.protection).toBe('business_uniqueness');
    expect(JOB_KIND_CLASS['telephony.sweep']).toBe('urgent');
  });

  it('names no workspace while nothing is owed, then one job per quarter hour for the one that owes', async () => {
    const pending = await session();
    const now = new Date().toISOString();
    expect(await telephonySweepSource().find(database.session, now)).toEqual([]);

    await database.session.query("UPDATE call_sessions SET expires_at = now() - INTERVAL '1 second' WHERE id = $1", [pending]);
    const specifications = await telephonySweepSource().find(database.session, now);
    expect(specifications).toEqual([
      {
        workspaceId: seeded.alpha.workspaceId,
        kind: 'telephony.sweep',
        idempotencyKey: jobIdempotencyKey.telephonySweep('alpha', quarterHourOf(now)),
        payload: { quarterHour: quarterHourOf(now) },
        maxAttempts: 4,
      },
    ]);
  });

  it('releases an unused session and estimates an abandoned call, once, under a stolen lease', async () => {
    const unused = await session();
    await database.session.query("UPDATE call_sessions SET expires_at = now() - INTERVAL '1 second' WHERE id = $1", [unused]);
    const placed = await session();
    const consumed = await withTransaction(database.session, async () =>
      await consumeCallSession(database.session, {
        workspaceId: seeded.alpha.workspaceId,
        sessionId: placed,
        callSid: `CA${randomBytes(16).toString('hex')}`,
        identity: `client:${seeded.alpha.salesperson.userId}`,
        at: policy.insideWindow,
      }),
    );
    expect(consumed.ok).toBe(true);
    // The call was placed five hours ago and no final callback ever came: past its
    // thirty reserved minutes plus fifteen.
    await database.session.query(
      `UPDATE call_sessions
          SET created_at = now() - INTERVAL '5 hours', expires_at = now() - INTERVAL '5 hours' + INTERVAL '60 seconds',
              consumed_at = now() - INTERVAL '5 hours' + INTERVAL '10 seconds'
        WHERE id = $1`,
      [placed],
    );

    const registry = new HandlerRegistry().register(telephonySweepJobHandler());
    const report = await runTwiceUnderStolenLease({
      session: database.session,
      registry,
      run: runClaimedJob,
      workspaceId: seeded.alpha.workspaceId,
      kind: 'telephony.sweep',
      idempotencyKey: jobIdempotencyKey.telephonySweep('alpha', quarterHourOf(new Date().toISOString())),
      payload: {},
      countEffects: async () => {
        const { rows } = await database.session.query<{ count: string }>(
          `SELECT count(*) AS count FROM provider_reservations
            WHERE workspace_id = $1 AND subject_kind = 'call_session' AND state IN ('released', 'estimated')`,
          [seeded.alpha.workspaceId],
        );
        return Number(rows[0]?.count);
      },
    });
    expect(report.freshOutcome).toBe('completed');
    expect(report.staleOutcome).toBe('lease_lost');
    // The earlier test's expired session, this test's unused one and the placed call.
    expect(report.effectsAfter - report.effectsBefore).toBe(3);

    expect(await reservationState(unused)).toMatchObject({ state: 'released', settled_cents: 0 });
    const abandoned = await reservationState(placed);
    expect(abandoned.state).toBe('estimated');
    expect(abandoned.settled_cents).toBe(abandoned.cents);
    expect(await telephonySweepSource().find(database.session, new Date().toISOString())).toEqual([]);
  });
});
