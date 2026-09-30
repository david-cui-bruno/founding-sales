import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLUSTER_URL_ENVIRONMENT_VARIABLE, createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { withTransaction } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { consumeCallSession, createCallSession, recordCallStatus, sweepCallSessionReservations } from '../../calls/sessions.ts';
import { sendGateLockName } from '../../policy/sendGate.ts';
import { logCallOutcome } from '../../dial/calls.ts';
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
 * **The cadence (slice C1).** Sessions created before any was placed all pass the
 * creation check; consumption reads the cadence again under the firm lock, where a call
 * placed a moment ago and still ringing is that day's unanswered attempt.
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

  async function create(workspace: 'alpha' | 'beta', at: string = policy.insideWindow): Promise<string> {
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
          at,
        },
      ),
    );
    if (!created.ok) throw new Error(created.reason);
    return created.value.sessionId;
  }

  const consumeInput = (workspace: 'alpha' | 'beta', sessionId: string, at: string = policy.insideWindow) => ({
    workspaceId: seeded[workspace].workspaceId,
    sessionId,
    callSid: callSid(),
    identity: `client:${seeded[workspace].salesperson.userId}`,
    at,
  });

  /** Date a placed call at `at` on the firm's clock (not the test's wall clock). */
  async function dateCall(sessionId: string, at: string): Promise<void> {
    await database.session.query(
      'UPDATE call_sessions SET consumed_at = $2::timestamptz, expires_at = GREATEST(expires_at, $2::timestamptz) WHERE id = $1',
      [sessionId, at],
    );
  }

  /** The call happened at `at`, and ends with Twilio's `status`. */
  async function endCall(sessionId: string, status: string, at: string): Promise<void> {
    await dateCall(sessionId, at);
    const { rows } = await database.session.query<{ twilio_call_sid: string }>(
      'SELECT twilio_call_sid FROM call_sessions WHERE id = $1',
      [sessionId],
    );
    await withTransaction(database.session, async () =>
      await recordCallStatus(database.session, { callSid: rows[0]?.twilio_call_sid ?? '', providerStatus: status }),
    );
  }

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

  it('places one of four sessions created together: the others are the same day’s attempt, refused at TwiML', async () => {
    const sessions = [await create('beta'), await create('beta'), await create('beta'), await create('beta')];
    const outcomes: string[] = [];
    for (const sessionId of sessions) {
      const consumed = await withTransaction(database.session, async () =>
        await consumeCallSession(database.session, consumeInput('beta', sessionId)),
      );
      outcomes.push(consumed.ok ? 'placed' : consumed.reason);
      if (consumed.ok) await dateCall(sessionId, policy.insideWindow);
    }
    expect(outcomes).toEqual(['placed', 'call_attempt_today', 'call_attempt_today', 'call_attempt_today']);
    // The placed one ends unanswered; the firm's day is spent either way.
    await endCall(sessions[0] ?? '', 'no-answer', policy.insideWindow);
  });

  it('refuses at TwiML the attempt past the fourth, placed after this session was created, and parks the firm', async () => {
    // Beta already has Wednesday's unanswered attempt (above). Two more on Thursday and Friday.
    const THU = '2026-09-17T17:00:00.000Z';
    const FRI = '2026-09-18T20:00:00.000Z';
    const MON = '2026-09-21T13:00:00.000Z';
    for (const at of [THU, FRI]) {
      const sessionId = await create('beta', at);
      const consumed = await withTransaction(database.session, async () =>
        await consumeCallSession(database.session, consumeInput('beta', sessionId, at)),
      );
      expect(consumed.ok).toBe(true);
      await endCall(sessionId, 'no-answer', at);
    }
    // (Wednesday, Thursday and Friday: three attempts.)
    // Monday: two sessions pass creation as the fourth attempt; one is placed and goes unanswered.
    const early = await create('beta', MON);
    const late = await create('beta', MON);
    const placed = await withTransaction(database.session, async () =>
      await consumeCallSession(database.session, consumeInput('beta', late, MON)),
    );
    expect(placed.ok).toBe(true);
    await endCall(late, 'no-answer', MON);
    const refused = await withTransaction(database.session, async () =>
      await consumeCallSession(database.session, consumeInput('beta', early, MON)),
    );
    expect(refused).toEqual({ ok: false, reason: 'call_attempts_exhausted' });
    const { rows } = await database.session.query<{ count: string }>(
      `SELECT count(*) AS count FROM active_holds
        WHERE workspace_id = $1 AND source_event_kind = 'call_cadence_parked' AND released_at IS NULL`,
      [seeded.beta.workspaceId],
    );
    expect(Number(rows[0]?.count)).toBe(1);
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
      // It ended having reached somebody: not an attempt the next test's cadence counts.
      await endCall(sessionId, 'completed', '2026-09-14T17:00:00.000Z');
    } finally {
      await other.end().catch(() => undefined);
    }
  });

  it('a final no-answer callback waits for Log outcome’s gate rather than holding the session against it (C1 fold 2)', async () => {
    const sessionId = await create('alpha');
    const input = consumeInput('alpha', sessionId);
    expect((await withTransaction(database.session, async () => await consumeCallSession(database.session, input))).ok).toBe(true);
    await dateCall(sessionId, '2026-09-10T14:00:00.000Z');
    const other = await otherConnection();
    try {
      const writerPid = await pidOf(async sql => await other.query<{ pid: number }>(sql));
      // Log outcome's order: the gate EXCLUSIVE, then the firm, then the session.
      await other.query('BEGIN');
      await other.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [sendGateLockName(seeded.alpha.workspaceId)]);
      await other.query('SELECT 1 FROM firms WHERE workspace_id = $1 AND id = $2 FOR UPDATE', [
        seeded.alpha.workspaceId,
        crm.alpha.firmId,
      ]);
      const callback = withTransaction(database.session, async () =>
        await recordCallStatus(database.session, { callSid: input.callSid, providerStatus: 'no-answer' }),
      );
      expect(await waitsOn(other as never, writerPid)).toBe(true);
      // The outcome's write to the same session. Had the callback locked the session
      // before asking for the gate, this would deadlock and one side would be aborted.
      await other.query('UPDATE call_sessions SET updated_at = now() WHERE id = $1', [sessionId]);
      await other.query('COMMIT');
      expect(await callback).toMatchObject({ known: true, status: 'completed', applied: true });
    } finally {
      await other.end().catch(() => undefined);
    }
  });

  it('a final no-answer callback and a real Log outcome on the same session, run together, both commit', async () => {
    const sessionId = await create('alpha', '2026-09-18T20:00:00.000Z');
    const input = consumeInput('alpha', sessionId, '2026-09-18T20:00:00.000Z');
    expect((await withTransaction(database.session, async () => await consumeCallSession(database.session, input))).ok).toBe(true);
    await dateCall(sessionId, '2026-09-11T14:00:00.000Z');
    const runtime = await database.appRuntimeSession();
    const salesperson = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.salesperson.userId, role: 'salesperson' }),
      runtime,
    );
    const [logged, called] = await Promise.all([
      withTransaction(runtime, async () =>
        await logCallOutcome(salesperson, { firmId: crm.alpha.firmId, callSessionId: sessionId, outcome: 'voicemail_left' }),
      ),
      withTransaction(database.session, async () =>
        await recordCallStatus(database.session, { callSid: input.callSid, providerStatus: 'no-answer' }),
      ),
    ]);
    expect(logged.ok).toBe(true);
    expect(called).toMatchObject({ known: true });
    const { rows } = await database.session.query<{ status: string; call_log_id: string | null }>(
      'SELECT status, call_log_id FROM call_sessions WHERE id = $1',
      [sessionId],
    );
    expect(rows[0]?.status).toBe('completed');
    expect(rows[0]?.call_log_id).not.toBeNull();
  });

  it('refuses a consumption that waited on the gate past the minute while the sweep released its reservation (fold 2)', async () => {
    const sessionId = await create('alpha');
    // The minute ends a moment from now, after this consumption's transaction began.
    await database.session.query(
      "UPDATE call_sessions SET expires_at = clock_timestamp() + INTERVAL '1500 milliseconds' WHERE id = $1",
      [sessionId],
    );
    const other = await otherConnection();
    const sweeper = await database.appRuntimeSession();
    try {
      const writerPid = await pidOf(async sql => await other.query<{ pid: number }>(sql));
      await other.query('BEGIN');
      await other.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [sendGateLockName(seeded.alpha.workspaceId)]);
      const consuming = withTransaction(database.session, async () =>
        await consumeCallSession(database.session, consumeInput('alpha', sessionId)),
      );
      expect(await waitsOn(other as never, writerPid)).toBe(true);
      // The minute passes while the consumption waits; the sweep, which takes no gate,
      // finds the unconsumed expired session and releases its reservation.
      await new Promise(resolve => setTimeout(resolve, 1_800));
      await sweeper.query('BEGIN');
      const swept = await sweepCallSessionReservations(
        repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), sweeper),
      );
      await sweeper.query('COMMIT');
      expect(swept.released).toBe(1);
      await other.query('ROLLBACK');

      expect(await consuming).toEqual({ ok: false, reason: 'session_expired' });
      const { rows } = await database.session.query<{ state: string; consumed_at: Date | null }>(
        `SELECT r.state, s.consumed_at FROM call_sessions s
           JOIN provider_reservations r ON r.workspace_id = s.workspace_id AND r.id = s.reservation_id
          WHERE s.id = $1`,
        [sessionId],
      );
      expect(rows[0]).toEqual({ state: 'released', consumed_at: null });
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
