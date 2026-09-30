import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { withTransaction } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import {
  consumeCallSession,
  createCallSession,
  recordCallRecording,
  recordCallStatus,
  sweepCallSessionReservations,
} from '../../calls/sessions.ts';
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
    return await withTransaction(database.session, async () =>
      await consumeCallSession(database.session, {
        workspaceId: seeded[workspace].workspaceId,
        sessionId,
        callSid: sid,
        identity: identity ?? `client:${seeded[workspace].salesperson.userId}`,
        at: policy.insideWindow,
      }),
    );
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

  it('acknowledges a callback for an unknown SID without writing', async () => {
    const outcome = await withTransaction(database.session, async () =>
      await recordCallStatus(database.session, { callSid: callSid(), providerStatus: 'completed' }),
    );
    expect(outcome).toEqual({ known: false });
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

  it('refuses a fourth placed call at one firm in a day', async () => {
    await budget('beta', 500);
    for (let placed = 0; placed < 3; placed += 1) {
      const created = await create('beta');
      if (!created.ok) throw new Error(created.reason);
      expect((await consume('beta', created.value.sessionId, callSid())).ok).toBe(true);
    }
    expect(await create('beta')).toEqual({ ok: false, reason: 'call_attempt_limit' });
  });
});
