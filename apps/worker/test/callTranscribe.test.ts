import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  consumeCallSession,
  createCallSession,
  recordCallRecording,
  recordCallStatus,
} from '@fss/domain/calls/sessions.ts';
import {
  beginCallTranscription,
  enqueueCallTranscription,
  ensureTranscriptionCalling,
  readCallTranscript,
  sweepTranscriptionReservations,
  workspacesOwingTranscriptionSweep,
  type TranscriptionOutcome,
  type TranscriptionProvider,
} from '@fss/domain/calls/transcription.ts';
import type { TwilioRecordingFetcher } from '@fss/domain/calls/twilioRecording.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '@fss/domain/db/workspaceScope.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { JOB_KIND_CLASS } from '@fss/domain/jobs/jobKinds.ts';
import { updateSetting } from '@fss/domain/settings/store.ts';
import { seedCrm, type SeededCrm } from '@fss/domain/test/db/support/crmFixtures.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '@fss/domain/test/db/support/fixtures.ts';
import { seedPolicy, type SeededPolicy } from '@fss/domain/test/db/support/policyFixtures.ts';
import { readTranscriptionComposition, registerHandlers } from '../src/bootstrap/main.ts';
import { callTranscribeJobHandler } from '../src/handlers/callTranscribe.ts';
import { telephonySweepJobHandler } from '../src/handlers/telephonySweep.ts';
import { runOnce } from '../src/runner/jobRunner.ts';
import {
  DEEPGRAM_PROVIDER_KEY,
  deepgramTranscription,
  parseDeepgramAnswer,
  readTranscriptionProvider,
  type DeepgramHttp,
} from '../src/transcription/deepgramClient.ts';

/**
 * Slice C2 in the worker: the Deepgram client against Deepgram's documented shapes, and
 * the `call.transcribe` job's money — reserved and settled, refused at the ceiling, an
 * ambiguous attempt estimated before its one bounded retry, a lost lease finalised by the
 * sweep — and the key, which appears in no outcome, log line or error.
 */

// Assembled at runtime so no scanner mistakes a fixture for a credential.
const FAKE_KEY = ['FAKE', 'dg', 'key', '0123456789'].join('-');
const AUDIO = Buffer.from('ID3 a recording, as far as this test is concerned');

const answer = (duration: number): unknown => ({
  metadata: { request_id: 'request-1', duration, models: ['nova-3'] },
  results: {
    utterances: [
      { start: 0.5, end: 1.5, confidence: 0.9, channel: 0, speaker: 0, transcript: 'Hello?' },
      { start: 2, end: 4, confidence: 0.9, channel: 0, speaker: 1, transcript: 'Hi, it is David from Callie.' },
    ],
  },
});

