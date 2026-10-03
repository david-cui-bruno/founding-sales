import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import type { SessionQueryable } from '../../db/queryable.ts';
import { withTransaction } from '../../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../../db/workspaceScope.ts';
import { foldMeetings, MEETING_COLUMNS, type MeetingRow } from '../../meetings/calcom.ts';
import { registerMeetingRecordings, type RecordingVerdict } from '../../meetings/recordings.ts';
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

const verifyOk = async (): Promise<RecordingVerdict> => await Promise.resolve('ok');
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
        await Promise.resolve(key.includes(sha('c')) ? 'recording_missing' : 'ok'),
      ),
    );
    expect(answer).toEqual({ ok: false, reason: 'recording_missing' });
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
