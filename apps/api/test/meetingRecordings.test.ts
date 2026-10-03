import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { firmRecordingsResponseSchema, recordingCandidatesResponseSchema, recordingUploadUrlSchema, recordingsRegisteredSchema } from '@fss/contracts';
import { localNoopSuppressionJournal } from '../src/journal/index.ts';
import { MeetingAudioUnavailableError, sha256Base64, type HeadAnswer, type MeetingAudioStore } from '../src/integrations/meetingAudio.ts';
import { dispatch, type ApiRequest } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedContact, seedFirm } from './support/crmSeed.ts';

/**
 * Lane M4 over the wire: the candidates read, the upload URL and the register command
 * (migration 0040), against a fake bucket that answers HEAD from what the test "uploaded".
 * Every firm, person and file name is invented.
 */

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A bucket in memory: what was "put", what HEAD answers, how many URLs were signed. */
function fakeBucket() {
  const objects = new Map<string, { sizeBytes: number; sha256Base64: string | null; lastModified: string }>();
  let unavailable = false;
  let signed = 0;
  const store: MeetingAudioStore = {
    presignPut: async input => {
      signed += 1;
      return await Promise.resolve({
        url: `https://fss-test-call-audio-123456789012.s3.us-east-1.amazonaws.com/${input.key}?X-Amz-Signature=${String(signed)}`,
        headers: { 'content-type': 'audio/mp4', 'content-length': String(input.sizeBytes), 'x-amz-checksum-sha256': sha256Base64(input.sha256Hex) },
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      });
    },
    head: async key => {
      if (unavailable) throw new MeetingAudioUnavailableError('down');
      const found = objects.get(key);
      const answer: HeadAnswer = found === undefined ? { found: false } : { found: true, ...found };
      return await Promise.resolve(answer);
    },
  };
  return {
    store,
    /** As S3 does: LastModified in whole seconds, now unless the test says when it was written. */
    put: (key: string, sizeBytes: number, digest: string | null, writtenAt: Date = new Date()) =>
      objects.set(key, {
        sizeBytes,
        sha256Base64: digest === null ? null : sha256Base64(digest),
        lastModified: new Date(Math.floor(writtenAt.getTime() / 1000) * 1000).toISOString(),
      }),
    setUnavailable: (value: boolean) => {
      unavailable = value;
    },
    signed: () => signed,
  };
}

