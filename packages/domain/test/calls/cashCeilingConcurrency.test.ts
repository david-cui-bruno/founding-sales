import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLUSTER_URL_ENVIRONMENT_VARIABLE, asSession, createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { withTransaction, type SessionQueryable } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { createCallSession } from '../../calls/sessions.ts';
import { claimResearchClearance } from '../../research/ceilings.ts';
import { beginFirmResearch } from '../../research/enrichment.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedPolicy, type SeededPolicy } from '../db/support/policyFixtures.ts';

/**
 * Slice P1, invariant I2: one cash ceiling across every paid kind, and one lock order.
 *
 * A call session (42¢ at this budget) and a research reservation (3¢ at the defaults)
 * each fit a month with 42¢ of headroom, and together they do not. Each takes its own
 * budget lock and then the workspace's monthly lock, so whichever reserves first makes the
 * other wait and then read it. Driven on two real connections, both orders.
 */
describe('one month, a call and a research run at its edge', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;
  let policy: SeededPolicy;
  let other: pg.Client;
  let otherSession: SessionQueryable;
  let counter = 0;

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
    crm = await seedCrm(database.session, seeded);
    policy = await seedPolicy(database.session, seeded, crm);
    await database.session.query(
      `INSERT INTO workspace_settings (workspace_id, setting_key, version, value, changed_by_user_id)
       VALUES ($1, 'telephony_budget', 1, '{"dailyCeilingCents": 1000, "maxMinutesPerCall": 30, "unitPriceMicros": 14000}'::jsonb, $2),
              ($1, 'monthly_cash_ceiling_cents', 1, '{"cents": 42}'::jsonb, $2)`,
      [seeded.alpha.workspaceId, seeded.alpha.admin.userId],
    );
    const url = new URL((process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] ?? '').trim());
    url.pathname = `/${database.name}`;
    other = new pg.Client({ connectionString: url.toString() });
    other.on('error', () => undefined);
    await other.connect();
    otherSession = asSession(other as unknown as Parameters<typeof asSession>[0]);
  });

  afterAll(async () => {
    await other?.end().catch(() => undefined);
    await database.drop();
  });

  const call = async (session: SessionQueryable) => {
    counter += 1;
    return await createCallSession(
      repositoryContext(
        workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.salesperson.userId, role: 'salesperson' }),
        session,
      ),
      {
        firmId: crm.alpha.firmId,
        routeId: policy.alpha.phoneRouteId,
        routeVersion: policy.alpha.phoneRouteVersion,
        callingIdentityId: policy.alpha.callingIdentityId,
        deviceId: seeded.alpha.salesperson.deviceId,
        commandId: `edge-${String(counter)}`,
        configuredCallerIdE164: '+14015550100',
        at: policy.insideWindow,
      },
    );
  };
  const research = async (session: SessionQueryable) =>
    await claimResearchClearance(repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), session), {
      firmId: crm.alpha.firmId,
      at: policy.insideWindow,
      attemptKind: 'first',
    });
  /** Hand back every reservation, so each order starts from the same empty month. */
  const reset = async (): Promise<void> => {
    await database.session.query('DELETE FROM call_sessions');
    await database.session.query('DELETE FROM provider_reservations');
    await database.session.query('DELETE FROM provider_ledger');
    await database.session.query('DELETE FROM daily_counters');
    await database.session.query('DELETE FROM research_runs');
  };
  const waitingOnTransaction = async (pid: number, observer: SessionQueryable = database.session): Promise<boolean> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const { rows } = await observer.query<{ waiting: boolean }>(
        `SELECT pg_backend_pid() = ANY(pg_blocking_pids($1)) AS waiting`,
        [pid],
      );
      if (rows[0]?.waiting === true) return true;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return false;
  };
  const otherPid = async (): Promise<number> => Number((await otherSession.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid);

  it('each fits alone (the control)', async () => {
    await reset();
    expect((await withTransaction(database.session, async () => await call(database.session))).ok).toBe(true);
    await reset();
    expect((await withTransaction(database.session, async () => await research(database.session))).ok).toBe(true);
  });

  it('a call holding the last cents makes research wait, then refuses it', async () => {
    await reset();
    await database.session.query('BEGIN');
    let open = true;
    try {
      expect((await call(database.session)).ok).toBe(true);
      const pending = withTransaction(otherSession, async () => await research(otherSession));
      expect(await waitingOnTransaction(await otherPid())).toBe(true);
      await database.session.query('COMMIT');
      open = false;
      expect(await pending).toEqual({ ok: false, reason: 'monthly_cash_ceiling' });
    } finally {
      if (open) await database.session.query('ROLLBACK');
    }
  });

  it('research holding the cents makes the call wait, then refuses it', async () => {
    await reset();
    const mainPid = Number((await database.session.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid);
    await otherSession.query('BEGIN');
    let open = true;
    try {
      // Chunk 1 of a run: the clearance and the reservation it inserts, uncommitted.
      const started = await beginFirmResearch(
        repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), otherSession),
        { firmId: crm.alpha.firmId, revision: 1, trigger: 'sweep', at: policy.insideWindow },
      );
      expect(started).toMatchObject({ ok: true, value: { kind: 'reserved' } });
      const pending = withTransaction(database.session, async () => await call(database.session));
      expect(await waitingOnTransaction(mainPid, otherSession)).toBe(true);
      await otherSession.query('COMMIT');
      open = false;
      expect(await pending).toEqual({ ok: false, reason: 'monthly_cash_ceiling' });
    } finally {
      if (open) await otherSession.query('ROLLBACK');
    }
  });
});
