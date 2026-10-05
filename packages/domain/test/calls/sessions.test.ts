import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { withTransaction, type Queryable, type QueryResultRowLike } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import {
  consumeCallSession,
  createCallSession,
  readCallCadence,
  resumeCallCadence,
  recordCallRecording,
  recordCallStatus,
  sweepCallSessionReservations,
} from '../../calls/sessions.ts';
import { logCallOutcome } from '../../dial/calls.ts';
import { authorizeDial } from '../../dial/authorize.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedPolicy, type SeededPolicy } from '../db/support/policyFixtures.ts';

/**
 * Call sessions at the domain (call-to-booking slice W, acceptance 2): the whole
 * authorization at creation, once-only consumption for the token's identity with the
 * decision taken again, idempotent callbacks that settle the reservation, and the sweep.
 * The same flow over real HTTP with signed Twilio requests is `apps/api/test/callToBooking.test.ts`.
 */
describe('call sessions', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;
  let policy: SeededPolicy;
  let counter = 0;

  const callSid = (): string => `CA${randomBytes(16).toString('hex')}`;
  const salesperson = (workspace: 'alpha' | 'beta'): RepositoryContext =>
    repositoryContext(
      workspaceScope(seeded[workspace].workspaceId, {
        kind: 'user',
        userId: seeded[workspace].salesperson.userId,
        role: 'salesperson',
      }),
      database.session,
    );

  async function budget(workspace: 'alpha' | 'beta', dailyCeilingCents: number): Promise<void> {
    await database.session.query(
      `INSERT INTO workspace_settings (workspace_id, setting_key, version, value, changed_by_user_id)
       VALUES ($1, 'telephony_budget', 1, $2::jsonb, $3)`,
      [
        seeded[workspace].workspaceId,
        JSON.stringify({ dailyCeilingCents, maxMinutesPerCall: 30, unitPriceMicros: 14_000 }),
        seeded[workspace].admin.userId,
      ],
    );
  }

  async function create(workspace: 'alpha' | 'beta') {
    counter += 1;
    const p = policy[workspace];
    return await withTransaction(database.session, async () =>
      await createCallSession(salesperson(workspace), {
        firmId: crm[workspace].firmId,
        routeId: p.phoneRouteId,
        routeVersion: p.phoneRouteVersion,
        callingIdentityId: p.callingIdentityId,
        deviceId: seeded[workspace].salesperson.deviceId,
        commandId: `session-${String(counter)}`,
        configuredCallerIdE164: '+14015550100',
        at: policy.insideWindow,
      }),
    );
  }

  async function consume(workspace: 'alpha' | 'beta', sessionId: string, sid: string, identity?: string) {
    const consumed = await withTransaction(database.session, async () =>
      await consumeCallSession(database.session, {
        workspaceId: seeded[workspace].workspaceId,
        sessionId,
        callSid: sid,
        identity: identity ?? `client:${seeded[workspace].salesperson.userId}`,
        at: policy.insideWindow,
      }),
    );
    // Every placed call is a cadence attempt (slice C1). These tests are about the session
    // itself, so the call is dated weeks before the decisions they take, outside the window.
    if (consumed.ok) {
      await database.session.query(
        "UPDATE call_sessions SET consumed_at = '2026-08-03T14:00:00Z', expires_at = GREATEST(expires_at, '2026-08-03T14:00:00Z') WHERE id = $1",
        [sessionId],
      );
    }
    return consumed;
  }

  async function reservationOf(sessionId: string): Promise<{ state: string; cents: number; settled_cents: number }> {
    const { rows } = await database.session.query<{ state: string; cents: number; settled_cents: number }>(
      `SELECT r.state, r.cents, r.settled_cents FROM call_sessions s
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
  });

  afterAll(async () => {
    await database.drop();
  });

  it('refuses a session while the telephony ceiling is 0, the default', async () => {
    expect(await create('beta')).toEqual({ ok: false, reason: 'telephony_budget_disabled' });
  });

  it('refuses a caller id the Twilio configuration does not present', async () => {
    await budget('alpha', 500);
    counter += 1;
    const refused = await withTransaction(database.session, async () =>
      await createCallSession(salesperson('alpha'), {
        firmId: crm.alpha.firmId,
        routeId: policy.alpha.phoneRouteId,
        routeVersion: policy.alpha.phoneRouteVersion,
        callingIdentityId: policy.alpha.callingIdentityId,
        deviceId: seeded.alpha.salesperson.deviceId,
        commandId: `session-${String(counter)}`,
        configuredCallerIdE164: '+14015559999',
        at: policy.insideWindow,
      }),
    );
    expect(refused).toEqual({ ok: false, reason: 'caller_id_mismatch' });
  });

  it('authorizes, reserves, consumes once for its own identity, and settles on the callbacks', async () => {
    const created = await create('alpha');
    if (!created.ok) throw new Error(created.reason);
    expect(created.value).not.toHaveProperty('e164');
    expect(await reservationOf(created.value.sessionId)).toMatchObject({ state: 'reserved', cents: 42 });

    const sid = callSid();
    expect(await consume('alpha', created.value.sessionId, sid, `client:${seeded.alpha.admin.userId}`)).toEqual({
      ok: false,
      reason: 'identity_mismatch',
    });
    const consumed = await consume('alpha', created.value.sessionId, sid);
    expect(consumed).toMatchObject({ ok: true, value: { e164: policy.alpha.e164, callerIdE164: '+14015550100' } });
    expect(await reservationOf(created.value.sessionId)).toMatchObject({ state: 'calling' });
    // A replay of the TwiML request, or a second use of the session, is refused.
    expect(await consume('alpha', created.value.sessionId, callSid())).toEqual({ ok: false, reason: 'already_consumed' });

    const status = async (providerStatus: string, extra: { durationSeconds?: number; priceDollars?: number } = {}) =>
      await withTransaction(database.session, async () =>
        await recordCallStatus(database.session, { callSid: sid, providerStatus, ...extra }),
      );
    expect(await status('ringing')).toMatchObject({ known: true, status: 'ringing', applied: true });
    expect(await status('in-progress')).toMatchObject({ status: 'in_progress', applied: true });
    // Retries and out-of-order deliveries never move it backward.
    expect(await status('ringing')).toMatchObject({ status: 'in_progress', applied: false });
    expect(await status('completed', { durationSeconds: 125 })).toMatchObject({
      status: 'completed',
      applied: true,
      settlement: 'estimated',
    });
    // Three started minutes at 14 000 micro-dollars: 4.2 cents, rounded up.
    expect(await reservationOf(created.value.sessionId)).toMatchObject({ state: 'estimated', settled_cents: 5 });
    expect(await status('completed', { durationSeconds: 125 })).toMatchObject({ applied: false, settlement: null });

    await withTransaction(database.session, async () =>
      await recordCallRecording(database.session, {
        callSid: sid,
        recordingSid: `RE${randomBytes(16).toString('hex')}`,
        recordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1',
        durationSeconds: 120,
      }),
    );
    const { rows } = await database.session.query<{ recording_path: string; answered_at: Date | null }>(
      'SELECT recording_path, answered_at FROM call_sessions WHERE id = $1',
      [created.value.sessionId],
    );
    expect(rows[0]?.recording_path).toBe('/2010-04-01/Accounts/AC1/Recordings/RE1');
    expect(rows[0]?.answered_at).not.toBeNull();
    const facts = await database.session.query<{ kind: string }>(
      "SELECT kind FROM funnel_facts WHERE dedupe_key = $1 AND kind LIKE 'call.%' ORDER BY kind",
      [created.value.sessionId],
    );
    expect(facts.rows.map(row => row.kind)).toEqual(['call.connected', 'call.placed']);
  });

  it('settles at the billed price when Twilio reports one', async () => {
    const created = await create('alpha');
    if (!created.ok) throw new Error(created.reason);
    const sid = callSid();
    expect((await consume('alpha', created.value.sessionId, sid)).ok).toBe(true);
    const outcome = await withTransaction(database.session, async () =>
      await recordCallStatus(database.session, { callSid: sid, providerStatus: 'completed', durationSeconds: 61, priceDollars: -0.028 }),
    );
    expect(outcome).toMatchObject({ settlement: 'settled' });
    expect(await reservationOf(created.value.sessionId)).toMatchObject({ state: 'settled', settled_cents: 3 });
  });

  it('corrects the ledger to a later callback\'s price, once (slice P1, finding 5)', async () => {
    const created = await create('alpha');
    if (!created.ok) throw new Error(created.reason);
    const sid = callSid();
    expect((await consume('alpha', created.value.sessionId, sid)).ok).toBe(true);
    const reservationId = (
      await database.session.query<{ reservation_id: string }>('SELECT reservation_id FROM call_sessions WHERE id = $1', [
        created.value.sessionId,
      ])
    ).rows[0]?.reservation_id;
    const ledgerCents = async (): Promise<number> => {
      const { rows } = await database.session.query<{ cents: string }>(
        `SELECT COALESCE(sum(l.cost_cents), 0)::text AS cents FROM provider_ledger l
           JOIN provider_reservations r ON r.workspace_id = l.workspace_id AND r.provider_key = l.provider_key
                                        AND r.business_date = l.business_date
          WHERE r.id = $1`,
        [reservationId],
      );
      return Number(rows[0]?.cents ?? 0);
    };
    const before = await ledgerCents();
    const status = async (extra: { durationSeconds?: number; priceDollars?: number }) =>
      await withTransaction(database.session, async () =>
        await recordCallStatus(database.session, { callSid: sid, providerStatus: 'completed', ...extra }),
      );
    // The first terminal callback has only the duration: an estimate of 5 cents.
    expect(await status({ durationSeconds: 125 })).toMatchObject({ settlement: 'estimated' });
    expect(await reservationOf(created.value.sessionId)).toMatchObject({ state: 'estimated', settled_cents: 5 });
    expect(await ledgerCents()).toBe(before + 5);
    // A later one carries Twilio's price, higher than the estimate: the price is the cost.
    expect(await status({ durationSeconds: 125, priceDollars: -0.09 })).toMatchObject({ settlement: 'settled' });
    expect(await reservationOf(created.value.sessionId)).toMatchObject({ state: 'settled', settled_cents: 9 });
    expect(await ledgerCents()).toBe(before + 9);
    // The same callback again changes nothing; a different final price moves it again.
    expect(await status({ durationSeconds: 125, priceDollars: -0.09 })).toMatchObject({ settlement: null });
    expect(await ledgerCents()).toBe(before + 9);
    expect(await status({ priceDollars: -0.07 })).toMatchObject({ settlement: 'settled' });
    expect(await reservationOf(created.value.sessionId)).toMatchObject({ state: 'settled', settled_cents: 7 });
    expect(await ledgerCents()).toBe(before + 7);
    const { rows } = await database.session.query<{ billed_price_cents: number }>(
      'SELECT billed_price_cents FROM call_sessions WHERE id = $1',
      [created.value.sessionId],
    );
    expect(rows[0]?.billed_price_cents).toBe(7);
  });

  it('acknowledges a callback for an unknown SID without writing', async () => {
    const outcome = await withTransaction(database.session, async () =>
      await recordCallStatus(database.session, { callSid: callSid(), providerStatus: 'completed' }),
    );
    expect(outcome).toEqual({ known: false });
  });

  it('answers unknown for a final no-answer whose SID the unlocked lookup missed, and writes nothing (C1 fold 3)', async () => {
    const created = await create('alpha');
    if (!created.ok) throw new Error(created.reason);
    const sid = callSid();
    expect((await consume('alpha', created.value.sessionId, sid)).ok).toBe(true);
    // The placement commits between the unlocked lookup and the locked read: the lookup
    // misses. Without the gate and the firm, the session must not be locked or written.
    const racing: Queryable = {
      query: async <Row extends QueryResultRowLike>(text: string, values?: readonly unknown[]) =>
        text.includes('SELECT workspace_id, firm_id FROM call_sessions')
          ? { rows: [] as Row[], rowCount: 0 }
          : await database.session.query<Row>(text, values),
    } as Queryable;
    const outcome = await withTransaction(database.session, async () =>
      await recordCallStatus(racing, { callSid: sid, providerStatus: 'no-answer' }),
    );
    expect(outcome).toEqual({ known: false });
    const { rows } = await database.session.query<{ status: string }>('SELECT status FROM call_sessions WHERE id = $1', [
      created.value.sessionId,
    ]);
    expect(rows[0]?.status).toBe('authorized');
  });

  it('refuses an expired session, and the sweep releases its reservation', async () => {
    const created = await create('alpha');
    if (!created.ok) throw new Error(created.reason);
    await database.session.query("UPDATE call_sessions SET expires_at = now() - INTERVAL '1 second' WHERE id = $1", [
      created.value.sessionId,
    ]);
    expect(await consume('alpha', created.value.sessionId, callSid())).toEqual({ ok: false, reason: 'session_expired' });
    const swept = await withTransaction(database.session, async () =>
      await sweepCallSessionReservations(
        repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), database.session),
      ),
    );
    expect(swept.released).toBeGreaterThanOrEqual(1);
    expect(await reservationOf(created.value.sessionId)).toMatchObject({ state: 'released', settled_cents: 0 });
  });

  it('refuses at consumption when a suppression landed after authorization, and at creation after it', async () => {
    const created = await create('alpha');
    if (!created.ok) throw new Error(created.reason);
    await database.session.query(
      `INSERT INTO suppression_events (workspace_id, event_id, scope, canonical_key, canonicalizer_version, source)
       VALUES ($1, 'w-firm-suppression', 'firm', $2, 'v1', 'prospect_do_not_call')`,
      [seeded.alpha.workspaceId, crm.alpha.firmId.toLowerCase()],
    );
    expect(await consume('alpha', created.value.sessionId, callSid())).toEqual({ ok: false, reason: 'firm_suppressed' });
    expect(await create('alpha')).toEqual({ ok: false, reason: 'firm_suppressed' });
  });

  describe('the cadence (slice C1)', () => {
    // Beta's firm is in America/New_York; every instant is inside the weekday window.
    const WED_10 = '2026-09-16T14:00:00.000Z';
    const WED_15 = '2026-09-16T19:00:00.000Z';
    const THU_11 = '2026-09-17T15:00:00.000Z';
    const THU_13 = '2026-09-17T17:00:00.000Z';
    const FRI_16 = '2026-09-18T20:00:00.000Z';
    const MON_09 = '2026-09-21T13:00:00.000Z';
    const TUE_12 = '2026-09-22T16:00:00.000Z';
    const WED_NEXT_15 = '2026-09-30T19:00:00.000Z';

    const beta = (): RepositoryContext => salesperson('beta');

    async function createAt(at: string, context: RepositoryContext = beta()) {
      counter += 1;
      return await withTransaction(database.session, async () =>
        await createCallSession(context, {
          firmId: crm.beta.firmId,
          routeId: policy.beta.phoneRouteId,
          routeVersion: policy.beta.phoneRouteVersion,
          callingIdentityId: policy.beta.callingIdentityId,
          deviceId: seeded.beta.salesperson.deviceId,
          commandId: `cadence-${String(counter)}`,
          configuredCallerIdE164: '+14015550100',
          at,
        }),
      );
    }

    /** Consume a created session at `at` and date the call there. Returns its Call SID. */
    async function place(sessionId: string, at: string): Promise<{ ok: boolean; reason?: string; sid: string }> {
      const sid = callSid();
      const consumed = await withTransaction(database.session, async () =>
        await consumeCallSession(database.session, {
          workspaceId: seeded.beta.workspaceId,
          sessionId,
          callSid: sid,
          identity: `client:${seeded.beta.salesperson.userId}`,
          at,
        }),
      );
      if (!consumed.ok) return { ok: false, reason: consumed.reason, sid };
      // The call happened at `at` on the firm's clock, not at the test's wall clock.
      await database.session.query(
        `UPDATE call_sessions SET consumed_at = $2::timestamptz, expires_at = GREATEST(expires_at, $2::timestamptz)
          WHERE id = $1`,
        [sessionId, at],
      );
      return { ok: true, sid };
    }

    const status = async (sid: string, providerStatus: string) =>
      await withTransaction(database.session, async () => await recordCallStatus(database.session, { callSid: sid, providerStatus }));

    /** An outcome recorded through the real command, linked to the session. */
    // "Just now" on the database's clock: an unanswered outcome's instant resets nothing.
    const record = async (sessionId: string, outcome: 'voicemail_left' | 'no_answer' | 'not_interested', _at: string) =>
      await withTransaction(database.session, async () =>
        await logCallOutcome(beta(), { firmId: crm.beta.firmId, callSessionId: sessionId, outcome }),
      );

    /** Create, place and end a call at `at`: Twilio's final status, and an outcome if given. */
    async function attempt(at: string, ending: { provider?: string; outcome?: 'voicemail_left' | 'no_answer' } = {}): Promise<string> {
      const created = await createAt(at);
      if (!created.ok) throw new Error(`refused at ${at}: ${created.reason}`);
      const placed = await place(created.value.sessionId, at);
      if (!placed.ok) throw new Error(`not placed at ${at}: ${placed.reason ?? ''}`);
      if (ending.provider !== undefined) await status(placed.sid, ending.provider);
      if (ending.outcome !== undefined) {
        const logged = await record(created.value.sessionId, ending.outcome, at);
        if (!logged.ok) throw new Error(logged.reason);
      }
      return created.value.sessionId;
    }

    /** A resetting outcome for the firm at `at`: everything before it is out of the count. */
    async function reset(at: string): Promise<void> {
      // Prior tests resume using wall-clock database time. Align their released
      // fixture holds to this scripted reset, or crossing 5 Oct 2026 makes the
      // first scripted attempt disappear from the next test's cadence count.
      await database.session.query(
        `UPDATE active_holds SET started_at=LEAST(started_at,$3::timestamptz),released_at=LEAST(released_at,$3::timestamptz)
          WHERE workspace_id=$1 AND scope_key=$2 AND source_event_kind='call_cadence_parked'
            AND released_at IS NOT NULL`,
        [seeded.beta.workspaceId,crm.beta.firmId,at],
      );
      await database.session.query(
        `INSERT INTO call_logs (workspace_id, firm_id, outcome, step_effect, occurred_at, recorded_at, actor_user_id)
         VALUES ($1, $2, 'interested', 'none', $3::timestamptz, $3::timestamptz, $4)`,
        [seeded.beta.workspaceId, crm.beta.firmId, at, seeded.beta.salesperson.userId],
      );
    }

    const cadenceAt = async (at: string) =>
      await withTransaction(database.session, async () => await readCallCadence(beta(), crm.beta.firmId, at));

    async function openParkingHolds(): Promise<number> {
      const { rows } = await database.session.query<{ count: string }>(
        `SELECT count(*) AS count FROM active_holds
          WHERE workspace_id = $1 AND scope_key = $2 AND source_event_kind = 'call_cadence_parked' AND released_at IS NULL`,
        [seeded.beta.workspaceId, crm.beta.firmId],
      );
      return Number(rows[0]?.count ?? 0);
    }

    const resume = async () =>
      await withTransaction(database.session, async () => await resumeCallCadence(beta(), { firmId: crm.beta.firmId }));

    beforeAll(async () => {
      await budget('beta', 5000);
    });

    it('counts every placed call, spaces them on the firm’s clock, and parks when the fourth is recorded unanswered', async () => {
      expect(await cadenceAt(WED_10)).toMatchObject({ unansweredAttempts: 0, nextAttempt: 1, parked: false, refusal: null });
      await attempt(WED_10, { provider: 'no-answer' });
      expect(await createAt(WED_15)).toEqual({ ok: false, reason: 'call_attempt_today' });
      expect(await createAt(THU_11)).toEqual({ ok: false, reason: 'call_attempt_too_soon' });
      // Answered, and no outcome recorded: still an attempt until one says somebody was reached.
      await attempt(THU_13, { provider: 'completed' });
      expect(await cadenceAt(FRI_16)).toMatchObject({ unansweredAttempts: 2, nextAttempt: 3 });
      // A machine answered (in progress to Twilio) and David recorded the voicemail.
      await attempt(FRI_16, { provider: 'in-progress', outcome: 'voicemail_left' });
      expect(await openParkingHolds()).toBe(0);

      // The fourth, recorded unanswered by Twilio's final status: parked at once, without
      // waiting for a fifth request that a disabled Call button would never send.
      await attempt(MON_09, { provider: 'no-answer' });
      expect(await openParkingHolds()).toBe(1);
      const { rows: holds } = await database.session.query<{ reason_code: string; blocked_action_kinds: string[] }>(
        `SELECT reason_code, blocked_action_kinds FROM active_holds
          WHERE workspace_id = $1 AND scope_key = $2 AND source_event_kind = 'call_cadence_parked'`,
        [seeded.beta.workspaceId, crm.beta.firmId],
      );
      expect(holds[0]).toMatchObject({ reason_code: 'scoped_pause', blocked_action_kinds: ['dial_authorization'] });
      // The tel: path's decision is held too, and after the window the firm is still parked.
      const held = await withTransaction(database.session, async () =>
        await authorizeDial(beta(), {
          firmId: crm.beta.firmId,
          routeId: policy.beta.phoneRouteId,
          routeVersion: policy.beta.phoneRouteVersion,
          callingIdentityId: policy.beta.callingIdentityId,
          at: TUE_12,
        }),
      );
      expect(held).toMatchObject({ allowed: false, reason: 'scoped_pause' });
      expect(await createAt(TUE_12)).toEqual({ ok: false, reason: 'call_attempts_exhausted' });
      expect(await cadenceAt(WED_NEXT_15)).toMatchObject({ parked: true, refusal: 'call_attempts_exhausted' });
      expect(await openParkingHolds()).toBe(1);

      // Resume calling: the review releases the hold and starts the count again.
      expect((await resume()).ok).toBe(true);
      expect(await openParkingHolds()).toBe(0);
      expect(await cadenceAt(new Date(Date.now() + 60_000).toISOString())).toMatchObject({ unansweredAttempts: 0, nextAttempt: 1 });
    });

    it('parks when the fourth is recorded as a voicemail left, once however often it is recorded', async () => {
      await reset('2026-10-01T14:00:00.000Z');
      const base = Date.parse('2026-10-05T14:00:00.000Z'); // Monday 10:00 in New York
      const day = (days: number, hour = 0): string => new Date(base + days * 86_400_000 + hour * 3_600_000).toISOString();
      await attempt(day(0), { provider: 'no-answer' });
      await attempt(day(1, 3), { provider: 'busy' });
      await attempt(day(2), { provider: 'no-answer' });
      const fourth = await attempt(day(3, 3), { provider: 'in-progress', outcome: 'voicemail_left' });
      expect(await openParkingHolds()).toBe(1);
      // The same attempt's final status arriving late parks nothing more.
      const { rows } = await database.session.query<{ twilio_call_sid: string }>('SELECT twilio_call_sid FROM call_sessions WHERE id = $1', [
        fourth,
      ]);
      await status(rows[0]?.twilio_call_sid ?? '', 'completed');
      expect(await openParkingHolds()).toBe(1);
      expect((await resume()).ok).toBe(true);
    });

    it('keeps a placed call with no status and no outcome in the history: no expiry, and it spaces the next', async () => {
      await reset('2026-10-12T12:00:00.000Z');
      const MON = '2026-10-19T14:00:00.000Z'; // 10:00 in New York
      const created = await createAt(MON);
      if (!created.ok) throw new Error(created.reason);
      expect((await place(created.value.sessionId, MON)).ok).toBe(true);
      // Six hours later, the same day: still that day's attempt (nothing expired it).
      expect(await createAt('2026-10-19T20:00:00.000Z')).toEqual({ ok: false, reason: 'call_attempt_today' });
      // The next day at nearly the same time: spaced from its time.
      expect(await createAt('2026-10-20T15:00:00.000Z')).toEqual({ ok: false, reason: 'call_attempt_too_soon' });
      expect(await cadenceAt('2026-10-26T14:00:00.000Z')).toMatchObject({ unansweredAttempts: 1, nextAttempt: 2 });
    });

    it('refuses the second of two sessions when the first reached a machine and has no outcome yet (the review’s case)', async () => {
      await reset('2026-10-27T12:00:00.000Z');
      const base = Date.parse('2026-11-02T15:00:00.000Z'); // Monday 10:00 in New York (EST)
      const day = (days: number, hour = 0): string => new Date(base + days * 86_400_000 + hour * 3_600_000).toISOString();
      await attempt(day(0), { provider: 'no-answer' });
      await attempt(day(1, 3), { provider: 'no-answer' });
      await attempt(day(2), { provider: 'no-answer' });
      // Two sessions for the fourth; the first is answered by a machine (in progress).
      const first = await createAt(day(3, 3));
      const second = await createAt(day(3, 3));
      if (!first.ok || !second.ok) throw new Error('not created');
      const placed = await place(first.value.sessionId, day(3, 3));
      await status(placed.sid, 'in-progress');
      expect(await place(second.value.sessionId, day(3, 3))).toMatchObject({ ok: false, reason: 'call_attempts_exhausted' });
      // David records the voicemail: the fourth unanswered attempt, and the firm is parked.
      expect((await record(first.value.sessionId, 'voicemail_left', day(3, 3))).ok).toBe(true);
      expect(await openParkingHolds()).toBe(1);
      expect((await resume()).ok).toBe(true);
    });

    it('parks from a call request only after the dial decision accepts the caller; another assignee’s firm writes nothing', async () => {
      await reset('2026-11-09T12:00:00.000Z');
      const base = Date.parse('2026-11-16T15:00:00.000Z'); // Monday 10:00 in New York
      const day = (days: number, hour = 0): string => new Date(base + days * 86_400_000 + hour * 3_600_000).toISOString();
      await attempt(day(0), { provider: 'no-answer' });
      await attempt(day(1, 3), { provider: 'no-answer' });
      await attempt(day(2), { provider: 'no-answer' });
      // The fourth reached somebody who was not asked what happened: an attempt, no hold yet.
      await attempt(day(3, 3), { provider: 'completed' });
      expect(await openParkingHolds()).toBe(0);

      await database.session.query('UPDATE firms SET assigned_user_id = $2 WHERE workspace_id = $1 AND id = $3', [
        seeded.beta.workspaceId,
        seeded.beta.admin.userId,
        crm.beta.firmId,
      ]);
      try {
        const refused = await createAt(day(4));
        expect(refused.ok).toBe(false);
        expect(refused).not.toEqual({ ok: false, reason: 'call_attempts_exhausted' });
        expect(await openParkingHolds()).toBe(0);
      } finally {
        await database.session.query('UPDATE firms SET assigned_user_id = $2 WHERE workspace_id = $1 AND id = $3', [
          seeded.beta.workspaceId,
          seeded.beta.salesperson.userId,
          crm.beta.firmId,
        ]);
      }
      // The assignee's own request is accepted by the decision, and parks the firm once.
      expect(await createAt(day(4))).toEqual({ ok: false, reason: 'call_attempts_exhausted' });
      expect(await createAt(day(4))).toEqual({ ok: false, reason: 'call_attempts_exhausted' });
      expect(await openParkingHolds()).toBe(1);
    });

    it('does not park on a late classification that completes no 14-day window (days 0, 7, 14, 15)', async () => {
      expect((await resume()).ok).toBe(true);
      await reset('2026-11-30T12:00:00.000Z');
      const base = Date.parse('2026-12-07T15:00:00.000Z'); // Monday 10:00 in New York
      const day = (days: number, hour = 0): string => new Date(base + days * 86_400_000 + hour * 3_600_000).toISOString();
      // Day 0 reached somebody who was not asked what happened: an attempt, unclassified.
      const first = await attempt(day(0), { provider: 'completed' });
      await attempt(day(7, 3), { provider: 'no-answer' });
      await attempt(day(14), { provider: 'no-answer' });
      await attempt(day(15, 3), { provider: 'no-answer' });
      expect(await openParkingHolds()).toBe(0);
      // On day 15 David records day 0's call as unanswered: the window ending at the latest
      // call holds days 7, 14 and 15 only.
      expect((await record(first, 'no_answer', day(15, 3))).ok).toBe(true);
      expect(await openParkingHolds()).toBe(0);
    });

    it('parks on a fourth placed at a microsecond past the millisecond: the window ends at the database’s instant (C1 fold 3)', async () => {
      await reset('2026-12-28T12:00:00.000Z');
      const base = Date.parse('2027-01-04T15:00:00.000Z'); // Monday 10:00 in New York
      const day = (days: number, hour = 0): string => new Date(base + days * 86_400_000 + hour * 3_600_000).toISOString();
      await attempt(day(0), { provider: 'no-answer' });
      await attempt(day(1, 3), { provider: 'no-answer' });
      await attempt(day(2), { provider: 'no-answer' });
      expect(await openParkingHolds()).toBe(0);
      // Through a JS Date this instant is .123, before the call itself: the window would
      // end before its own latest call and hold three.
      await attempt(day(3, 3).replace('.000Z', '.123456Z'), { provider: 'no-answer' });
      expect(await openParkingHolds()).toBe(1);
      expect((await resume()).ok).toBe(true);
    });
  });
});
