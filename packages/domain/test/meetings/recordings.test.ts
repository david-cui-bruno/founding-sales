import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { withTransaction } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { foldMeetings, MEETING_COLUMNS, receiveCalcomEvent, type MeetingRow } from '../../meetings/calcom.ts';
import { listFirmRecordings, listRecordingCandidates, minimiseName, registerMeetingRecordings, type RecordingCheck, type UploaderBinding } from '../../meetings/recordings.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';

/**
 * Lane M4: a demo's uploaded files, as the domain records them (migration 0041).
 *
 *   * Two registers of the same file on two connections, at once: the firm row's lock
 *     serializes them, and the second finds the first's row — one row, `new` then `existing`.
 *   * A Cal.com fold moves the folded meeting's recordings to the survivor (keeping each
 *     object's key); a digest the survivor already has is the same file and is not doubled.
 *   * A deleted meeting takes its recordings with it.
 *
 * Invented names only.
 */

const verifyOk = async (): Promise<RecordingCheck> => await Promise.resolve({ verdict: 'ok', uploadId: '77777777-7777-4777-8777-777777777777' });
const sha = (letter: string): string => letter.repeat(64);
const file = (letter: string, segment = 1) => ({ sha256: sha(letter), sizeBytes: 100, participantLabel: `audioSpeaker${letter}1.m4a`, segment });

