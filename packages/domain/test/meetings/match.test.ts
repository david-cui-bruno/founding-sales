import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { withTransaction } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { receiveCalcomEvent } from '../../meetings/calcom.ts';
import { listFirmMeetings, listUnmatchedMeetings, matchMeetingToFirm } from '../../meetings/match.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';

/**
 * A person attaching an unmatched Cal.com booking to a firm (slice M1): who may, what it
 * links, the review item it resolves, and the evidence it applies. The stop it owes to
 * prospecting is proven over HTTP in `apps/api/test/calcomDepth.test.ts`.
 */
describe('matching an unmatched booking to a firm', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let counter = 0;
  const workspaceId = (): string => seeded.alpha.workspaceId;

  const salesperson = (): RepositoryContext =>
    repositoryContext(
      workspaceScope(workspaceId(), { kind: 'user', userId: seeded.alpha.salesperson.userId, role: 'salesperson' }),
      database.session,
    );
  const admin = (): RepositoryContext =>
    repositoryContext(workspaceScope(workspaceId(), { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }), database.session);

  async function firm(name: string, assignedUserId: string): Promise<string> {
    const { rows } = await database.session.query<{ id: string }>(
      'INSERT INTO firms (workspace_id, name, assigned_user_id) VALUES ($1, $2, $3) RETURNING id',
      [workspaceId(), name, assignedUserId],
    );
    return rows[0]?.id ?? '';
  }

  /** A booking by somebody no firm knows: an unmatched meeting and its review item. */
  async function unmatched(attendee: string, trigger = 'BOOKING_CREATED'): Promise<string> {
    counter += 1;
    const body = {
      triggerEvent: trigger,
      createdAt: `2026-09-30T12:${String(counter).padStart(2, '0')}:00.000Z`,
      payload: {
        uid: `mt${String(counter)}x`,
        startTime: '2026-10-06T15:00:00.000Z',
        endTime: '2026-10-06T15:30:00.000Z',
        attendees: [{ email: attendee }],
      },
    };
    const receipt = await withTransaction(database.session, async () =>
      await receiveCalcomEvent(database.session, { workspaceId: workspaceId(), rawBody: Buffer.from(JSON.stringify(body)), body }),
    );
    if (receipt.meetingId === null) throw new Error('no meeting');
    return receipt.meetingId;
  }

  const match = async (context: RepositoryContext, meetingId: string, firmId: string) =>
    await withTransaction(database.session, async () => await matchMeetingToFirm(context, { meetingId, firmId }));

  async function review(meetingId: string): Promise<{ reason: string; resolved: boolean; firm_id: string | null } | undefined> {
    const { rows } = await database.session.query<{ reason: string; resolved: boolean; firm_id: string | null }>(
      `SELECT reason, resolved_at IS NOT NULL AS resolved, firm_id FROM stage_review_items
        WHERE workspace_id = $1 AND evidence_kind = 'meeting.booked' AND evidence_id = $2`,
      [workspaceId(), meetingId],
    );
    return rows[0];
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
  });

  afterAll(async () => {
    await database.drop();
  });

  it('links the firm, creates the contact with the address, resolves the review item, and moves no deal (lane M1)', async () => {
    const firmId = await firm('Lakeside Law', seeded.alpha.salesperson.userId);
    const meetingId = await unmatched('dana@lakeside.example');
    expect((await listUnmatchedMeetings(salesperson())).map(entry => entry.meetingId)).toContain(meetingId);

    const matched = await match(salesperson(), meetingId, firmId);
    expect(matched).toMatchObject({ ok: true, value: { meetingId, firmId, state: 'booked', stage: 'none' } });
    const contactId = matched.ok ? matched.value.contactId : null;
    expect(contactId).not.toBeNull();

    const { rows: address } = await database.session.query<{ contact_id: string; source: string }>(
      "SELECT contact_id, source FROM email_addresses WHERE workspace_id = $1 AND firm_id = $2 AND address = 'dana@lakeside.example'",
      [workspaceId(), firmId],
    );
    expect(address).toEqual([{ contact_id: contactId, source: 'salesperson' }]);
    expect(await review(meetingId)).toEqual({ reason: 'firm_unmatched', resolved: true, firm_id: firmId });
    // No opportunity opened at Demo booked: the board offers that move as one click instead.
    const { rows: opened } = await database.session.query<{ count: string }>(
      'SELECT count(*) AS count FROM opportunities WHERE workspace_id = $1 AND firm_id = $2',
      [workspaceId(), firmId],
    );
    expect(Number(opened[0]?.count)).toBe(0);
    expect((await listUnmatchedMeetings(salesperson())).map(entry => entry.meetingId)).not.toContain(meetingId);
    expect((await listFirmMeetings(salesperson(), firmId))?.map(entry => entry.state)).toEqual(['booked']);
  });

  it('links the firm s existing contact when the attendee s address is theirs', async () => {
    const firmId = await firm('Harbor Law', seeded.alpha.salesperson.userId);
    const { rows } = await database.session.query<{ id: string }>(
      "INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, 'Robin Example') RETURNING id",
      [workspaceId(), firmId],
    );
    const contactId = rows[0]?.id ?? '';
    // A booking made before the address was on the contact: unmatched when it arrived.
    const meetingId = await unmatched('robin@harbor.example');
    await database.session.query(
      `INSERT INTO email_addresses (workspace_id, firm_id, contact_id, address, source, retrieved_at, technical_validation, eligibility)
       VALUES ($1, $2, $3, 'robin@harbor.example', 'salesperson', now(), 'unknown', 'candidate')`,
      [workspaceId(), firmId, contactId],
    );
    expect(await match(salesperson(), meetingId, firmId)).toMatchObject({ ok: true, value: { contactId } });
    const { rows: contacts } = await database.session.query<{ count: string }>('SELECT count(*) AS count FROM contacts WHERE workspace_id = $1 AND firm_id = $2', [
      workspaceId(),
      firmId,
    ]);
    expect(Number(contacts[0]?.count)).toBe(1);
  });

  it('refuses a firm that is not the caller s, an unknown meeting, and a meeting already matched', async () => {
    const theirs = await firm('Elsewhere Law', seeded.alpha.admin.userId);
    const mine = await firm('Mine Law', seeded.alpha.salesperson.userId);
    const meetingId = await unmatched('pat@nowhere.example');
    expect(await match(salesperson(), meetingId, theirs)).toEqual({ ok: false, reason: 'not_assigned' });
    expect(await match(salesperson(), '00000000-0000-4000-8000-000000000000', mine)).toEqual({ ok: false, reason: 'meeting_unknown' });
    expect(await match(salesperson(), meetingId, '00000000-0000-4000-8000-000000000000')).toEqual({ ok: false, reason: 'firm_unknown' });
    // An administrator may match to any firm; after that the meeting is matched.
    expect(await match(admin(), meetingId, theirs)).toMatchObject({ ok: true });
    expect(await match(admin(), meetingId, mine)).toEqual({ ok: false, reason: 'meeting_already_matched' });
  });

  it('opens no review item and no deal for a firm whose opportunity is closed: the stage is a person s (lane M1)', async () => {
    const firmId = await firm('Closed Law', seeded.alpha.salesperson.userId);
    await database.session.query(
      `INSERT INTO opportunities (workspace_id, firm_id, stage_id, status, closed_at, close_reason, control_mode_changed_at)
       VALUES ($1, $2, (SELECT id FROM pipeline_stages WHERE workspace_id = $1 AND key = 'lost'), 'lost', now(), 'went quiet', now())`,
      [workspaceId(), firmId],
    );
    const meetingId = await unmatched('lee@closed.example');
    expect(await match(salesperson(), meetingId, firmId)).toMatchObject({ ok: true, value: { stage: 'none' } });
    // The matching item is resolved, and no new one is opened: there is no automatic move to review.
    expect(await review(meetingId)).toEqual({ reason: 'firm_unmatched', resolved: true, firm_id: firmId });
  });

  it('writes no meeting.held for a booking that has only ended when it is matched (lane M1)', async () => {
    const firmId = await firm('Ended Law', seeded.alpha.salesperson.userId);
    const meetingId = await unmatched('casey@ended.example');
    // Cal.com's scheduled end arrives before anybody matched the booking.
    counter += 1;
    const body = {
      triggerEvent: 'MEETING_ENDED',
      uid: `mt${String(counter - 1)}x`,
      startTime: '2026-10-06T15:00:00.000Z',
      endTime: '2026-10-06T15:30:00.000Z',
      attendees: [{ email: 'casey@ended.example', noShow: false }],
    };
    await withTransaction(database.session, async () =>
      await receiveCalcomEvent(database.session, { workspaceId: workspaceId(), rawBody: Buffer.from(JSON.stringify(body)), body }),
    );
    expect(await match(salesperson(), meetingId, firmId)).toMatchObject({ ok: true, value: { state: 'ended', stage: 'none' } });
    const { rows } = await database.session.query(
      "SELECT 1 FROM funnel_facts WHERE workspace_id = $1 AND kind = 'meeting.held' AND firm_id = $2",
      [workspaceId(), firmId],
    );
    expect(rows).toEqual([]);
  });

  it('links a cancelled booking without applying anything', async () => {
    const firmId = await firm('Cancelled Law', seeded.alpha.salesperson.userId);
    const meetingId = await unmatched('sam@cancelled.example', 'BOOKING_CANCELLED');
    expect(await match(salesperson(), meetingId, firmId)).toMatchObject({ ok: true, value: { state: 'cancelled', stage: 'none' } });
    const { rows } = await database.session.query<{ count: string }>('SELECT count(*) AS count FROM opportunities WHERE workspace_id = $1 AND firm_id = $2', [
      workspaceId(),
      firmId,
    ]);
    expect(Number(rows[0]?.count)).toBe(0);
  });
});
