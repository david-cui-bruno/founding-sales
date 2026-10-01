import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import type { TwilioRecordingFetcher } from '@fss/domain/calls/twilioRecording.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedContact, seedFirm } from './support/crmSeed.ts';
import { PUBLIC_ORIGIN, startIntegrationServer, type IntegrationServer } from './support/integrationServer.ts';
import { runOnce } from '../../worker/src/runner/jobRunner.ts';
import { callTranscribeJobHandler } from '../../worker/src/handlers/callTranscribe.ts';
import { deepgramTranscription, type DeepgramHttp } from '../../worker/src/transcription/deepgramClient.ts';
import { silentMp3 } from '@fss/domain/test/calls/mp3Fixture.ts';

/**
 * Slice C2 end to end, with fakes for the two providers only: three calls placed through
 * the real API and its signed Twilio callbacks — an answered three-minute call, an answered
 * fifteen-second one, and one nobody answered — then the worker's own runner with the
 * `call.transcribe` handler. Only the first is queued, transcribed, settled and readable
 * at `GET /calls/transcript`; the other two never reach a provider.
 */

const CALLER_ID = '+14015550100';
// Three minutes of silent MP3 frames: what Twilio would hand back for the answered call.
const AUDIO = silentMp3(180);
// Assembled at runtime so no scanner mistakes a fixture for a credential.
const FAKE_KEY = ['FAKE', 'dg', 'key', '0123456789'].join('-');

const DEEPGRAM_ANSWER = {
  metadata: { request_id: 'request-1', duration: 180.4, models: ['nova-3'] },
  results: {
    utterances: [
      // Multichannel (slice C3a): the prospect on channel 1, David on channel 0.
      { start: 0.4, end: 1.2, confidence: 0.98, channel: 1, transcript: 'Hello, Lenox Test Law.' },
      { start: 1.6, end: 4.9, confidence: 0.97, channel: 0, transcript: 'Hi, this is David from Callie.' },
      { start: 5.2, end: 7.0, confidence: 0.95, channel: 1, transcript: 'Sure, go ahead.' },
    ],
  },
};

