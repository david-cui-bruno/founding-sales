import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLUSTER_URL_ENVIRONMENT_VARIABLE, createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { withTransaction } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { consumeCallSession, createCallSession } from '../../calls/sessions.ts';
import { sendGateLockName } from '../../policy/sendGate.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedPolicy, type SeededPolicy } from '../db/support/policyFixtures.ts';

/**
 * Consumption races (call-to-booking slice W, review fold 1, findings 1 and 2).
 *
 * **The gate.** A suppression writer takes the send gate EXCLUSIVE; the TwiML
 * consumption takes it SHARED before any row and holds it to its commit. Both
 * interleavings are driven with a second connection and observed through
 * `pg_blocking_pids`, so each test proves the wait happened rather than inferring it
 * from an outcome a lucky schedule could also produce.
 *
 * **The attempt limit.** Sessions created before any was placed all pass the creation
 * check; consumption counts again under the firm lock.
 */
describe('call-session consumption under concurrency', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;
  let policy: SeededPolicy;
  let counter = 0;

  const callSid = (): string => `CA${randomBytes(16).toString('hex')}`;

  async function otherConnection(): Promise<pg.Client> {
    const url = new URL((process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] ?? '').trim());
    url.pathname = `/${database.name}`;
    const client = new pg.Client({ connectionString: url.toString() });
    client.on('error', () => undefined);
    await client.connect();
    return client;
  }

  /** Whether any backend other than the asking one is waiting on `blocker`'s pid. */
  async function waitsOn(asker: { query: (sql: string, values?: unknown[]) => Promise<{ rows: { count: string }[] }> }, blockerPid: number): Promise<boolean> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const { rows } = await asker.query(
        `SELECT count(*)::text AS count FROM pg_stat_activity
          WHERE pid <> pg_backend_pid() AND $1::int = ANY(pg_blocking_pids(pid))`,
        [blockerPid],
      );
      if (Number(rows[0]?.count ?? 0) > 0) return true;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return false;
  }

  async function pidOf(query: (sql: string) => Promise<{ rows: { pid: number }[] }>): Promise<number> {
    const { rows } = await query('SELECT pg_backend_pid() AS pid');
    return Number(rows[0]?.pid);
  }

  async function budget(workspace: 'alpha' | 'beta'): Promise<void> {
    await database.session.query(
      `INSERT INTO workspace_settings (workspace_id, setting_key, version, value, changed_by_user_id)
       VALUES ($1, 'telephony_budget', 1, $2::jsonb, $3)`,
      [
        seeded[workspace].workspaceId,
        JSON.stringify({ dailyCeilingCents: 1000, maxMinutesPerCall: 30, unitPriceMicros: 14_000 }),
        seeded[workspace].admin.userId,
      ],
    );
  }

  async function create(workspace: 'alpha' | 'beta'): Promise<string> {
    counter += 1;
    const p = policy[workspace];
    const created = await withTransaction(database.session, async () =>
      await createCallSession(
        repositoryContext(
          workspaceScope(seeded[workspace].workspaceId, {
            kind: 'user',
            userId: seeded[workspace].salesperson.userId,
            role: 'salesperson',
          }),
          database.session,
        ),
        {
          firmId: crm[workspace].firmId,
          routeId: p.phoneRouteId,
          routeVersion: p.phoneRouteVersion,
          callingIdentityId: p.callingIdentityId,
          deviceId: seeded[workspace].salesperson.deviceId,
          commandId: `concurrency-${String(counter)}`,
          configuredCallerIdE164: '+14015550100',
          at: policy.insideWindow,
        },
      ),
    );
    if (!created.ok) throw new Error(created.reason);
    return created.value.sessionId;
  }

  const consumeInput = (workspace: 'alpha' | 'beta', sessionId: string) => ({
    workspaceId: seeded[workspace].workspaceId,
    sessionId,
    callSid: callSid(),
    identity: `client:${seeded[workspace].salesperson.userId}`,
    at: policy.insideWindow,
  });

  const suppressFirm = async (client: pg.Client, eventId: string): Promise<void> => {
    await client.query(
      `INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source)
       VALUES ($1, $2, 'firm', $3, 'v1', 'prospect_do_not_call')`,
      [seeded.alpha.workspaceId, eventId, crm.alpha.firmId.toLowerCase()],
    );
  };

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
    crm = await seedCrm(database.session, seeded);
    policy = await seedPolicy(database.session, seeded, crm);
    await budget('alpha');
    await budget('beta');
  });

  afterAll(async () => {
    await database.drop();
  });

  it('places only as many of four pre-created sessions as the attempt limit allows', async () => {
    const sessions = [await create('beta'), await create('beta'), await create('beta'), await create('beta')];
    const outcomes: string[] = [];
    for (const sessionId of sessions) {
      const consumed = await withTransaction(database.session, async () =>
        await consumeCallSession(database.session, consumeInput('beta', sessionId)),
      );
      outcomes.push(consumed.ok ? 'placed' : consumed.reason);
    }
    expect(outcomes).toEqual(['placed', 'placed', 'placed', 'call_attempt_limit']);
  });

  it('holds a suppression writer until the authorization commits, when the consumption took the gate first', async () => {
    const sessionId = await create('alpha');
    const other = await otherConnection();
    try {
      const mainPid = await pidOf(async sql => await database.session.query<{ pid: number }>(sql));
      let writer: Promise<unknown> | null = null;
      let blocked = false;
      const consumed = await withTransaction(database.session, async () => {
        const outcome = await consumeCallSession(database.session, consumeInput('alpha', sessionId));
        // Not yet committed: a suppression writer now must wait on the gate.
        await other.query('BEGIN');
        writer = other.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          sendGateLockName(seeded.alpha.workspaceId),
        ]);
        blocked = await waitsOn(database.session as never, mainPid);
        return outcome;
      });
      // The writer gets the gate once the authorization committed. It rolls back rather
      // than suppressing, so the next test starts from an unsuppressed firm.
      await writer;
      await other.query('ROLLBACK');
      expect(blocked).toBe(true);
      // The call linearised before the suppression, the ordering the gate allows.
      expect(consumed.ok).toBe(true);
    } finally {
      await other.end().catch(() => undefined);
    }
  });

  it('refuses at TwiML when a suppression writer holding the gate commits during the consumption', async () => {
    const sessionId = await create('alpha');
    const other = await otherConnection();
    try {
      const writerPid = await pidOf(async sql => await other.query<{ pid: number }>(sql));
      await other.query('BEGIN');
      await other.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [sendGateLockName(seeded.alpha.workspaceId)]);
      await suppressFirm(other, 'w-race-before');
      // The consumption starts while the suppression is written but not committed.
      const consuming = withTransaction(database.session, async () =>
        await consumeCallSession(database.session, consumeInput('alpha', sessionId)),
      );
      const blocked = await waitsOn(other as never, writerPid);
      await other.query('COMMIT');
      const consumed = await consuming;
      expect(blocked).toBe(true);
      expect(consumed).toEqual({ ok: false, reason: 'firm_suppressed' });
    } finally {
      await other.end().catch(() => undefined);
    }
  });
});