describe('the Deepgram client', () => {
  it('posts the audio to /v1/listen with nova-3, diarization, utterances and mip_opt_out', async () => {
    const seen: { url: string; headers: Record<string, string>; body: number }[] = [];
    const provider = deepgramTranscription({
      apiKey: FAKE_KEY,
      http: async (url, init) => {
        seen.push({ url, headers: init.headers, body: init.body.byteLength });
        return await Promise.resolve(new Response(JSON.stringify(answer(61.2)), { status: 200 }));
      },
    });
    const outcome = await provider.transcribe({ audio: AUDIO, contentType: 'audio/mpeg' });
    expect(outcome).toEqual({
      ok: true,
      durationSeconds: 61.2,
      language: 'en',
      utterances: [
        { speaker: 0, start: 0.5, end: 1.5, text: 'Hello?' },
        { speaker: 1, start: 2, end: 4, text: 'Hi, it is David from Callie.' },
      ],
    });
    expect(seen[0]?.url).toBe('https://api.deepgram.com/v1/listen?model=nova-3&diarize=true&punctuate=true&utterances=true&mip_opt_out=true');
    expect(seen[0]?.headers).toEqual({ authorization: `Token ${FAKE_KEY}`, 'content-type': 'audio/mpeg', accept: 'application/json' });
    expect(seen[0]?.body).toBe(AUDIO.byteLength);
    expect(provider).not.toHaveProperty('apiKey');
    expect(JSON.stringify(provider)).not.toContain(FAKE_KEY);
  });

  it('calls a 4xx refused, and a 5xx, a timeout, a dropped connection or an unreadable answer ambiguous — never with the key', async () => {
    const leaky = (status: number): DeepgramHttp => async () =>
      await Promise.resolve(new Response(JSON.stringify({ err_code: 'X', err_msg: `bad key ${FAKE_KEY}` }), { status }));
    const cases: [DeepgramHttp, TranscriptionOutcome][] = [
      [leaky(401), { ok: false, kind: 'refused', code: 'deepgram_http_401' }],
      [leaky(402), { ok: false, kind: 'refused', code: 'deepgram_http_402' }],
      [leaky(429), { ok: false, kind: 'refused', code: 'deepgram_http_429' }],
      [leaky(503), { ok: false, kind: 'ambiguous', code: 'deepgram_http_503' }],
      [
        async () => await Promise.reject(new Error(`connect ECONNRESET Authorization: Token ${FAKE_KEY}`)),
        { ok: false, kind: 'ambiguous', code: 'deepgram_unreachable' },
      ],
      [
        async () => await Promise.resolve(new Response(`{"metadata": "not the shape", "key": "${FAKE_KEY}"}`, { status: 200 })),
        { ok: false, kind: 'ambiguous', code: 'deepgram_answer_unreadable' },
      ],
    ];
    for (const [http, expected] of cases) {
      const outcome = await deepgramTranscription({ apiKey: FAKE_KEY, http }).transcribe({ audio: AUDIO, contentType: 'audio/mpeg' });
      expect(outcome).toEqual(expected);
      expect(JSON.stringify(outcome)).not.toContain(FAKE_KEY);
    }
  });

  it('times out a request that does not answer', async () => {
    const provider = deepgramTranscription({
      apiKey: FAKE_KEY,
      timeoutMs: 20,
      http: async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason));
        }),
    });
    expect(await provider.transcribe({ audio: AUDIO, contentType: 'audio/mpeg' })).toEqual({
      ok: false,
      kind: 'ambiguous',
      code: 'deepgram_unreachable',
    });
  });

  it('refuses audio that is empty or over the recording bound without a request', async () => {
    let requests = 0;
    const provider = deepgramTranscription({
      apiKey: FAKE_KEY,
      http: async () => {
        requests += 1;
        return await Promise.resolve(new Response('{}', { status: 200 }));
      },
    });
    expect(await provider.transcribe({ audio: Buffer.alloc(0), contentType: 'audio/mpeg' })).toMatchObject({ kind: 'refused' });
    expect(await provider.transcribe({ audio: Buffer.alloc(40 * 1024 * 1024 + 1), contentType: 'audio/mpeg' })).toMatchObject({ kind: 'refused' });
    expect(requests).toBe(0);
  });

  it('reads the documented answer, and nothing that is not it', () => {
    expect(parseDeepgramAnswer(answer(10))).not.toBeNull();
    expect(parseDeepgramAnswer({ metadata: { duration: 3 }, results: {} })).toEqual({ durationSeconds: 3, utterances: [] });
    expect(parseDeepgramAnswer({ metadata: { duration: -1 }, results: {} })).toBeNull();
    expect(parseDeepgramAnswer({ metadata: { duration: 3 }, results: { utterances: [{ start: 0, end: 1, speaker: 'x', transcript: '' }] } })).toBeNull();
  });

  it('reads the key from the transcription entry, and says what is missing by field name only', () => {
    expect(readTranscriptionProvider({}).problem).toBe('absent');
    expect(readTranscriptionProvider({ transcription: '{}' }).problem).toBe('field:provider');
    expect(readTranscriptionProvider({ transcription: JSON.stringify({ provider: 'deepgram', api_key: 'short' }) }).problem).toBe('field:api_key');
    const configured = readTranscriptionProvider({ transcription: JSON.stringify({ provider: 'deepgram', api_key: FAKE_KEY }) });
    expect(configured.problem).toBeNull();
    expect(configured.provider?.model).toBe('nova-3');
  });

  it('composes the job only with both the key and the Twilio recording credentials', () => {
    const transcription = JSON.stringify({ provider: 'deepgram', api_key: FAKE_KEY });
    const twilio = JSON.stringify({
      account_sid: `AC${'a'.repeat(32)}`,
      api_key_sid: `SK${'b'.repeat(32)}`,
      api_key_secret: 'c'.repeat(24),
    });
    expect(readTranscriptionComposition({}).problem).toBe('transcription:absent');
    expect(readTranscriptionComposition({ transcription }).problem).toBe('twilio:absent');
    expect(readTranscriptionComposition({ transcription, 'twilio-voice': '{}' }).problem).toBe('twilio:field:account_sid');
    const composed = readTranscriptionComposition({ transcription, 'twilio-voice': twilio });
    expect(composed.problem).toBeNull();
    expect(JSON.stringify(composed)).not.toContain(FAKE_KEY);
    const registry = registerHandlers(new HandlerRegistry(), { transcription: composed.options ?? undefined } as Parameters<typeof registerHandlers>[1]);
    expect(registry.get('call.transcribe')?.protection).toBe('business_uniqueness');
    expect(registry.get('call.transcribe')?.chunked).toBe(true);
    expect(JOB_KIND_CLASS['call.transcribe']).toBe('bulk');
    expect(registerHandlers(new HandlerRegistry(), {} as Parameters<typeof registerHandlers>[1]).get('call.transcribe')).toBeUndefined();
  });
});