describe('meeting recordings over the wire (lane M4)', () => {
  let fixture: AuthFixture;
  let adminToken: string;
  let salesToken: string;
  let ownFirm: string;
  let otherFirm: string;
  let ownMeeting: string;
  let otherMeeting: string;
  let unmatchedMeeting: string;
  let cancelledMeeting: string;
  const bucket = fakeBucket();

  const options = (withBucket = true) => ({
    session: fixture.db,
    supportedClientVersions: fixture.deps.config.supportedClientVersions,
    sendingEnabled: false,
    auth: fixture.deps,
    upgradeUrl: 'https://callie.example/downloads/mac',
    suppressionJournal: localNoopSuppressionJournal(),
    ...(withBucket ? { meetingAudio: bucket.store } : {}),
  });

  const call = async (
    token: string,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    query = new URLSearchParams(),
    withBucket = true,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const request: ApiRequest = { method, path, query, headers: { authorization: `Bearer ${token}` }, body };
    const result = await dispatch(request, options(withBucket));
    return { status: result.status, body: JSON.parse(JSON.stringify(result.body ?? null)) as Record<string, unknown> };
  };
  const envelope = (commandId: string = randomUUID()) => ({ commandId, clientVersion: CURRENT_CLIENT_VERSION });

  async function meeting(firmId: string | null, contactId: string | null, startsAt: string, state = 'booked'): Promise<string> {
    const uid = `m4wire${randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const { rows } = await fixture.db.query<{ id: string }>(
      `INSERT INTO meetings (workspace_id, booking_uid, current_booking_uid, firm_id, contact_id, state, starts_at, ends_at,
                             attendee_email, last_event_at)
       VALUES ($1, $2, $2, $3, $4, $5, $6::timestamptz, $6::timestamptz + interval '20 minutes', 'jordan.placeholder@example.test', now())
       RETURNING id`,
      [fixture.alpha.workspaceId, uid, firmId, contactId, state, startsAt],
    );
    return rows[0]?.id ?? '';
  }

  const rowsOf = async (meetingId: string) =>
    (
      await fixture.db.query<{ sha256: string; segment: number; participant_label: string; state: string; s3_key: string }>(
        'SELECT sha256, segment, participant_label, state, s3_key FROM meeting_recordings WHERE meeting_id = $1 ORDER BY participant_label, segment',
        [meetingId],
      )
    ).rows;

  beforeAll(async () => {
    fixture = await createAuthFixture();
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    salesToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
    ownFirm = await seedFirm(fixture, { name: 'Recording Own Rentals Test Co', regionCode: 'TX', assignedUserId: fixture.alpha.salesperson.userId });
    otherFirm = await seedFirm(fixture, { name: 'Recording Other Rentals Test Co', regionCode: 'TX', assignedUserId: fixture.alpha.admin.userId });
    const contact = await seedContact(fixture, { firmId: ownFirm, fullName: 'Jordan Placeholder' });
    ownMeeting = await meeting(ownFirm, contact, '2026-10-05T19:00:00Z');
    otherMeeting = await meeting(otherFirm, null, '2026-10-05T21:00:00Z');
    unmatchedMeeting = await meeting(null, null, '2026-10-06T15:00:00Z');
    cancelledMeeting = await meeting(ownFirm, contact, '2026-10-05T20:00:00Z', 'cancelled');
  });

  afterAll(async () => {
    await fixture.stop();
  });

  it('candidates: a salesperson sees only meetings on firms assigned to them, an admin all; never a whole address; over 35 days is refused', async () => {
    const window = new URLSearchParams({ from: '2026-10-03T00:00:00Z', to: '2026-10-07T00:00:00Z' });
    const answer = await call(salesToken, 'GET', '/meetings/recordings/candidates', undefined, window);
    expect(answer.status).toBe(200);
    const parsed = recordingCandidatesResponseSchema.parse(answer.body);
    // Review M4R, finding 3: not the other firm's meeting, not the unmatched one.
    expect(parsed.meetings.map(entry => entry.meetingId)).toEqual([ownMeeting]);
    expect(parsed.meetings[0]).toMatchObject({ firmName: 'Recording Own Rentals Test Co', attendeeName: 'Jordan Placeholder', attendeeLocalPart: 'jordan.placeholder' });
    expect(parsed.truncated).toBe(false);
    expect(JSON.stringify(answer.body)).not.toContain('@');
    const asAdmin = recordingCandidatesResponseSchema.parse((await call(adminToken, 'GET', '/meetings/recordings/candidates', undefined, window)).body);
    expect(asAdmin.meetings.map(entry => entry.meetingId)).toEqual([ownMeeting, otherMeeting, unmatchedMeeting]);
    expect(asAdmin.meetings.some(entry => entry.meetingId === cancelledMeeting)).toBe(false);

    const wide = await call(salesToken, 'GET', '/meetings/recordings/candidates', undefined, new URLSearchParams({ from: '2026-08-01T00:00:00Z', to: '2026-10-06T00:00:00Z' }));
    expect(wide.status).toBe(400);
    const backwards = await call(salesToken, 'GET', '/meetings/recordings/candidates', undefined, new URLSearchParams({ from: '2026-10-06T00:00:00Z', to: '2026-10-05T00:00:00Z' }));
    expect(backwards.status).toBe(400);
  });

  it('candidates: more meetings than the limit answers the first hundred and truncated (review M4R, finding 10)', async () => {
    const busy = await seedFirm(fixture, { name: 'Recording Busy Rentals Test Co', regionCode: 'TX', assignedUserId: fixture.alpha.admin.userId });
    for (let index = 0; index < 101; index += 1) await meeting(busy, null, new Date(Date.UTC(2026, 10, 2, 0, index)).toISOString());
    const window = (to: string) => new URLSearchParams({ from: '2026-11-02T00:00:00Z', to });
    const full = recordingCandidatesResponseSchema.parse((await call(adminToken, 'GET', '/meetings/recordings/candidates', undefined, window('2026-11-03T00:00:00Z'))).body);
    expect(full.meetings).toHaveLength(100);
    expect(full.truncated).toBe(true);
    const narrow = recordingCandidatesResponseSchema.parse((await call(adminToken, 'GET', '/meetings/recordings/candidates', undefined, window('2026-11-02T00:30:00Z'))).body);
    expect(narrow.meetings).toHaveLength(31);
    expect(narrow.truncated).toBe(false);
  });

  it('upload-url: a fresh PUT for the assignee, never stored; refused to others, for a cancelled meeting, and 404 without the bucket', async () => {
    const digest = sha('upload-url speaker one');
    const commandId = randomUUID();
    const body = { ...envelope(commandId), meetingId: ownMeeting, fileSha256: digest, sizeBytes: 4096, participantLabel: 'audioJordanPlaceholder21234567890.m4a', segment: 1 };
    const first = await call(salesToken, 'POST', '/meetings/recordings/upload-url', body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const answer = recordingUploadUrlSchema.parse(first.body['result']);
    expect(answer).toMatchObject({ status: 'upload', key: `meetings/${ownMeeting}/${digest}.m4a`, headers: { 'content-length': '4096' } });

    // A replay of the same command signs a new URL; the receipt holds the key, never a URL.
    const replay = await call(salesToken, 'POST', '/meetings/recordings/upload-url', body);
    expect(replay.body['replayed']).toBe(true);
    const again = recordingUploadUrlSchema.parse(replay.body['result']);
    expect(again.status === 'upload' && answer.status === 'upload' && again.url !== answer.url).toBe(true);
    const { rows: receipts } = await fixture.db.query<{ result: unknown }>('SELECT result FROM command_receipts WHERE command_id = $1', [commandId]);
    expect(JSON.stringify(receipts[0]?.result)).not.toContain('https://');
    expect(JSON.stringify(receipts[0]?.result)).not.toContain('Signature');

    const notMine = await call(salesToken, 'POST', '/meetings/recordings/upload-url', { ...body, ...envelope(), meetingId: otherMeeting });
    expect(notMine).toMatchObject({ status: 409, body: { reason: 'not_assigned' } });
    const unmatchedBySales = await call(salesToken, 'POST', '/meetings/recordings/upload-url', { ...body, ...envelope(), meetingId: unmatchedMeeting });
    expect(unmatchedBySales).toMatchObject({ status: 409, body: { reason: 'not_assigned' } });
    const unmatchedByAdmin = await call(adminToken, 'POST', '/meetings/recordings/upload-url', { ...body, ...envelope(), meetingId: unmatchedMeeting });
    expect(unmatchedByAdmin.status).toBe(200);
    const cancelled = await call(adminToken, 'POST', '/meetings/recordings/upload-url', { ...body, ...envelope(), meetingId: cancelledMeeting });
    expect(cancelled).toMatchObject({ status: 409, body: { reason: 'meeting_cancelled' } });
    const unknown = await call(adminToken, 'POST', '/meetings/recordings/upload-url', { ...body, ...envelope(), meetingId: randomUUID() });
    expect(unknown).toMatchObject({ status: 409, body: { reason: 'meeting_unknown' } });
    const tooLarge = await call(adminToken, 'POST', '/meetings/recordings/upload-url', { ...body, ...envelope(), sizeBytes: 300 * 1024 * 1024 + 1 });
    expect(tooLarge.status).toBe(400);
    const noBucket = await call(adminToken, 'POST', '/meetings/recordings/upload-url', { ...body, ...envelope() }, new URLSearchParams(), false);
    expect(noBucket.status).toBe(404);
  });

  it('upload-url: a replay signs a new URL only for somebody still authorized, for a meeting still there (review M4R, finding 8)', async () => {
    const firm = await seedFirm(fixture, { name: 'Recording Replay Rentals Test Co', regionCode: 'TX', assignedUserId: fixture.alpha.salesperson.userId });
    const target = await meeting(firm, null, '2026-10-05T16:00:00Z');
    const body = { ...envelope(), meetingId: target, fileSha256: sha('replay file'), sizeBytes: 100, participantLabel: 'audio1.m4a', segment: 1 };
    expect((await call(salesToken, 'POST', '/meetings/recordings/upload-url', body)).status).toBe(200);
    const signedBefore = bucket.signed();
    // The firm is reassigned: the same command, replayed, is refused and signs nothing.
    await fixture.db.query('UPDATE firms SET assigned_user_id = $2 WHERE id = $1', [firm, fixture.alpha.admin.userId]);
    expect(await call(salesToken, 'POST', '/meetings/recordings/upload-url', body)).toMatchObject({ status: 409, body: { reason: 'not_assigned', replayed: true } });
    await fixture.db.query('UPDATE firms SET assigned_user_id = $2 WHERE id = $1', [firm, fixture.alpha.salesperson.userId]);
    // The meeting is cancelled: likewise.
    await fixture.db.query("UPDATE meetings SET state = 'cancelled' WHERE id = $1", [target]);
    expect(await call(salesToken, 'POST', '/meetings/recordings/upload-url', body)).toMatchObject({ status: 409, body: { reason: 'meeting_cancelled' } });
    // Deleted: likewise.
    await fixture.db.query('DELETE FROM meetings WHERE id = $1', [target]);
    expect(await call(salesToken, 'POST', '/meetings/recordings/upload-url', body)).toMatchObject({ status: 409, body: { reason: 'meeting_unknown' } });
    expect(bucket.signed()).toBe(signedBefore);
  });

  it('register: several speakers and segments under one meeting, checked by HEAD, recorded once whatever repeats', async () => {
    const files = [
      { sha256: sha('david seg 1'), sizeBytes: 1000, participantLabel: 'audioDavidCui11234567890.m4a', segment: 1 },
      { sha256: sha('david seg 2'), sizeBytes: 1100, participantLabel: 'audioDavidCui11234567891.m4a', segment: 2 },
      { sha256: sha('jordan seg 1'), sizeBytes: 1200, participantLabel: 'audioJordanPlaceholder21234567890.m4a', segment: 1 },
    ];
    // Without an upload URL issued to this person: refused (uploader binding).
    expect(await call(salesToken, 'POST', '/meetings/recordings/register', { ...envelope(), meetingId: ownMeeting, files })).toMatchObject({
      status: 409,
      body: { reason: 'recording_not_issued' },
    });
    for (const file of files) {
      const issued = await call(salesToken, 'POST', '/meetings/recordings/upload-url', {
        ...envelope(),
        meetingId: ownMeeting,
        fileSha256: file.sha256,
        sizeBytes: file.sizeBytes,
        participantLabel: file.participantLabel,
        segment: file.segment,
      });
      expect(issued.status).toBe(200);
    }
    // Issued, but nothing uploaded yet: object_missing with every digest, no receipt, no row.
    const missingId = randomUUID();
    const missing = await call(salesToken, 'POST', '/meetings/recordings/register', { ...envelope(missingId), meetingId: ownMeeting, files });
    expect(missing).toMatchObject({ status: 409, body: { reason: 'object_missing', missing: files.map(file => file.sha256) } });
    expect((await fixture.db.query('SELECT 1 FROM command_receipts WHERE command_id = $1', [missingId])).rows).toEqual([]);
    expect(await rowsOf(ownMeeting)).toEqual([]);

    for (const file of files) bucket.put(`meetings/${ownMeeting}/${file.sha256}.m4a`, file.sizeBytes, file.sha256);
    const commandId = randomUUID();
    const registered = await call(salesToken, 'POST', '/meetings/recordings/register', { ...envelope(commandId), meetingId: ownMeeting, files });
    expect(registered.status, JSON.stringify(registered.body)).toBe(200);
    const parsed = recordingsRegisteredSchema.parse(registered.body['result']);
    expect(parsed.files.map(file => file.outcome)).toEqual(['new', 'new', 'new']);
    expect(await rowsOf(ownMeeting)).toEqual([
      { sha256: files[0]!.sha256, segment: 1, participant_label: files[0]!.participantLabel, state: 'uploaded', s3_key: `meetings/${ownMeeting}/${files[0]!.sha256}.m4a` },
      { sha256: files[1]!.sha256, segment: 2, participant_label: files[1]!.participantLabel, state: 'uploaded', s3_key: `meetings/${ownMeeting}/${files[1]!.sha256}.m4a` },
      { sha256: files[2]!.sha256, segment: 1, participant_label: files[2]!.participantLabel, state: 'uploaded', s3_key: `meetings/${ownMeeting}/${files[2]!.sha256}.m4a` },
    ]);

    // The same command again: its receipt. A new command (a restart, a duplicate discovery): `existing`.
    const replay = await call(salesToken, 'POST', '/meetings/recordings/register', { ...envelope(commandId), meetingId: ownMeeting, files });
    expect(replay.body['replayed']).toBe(true);
    const duplicate = await call(salesToken, 'POST', '/meetings/recordings/register', { ...envelope(), meetingId: ownMeeting, files: [files[0], files[0]] });
    expect(recordingsRegisteredSchema.parse(duplicate.body['result']).files.map(file => file.outcome)).toEqual(['existing']);
    expect(await rowsOf(ownMeeting)).toHaveLength(3);

    // And the upload URL now says there is nothing to upload.
    const url = await call(salesToken, 'POST', '/meetings/recordings/upload-url', {
      ...envelope(),
      meetingId: ownMeeting,
      fileSha256: files[2]!.sha256,
      sizeBytes: files[2]!.sizeBytes,
      participantLabel: files[2]!.participantLabel,
      segment: 1,
    });
    expect(url.body['result']).toEqual({ status: 'registered' });
  });

  it('register: an administrator registers without an issued URL; a short or substituted object is refused; S3 not answering is a 503 with no receipt', async () => {
    const short = { sha256: sha('short file'), sizeBytes: 5000, participantLabel: 'audio1234567890.m4a', segment: 1 };
    bucket.put(`meetings/${ownMeeting}/${short.sha256}.m4a`, 4000, short.sha256);
    expect(await call(adminToken, 'POST', '/meetings/recordings/register', { ...envelope(), meetingId: ownMeeting, files: [short] })).toMatchObject({
      status: 409,
      body: { reason: 'recording_size_mismatch' },
    });
    const swapped = { sha256: sha('swapped file'), sizeBytes: 5000, participantLabel: 'audio1234567891.m4a', segment: 2 };
    bucket.put(`meetings/${ownMeeting}/${swapped.sha256}.m4a`, 5000, sha('something else'));
    expect(await call(adminToken, 'POST', '/meetings/recordings/register', { ...envelope(), meetingId: ownMeeting, files: [swapped] })).toMatchObject({
      status: 409,
      body: { reason: 'recording_checksum_mismatch' },
    });

    const fine = { sha256: sha('arrives later'), sizeBytes: 900, participantLabel: 'audio1234567892.m4a', segment: 3 };
    bucket.put(`meetings/${ownMeeting}/${fine.sha256}.m4a`, 900, fine.sha256);
    const commandId = randomUUID();
    bucket.setUnavailable(true);
    const down = await call(adminToken, 'POST', '/meetings/recordings/register', { ...envelope(commandId), meetingId: ownMeeting, files: [fine] });
    expect(down).toMatchObject({ status: 503, body: { error: 'storage_unavailable' } });
    expect((await fixture.db.query('SELECT 1 FROM command_receipts WHERE command_id = $1', [commandId])).rows).toEqual([]);
    bucket.setUnavailable(false);
    const retried = await call(adminToken, 'POST', '/meetings/recordings/register', { ...envelope(commandId), meetingId: ownMeeting, files: [fine] });
    expect(retried.status).toBe(200);
    expect(retried.body['replayed']).toBe(false);
    expect((await rowsOf(ownMeeting)).map(row => row.sha256)).toContain(fine.sha256);
    expect((await rowsOf(ownMeeting)).map(row => row.sha256)).not.toContain(short.sha256);
  });
  it('R6: an object somebody else staged before this person’s URL is not theirs to register, though the URL was issued (the reviewer’s repro)', async () => {
    const firm = await seedFirm(fixture, { name: 'Recording Binding Rentals Test Co', regionCode: 'TX', assignedUserId: fixture.alpha.salesperson.userId });
    const target = await meeting(firm, null, '2026-10-05T17:00:00Z');
    const file = { sha256: sha('staged by somebody else'), sizeBytes: 100, participantLabel: 'audioSomebody1.m4a', segment: 1 };
    const key = `meetings/${target}/${file.sha256}.m4a`;
    // Somebody else's object is there first; this person then asks for a URL and sends NO PUT.
    bucket.put(key, file.sizeBytes, file.sha256, new Date(Date.now() - 120_000));
    const issued = await call(salesToken, 'POST', '/meetings/recordings/upload-url', {
      ...envelope(),
      meetingId: target,
      fileSha256: file.sha256,
      sizeBytes: file.sizeBytes,
      participantLabel: file.participantLabel,
      segment: 1,
    });
    expect(issued.status).toBe(200);
    expect(await call(salesToken, 'POST', '/meetings/recordings/register', { ...envelope(), meetingId: target, files: [file] })).toMatchObject({
      status: 409,
      body: { reason: 'not_your_upload' },
    });
    expect(await rowsOf(target)).toEqual([]);
    // Their own PUT, after their URL, is theirs.
    bucket.put(key, file.sizeBytes, file.sha256, new Date(Date.now() + 1000));
    const registered = await call(salesToken, 'POST', '/meetings/recordings/register', { ...envelope(), meetingId: target, files: [file] });
    expect(registered.status, JSON.stringify(registered.body)).toBe(200);
    expect(await rowsOf(target)).toHaveLength(1);
  });

  it('R4: the firm’s registered recordings, from the rows, for an administrator or the assignee only; 404 for anybody else and an unknown firm, 400 for no id', async () => {
    const firm = await seedFirm(fixture, { name: 'Recording Listed Rentals Test Co', regionCode: 'TX', assignedUserId: fixture.alpha.salesperson.userId });
    const target = await meeting(firm, null, '2026-10-05T18:00:00Z');
    const file = { sha256: sha('listed file'), sizeBytes: 100, participantLabel: 'audioListed1.m4a', segment: 1 };
    bucket.put(`meetings/${target}/${file.sha256}.m4a`, file.sizeBytes, file.sha256);
    expect((await call(adminToken, 'POST', '/meetings/recordings/register', { ...envelope(), meetingId: target, files: [file] })).status).toBe(200);
    for (const token of [salesToken, adminToken]) {
      const answer = await call(token, 'GET', '/meetings/recordings', undefined, new URLSearchParams({ firmId: firm }));
      expect(answer.status).toBe(200);
      const parsed = firmRecordingsResponseSchema.parse(answer.body);
      expect(parsed).toMatchObject({ truncated: false, recordings: [{ meetingId: target, segment: 1, participantLabel: 'audioListed1.m4a', state: 'uploaded' }] });
    }
    // Admin-or-assignee, as /meetings/brief: participant labels can carry names. Another
    // member's firm is the same 404 as an unknown one; its administrator reads it.
    const elsewhere = await seedFirm(fixture, { name: 'Recording Elsewhere Rentals Test Co', regionCode: 'TX', assignedUserId: fixture.alpha.admin.userId });
    const theirs = await meeting(elsewhere, null, '2026-10-05T18:30:00Z');
    const their = { sha256: sha('elsewhere file'), sizeBytes: 100, participantLabel: 'audioSomeoneNamed1.m4a', segment: 1 };
    bucket.put(`meetings/${theirs}/${their.sha256}.m4a`, their.sizeBytes, their.sha256);
    expect((await call(adminToken, 'POST', '/meetings/recordings/register', { ...envelope(), meetingId: theirs, files: [their] })).status).toBe(200);
    const refused = await call(salesToken, 'GET', '/meetings/recordings', undefined, new URLSearchParams({ firmId: elsewhere }));
    expect(refused.status).toBe(404);
    expect(JSON.stringify(refused.body)).not.toContain('SomeoneNamed');
    expect(firmRecordingsResponseSchema.parse((await call(adminToken, 'GET', '/meetings/recordings', undefined, new URLSearchParams({ firmId: elsewhere }))).body).recordings).toHaveLength(1);
    expect((await call(salesToken, 'GET', '/meetings/recordings', undefined, new URLSearchParams({ firmId: randomUUID() }))).status).toBe(404);
    expect((await call(salesToken, 'GET', '/meetings/recordings', undefined, new URLSearchParams())).status).toBe(400);
    expect((await call(salesToken, 'POST', '/meetings/recordings', {}, new URLSearchParams({ firmId: firm }))).status).toBe(405);
  });
});