describe('call transcription, end to end (slice C2)', () => {
  let fixture: AuthFixture;
  let server: IntegrationServer;
  let adminToken = '';
  let salespersonToken = '';
  let identityId = '';
  const deepgramRequests: { url: string; authorization: string | undefined; contentType: string | undefined; bytes: number }[] = [];
  const recordingReads: string[] = [];

  const command = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    commandId: randomUUID(),
    clientVersion: CURRENT_CLIENT_VERSION,
    ...extra,
  });

  async function post(path: string, token: string, body: unknown = {}) {
    const response = await fetch(`${server.origin}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown> };
  }

  async function get(path: string, token: string) {
    const response = await fetch(`${server.origin}${path}`, { headers: { authorization: `Bearer ${token}` } });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown> };
  }

  async function twilio(path: string, params: Record<string, string>): Promise<number> {
    const response = await fetch(`${server.origin}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': server.twilioSign(`${PUBLIC_ORIGIN}${path}`, params),
      },
      body: new URLSearchParams(params).toString(),
    });
    await response.text();
    return response.status;
  }

  const resultOf = (answer: { body: Record<string, unknown> }): Record<string, unknown> =>
    (answer.body['result'] ?? {}) as Record<string, unknown>;

  /** One firm of its own (the cadence allows one attempt a day per firm), called once. */
  async function placeCall(label: string, input: { readonly answered: boolean; readonly seconds: number; readonly phone: string }) {
    const firmId = await seedFirm(fixture, {
      name: `${label} Test Law`,
      regionCode: 'RI',
      postalCode: '02903',
      website: `https://www.${label.toLowerCase()}-law.example`,
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    expect((await post('/firms/resolve-zone', adminToken, command({ firmId }))).status).toBe(200);
    const contactId = await seedContact(fixture, { firmId, fullName: `Dana ${label}` });
    const phone = await post(
      '/contacts/routes/add',
      salespersonToken,
      command({
        firmId,
        contactId,
        routeKind: 'phone',
        value: input.phone,
        source: 'salesperson',
        technicalValidation: 'passed',
        associationConfidence: 0.95,
      }),
    );
    expect(phone.status, phone.text).toBe(200);
    const created = await post(
      '/calls/session',
      salespersonToken,
      command({ firmId, contactId, routeId: String(resultOf(phone)['id']), routeVersion: 1, callingIdentityId: identityId }),
    );
    expect(created.status, created.text).toBe(200);
    const sessionId = String(resultOf(created)['sessionId']);
    const parent = `CA${randomBytes(16).toString('hex')}`;
    const child = `CA${randomBytes(16).toString('hex')}`;
    const identity = `client:${fixture.alpha.salesperson.userId}`;
    expect(
      await twilio('/integrations/twilio/voice', { AccountSid: server.accountSid, CallSid: parent, From: identity, Caller: identity, sessionId }),
    ).toBe(200);
    if (input.answered) {
      // The `<Number>` status callback for the dialled leg: it answered.
      expect(
        await twilio('/integrations/twilio/status', {
          AccountSid: server.accountSid,
          CallSid: child,
          ParentCallSid: parent,
          CallStatus: 'in-progress',
        }),
      ).toBe(200);
    }
    expect(
      await twilio('/integrations/twilio/status', {
        AccountSid: server.accountSid,
        CallSid: parent,
        DialCallSid: child,
        DialCallStatus: input.answered ? 'completed' : 'no-answer',
        DialCallDuration: String(input.seconds),
      }),
    ).toBe(200);
    const recordingSid = `RE${randomBytes(16).toString('hex')}`;
    expect(
      await twilio('/integrations/twilio/recording', {
        AccountSid: server.accountSid,
        CallSid: parent,
        RecordingSid: recordingSid,
        RecordingUrl: `https://api.twilio.com/2010-04-01/Accounts/${server.accountSid}/Recordings/${recordingSid}`,
        RecordingDuration: String(input.seconds),
        RecordingStatus: 'completed',
      }),
    ).toBe(200);
    return { firmId, sessionId };
  }

  const deepgramHttp: DeepgramHttp = async (url, init) => {
    deepgramRequests.push({
      url,
      authorization: init.headers['authorization'],
      contentType: init.headers['content-type'],
      bytes: init.body.byteLength,
    });
    return await Promise.resolve(new Response(JSON.stringify(DEEPGRAM_ANSWER), { status: 200, headers: { 'content-type': 'application/json' } }));
  };
  const recordings: TwilioRecordingFetcher = {
    fetchRecording: async path => {
      recordingReads.push(path);
      return await Promise.resolve({ ok: true as const, contentType: 'audio/mpeg' as const, bytes: AUDIO });
    },
  };
  const registry = (): HandlerRegistry =>
    new HandlerRegistry().register(callTranscribeJobHandler({ provider: deepgramTranscription({ apiKey: FAKE_KEY, http: deepgramHttp }), recordings }));

  let answered = { firmId: '', sessionId: '' };
  let short = { firmId: '', sessionId: '' };
  let unanswered = { firmId: '', sessionId: '' };

  beforeAll(async () => {
    fixture = await createAuthFixture();
    server = await startIntegrationServer(fixture, { callerIdE164: CALLER_ID });
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    salespersonToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
    for (const [settingKey, value] of [
      ['calling_provider', { provider: 'twilio' }],
      ['telephony_budget', { dailyCeilingCents: 500, maxMinutesPerCall: 30, unitPriceMicros: 14_000 }],
      ['call_transcription', { enabled: true, dailyCeilingCents: 100, unitPriceMicros: 4_300 }],
    ] as const) {
      const saved = await post('/settings/update', adminToken, command({ settingKey, value }));
      expect(saved.status, saved.text).toBe(200);
    }
    const identity = await post('/calling-identities/register', salespersonToken, command({ e164: CALLER_ID }));
    identityId = String((resultOf(identity)['identity'] as { id?: string } | undefined)?.id);
    expect((await post('/postures/allow', adminToken, command({ states: ['RI'], confirmed: true }))).status).toBe(200);

    // The API is not given the key (review fold 1, P2): until a worker that can transcribe
    // has beaten, Settings says the key is not in place. One idle pass of the worker that
    // has it publishes `call_transcribe` in its heartbeat.
    const before = await get('/settings/integrations?include=transcription', adminToken);
    expect(before.body['transcription']).toMatchObject({ configured: { ok: false, missing: [] } });
    await runOnce(fixture.db, { registry: registry(), owner: 'transcription-test', limit: 1 });

    answered = await placeCall('Answered', { answered: true, seconds: 180, phone: '+14015550187' });
    short = await placeCall('Short', { answered: true, seconds: 15, phone: '+14015550186' });
    unanswered = await placeCall('Unanswered', { answered: false, seconds: 25, phone: '+14015550185' });
  });

  afterAll(async () => {
    await server.close();
    await fixture.stop();
  });

  it('queues a transcription for the answered three-minute call only', async () => {
    const { rows } = await fixture.db.query<{ idempotency_key: string; payload: { callSessionId: string } }>(
      "SELECT idempotency_key, payload FROM jobs WHERE kind = 'call.transcribe' ORDER BY created_at",
    );
    expect(rows.map(row => row.payload.callSessionId)).toEqual([answered.sessionId]);
    expect(rows[0]?.idempotency_key).toBe(`call-transcribe:${answered.sessionId}`);
  });

  it('transcribes it with the worker, reserving and settling the cost, and serves it at GET /calls/transcript', async () => {
    const report = await runOnce(fixture.db, { registry: registry(), owner: 'transcription-test', limit: 5 });
    expect(report).toMatchObject({ claimed: 1, completed: 1, failed: 0 });

    // The recording was read by its stored path, and Deepgram was asked once, as documented.
    expect(recordingReads).toHaveLength(1);
    expect(deepgramRequests).toHaveLength(1);
    const request = new URL(deepgramRequests[0]?.url ?? '');
    expect(`${request.origin}${request.pathname}`).toBe('https://api.deepgram.com/v1/listen');
    expect(Object.fromEntries(request.searchParams)).toEqual({
      model: 'nova-3',
      multichannel: 'true',
      punctuate: 'true',
      utterances: 'true',
      mip_opt_out: 'true',
    });
    expect(deepgramRequests[0]?.authorization).toBe(`Token ${FAKE_KEY}`);
    expect(deepgramRequests[0]?.contentType).toBe('audio/mpeg');
    expect(deepgramRequests[0]?.bytes).toBe(AUDIO.byteLength);

    // Reserved at (180 + 2) s, four minutes, for each of the two channels Deepgram may bill
    // (slice C3a: 34 400 micro-dollars, 4 cents) — the bound the audio was cut to — and
    // settled at Deepgram's 180.4 s, four started minutes, 4 cents.
    const { rows: reservations } = await fixture.db.query<{ state: string; cents: number; settled_cents: number; max_units: number }>(
      "SELECT state, cents, settled_cents, max_units FROM provider_reservations WHERE subject_kind = 'call_transcription' AND subject_id = $1",
      [answered.sessionId],
    );
    expect(reservations).toEqual([{ state: 'settled', cents: 4, settled_cents: 4, max_units: 4 }]);

    const transcript = await get(`/calls/transcript?callSessionId=${answered.sessionId}`, salespersonToken);
    expect(transcript.status, transcript.text).toBe(200);
    expect(transcript.body).toMatchObject({
      callSessionId: answered.sessionId,
      provider: 'deepgram',
      model: 'nova-3-multichannel',
      language: 'en',
      durationSeconds: 180,
      utterances: [
        { speaker: 1, start: 0.4, end: 1.2, text: 'Hello, Lenox Test Law.' },
        { speaker: 0, start: 1.6, end: 4.9, text: 'Hi, this is David from Callie.' },
        { speaker: 1, start: 5.2, end: 7, text: 'Sure, go ahead.' },
      ],
    });
    expect(transcript.text).not.toContain(FAKE_KEY);

    const history = await get(`/calls/history?firmId=${answered.firmId}`, salespersonToken);
    expect(history.body['calls']).toEqual([expect.objectContaining({ sessionId: answered.sessionId, hasTranscript: true })]);

    // Settings counts it as today's transcription spend, and says the key is in place.
    const settings = await get('/settings/integrations?include=transcription', adminToken);
    expect(settings.status, settings.text).toBe(200);
    expect(settings.body['transcription']).toEqual({
      setting: { enabled: true, dailyCeilingCents: 100, unitPriceMicros: 4_300 },
      configured: { ok: true, missing: [] },
      spentTodayCents: 4,
    });
    // An S1 desktop does not ask, and is not sent a key it would refuse.
    expect((await get('/settings/integrations', adminToken)).body).not.toHaveProperty('transcription');
  });

  it('never transcribes the fifteen-second call or the unanswered one', async () => {
    for (const call of [short, unanswered]) {
      expect((await get(`/calls/transcript?callSessionId=${call.sessionId}`, salespersonToken)).status).toBe(404);
      const history = await get(`/calls/history?firmId=${call.firmId}`, salespersonToken);
      expect(history.body['calls']).toEqual([expect.objectContaining({ sessionId: call.sessionId, hasTranscript: false })]);
    }
    const { rows } = await fixture.db.query(
      "SELECT 1 FROM provider_reservations WHERE subject_kind = 'call_transcription' AND subject_id = ANY($1::uuid[])",
      [[short.sessionId, unanswered.sessionId]],
    );
    expect(rows).toEqual([]);
    expect(deepgramRequests).toHaveLength(1);
  });

  it('answers 404 to another firm’s salesperson and to another workspace', async () => {
    const beta = (await issueSessionFor(fixture, fixture.beta, fixture.beta.admin)).accessToken;
    expect(
      (await post('/settings/update', beta, command({ settingKey: 'calling_provider', value: { provider: 'twilio' } }))).status,
    ).toBe(200);
    expect((await get(`/calls/transcript?callSessionId=${answered.sessionId}`, beta)).status).toBe(404);
    await fixture.db.query('UPDATE firms SET assigned_user_id = $2 WHERE id = $1', [answered.firmId, fixture.alpha.admin.userId]);
    try {
      expect((await get(`/calls/transcript?callSessionId=${answered.sessionId}`, salespersonToken)).status).toBe(404);
      // An admin may read any firm's.
      expect((await get(`/calls/transcript?callSessionId=${answered.sessionId}`, adminToken)).status).toBe(200);
    } finally {
      await fixture.db.query('UPDATE firms SET assigned_user_id = $2 WHERE id = $1', [answered.firmId, fixture.alpha.salesperson.userId]);
    }
  });

  it('adds a call’s summary to the history only when asked (slice C3b), so an older Mac never meets it', async () => {
    await fixture.db.query(
      `INSERT INTO call_summaries (workspace_id, call_session_id, model, prompt_version, summary, next_steps, commitments)
       VALUES ($1, $2, 'claude-haiku-4-5-20251001', 'c3b.summary.1', $3, $4::jsonb, $5::jsonb)`,
      [
        fixture.alpha.workspaceId,
        answered.sessionId,
        'You reached the office. They asked for pricing. You agreed to send it.',
        JSON.stringify([{ action: 'Send pricing', owner: 'you', due: 'by Friday' }]),
        JSON.stringify([{ speaker: 'you', quote: 'I will send it by Friday' }]),
      ],
    );
    const plain = await get(`/calls/history?firmId=${answered.firmId}`, salespersonToken);
    expect(plain.status).toBe(200);
    expect(JSON.stringify(plain.body)).not.toContain('summary');
    const asked = await get(`/calls/history?firmId=${answered.firmId}&include=summary`, salespersonToken);
    expect(asked.status, asked.text).toBe(200);
    expect(asked.body['calls']).toEqual([
      expect.objectContaining({
        sessionId: answered.sessionId,
        summary: {
          summary: 'You reached the office. They asked for pricing. You agreed to send it.',
          nextSteps: [{ action: 'Send pricing', owner: 'you', due: 'by Friday' }],
          commitments: [{ speaker: 'you', quote: 'I will send it by Friday' }],
          model: 'claude-haiku-4-5-20251001',
          createdAt: expect.any(String) as unknown,
        },
      }),
    ]);
    // Another firm's salesperson reads nothing, summary or not.
    await fixture.db.query('UPDATE firms SET assigned_user_id = $2 WHERE id = $1', [answered.firmId, fixture.alpha.admin.userId]);
    try {
      expect((await get(`/calls/history?firmId=${answered.firmId}&include=summary`, salespersonToken)).status).toBe(404);
    } finally {
      await fixture.db.query('UPDATE firms SET assigned_user_id = $2 WHERE id = $1', [answered.firmId, fixture.alpha.salesperson.userId]);
    }
  });
});