describe('the call.transcribe job', () => {
  let database: TestDatabase;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;
  let policy: SeededPolicy;
  let counter = 0;
  const logs: { event: string; fields: Readonly<Record<string, unknown>> }[] = [];

  const salesperson = (): RepositoryContext =>
    repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.salesperson.userId, role: 'salesperson' }),
      database.session,
    );
  const admin = (): RepositoryContext =>
    repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }), database.session);
  const system = (): RepositoryContext =>
    repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), database.session);

  async function setting(settingKey: 'call_transcription' | 'telephony_budget', value: unknown): Promise<void> {
    const saved = await withTransaction(database.session, async () => await updateSetting(admin(), { settingKey, value }));
    if (!saved.ok) throw new Error(saved.reason);
  }

  /** A placed call: answered or not, lasting `seconds`, with a recording of that length. */
  async function call(seconds: number, options: { readonly answered?: boolean } = {}): Promise<string> {
    counter += 1;
    const created = await withTransaction(database.session, async () =>
      await createCallSession(salesperson(), {
        firmId: crm.alpha.firmId,
        routeId: policy.alpha.phoneRouteId,
        routeVersion: policy.alpha.phoneRouteVersion,
        callingIdentityId: policy.alpha.callingIdentityId,
        deviceId: seeded.alpha.salesperson.deviceId,
        commandId: `transcribe-${String(counter)}`,
        configuredCallerIdE164: '+14015550100',
        at: policy.insideWindow,
      }),
    );
    if (!created.ok) throw new Error(created.reason);
    const sessionId = created.value.sessionId;
    const sid = `CA${randomBytes(16).toString('hex')}`;
    const consumed = await withTransaction(database.session, async () =>
      await consumeCallSession(database.session, {
        workspaceId: seeded.alpha.workspaceId,
        sessionId,
        callSid: sid,
        identity: `client:${seeded.alpha.salesperson.userId}`,
        at: policy.insideWindow,
      }),
    );
    if (!consumed.ok) throw new Error(consumed.reason);
    // Every placed call is a cadence attempt; dated outside the window so the next can be placed.
    await database.session.query(
      "UPDATE call_sessions SET consumed_at = '2026-08-03T14:00:00Z', expires_at = GREATEST(expires_at, '2026-08-03T14:00:00Z') WHERE id = $1",
      [sessionId],
    );
    await withTransaction(database.session, async () => {
      if (options.answered !== false) await recordCallStatus(database.session, { callSid: sid, providerStatus: 'in-progress' });
      await recordCallStatus(database.session, {
        callSid: sid,
        providerStatus: options.answered === false ? 'no-answer' : 'completed',
        durationSeconds: seconds,
      });
      await recordCallRecording(database.session, {
        callSid: sid,
        recordingSid: `RE${randomBytes(16).toString('hex')}`,
        recordingUrl: `https://api.twilio.com/2010-04-01/Accounts/AC${'a'.repeat(32)}/Recordings/RE${randomBytes(16).toString('hex')}`,
        durationSeconds: seconds,
      });
    });
    return sessionId;
  }

  async function enqueue(sessionId: string, keyConfigured = true) {
    return await withTransaction(database.session, async () =>
      await enqueueCallTranscription(database.session, { workspaceId: seeded.alpha.workspaceId, sessionId, keyConfigured }),
    );
  }

  async function attempts(sessionId: string): Promise<{ attempt: number; state: string; cents: number; settled_cents: number }[]> {
    const { rows } = await database.session.query<{ attempt: number; state: string; cents: number; settled_cents: number }>(
      `SELECT attempt, state, cents, settled_cents FROM provider_reservations
        WHERE subject_kind = 'call_transcription' AND subject_id = $1 ORDER BY attempt`,
      [sessionId],
    );
    return rows;
  }

  /** A provider that answers from a script, one outcome per call, recording each call. */
  function scripted(outcomes: (TranscriptionOutcome | 'throw')[]): TranscriptionProvider & { calls: number; seenStates: string[][] } {
    const provider = {
      providerKey: DEEPGRAM_PROVIDER_KEY,
      provider: 'deepgram',
      model: 'nova-3',
      calls: 0,
      seenStates: [] as string[][],
      transcribe: async (): Promise<TranscriptionOutcome> => {
        const next = outcomes[provider.calls] ?? 'throw';
        provider.calls += 1;
        if (next === 'throw') throw new Error(`socket hang up; Authorization: Token ${FAKE_KEY}`);
        return await Promise.resolve(next);
      },
    };
    return provider;
  }

  const recordings: TwilioRecordingFetcher = {
    fetchRecording: async () => await Promise.resolve({ ok: true as const, contentType: 'audio/mpeg' as const, bytes: AUDIO }),
  };
  const ok = (duration: number): TranscriptionOutcome => ({
    ok: true,
    durationSeconds: duration,
    language: 'en',
    utterances: [
      { speaker: 0, start: 0.5, end: 1.5, text: 'Hello?' },
      { speaker: 1, start: 2, end: 4, text: 'Hi, it is David.' },
    ],
  });

  async function drain(provider: TranscriptionProvider): Promise<void> {
    const registry = new HandlerRegistry().register(
      callTranscribeJobHandler({ provider, recordings, log: (event, fields) => logs.push({ event, fields }) }),
    );
    for (let pass = 0; pass < 5; pass += 1) {
      const report = await runOnce(database.session, { registry, owner: 'transcribe-test', limit: 10 });
      if (report.claimed === 0) return;
    }
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    seeded = await seedTwoWorkspaces(database.session);
    crm = await seedCrm(database.session, seeded);
    policy = await seedPolicy(database.session, seeded, crm);
    await setting('telephony_budget', { dailyCeilingCents: 10_000, maxMinutesPerCall: 30, unitPriceMicros: 14_000 });
    await setting('call_transcription', { enabled: true, dailyCeilingCents: 500, unitPriceMicros: 4_300 });
  });

  beforeEach(() => {
    logs.length = 0;
  });

  afterAll(async () => {
    await database.drop();
  });

  it('queues only an answered call of at least twenty seconds, with the switch on and a key', async () => {
    expect(await enqueue(await call(15))).toEqual({ enqueued: false, reason: 'transcription_not_eligible' });
    expect(await enqueue(await call(120, { answered: false }))).toEqual({ enqueued: false, reason: 'transcription_not_eligible' });
    expect(await enqueue(await call(120), false)).toEqual({ enqueued: false, reason: 'transcription_unconfigured' });
    expect((await enqueue(await call(20))).enqueued).toBe(true);
    await setting('call_transcription', { enabled: false, dailyCeilingCents: 500, unitPriceMicros: 4_300 });
    try {
      expect(await enqueue(await call(120))).toEqual({ enqueued: false, reason: 'transcription_off' });
    } finally {
      await setting('call_transcription', { enabled: true, dailyCeilingCents: 500, unitPriceMicros: 4_300 });
    }
    // Drain the twenty-second one, so later tests start with an empty queue.
    await drain(scripted([ok(20)]));
  });

  it('reserves at the recording’s minutes, settles at the provider’s duration, and stores the transcript', async () => {
    const sessionId = await call(150);
    expect((await enqueue(sessionId)).enqueued).toBe(true);
    // A second callback queues nothing more.
    expect(await enqueue(sessionId)).toMatchObject({ enqueued: true });
    const provider = scripted([ok(301)]);
    await drain(provider);
    expect(provider.calls).toBe(1);
    // Three minutes reserved (12 900 µ$ → 2 ¢); 301 s is six started minutes (25 800 µ$ → 3 ¢).
    expect(await attempts(sessionId)).toEqual([{ attempt: 1, state: 'settled', cents: 2, settled_cents: 3 }]);
    const transcript = await readCallTranscript(salesperson(), sessionId);
    expect(transcript).toMatchObject({ callSessionId: sessionId, provider: 'deepgram', model: 'nova-3', language: 'en', durationSeconds: 301 });
    expect(transcript?.utterances).toHaveLength(2);
    const { rows } = await database.session.query<{ cost_cents: number }>(
      'SELECT cost_cents FROM provider_ledger WHERE workspace_id = $1 AND provider_key = $2',
      [seeded.alpha.workspaceId, DEEPGRAM_PROVIDER_KEY],
    );
    expect(rows.reduce((total, row) => total + Number(row.cost_cents), 0)).toBeGreaterThanOrEqual(3);
    expect(logs.find(line => line.event === 'call_transcription')?.fields).toMatchObject({ settled_cents: 3, utterances: 2 });
  });

  it('refuses with transcription_budget_exhausted when the day’s ceiling would be passed, and calls nobody', async () => {
    const sessionId = await call(600);
    expect((await enqueue(sessionId)).enqueued).toBe(true);
    // Ten minutes at 4 300 µ$ is 5 cents; a 4-cent ceiling with today's spend cannot fit it.
    await setting('call_transcription', { enabled: true, dailyCeilingCents: 4, unitPriceMicros: 4_300 });
    try {
      const provider = scripted([ok(600)]);
      await drain(provider);
      expect(provider.calls).toBe(0);
      expect(await attempts(sessionId)).toEqual([]);
      expect(logs.find(line => line.event === 'call_transcription_skipped')?.fields).toMatchObject({ reason: 'transcription_budget_exhausted' });
      expect(await readCallTranscript(salesperson(), sessionId)).toBeNull();
    } finally {
      await setting('call_transcription', { enabled: true, dailyCeilingCents: 500, unitPriceMicros: 4_300 });
    }
  });

  it('estimates an ambiguous attempt before its one bounded retry, and settles the retry', async () => {
    const sessionId = await call(90);
    expect((await enqueue(sessionId)).enqueued).toBe(true);
    const states: string[][] = [];
    const base = scripted([{ ok: false, kind: 'ambiguous', code: 'deepgram_http_503' }, ok(90)]);
    const provider: TranscriptionProvider = {
      ...base,
      transcribe: async input => {
        // What the ledger says at the moment of each call: the first attempt is already
        // estimated by the time the retry is made.
        states.push((await attempts(sessionId)).map(row => `${String(row.attempt)}:${row.state}`));
        return await base.transcribe(input);
      },
    };
    await drain(provider);
    expect(states).toEqual([['1:calling'], ['1:estimated', '2:calling']]);
    expect(await attempts(sessionId)).toEqual([
      { attempt: 1, state: 'estimated', cents: 1, settled_cents: 1 },
      { attempt: 2, state: 'settled', cents: 1, settled_cents: 1 },
    ]);
    expect(await readCallTranscript(salesperson(), sessionId)).not.toBeNull();
  });

  it('stops after the retry: two ambiguous attempts are two estimates and no third call, and the key is in no log', async () => {
    const sessionId = await call(90);
    expect((await enqueue(sessionId)).enqueued).toBe(true);
    const provider = scripted(['throw', 'throw', ok(90)]);
    await drain(provider);
    expect(provider.calls).toBe(2);
    expect((await attempts(sessionId)).map(row => row.state)).toEqual(['estimated', 'estimated']);
    expect(await readCallTranscript(salesperson(), sessionId)).toBeNull();
    expect(logs.find(line => line.event === 'call_transcription_skipped')?.fields).toMatchObject({ reason: 'transcription_failed', code: 'provider_threw' });
    expect(JSON.stringify(logs)).not.toContain(FAKE_KEY);
    const { rows } = await database.session.query<{ error_detail: string | null; payload: unknown }>(
      "SELECT error_detail, payload FROM jobs WHERE kind = 'call.transcribe'",
    );
    expect(JSON.stringify(rows)).not.toContain(FAKE_KEY);
  });

  it('estimates the attempt of a claim that died mid-call before the next claim retries', async () => {
    const sessionId = await call(90);
    expect((await enqueue(sessionId)).enqueued).toBe(true);
    const at = new Date().toISOString();
    const common = { sessionId, at, keyConfigured: true, providerKey: DEEPGRAM_PROVIDER_KEY };
    // An earlier claim got as far as marking attempt 1 `calling`, then vanished with its
    // cursor; the job is claimed again from scratch.
    await withTransaction(database.session, async () => await beginCallTranscription(system(), common));
    await withTransaction(database.session, async () => await ensureTranscriptionCalling(system(), common));
    const states: string[][] = [];
    const base = scripted([ok(90)]);
    await drain({
      ...base,
      transcribe: async input => {
        states.push((await attempts(sessionId)).map(row => `${String(row.attempt)}:${row.state}`));
        return await base.transcribe(input);
      },
    });
    expect(states).toEqual([['1:estimated', '2:calling']]);
    expect((await attempts(sessionId)).map(row => row.state)).toEqual(['estimated', 'settled']);
  });

  it('settles a refusal the provider answered with at 0 and does not retry it', async () => {
    const sessionId = await call(90);
    expect((await enqueue(sessionId)).enqueued).toBe(true);
    const provider = scripted([{ ok: false, kind: 'refused', code: 'deepgram_http_402' }, ok(90)]);
    await drain(provider);
    expect(provider.calls).toBe(1);
    expect(await attempts(sessionId)).toEqual([{ attempt: 1, state: 'settled', cents: 1, settled_cents: 0 }]);
  });

  it('finalises a lost lease in the sweep, and leaves alone a session a live claim holds', async () => {
    const sessionId = await call(90);
    const at = new Date().toISOString();
    const common = { sessionId, at, keyConfigured: true, providerKey: DEEPGRAM_PROVIDER_KEY };
    // Chunks 1 and 2 committed; the worker then vanished before chunk 3.
    expect(await withTransaction(database.session, async () => await beginCallTranscription(system(), common))).toEqual({ kind: 'reserved', attempt: 1 });
    expect(await withTransaction(database.session, async () => await ensureTranscriptionCalling(system(), common))).toEqual({ kind: 'calling', attempt: 1 });
    // Not yet: inside its half hour a reservation may still be some claim's.
    expect(await withTransaction(database.session, async () => await sweepTranscriptionReservations(system()))).toEqual({ released: 0, estimated: 0 });
    await database.session.query(
      "UPDATE provider_reservations SET created_at = now() - INTERVAL '31 minutes' WHERE subject_kind = 'call_transcription' AND subject_id = $1",
      [sessionId],
    );
    expect(await workspacesOwingTranscriptionSweep(database.session)).toContain(seeded.alpha.workspaceId);

    // A live claim holds the session's lock: the sweep skips it.
    const other = await database.appRuntimeSession();
    await other.query('BEGIN');
    await other.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${seeded.alpha.workspaceId}:call_transcription:${sessionId}`]);
    try {
      expect(await withTransaction(database.session, async () => await sweepTranscriptionReservations(system()))).toEqual({ released: 0, estimated: 0 });
    } finally {
      await other.query('ROLLBACK');
    }

    // The telephony sweep job runs it: `calling` is estimated at the reservation.
    const registry = new HandlerRegistry().register(telephonySweepJobHandler());
    await database.session.query(
      `INSERT INTO jobs (workspace_id, kind, payload, idempotency_key) VALUES ($1, 'telephony.sweep', '{}'::jsonb, 'transcribe-sweep-test')`,
      [seeded.alpha.workspaceId],
    );
    await runOnce(database.session, { registry, owner: 'sweep-test', limit: 5 });
    expect(await attempts(sessionId)).toEqual([{ attempt: 1, state: 'estimated', cents: 1, settled_cents: 1 }]);
  });
});
