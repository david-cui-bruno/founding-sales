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
 * is closed first rather than left counting against the budget for ever. Slice C2: the
 * call's transcript goes too, and an open transcription attempt is finalised first.
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

    // Slice C2: the call was transcribed, and a second transcription attempt is still
    // `calling` (a claim mid-call when the deletion arrives).
    await database.session.query(
      `INSERT INTO call_transcripts (workspace_id, call_session_id, provider, model, language, duration_seconds, utterances)
       VALUES ($1, $2, 'deepgram', 'nova-3', 'en', 95, '[{"speaker": 0, "start": 0, "end": 1, "text": "Hello?"}]'::jsonb)`,
      [seeded.alpha.workspaceId, created.value.sessionId],
    );
    await database.session.query(
      `INSERT INTO provider_reservations
         (workspace_id, provider_key, subject_kind, subject_id, attempt, business_date, business_time_zone,
          cents, priced_unit, max_units, unit_price_micros, state)
       VALUES ($1, 'deepgram.nova-3', 'call_transcription', $2, 1, '2026-09-30', 'America/New_York', 1, 'minute', 2, 4300, 'calling')`,
      [seeded.alpha.workspaceId, created.value.sessionId],
    );

    const preview = await previewDeletion(admin(), { targetKind: 'firm', firmId: crm.alpha.firmId });
    expect(preview.value?.removes['call_sessions']).toBe(1);
    expect(preview.value?.removes['call_transcripts']).toBe(1);
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
    // The transcript went with the session, and its open attempt was estimated, not left counting.
    const { rows: transcripts } = await database.session.query('SELECT 1 FROM call_transcripts WHERE call_session_id = $1', [
      created.value.sessionId,
    ]);
    expect(transcripts).toEqual([]);
    const { rows: transcription } = await database.session.query<{ state: string; settled_cents: number }>(
      "SELECT state, settled_cents FROM provider_reservations WHERE workspace_id = $1 AND subject_kind = 'call_transcription'",
      [seeded.alpha.workspaceId],
    );
    expect(transcription).toEqual([{ state: 'estimated', settled_cents: 1 }]);
  });

  it('removes a person s unmatched and domain-matched meetings with their contact (review fold 1, finding 10)', async () => {
    const beta = seeded.beta.workspaceId;
    const betaAdmin = repositoryContext(
      workspaceScope(beta, { kind: 'user', userId: seeded.beta.admin.userId, role: 'admin' }),
      database.session,
    );
    await database.session.query("UPDATE firms SET website = 'https://beta-person-firm.example' WHERE id = $1", [crm.beta.firmId]);
    const book = async (uid: string, email: string) => {
      const body = {
        triggerEvent: 'BOOKING_CREATED',
        createdAt: '2026-09-30T12:00:00Z',
        payload: { uid, startTime: '2026-10-06T15:00:00Z', endTime: '2026-10-06T15:30:00Z', attendees: [{ email }] },
      };
      return await withTransaction(database.session, async () =>
        await receiveCalcomEvent(database.session, { workspaceId: beta, rawBody: Buffer.from(JSON.stringify(body)), body }),
      );
    };
    // Booked before Callie knew the person: one on an address nobody has, one matched
    // only by the firm's domain.
    const unmatched = await book('person-unmatched', 'pat@personal-mail.example');
    const byDomain = await book('person-domain', 'pat@beta-person-firm.example');
    const bystander = await book('someone-else', 'other@beta-person-firm.example');
    expect(unmatched).toMatchObject({ outcome: 'unmatched' });
    expect(byDomain).toMatchObject({ outcome: 'applied' });

    // Then the person is added, with both addresses, and asks to be deleted.
    const { rows: contact } = await database.session.query<{ id: string }>(
      "INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, 'Pat Person') RETURNING id",
      [beta, crm.beta.firmId],
    );
    const contactId = contact[0]?.id ?? '';
    for (const address of ['pat@personal-mail.example', 'pat@beta-person-firm.example']) {
      await database.session.query(
        `INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at)
         VALUES ($1, $2, $3, $4, 'salesperson', now())`,
        [beta, crm.beta.firmId, contactId, address],
      );
    }
    const preview = await previewDeletion(betaAdmin, { targetKind: 'contact', firmId: crm.beta.firmId, contactId });
    expect(preview.value?.removes['meetings']).toBe(2);
    const outcome = await commitDeletion(betaAdmin, {
      requestId: preview.value?.requestId ?? '',
      previewHash: preview.value?.previewHash ?? '',
      commandId: 'deletion-person-meetings',
      journal: recordingSuppressionJournal(),
    });
    expect(outcome.ok, outcome.ok ? '' : outcome.reason).toBe(true);
    const { rows: left } = await database.session.query<{ booking_uid: string }>(
      'SELECT booking_uid FROM meetings WHERE workspace_id = $1 ORDER BY booking_uid',
      [beta],
    );
    expect(left.map(row => row.booking_uid)).toEqual(['someone-else']);
    const { rows: reviews } = await database.session.query<{ evidence_id: string }>(
      "SELECT evidence_id FROM stage_review_items WHERE workspace_id = $1 AND evidence_kind = 'meeting.booked'",
      [beta],
    );
    expect(reviews.map(row => row.evidence_id)).not.toContain(unmatched.meetingId);
    const { rows: deliveries } = await database.session.query<{ booking_uid: string }>(
      'SELECT booking_uid FROM calcom_events WHERE workspace_id = $1 ORDER BY booking_uid',
      [beta],
    );
    expect(deliveries.map(row => row.booking_uid)).toEqual(['someone-else']);
    expect(bystander.meetingId).not.toBeNull();
  });
});
