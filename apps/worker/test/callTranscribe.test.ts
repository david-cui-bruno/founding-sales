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
  finishCallTranscription,
  readCallTranscript,
  sweepTranscriptionReservations,
  transcriptionSpentCents,
  transcriptionWorkerAvailable,
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
import { readSpend, workspaceBusinessZone } from '@fss/domain/research/ledger.ts';
import { seedCrm, type SeededCrm } from '@fss/domain/test/db/support/crmFixtures.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '@fss/domain/test/db/support/fixtures.ts';
import { seedPolicy, type SeededPolicy } from '@fss/domain/test/db/support/policyFixtures.ts';
import { readTranscriptionComposition, registerHandlers } from '../src/bootstrap/main.ts';
import { silentMp3 } from '@fss/domain/test/calls/mp3Fixture.ts';
import { boundMp3 } from '@fss/domain/calls/mp3Bound.ts';
import { commitDeletion, previewDeletion } from '@fss/domain/retention/deletion.ts';
import { recordingSuppressionJournal } from '@fss/domain/suppression/journal.ts';
import { callTranscribeJobHandler, heldTranscriptionSource } from '../src/handlers/callTranscribe.ts';
import { enqueueJob } from '@fss/domain/jobs/jobStore.ts';
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
// Fifteen seconds of silent MP3 frames: inside every reserved bound below.
const AUDIO = silentMp3(15);

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

  async function setting(settingKey: 'call_transcription' | 'telephony_budget' | 'monthly_cash_ceiling_cents', value: unknown): Promise<void> {
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

  async function drain(provider: TranscriptionProvider, fetcher: TwilioRecordingFetcher = recordings): Promise<void> {
    const registry = new HandlerRegistry().register(
      callTranscribeJobHandler({ provider, recordings: fetcher, log: (event, fields) => logs.push({ event, fields }) }),
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
    // (150 + 2) s is three minutes reserved (12 900 µ$ → 2 ¢), and three is the bound: a
    // report of 301 s settles at the three minutes that were cleared, not six.
    expect(await attempts(sessionId)).toEqual([{ attempt: 1, state: 'settled', cents: 2, settled_cents: 2 }]);
    const transcript = await readCallTranscript(salesperson(), sessionId);
    expect(transcript).toMatchObject({ callSessionId: sessionId, provider: 'deepgram', model: 'nova-3', language: 'en', durationSeconds: 301 });
    expect(transcript?.utterances).toHaveLength(2);
    const { rows } = await database.session.query<{ cost_cents: number }>(
      'SELECT cost_cents FROM provider_ledger WHERE workspace_id = $1 AND provider_key = $2',
      [seeded.alpha.workspaceId, DEEPGRAM_PROVIDER_KEY],
    );
    expect(rows.reduce((total, row) => total + Number(row.cost_cents), 0)).toBeGreaterThanOrEqual(2);
    expect(logs.find(line => line.event === 'call_transcription')?.fields).toMatchObject({ settled_cents: 2, utterances: 2 });
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

  // ------------------------------------------------------------------ review fold 1
  const today = async (): Promise<number> =>
    await withTransaction(database.session, async () => {
      const { rows } = await database.session.query<{ date: string }>(
        "SELECT (now() AT TIME ZONE 'America/New_York')::date::text AS date",
      );
      return await transcriptionSpentCents(system(), rows[0]?.date ?? '');
    });

  it('never records more than the ceiling: two 120 s calls against a 2¢ ceiling, Deepgram hearing 120.4 s (P1)', async () => {
    const spentBefore = await today();
    await setting('call_transcription', { enabled: true, dailyCeilingCents: spentBefore + 2, unitPriceMicros: 4_300 });
    try {
      const first = await call(120);
      const second = await call(120);
      expect((await enqueue(first)).enqueued).toBe(true);
      expect((await enqueue(second)).enqueued).toBe(true);
      await drain(scripted([ok(120.4), ok(120.4)]), {
        fetchRecording: async () => await Promise.resolve({ ok: true as const, contentType: 'audio/mpeg' as const, bytes: silentMp3(120) }),
      });
      // (120 + 2) s is three minutes, 2 ¢: the first fits the ceiling and the second is refused.
      expect(await today()).toBeLessThanOrEqual(spentBefore + 2);
      expect(await attempts(first)).toEqual([{ attempt: 1, state: 'settled', cents: 2, settled_cents: 2 }]);
      expect(await attempts(second)).toEqual([]);
    } finally {
      await setting('call_transcription', { enabled: true, dailyCeilingCents: 500, unitPriceMicros: 4_300 });
    }
  });

  it('settles at the reserved minutes when the provider reports more than was cleared (P1)', async () => {
    const spentBefore = await today();
    // A cent a minute, so a minute more shows as a cent more.
    await setting('call_transcription', { enabled: true, dailyCeilingCents: spentBefore + 6, unitPriceMicros: 10_000 });
    try {
      const first = await call(120);
      const second = await call(120);
      expect((await enqueue(first)).enqueued).toBe(true);
      expect((await enqueue(second)).enqueued).toBe(true);
      await drain(scripted([ok(200), ok(200)]));
      expect((await attempts(first))[0]).toMatchObject({ cents: 3, settled_cents: 3 });
      expect((await attempts(second))[0]).toMatchObject({ cents: 3, settled_cents: 3 });
      expect(await today()).toBe(spentBefore + 6);
    } finally {
      await setting('call_transcription', { enabled: true, dailyCeilingCents: 500, unitPriceMicros: 4_300 });
    }
  });

  it('sends the provider at most the reserved minutes of audio, and nothing it cannot read as MP3 (P1)', async () => {
    const sessionId = await call(60);
    expect((await enqueue(sessionId)).enqueued).toBe(true);
    const sent: number[] = [];
    const base = scripted([ok(60)]);
    // Twilio said 60 s and hands back ten minutes: only the two reserved minutes go out.
    await drain(
      {
        ...base,
        transcribe: async input => {
          sent.push(boundMp3(input.audio, Number.MAX_SAFE_INTEGER)?.seconds ?? -1);
          return await base.transcribe(input);
        },
      },
      { fetchRecording: async () => await Promise.resolve({ ok: true as const, contentType: 'audio/mpeg' as const, bytes: silentMp3(600) }) },
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeLessThanOrEqual(120);
    expect(sent[0]).toBeGreaterThan(119);

    const unreadable = await call(60);
    expect((await enqueue(unreadable)).enqueued).toBe(true);
    const provider = scripted([ok(60)]);
    await drain(provider, {
      fetchRecording: async () => await Promise.resolve({ ok: true as const, contentType: 'audio/mpeg' as const, bytes: Buffer.from('not audio') }),
    });
    expect(provider.calls).toBe(0);
    expect(await attempts(unreadable)).toEqual([{ attempt: 1, state: 'released', cents: 1, settled_cents: 0 }]);
  });

  it('releases a reservation, and calls nobody, when transcription is turned off or set to $0 after it was made (P2)', async () => {
    const at = new Date().toISOString();
    // Off between chunk 1 and chunk 2: the unused reservation is released by the next claim.
    const off = await call(90);
    expect((await enqueue(off)).enqueued).toBe(true);
    const common = { sessionId: off, at, keyConfigured: true, providerKey: DEEPGRAM_PROVIDER_KEY };
    expect(await withTransaction(database.session, async () => await beginCallTranscription(system(), common))).toEqual({ kind: 'reserved', attempt: 1 });
    await setting('call_transcription', { enabled: false, dailyCeilingCents: 500, unitPriceMicros: 4_300 });
    try {
      const provider = scripted([ok(90)]);
      await drain(provider);
      expect(provider.calls).toBe(0);
      expect(await attempts(off)).toEqual([{ attempt: 1, state: 'released', cents: 1, settled_cents: 0 }]);
    } finally {
      await setting('call_transcription', { enabled: true, dailyCeilingCents: 500, unitPriceMicros: 4_300 });
    }

    // $0 between chunk 2 and chunk 3: the claim that marked it releases it, uncalled.
    const zero = await call(90);
    const zeroCommon = { ...common, sessionId: zero };
    await withTransaction(database.session, async () => await beginCallTranscription(system(), zeroCommon));
    expect(await withTransaction(database.session, async () => await ensureTranscriptionCalling(system(), zeroCommon))).toEqual({ kind: 'calling', attempt: 1 });
    await setting('call_transcription', { enabled: true, dailyCeilingCents: 0, unitPriceMicros: 4_300 });
    try {
      const provider = scripted([ok(90)]);
      const finished = await withTransaction(database.session, async () =>
        await finishCallTranscription(system(), { sessionId: zero, attempt: 1, at, recordings, provider }),
      );
      expect(finished).toEqual({ kind: 'done', reason: 'transcription_off' });
      expect(provider.calls).toBe(0);
      expect(await attempts(zero)).toEqual([{ attempt: 1, state: 'released', cents: 1, settled_cents: 0 }]);
    } finally {
      await setting('call_transcription', { enabled: true, dailyCeilingCents: 500, unitPriceMicros: 4_300 });
    }
  });

  it('calls nobody when transcription is turned off while the recording is read from Twilio (slice P1)', async () => {
    const at = new Date().toISOString();
    const late = await call(90);
    const common = { sessionId: late, at, keyConfigured: true, providerKey: DEEPGRAM_PROVIDER_KEY };
    await withTransaction(database.session, async () => await beginCallTranscription(system(), common));
    expect(await withTransaction(database.session, async () => await ensureTranscriptionCalling(system(), common))).toEqual({ kind: 'calling', attempt: 1 });
    // The switch goes off during the Twilio read: after the first re-check, before Deepgram.
    // Written in the chunk's own transaction, so the next read in it sees the write.
    const turnsOff: TwilioRecordingFetcher = {
      fetchRecording: async () => {
        const saved = await updateSetting(admin(), {
          settingKey: 'call_transcription',
          value: { enabled: false, dailyCeilingCents: 500, unitPriceMicros: 4_300 },
        });
        if (!saved.ok) throw new Error(saved.reason);
        return { ok: true as const, contentType: 'audio/mpeg' as const, bytes: AUDIO };
      },
    };
    try {
      const provider = scripted([ok(90)]);
      const finished = await withTransaction(database.session, async () =>
        await finishCallTranscription(system(), { sessionId: late, attempt: 1, at, recordings: turnsOff, provider }),
      );
      expect(finished).toEqual({ kind: 'done', reason: 'transcription_off' });
      expect(provider.calls).toBe(0);
      expect(await attempts(late)).toEqual([{ attempt: 1, state: 'released', cents: 1, settled_cents: 0 }]);
    } finally {
      await setting('call_transcription', { enabled: true, dailyCeilingCents: 500, unitPriceMicros: 4_300 });
    }
  });

  it('holds a transcription turned off mid-flight, and runs it exactly once when turned back on (slice P1, finding 6)', async () => {
    const held = await call(90);
    expect((await enqueue(held)).enqueued).toBe(true);
    // Off during the Twilio read: the final check before Deepgram finds it, and the job completes.
    const turnsOff: TwilioRecordingFetcher = {
      fetchRecording: async () => {
        await setting('call_transcription', { enabled: false, dailyCeilingCents: 500, unitPriceMicros: 4_300 });
        return { ok: true as const, contentType: 'audio/mpeg' as const, bytes: AUDIO };
      },
    };
    const source = heldTranscriptionSource({ enabled: true });
    const owed = async () =>
      (await source.find(database.session, new Date().toISOString())).filter(spec => spec.payload['callSessionId'] === held);
    const resume = async (): Promise<readonly string[]> => {
      const specs = await owed();
      for (const spec of specs) await withTransaction(database.session, async () => await enqueueJob(database.session, spec));
      return specs.map(spec => spec.idempotencyKey);
    };
    const first = scripted([ok(90)]);
    await drain(first, turnsOff);
    expect(first.calls).toBe(0);
    expect(await attempts(held)).toEqual([{ attempt: 1, state: 'released', cents: 1, settled_cents: 0 }]);
    // Still off: nothing is owed. A worker without the handler never materializes one.
    expect(await owed()).toEqual([]);
    await setting('call_transcription', { enabled: true, dailyCeilingCents: 500, unitPriceMicros: 4_300 });
    expect(await heldTranscriptionSource({ enabled: false }).find(database.session, new Date().toISOString())).toEqual([]);
    // Turned off mid-flight a second time: a held attempt cost nothing, so it is no reason to give up.
    expect(await resume()).toEqual([`call-transcribe:${held}:r1`]);
    await drain(first, turnsOff);
    expect(first.calls).toBe(0);
    await setting('call_transcription', { enabled: true, dailyCeilingCents: 500, unitPriceMicros: 4_300 });
    expect(await resume()).toEqual([`call-transcribe:${held}:r2`]);
    const second = scripted([ok(90), ok(90)]);
    await drain(second);
    expect(second.calls).toBe(1);
    // One paid attempt: the held ones cost nothing, the resumed one is settled once.
    expect(await attempts(held)).toEqual([
      { attempt: 1, state: 'released', cents: 1, settled_cents: 0 },
      { attempt: 2, state: 'released', cents: 1, settled_cents: 0 },
      { attempt: 3, state: 'settled', cents: 1, settled_cents: 1 },
    ]);
    expect(await readCallTranscript(salesperson(), held)).not.toBeNull();
    // And never again: the source owes nothing more, and a re-enqueue of a key runs nothing.
    expect(await owed()).toEqual([]);
    await withTransaction(database.session, async () =>
      await enqueueJob(database.session, {
        workspaceId: seeded.alpha.workspaceId,
        kind: 'call.transcribe',
        idempotencyKey: `call-transcribe:${held}:r2`,
        payload: { callSessionId: held },
        maxAttempts: 3,
      }),
    );
    await drain(second);
    expect(second.calls).toBe(1);
  });

  /** This calendar month's spend, on the business calendar, as of the fixture's call instant. */
  const monthSpent = async (): Promise<number> =>
    (await readSpend(system(), { businessTimeZone: await workspaceBusinessZone(system()), at: policy.insideWindow })).monthToDateCents;
  /** A call session's reservation at the budget above: thirty minutes at 1.4¢, rounded up. */
  const CALL_RESERVATION_CENTS = 42;
  const createSession = async (session: typeof database.session, commandId: string) =>
    await createCallSession(
      repositoryContext(
        workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.salesperson.userId, role: 'salesperson' }),
        session,
      ),
      {
        firmId: crm.alpha.firmId,
        routeId: policy.alpha.phoneRouteId,
        routeVersion: policy.alpha.phoneRouteVersion,
        callingIdentityId: policy.alpha.callingIdentityId,
        deviceId: seeded.alpha.salesperson.deviceId,
        commandId,
        configuredCallerIdE164: '+14015550100',
        at: policy.insideWindow,
      },
    );

  it('refuses a call session or a transcription that would pass the month’s cash ceiling (slice P1)', async () => {
    const eligible = await call(90);
    try {
      // One cent short of a call's reservation: the call is refused, before any ticket.
      await setting('monthly_cash_ceiling_cents', { cents: (await monthSpent()) + CALL_RESERVATION_CENTS - 1 });
      const refused = await withTransaction(database.session, async () => await createSession(database.session, 'month-refused'));
      expect(refused).toEqual({ ok: false, reason: 'monthly_cash_ceiling' });

      // No headroom at all: the transcription is refused at its reservation, and calls nobody.
      await setting('monthly_cash_ceiling_cents', { cents: await monthSpent() });
      const common = { sessionId: eligible, at: policy.insideWindow, keyConfigured: true, providerKey: DEEPGRAM_PROVIDER_KEY };
      expect(await withTransaction(database.session, async () => await beginCallTranscription(system(), common))).toEqual({
        kind: 'done',
        reason: 'monthly_cash_ceiling',
      });
      expect(await attempts(eligible)).toEqual([]);

      // Exactly enough: the call fits.
      await setting('monthly_cash_ceiling_cents', { cents: (await monthSpent()) + CALL_RESERVATION_CENTS });
      const fits = await withTransaction(database.session, async () => await createSession(database.session, 'month-fits'));
      expect(fits.ok).toBe(true);
    } finally {
      await setting('monthly_cash_ceiling_cents', { cents: 5_000 });
    }
  });

  it('serialises two reservations at the edge of the month: a call holding the last cents makes a transcription wait, then refuses it (slice P1)', async () => {
    const eligible = await call(90);
    const other = await database.appRuntimeSession();
    const worker = repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), other);
    // Room for the call or the transcription, not both.
    await setting('monthly_cash_ceiling_cents', { cents: (await monthSpent()) + CALL_RESERVATION_CENTS });
    await database.session.query('BEGIN');
    let open = true;
    try {
      // The call reserves the last cents, uncommitted.
      const created = await createSession(database.session, 'month-edge-call');
      expect(created.ok).toBe(true);

      // Meanwhile a worker, on its own connection, clears the transcription's reservation.
      const common = { sessionId: eligible, at: policy.insideWindow, keyConfigured: true, providerKey: DEEPGRAM_PROVIDER_KEY };
      let settled = false;
      const begun = withTransaction(other, async () => await beginCallTranscription(worker, common)).finally(() => {
        settled = true;
      });
      // It waits on the monthly lock the call's transaction holds.
      let waiting = false;
      for (let attempt = 0; attempt < 200 && !waiting; attempt += 1) {
        const { rows } = await database.session.query<{ waiting: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
                           WHERE NOT l.granted AND l.locktype = 'advisory' AND a.pid <> pg_backend_pid()
                             AND a.datname = current_database()) AS waiting`,
        );
        waiting = rows[0]?.waiting === true;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(true);
      expect(settled).toBe(false);

      await database.session.query('COMMIT');
      open = false;
      // It then reads the committed call and refuses: the month would be passed.
      expect(await begun).toEqual({ kind: 'done', reason: 'monthly_cash_ceiling' });
      expect(await attempts(eligible)).toEqual([]);
    } finally {
      if (open) await database.session.query('ROLLBACK');
      await setting('monthly_cash_ceiling_cents', { cents: 5_000 });
    }
  });

  it('closes only the attempts that are themselves old, leaving a fresh retry alone (P2)', async () => {
    const sessionId = await call(90);
    const at = new Date().toISOString();
    const common = { sessionId, at, keyConfigured: true, providerKey: DEEPGRAM_PROVIDER_KEY };
    await withTransaction(database.session, async () => await beginCallTranscription(system(), common));
    await withTransaction(database.session, async () => await ensureTranscriptionCalling(system(), common));
    await database.session.query(
      "UPDATE provider_reservations SET created_at = now() - INTERVAL '31 minutes' WHERE subject_kind = 'call_transcription' AND subject_id = $1",
      [sessionId],
    );
    // A recovering claim's fresh attempt 2, written after the sweep chose the session by
    // attempt 1's age and before it took the lock.
    await database.session.query(
      `INSERT INTO provider_reservations
         (workspace_id, provider_key, subject_kind, subject_id, attempt, business_date, business_time_zone,
          cents, priced_unit, max_units, unit_price_micros, state)
       VALUES ($1, $2, 'call_transcription', $3, 2, (now() AT TIME ZONE 'America/New_York')::date, 'America/New_York', 1, 'minute', 2, 4300, 'calling')`,
      [seeded.alpha.workspaceId, DEEPGRAM_PROVIDER_KEY, sessionId],
    );
    expect(await withTransaction(database.session, async () => await sweepTranscriptionReservations(system()))).toEqual({ released: 0, estimated: 1 });
    expect((await attempts(sessionId)).map(row => `${String(row.attempt)}:${row.state}`)).toEqual(['1:estimated', '2:calling']);
    // Leave nothing open for the tests after this one.
    await database.session.query("UPDATE provider_reservations SET state = 'estimated', settled_cents = cents, settled_at = now() WHERE subject_id = $1 AND state = 'calling'", [sessionId]);
  });

  it('says a worker can transcribe only while a fresh worker heartbeat says so (P2)', async () => {
    await database.session.query("DELETE FROM heartbeats WHERE component = 'worker'");
    expect(await transcriptionWorkerAvailable(database.session)).toBe(false);
    // A worker without the handler beats: still no.
    await runOnce(database.session, { registry: new HandlerRegistry(), owner: 'no-key-worker', limit: 1 });
    expect(await transcriptionWorkerAvailable(database.session)).toBe(false);
    await drain(scripted([]));
    expect(await transcriptionWorkerAvailable(database.session)).toBe(true);
    // A beat older than its interval is not a live worker.
    await database.session.query("UPDATE heartbeats SET observed_at = now() - INTERVAL '2 minutes' WHERE component = 'worker'");
    expect(await transcriptionWorkerAvailable(database.session)).toBe(false);
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

  // Last, because it deletes the firm every call above was placed at.
  it('sends no audio once the session is deleted, even for a transcription that begins during the deletion (P1)', async () => {
    const sessionId = await call(90);
    const admin = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }),
      database.session,
    );
    const preview = await previewDeletion(admin, { targetKind: 'firm', firmId: crm.alpha.firmId });
    // The deletion runs, uncommitted, before the session has any reservation.
    await database.session.query('BEGIN');
    let committed = false;
    try {
      const outcome = await commitDeletion(admin, {
        requestId: preview.value?.requestId ?? '',
        previewHash: preview.value?.previewHash ?? '',
        commandId: 'deletion-during-transcription',
        journal: recordingSuppressionJournal(),
      });
      expect(outcome.ok, outcome.ok ? '' : outcome.reason).toBe(true);

      // Meanwhile a worker, on its own connection, begins this call's transcription.
      const other = await database.appRuntimeSession();
      const worker = repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), other);
      const provider = scripted([ok(90)]);
      const at = new Date().toISOString();
      const common = { sessionId, at, keyConfigured: true, providerKey: DEEPGRAM_PROVIDER_KEY };
      let settledWorker = false;
      const run = (async () => {
        const begun = await withTransaction(other, async () => await beginCallTranscription(worker, common));
        if (begun.kind !== 'reserved') return begun;
        const calling = await withTransaction(other, async () => await ensureTranscriptionCalling(worker, common));
        if (calling.kind !== 'calling') return calling;
        return await withTransaction(other, async () =>
          await finishCallTranscription(worker, { sessionId, attempt: calling.attempt, at, recordings, provider }),
        );
      })().finally(() => {
        settledWorker = true;
      });
      await new Promise(resolve => setTimeout(resolve, 300));
      // It waits on the session's lock the deletion holds, and has sent nothing.
      expect(settledWorker).toBe(false);
      expect(provider.calls).toBe(0);
      await database.session.query('COMMIT');
      committed = true;
      expect(await run).toMatchObject({ kind: 'done', reason: 'transcription_not_eligible' });
      expect(provider.calls).toBe(0);
      expect(await attempts(sessionId)).toEqual([]);
    } finally {
      if (!committed) await database.session.query('ROLLBACK');
    }
  });
});
