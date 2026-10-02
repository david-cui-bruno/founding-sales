import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { withTransaction } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { consumeCallSession, createCallSession, readCallCadence, recordCallStatus } from '../../calls/sessions.ts';
import { logCallOutcome } from '../../dial/calls.ts';
import { readCallsPlacedToday } from '../../today/callsPlaced.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedPolicy, type SeededPolicy } from '../db/support/policyFixtures.ts';

/**
 * "Log incoming call" (slice S2, migration 0034): a callback David took on his mobile,
 * logged against its firm and contact through the ordinary call-outcome command.
 *
 * It is recorded with `direction = 'inbound'` and its optional length, it binds nothing
 * a placed call binds (ticket, session, route, calling identity, a sequence's call step),
 * and its outcome says somebody was reached. And it is never an attempt: the cadence
 * counts placed sessions, so three unanswered attempts and an incoming call are three,
 * not the four that would park the firm, and the day's "calls placed" does not move.
 */
describe('an incoming call', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;
  let policy: SeededPolicy;
  let counter = 0;

  const salesperson = (): RepositoryContext =>
    repositoryContext(
      workspaceScope(seeded.beta.workspaceId, { kind: 'user', userId: seeded.beta.salesperson.userId, role: 'salesperson' }),
      database.session,
    );
  const log = async (input: Omit<Parameters<typeof logCallOutcome>[1], 'firmId'>) =>
    await withTransaction(database.session, async () => await logCallOutcome(salesperson(), { firmId: crm.beta.firmId, ...input }));

  /** Create, place and end one unanswered call at `at` (Beta's firm is in New York). */
  async function unansweredAttempt(at: string): Promise<void> {
    counter += 1;
    const created = await withTransaction(database.session, async () =>
      await createCallSession(salesperson(), {
        firmId: crm.beta.firmId,
        routeId: policy.beta.phoneRouteId,
        routeVersion: policy.beta.phoneRouteVersion,
        callingIdentityId: policy.beta.callingIdentityId,
        deviceId: seeded.beta.salesperson.deviceId,
        commandId: `incoming-${String(counter)}`,
        configuredCallerIdE164: '+14015550100',
        at,
      }),
    );
    if (!created.ok) throw new Error(created.reason);
    const sid = `CA${randomBytes(16).toString('hex')}`;
    const consumed = await withTransaction(database.session, async () =>
      await consumeCallSession(database.session, {
        workspaceId: seeded.beta.workspaceId,
        sessionId: created.value.sessionId,
        callSid: sid,
        identity: `client:${seeded.beta.salesperson.userId}`,
        at,
      }),
    );
    if (!consumed.ok) throw new Error(consumed.reason);
    await database.session.query(
      'UPDATE call_sessions SET consumed_at = $2::timestamptz, expires_at = GREATEST(expires_at, $2::timestamptz) WHERE id = $1',
      [created.value.sessionId, at],
    );
    await withTransaction(database.session, async () => await recordCallStatus(database.session, { callSid: sid, providerStatus: 'no-answer' }));
  }

  const parkingHolds = async (): Promise<number> => {
    const { rows } = await database.session.query<{ count: string }>(
      `SELECT count(*) AS count FROM active_holds
        WHERE workspace_id = $1 AND scope_key = $2 AND source_event_kind = 'call_cadence_parked' AND released_at IS NULL`,
      [seeded.beta.workspaceId, crm.beta.firmId],
    );
    return Number(rows[0]?.count ?? 0);
  };

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
    crm = await seedCrm(database.session, seeded);
    policy = await seedPolicy(database.session, seeded, crm);
    await database.session.query(
      `INSERT INTO workspace_settings (workspace_id, setting_key, version, value, changed_by_user_id)
       VALUES ($1, 'telephony_budget', 1, '{"dailyCeilingCents": 5000, "maxMinutesPerCall": 30, "unitPriceMicros": 14000}'::jsonb, $2)`,
      [seeded.beta.workspaceId, seeded.beta.admin.userId],
    );
  });

  afterAll(async () => {
    await database.drop();
  });

  it('is recorded inbound, with its length and note, against the firm and contact', async () => {
    const before = await readCallsPlacedToday(salesperson());
    const occurredAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const logged = await log({
      direction: 'inbound',
      durationSeconds: 240,
      contactId: crm.beta.contactId,
      outcome: 'interested',
      occurredAt,
      note: 'Called back about the after-hours line',
    });
    expect(logged.ok).toBe(true);
    const id = logged.ok ? logged.value.callLogId : '';
    const { rows } = await database.session.query<Record<string, unknown>>(
      'SELECT direction, duration_seconds, contact_id, ticket_id, phone_route_id, occurred_at, note FROM call_logs WHERE id = $1',
      [id],
    );
    expect(rows[0]).toMatchObject({
      direction: 'inbound',
      duration_seconds: 240,
      contact_id: crm.beta.contactId,
      ticket_id: null,
      phone_route_id: null,
      note: 'Called back about the after-hours line',
    });
    expect((rows[0]?.['occurred_at'] as Date).toISOString()).toBe(occurredAt);
    // Not a call placed: today's count is what it was.
    expect((await readCallsPlacedToday(salesperson())).calls).toBe(before.calls);
  });

  it('binds nothing a placed call binds, and is never unanswered', async () => {
    for (const outcome of ['no_answer', 'busy', 'voicemail_left', 'wrong_number', 'policy_or_technical_failure'] as const) {
      expect(await log({ direction: 'inbound', outcome })).toEqual({ ok: false, reason: 'invalid_input' });
    }
    expect(await log({ direction: 'inbound', outcome: 'interested', routeId: policy.beta.phoneRouteId })).toEqual({
      ok: false,
      reason: 'invalid_input',
    });
    expect(await log({ direction: 'inbound', outcome: 'interested', callingIdentityId: policy.beta.callingIdentityId })).toEqual({
      ok: false,
      reason: 'invalid_input',
    });
    // A typed length belongs to an incoming call only; an outbound call's is its session's.
    expect(await log({ outcome: 'no_answer', durationSeconds: 30 })).toEqual({ ok: false, reason: 'invalid_input' });
    expect(await log({ direction: 'inbound', outcome: 'interested', durationSeconds: -1 })).toEqual({ ok: false, reason: 'invalid_input' });
  });

  it('is not an attempt: three unanswered calls and an incoming one do not park the firm', async () => {
    // Monday 10:00 New York, a week from the seed; each attempt a day and three hours apart.
    const base = Date.parse('2026-11-02T15:00:00.000Z');
    const day = (days: number, hours = 0): string => new Date(base + days * 86_400_000 + hours * 3_600_000).toISOString();
    await unansweredAttempt(day(0));
    await unansweredAttempt(day(1, 3));
    await unansweredAttempt(day(2));
    const cadence = async () => await withTransaction(database.session, async () => await readCallCadence(salesperson(), crm.beta.firmId, day(3)));
    expect(await cadence()).toMatchObject({ unansweredAttempts: 3, nextAttempt: 4, parked: false });

    const sessionsBefore = (await database.session.query('SELECT id FROM call_sessions WHERE firm_id = $1', [crm.beta.firmId])).rows.length;
    expect((await log({ direction: 'inbound', outcome: 'callback_requested', contactId: crm.beta.contactId })).ok).toBe(true);
    expect((await database.session.query('SELECT id FROM call_sessions WHERE firm_id = $1', [crm.beta.firmId])).rows).toHaveLength(sessionsBefore);
    // Logged "just now", before the three: it starts nothing again and adds nothing.
    expect(await cadence()).toMatchObject({ unansweredAttempts: 3, nextAttempt: 4, parked: false });
    expect(await parkingHolds()).toBe(0);
  });
});
