import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordingCandidatesResponseSchema, recordingUploadUrlSchema, recordingsRegisteredSchema } from '@fss/contracts';
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
  const objects = new Map<string, { sizeBytes: number; sha256Base64: string | null }>();
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
    put: (key: string, sizeBytes: number, digest: string | null) => objects.set(key, { sizeBytes, sha256Base64: digest === null ? null : sha256Base64(digest) }),
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

  it('candidates: the window’s non-cancelled meetings with the names the Mac corroborates by; a window over 35 days is refused', async () => {
    const answer = await call(
      salesToken,
      'GET',
      '/meetings/recordings/candidates',
      undefined,
      new URLSearchParams({ from: '2026-10-03T00:00:00Z', to: '2026-10-06T00:00:00Z' }),
    );
    expect(answer.status).toBe(200);
    const parsed = recordingCandidatesResponseSchema.parse(answer.body);
    expect(parsed.meetings.map(entry => entry.meetingId)).toEqual([ownMeeting, otherMeeting]);
    expect(parsed.meetings[0]).toMatchObject({ firmName: 'Recording Own Rentals Test Co', attendeeName: 'Jordan Placeholder', attendeeEmail: 'jordan.placeholder@example.test' });
    expect(parsed.meetings.some(entry => entry.meetingId === cancelledMeeting)).toBe(false);

    const wide = await call(salesToken, 'GET', '/meetings/recordings/candidates', undefined, new URLSearchParams({ from: '2026-08-01T00:00:00Z', to: '2026-10-06T00:00:00Z' }));
    expect(wide.status).toBe(400);
    const backwards = await call(salesToken, 'GET', '/meetings/recordings/candidates', undefined, new URLSearchParams({ from: '2026-10-06T00:00:00Z', to: '2026-10-05T00:00:00Z' }));
    expect(backwards.status).toBe(400);
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

  it('register: several speakers and segments under one meeting, checked by HEAD, recorded once whatever repeats', async () => {
    const files = [
      { sha256: sha('david seg 1'), sizeBytes: 1000, participantLabel: 'audioDavidCui11234567890.m4a', segment: 1 },
      { sha256: sha('david seg 2'), sizeBytes: 1100, participantLabel: 'audioDavidCui11234567891.m4a', segment: 2 },
      { sha256: sha('jordan seg 1'), sizeBytes: 1200, participantLabel: 'audioJordanPlaceholder21234567890.m4a', segment: 1 },
    ];
    // Nothing uploaded yet: a definite refusal, and no row.
    const missing = await call(salesToken, 'POST', '/meetings/recordings/register', { ...envelope(), meetingId: ownMeeting, files });
    expect(missing).toMatchObject({ status: 409, body: { reason: 'recording_missing' } });
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

  it('register: a short or substituted object is refused, nothing is written; S3 not answering is a 503 with no receipt', async () => {
    const short = { sha256: sha('short file'), sizeBytes: 5000, participantLabel: 'audio1234567890.m4a', segment: 1 };
    bucket.put(`meetings/${ownMeeting}/${short.sha256}.m4a`, 4000, short.sha256);
    expect(await call(salesToken, 'POST', '/meetings/recordings/register', { ...envelope(), meetingId: ownMeeting, files: [short] })).toMatchObject({
      status: 409,
      body: { reason: 'recording_size_mismatch' },
    });
    const swapped = { sha256: sha('swapped file'), sizeBytes: 5000, participantLabel: 'audio1234567891.m4a', segment: 2 };
    bucket.put(`meetings/${ownMeeting}/${swapped.sha256}.m4a`, 5000, sha('something else'));
    expect(await call(salesToken, 'POST', '/meetings/recordings/register', { ...envelope(), meetingId: ownMeeting, files: [swapped] })).toMatchObject({
      status: 409,
      body: { reason: 'recording_checksum_mismatch' },
    });

    const fine = { sha256: sha('arrives later'), sizeBytes: 900, participantLabel: 'audio1234567892.m4a', segment: 3 };
    bucket.put(`meetings/${ownMeeting}/${fine.sha256}.m4a`, 900, fine.sha256);
    const commandId = randomUUID();
    bucket.setUnavailable(true);
    const down = await call(salesToken, 'POST', '/meetings/recordings/register', { ...envelope(commandId), meetingId: ownMeeting, files: [fine] });
    expect(down).toMatchObject({ status: 503, body: { error: 'storage_unavailable' } });
    expect((await fixture.db.query('SELECT 1 FROM command_receipts WHERE command_id = $1', [commandId])).rows).toEqual([]);
    bucket.setUnavailable(false);
    const retried = await call(salesToken, 'POST', '/meetings/recordings/register', { ...envelope(commandId), meetingId: ownMeeting, files: [fine] });
    expect(retried.status).toBe(200);
    expect(retried.body['replayed']).toBe(false);
    expect((await rowsOf(ownMeeting)).map(row => row.sha256)).toContain(fine.sha256);
    expect((await rowsOf(ownMeeting)).map(row => row.sha256)).not.toContain(short.sha256);
  });
});
