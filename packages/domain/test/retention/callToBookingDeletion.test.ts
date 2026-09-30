import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { withTransaction } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { consumeCallSession, createCallSession } from '../../calls/sessions.ts';
import { receiveCalcomEvent } from '../../meetings/calcom.ts';
import { commitDeletion, previewDeletion } from '../../retention/deletion.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';
import { seedPolicy, type SeededPolicy } from '../db/support/policyFixtures.ts';

/**
 * A firm deletion with migration 0028's rows (slice W): the call session, the meeting,
 * its Cal.com delivery and the review item go with the firm, in an order their foreign
 * keys onto the dial ticket and the call log allow, and the session's open reservation
 * is closed first rather than left counting against the budget for ever.
 */
describe('the deletion workflow and the call-to-booking rows', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;
  let policy: SeededPolicy;

  const admin = (): RepositoryContext =>
    repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
      database.session,
    );

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
    crm = await seedCrm(database.session, seeded);
    policy = await seedPolicy(database.session, seeded, crm);
    await database.session.query(
      `INSERT INTO workspace_settings (workspace_id, setting_key, version, value, changed_by_user_id)
       VALUES ($1, 'telephony_budget', 1, '{"dailyCeilingCents": 500, "maxMinutesPerCall": 30, "unitPriceMicros": 14000}', $2)`,
      [seeded.alpha.workspaceId, seeded.alpha.admin.userId],
    );
    await database.session.query("UPDATE firms SET website = 'https://deleted-firm.example' WHERE id = $1", [crm.alpha.firmId]);
  });

  afterAll(async () => {
    await database.drop();
  });

  it('removes the session, the meeting and its delivery, and closes the reservation', async () => {
    const salesperson = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.salesperson.userId, role: 'salesperson' }),
      database.session,
    );
    const created = await withTransaction(database.session, async () =>
      await createCallSession(salesperson, {
        firmId: crm.alpha.firmId,
        routeId: policy.alpha.phoneRouteId,
        routeVersion: policy.alpha.phoneRouteVersion,
        callingIdentityId: policy.alpha.callingIdentityId,
        deviceId: seeded.alpha.salesperson.deviceId,
        commandId: 'deletion-session',
        configuredCallerIdE164: '+14015550100',
        at: policy.insideWindow,
      }),
    );
    if (!created.ok) throw new Error(created.reason);
    const consumed = await withTransaction(database.session, async () =>
      await consumeCallSession(database.session, {
        workspaceId: seeded.alpha.workspaceId,
        sessionId: created.value.sessionId,
        callSid: `CA${randomBytes(16).toString('hex')}`,
        identity: `client:${seeded.alpha.salesperson.userId}`,
        at: policy.insideWindow,
      }),
    );
    expect(consumed.ok).toBe(true);
    const body = {
      triggerEvent: 'BOOKING_CREATED',
      createdAt: '2026-09-30T12:00:00Z',
      payload: {
        uid: 'deletedbooking',
        startTime: '2026-10-06T15:00:00Z',
        endTime: '2026-10-06T15:30:00Z',
        attendees: [{ email: 'someone@deleted-firm.example' }],
      },
    };
    const meeting = await withTransaction(database.session, async () =>
      await receiveCalcomEvent(database.session, {
        workspaceId: seeded.alpha.workspaceId,
        rawBody: Buffer.from(JSON.stringify(body)),
        body,
      }),
    );
    expect(meeting).toMatchObject({ outcome: 'applied' });

    const preview = await previewDeletion(admin(), { targetKind: 'firm', firmId: crm.alpha.firmId });
    expect(preview.value?.removes['call_sessions']).toBe(1);
    expect(preview.value?.removes['meetings']).toBe(1);
    expect(preview.value?.removes['calcom_events']).toBe(1);
    const outcome = await commitDeletion(admin(), {
      requestId: preview.value?.requestId ?? '',
      previewHash: preview.value?.previewHash ?? '',
      commandId: 'deletion-call-to-booking',
      journal: recordingSuppressionJournal(),
    });
    expect(outcome.ok, outcome.ok ? '' : outcome.reason).toBe(true);
    for (const table of ['call_sessions', 'meetings']) {
      const { rows } = await database.session.query<{ count: string }>(
        `SELECT count(*) AS count FROM ${table} WHERE workspace_id = $1 AND firm_id = $2`,
        [seeded.alpha.workspaceId, crm.alpha.firmId],
      );
      expect(Number(rows[0]?.count), table).toBe(0);
    }
    const { rows } = await database.session.query<{ state: string }>(
      "SELECT state FROM provider_reservations WHERE workspace_id = $1 AND subject_kind = 'call_session'",
      [seeded.alpha.workspaceId],
    );
    expect(rows.map(row => row.state)).toEqual(['estimated']);
  });
});
