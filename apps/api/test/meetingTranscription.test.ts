import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatch } from '../src/server.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { sha256Base64, type MeetingAudioStore } from '../src/integrations/meetingAudio.ts';
import { localNoopSuppressionJournal } from '../src/journal/index.ts';
import { seedFirm } from './support/crmSeed.ts';
describe('meeting transcript reads', () => {
    let fixture: AuthFixture;
    let token: string;
    let admin: string;
    let meetingId: string;
    let firmId: string;
    const read = async (id = meetingId, bearer = token, cursor?: string) => await dispatch({
        method: 'GET', path: '/meetings/transcript', query: new URLSearchParams({ meetingId: id, ...(cursor === undefined ? {} : { cursor }) }),
        headers: { authorization: `Bearer ${bearer}` }, body: undefined,
    }, { session: fixture.db, auth: fixture.deps, supportedClientVersions: fixture.deps.config.supportedClientVersions,
        sendingEnabled: false, upgradeUrl: 'https://callie.example/download' });
    beforeAll(async () => {
        fixture = await createAuthFixture();
        token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
        admin = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
        firmId = await seedFirm(fixture, { name: 'Transcript Test Rentals', regionCode: 'TX', assignedUserId: fixture.alpha.salesperson.userId });
        meetingId = randomUUID();
        await fixture.db.query(`INSERT INTO meetings (workspace_id,id,booking_uid,current_booking_uid,firm_id,state,starts_at,ends_at,last_event_at)
      VALUES ($1,$2,'m5api','m5api',$3,'booked',now(),now()+interval '20 minutes',now())`, [fixture.alpha.workspaceId, meetingId, firmId]);
    });
    afterAll(async () => { await fixture.stop(); });
    it('answers meeting settings only to clients asking for them, disabled by default', async () => {
      const call = (include: string) => dispatch({ method: 'GET', path: '/settings/integrations', query: new URLSearchParams({ include }), headers: { authorization: `Bearer ${admin}` }, body: undefined }, {
        session: fixture.db, auth: fixture.deps, supportedClientVersions: fixture.deps.config.supportedClientVersions, sendingEnabled: false, upgradeUrl: 'https://callie.example/download',
      });
      expect((await call('meeting_transcription')).body).toMatchObject({ meetingTranscription: { setting: { enabled: false, dailyCeilingCents: 0, creditCoverage: null }, spentTodayCents: 0 } });
      expect((await call('transcription')).body).not.toHaveProperty('meetingTranscription');
    });
    it('gives the assigned user an honest empty transcript without confirming attendance', async () => {
        const result = await read();
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ meetingId, coverage: { total: 0, ready: 0 }, utterances: [], nextCursor: null, timing: 'file_relative' });
        expect((await fixture.db.query<{
            state: string;
        }>('SELECT state FROM meetings WHERE id=$1', [meetingId])).rows[0]?.state).toBe('booked');
    });
    it('does not reveal transcript presence after reassignment or across workspaces', async () => {
        await fixture.db.query('UPDATE firms SET assigned_user_id=$2 WHERE id=$1', [firmId, fixture.alpha.admin.userId]);
        expect((await read()).status).toBe(404);
        expect((await read(randomUUID())).status).toBe(404);
        expect((await read(meetingId, admin)).status).toBe(200);
        const beta = (await issueSessionFor(fixture, fixture.beta, fixture.beta.admin)).accessToken;
        expect((await read(meetingId, beta)).status).toBe(404);
        await fixture.db.query('UPDATE firms SET assigned_user_id=$2 WHERE id=$1', [firmId, fixture.alpha.salesperson.userId]);
    });
});

// Same signed receipt semantics as the importer, but recovery must keep the original identity.
describe('meeting recording recovery API', () => {
  let f: AuthFixture, token: string, otherToken: string, firmId: string, recordingId: string;
  let signed = 0;
  let uploaded: { key: string; sizeBytes: number; sha256Hex: string; uploadId: string } | null = null;
  const store: MeetingAudioStore = {
    presignPut: async input => { signed++; uploaded = input; return { url: 'https://audio.example.test/recovery', expiresAt: new Date(Date.now()+900000).toISOString(), headers: {
      'content-type': 'audio/mp4', 'content-length': String(input.sizeBytes), 'x-amz-checksum-sha256': sha256Base64(input.sha256Hex), 'x-amz-meta-callie-upload': input.uploadId,
    } }; },
    head: async () => uploaded === null ? { found: false } : { found: true, sizeBytes: uploaded.sizeBytes, sha256Base64: sha256Base64(uploaded.sha256Hex), uploadId: uploaded.uploadId },
  };
  const post = (path: string, bearer = token, commandId = randomUUID()) => dispatch({ method: 'POST', path: `/meetings/recordings/${path}`, query: new URLSearchParams(), headers: { authorization: `Bearer ${bearer}` }, body: { recordingId, commandId, clientVersion: CURRENT_CLIENT_VERSION } }, {
    session: f.db, auth: f.deps, supportedClientVersions: f.deps.config.supportedClientVersions, sendingEnabled: false, upgradeUrl: 'https://callie.example.test', meetingAudio: store, suppressionJournal: localNoopSuppressionJournal(),
  });
  beforeAll(async () => {
    f = await createAuthFixture(); token = (await issueSessionFor(f, f.alpha, f.alpha.salesperson)).accessToken;
    otherToken = (await issueSessionFor(f, f.alpha, f.alpha.admin)).accessToken;
    firmId = await seedFirm(f, { name: 'Recovery Fixture', regionCode: 'TX', assignedUserId: f.alpha.salesperson.userId });
    const m = randomUUID(); recordingId = randomUUID();
    await f.db.query("INSERT INTO meetings (workspace_id,id,booking_uid,current_booking_uid,firm_id,state,starts_at,ends_at,last_event_at) VALUES ($1,$2,'recovery','recovery',$3,'booked',now(),now()+interval '20 minutes',now())", [f.alpha.workspaceId,m,firmId]);
    await f.db.query("INSERT INTO meeting_recordings (workspace_id,id,meeting_id,segment,participant_label,sha256,size_bytes,s3_key,processing_status) VALUES ($1,$2,$3,1,'Fixture',$4,100,$5,'needs_reupload')", [f.alpha.workspaceId,recordingId,m,'a'.repeat(64),`meetings/${m}/${'a'.repeat(64)}.m4a`]);
  });
  afterAll(async () => { await f.stop(); });
  it('reauthorizes URL replay and binds completion to the actual uploader', async () => {
    const id = randomUUID();
    expect((await post('recovery-url',token,id)).status).toBe(200);
    expect((await post('recovery-complete',otherToken)).status).toBe(409);
    await f.db.query('UPDATE firms SET assigned_user_id=$2 WHERE id=$1', [firmId,f.alpha.admin.userId]);
    const before = signed; expect((await post('recovery-url',token,id)).status).toBe(409); expect(signed).toBe(before);
    await f.db.query('UPDATE firms SET assigned_user_id=$2 WHERE id=$1', [firmId,f.alpha.salesperson.userId]);
    const completion = randomUUID();
    expect((await post('recovery-complete',token,completion)).body).toMatchObject({ result: { status: 'resumed' } });
    expect((await post('recovery-complete',token,completion)).body).toMatchObject({ replayed: true, result: { status: 'resumed' } });
    expect((await f.db.query('SELECT id FROM meeting_recordings')).rows).toEqual([{ id: recordingId }]);
  });
});