describe('meeting recordings in the domain', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let other: SessionQueryable;
  let counter = 0;
  const workspaceId = (): string => seeded.alpha.workspaceId;
  const salesperson = (session: SessionQueryable): RepositoryContext =>
    repositoryContext(workspaceScope(workspaceId(), { kind: 'user', userId: seeded.alpha.salesperson.userId, role: 'salesperson' }), session);

  async function firm(): Promise<string> {
    counter += 1;
    const { rows } = await database.session.query<{ id: string }>(
      'INSERT INTO firms (workspace_id, name, assigned_user_id) VALUES ($1, $2, $3) RETURNING id',
      [workspaceId(), `Recording Domain Test ${String(counter)}`, seeded.alpha.salesperson.userId],
    );
    return rows[0]?.id ?? '';
  }

  async function meeting(firmId: string): Promise<string> {
    counter += 1;
    const uid = `m4dom${String(counter)}`;
    const { rows } = await database.session.query<{ id: string }>(
      `INSERT INTO meetings (workspace_id, booking_uid, current_booking_uid, firm_id, state, starts_at, ends_at, last_event_at)
       VALUES ($1, $2, $2, $3, 'booked', '2026-10-05T15:00:00Z', '2026-10-05T15:20:00Z', now()) RETURNING id`,
      [workspaceId(), uid, firmId],
    );
    const id = rows[0]?.id ?? '';
    await database.session.query('INSERT INTO meeting_booking_uids (workspace_id, booking_uid, meeting_id) VALUES ($1, $2, $3)', [workspaceId(), uid, id]);
    return id;
  }

  const recordings = async (meetingId: string) =>
    (await database.session.query<{ sha256: string; s3_key: string }>('SELECT sha256, s3_key FROM meeting_recordings WHERE meeting_id = $1 ORDER BY sha256', [meetingId])).rows;

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
    other = await database.appRuntimeSession();
  });

  afterAll(async () => {
    await database.drop();
  });

  it('two registers of one file at once, on two connections: one row, new then existing', async () => {
    const meetingId = await meeting(await firm());
    await database.session.query('BEGIN');
    let first: Awaited<ReturnType<typeof registerMeetingRecordings>>;
    let second: Promise<Awaited<ReturnType<typeof registerMeetingRecordings>>>;
    try {
      first = await registerMeetingRecordings(salesperson(database.session), { meetingId, files: [file('a')] }, verifyOk);
      // The second waits on the firm row the first holds.
      second = withTransaction(other, async () => await registerMeetingRecordings(salesperson(other), { meetingId, files: [file('a')] }, verifyOk));
      await new Promise(resolve => setTimeout(resolve, 200));
    } finally {
      await database.session.query('COMMIT');
    }
    const late = await second;
    expect(first.ok && first.value.files.map(entry => entry.outcome)).toEqual(['new']);
    expect(late.ok && late.value.files.map(entry => entry.outcome)).toEqual(['existing']);
    expect(await recordings(meetingId)).toHaveLength(1);
  });

  it('a refused verification writes nothing, even for the files that would have passed', async () => {
    const meetingId = await meeting(await firm());
    const answer = await withTransaction(database.session, async () =>
      await registerMeetingRecordings(salesperson(database.session), { meetingId, files: [file('b'), file('c')] }, async key =>
        await Promise.resolve({ verdict: key.includes(sha('c')) ? ('recording_size_mismatch' as const) : ('ok' as const), uploadId: null }),
      ),
    );
    expect(answer).toEqual({ ok: false, reason: 'recording_size_mismatch' });
    expect(await recordings(meetingId)).toEqual([]);
    // A missing object is thrown with every missing digest, so the route keeps no receipt.
    await expect(
      withTransaction(database.session, async () =>
        await registerMeetingRecordings(salesperson(database.session), { meetingId, files: [file('b'), file('c'), file('d')] }, async key =>
          await Promise.resolve({ verdict: key.includes(sha('b')) ? ('ok' as const) : ('recording_missing' as const), uploadId: null }),
        ),
      ),
    ).rejects.toMatchObject({ name: 'RecordingObjectsMissingError', missing: [sha('c'), sha('d')] });
    expect(await recordings(meetingId)).toEqual([]);
  });

  it('a fold moves the folded meeting’s recordings to the survivor, keeping their keys, and never doubles a digest', async () => {
    const firmId = await firm();
    const survivor = await meeting(firmId);
    const folded = await meeting(firmId);
    await withTransaction(database.session, async () => {
      await registerMeetingRecordings(salesperson(database.session), { meetingId: survivor, files: [file('d')] }, verifyOk);
      await registerMeetingRecordings(salesperson(database.session), { meetingId: folded, files: [file('d'), file('e')] }, verifyOk);
    });
    await withTransaction(database.session, async () => {
      const { rows } = await database.session.query<MeetingRow>(`SELECT ${MEETING_COLUMNS} FROM meetings WHERE id = ANY ($1::uuid[]) FOR UPDATE`, [[survivor, folded]]);
      const system = repositoryContext(workspaceScope(workspaceId(), { kind: 'system', component: 'worker' }), database.session);
      await foldMeetings(system, rows, survivor);
    });
    expect(await recordings(survivor)).toEqual([
      { sha256: sha('d'), s3_key: `meetings/${survivor}/${sha('d')}.m4a` },
      { sha256: sha('e'), s3_key: `meetings/${folded}/${sha('e')}.m4a` },
    ]);
    expect(await recordings(folded)).toEqual([]);
    // R4: the firm page's read follows the fold: both files, under the survivor, from the rows.
    const listed = await withTransaction(database.session, async () => await listFirmRecordings(salesperson(database.session), firmId));
    expect(listed?.truncated).toBe(false);
    expect(listed?.recordings.map(entry => entry.meetingId)).toEqual([survivor, survivor]);
    expect(listed?.recordings.every(entry => entry.state === 'uploaded')).toBe(true);
    expect(await withTransaction(database.session, async () => await listFirmRecordings(salesperson(database.session), '99999999-9999-4999-8999-999999999999'))).toBeNull();
    // Admin-or-assignee: the same firm given to somebody else is not this salesperson's to read.
    await database.session.query('UPDATE firms SET assigned_user_id = $2 WHERE id = $1', [firmId, seeded.alpha.admin.userId]);
    expect(await withTransaction(database.session, async () => await listFirmRecordings(salesperson(database.session), firmId))).toBeNull();
    const admin = repositoryContext(workspaceScope(workspaceId(), { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }), database.session);
    expect((await withTransaction(database.session, async () => await listFirmRecordings(admin, firmId)))?.recordings).toHaveLength(2);
  });

  it('R5: every candidate name goes through one minimiser — a contact named by its address answers only the local part', async () => {
    expect(minimiseName('jordan@private.example')).toBe('jordan');
    expect(minimiseName('  Jordan Placeholder ')).toBe('Jordan Placeholder');
    expect(minimiseName('@private.example')).toBeNull();
    expect(minimiseName('')).toBeNull();
    expect(minimiseName(null)).toBeNull();
    const firmId = await firm();
    const { rows } = await database.session.query<{ id: string }>(
      `INSERT INTO contacts (workspace_id, firm_id, full_name) VALUES ($1, $2, 'jordan@private.example') RETURNING id`,
      [workspaceId(), firmId],
    );
    const meetingId = await meeting(firmId);
    await database.session.query("UPDATE meetings SET contact_id = $2, attendee_email = 'jordan.p@private.example' WHERE id = $1", [meetingId, rows[0]?.id]);
    const listed = await withTransaction(database.session, async () =>
      await listRecordingCandidates(salesperson(database.session), { from: '2026-10-05T00:00:00Z', to: '2026-10-06T00:00:00Z' }),
    );
    const mine = listed.meetings.find(entry => entry.meetingId === meetingId);
    expect(mine).toMatchObject({ attendeeName: 'jordan', attendeeLocalPart: 'jordan.p' });
    expect(JSON.stringify(listed)).not.toContain('@');
  });

  it('R6: an object is registered only if it carries the upload id of a URL issued to this person (an administrator: to anybody, for this key)', async () => {
    const meetingId = await meeting(await firm());
    const mine = '77777777-7777-4777-8777-777777777777';
    const theirs = '88888888-8888-4888-8888-888888888888';
    const written = (uploadId: string | null) => async (): Promise<RecordingCheck> => await Promise.resolve({ verdict: 'ok', uploadId });
    const asked: { uploadId: string; anyIssuer: boolean }[] = [];
    const binding = (issued: boolean, ownIds: readonly string[], anyIds: readonly string[] = ownIds): UploaderBinding => ({
      issued: async () => await Promise.resolve(issued),
      wrote: async (_key, uploadId, anyIssuer) => {
        asked.push({ uploadId, anyIssuer });
        return await Promise.resolve((anyIssuer ? anyIds : ownIds).includes(uploadId));
      },
    });
    const admin = repositoryContext(workspaceScope(workspaceId(), { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }), database.session);
    const register = async (b: UploaderBinding, verify: () => Promise<RecordingCheck>, context = salesperson(database.session)) =>
      await withTransaction(database.session, async () => await registerMeetingRecordings(context, { meetingId, files: [file('7')] }, verify, b));
    expect(await register(binding(false, []), written(mine))).toEqual({ ok: false, reason: 'recording_not_issued' });
    // A URL was issued to this person, but the object was written through somebody else's.
    expect(await register(binding(true, [mine]), written(theirs))).toEqual({ ok: false, reason: 'not_your_upload' });
    // Not written through any URL of ours: refused, an administrator included.
    expect(await register(binding(true, [mine]), written(null))).toEqual({ ok: false, reason: 'not_your_upload' });
    expect(await register(binding(true, [], []), written(theirs), admin)).toEqual({ ok: false, reason: 'not_your_upload' });
    expect(await recordings(meetingId)).toEqual([]);
    // An administrator: any URL issued for this key.
    expect((await register(binding(false, [], [theirs]), written(theirs), admin)).ok).toBe(true);
    expect(asked.at(-1)).toEqual({ uploadId: theirs, anyIssuer: true });
    expect(await recordings(meetingId)).toHaveLength(1);
  });

  it('a replacement booking folded in by a late reschedule brings its recordings to the surviving meeting', async () => {
    const send = async (trigger: string, createdAt: string, payload: Record<string, unknown>): Promise<void> => {
      const body = { triggerEvent: trigger, createdAt, payload };
      await withTransaction(database.session, async () =>
        await receiveCalcomEvent(database.session, { workspaceId: workspaceId(), rawBody: Buffer.from(JSON.stringify(body)), body }),
      );
    };
    const booking = (uid: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      uid,
      startTime: '2026-10-09T17:00:00.000Z',
      endTime: '2026-10-09T17:30:00.000Z',
      attendees: [{ email: 'partner@m4-fold.example', name: 'A Partner' }],
      ...extra,
    });
    await send('BOOKING_CREATED', '2026-09-30T14:30:00.000Z', booking('m4foldA'));
    // An early delivery about the replacement makes a row of its own first.
    await send('BOOKING_CANCELLED', '2026-09-30T14:50:00.000Z', booking('m4foldB'));
    const rowOf = async (uid: string): Promise<string> =>
      (await database.session.query<{ id: string }>('SELECT meeting_id AS id FROM meeting_booking_uids WHERE booking_uid = $1', [uid])).rows[0]?.id ?? '';
    const early = await rowOf('m4foldB');
    expect(early).not.toBe('');
    expect(early).not.toBe(await rowOf('m4foldA'));
    await database.session.query(
      `INSERT INTO meeting_recordings (workspace_id, meeting_id, segment, participant_label, sha256, size_bytes, s3_key)
       VALUES ($1, $2, 1, 'audio1.m4a', $3, 10, $4)`,
      [workspaceId(), early, sha('9'), `meetings/${early}/${sha('9')}.m4a`],
    );
    await send('BOOKING_RESCHEDULED', '2026-09-30T14:40:00.000Z', booking('m4foldB', { rescheduleUid: 'm4foldA' }));
    const survivor = await rowOf('m4foldA');
    expect(await rowOf('m4foldB')).toBe(survivor);
    expect(await recordings(survivor)).toEqual([{ sha256: sha('9'), s3_key: `meetings/${early}/${sha('9')}.m4a` }]);
  });

  it('a deleted meeting takes its recordings with it', async () => {
    const meetingId = await meeting(await firm());
    await withTransaction(database.session, async () => {
      await registerMeetingRecordings(salesperson(database.session), { meetingId, files: [file('f'), file('0', 2)] }, verifyOk);
    });
    expect(await recordings(meetingId)).toHaveLength(2);
    await database.session.query('DELETE FROM meeting_booking_uids WHERE meeting_id = $1', [meetingId]);
    await database.session.query('DELETE FROM meetings WHERE id = $1', [meetingId]);
    expect(await recordings(meetingId)).toEqual([]);
  });
});
