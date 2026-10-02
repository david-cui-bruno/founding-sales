import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { messagesCallAnalyzer } from '@fss/domain/calls/analysisAdapter.ts';
import type { AnthropicMessageResponse, AnthropicMessagesTransport } from '@fss/domain/classification/anthropicClient.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { answer } from '@fss/domain/test/calls/analysisFixtures.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedContact, seedFirm } from './support/crmSeed.ts';
import { PUBLIC_ORIGIN, startIntegrationServer, type IntegrationServer } from './support/integrationServer.ts';
import { runOnce } from '../../worker/src/runner/jobRunner.ts';
import { callAnalyzeHandlers } from '../../worker/src/handlers/callAnalyze.ts';

/**
 * Slice 3a, A-6: the analysis API end to end — calls placed through the real API and its
 * signed Twilio callbacks, a channel-labelled transcript stored for each, and the worker's own
 * runner with the `call.analyze` handler over a fake Messages transport:
 *
 *   * `POST /calls/analysis/retry` queues one job per command (a replay queues nothing more);
 *     a historical call (summary path) is refused `reanalysis_required` for `retry` and
 *     queued for `reanalysis`; a pending version is `analysis_in_flight`;
 *   * `GET /calls/analysis` serves the completed version and its proposals;
 *   * `GET /calls/history?include=summary` maps the current analysis — David's notes over the
 *     model's — and falls back to a stored summary for a call with none;
 *   * another workspace, another firm's salesperson and a malformed body are refused.
 */

const CALLER_ID = '+14015550100';
const UTTERANCES = [
  { speaker: 0, start: 1.1, end: 5.0, text: 'Hi Dana, this is David from Callie.' },
  { speaker: 1, start: 5.5, end: 10.0, text: "We're evaluating a couple of tools. Can you show us a demo?" },
  { speaker: 0, start: 10.5, end: 15.0, text: 'Absolutely. I will send you a calendar link today.' },
];
const GOOD = answer({
  summary: 'You reached Dana. She is evaluating tools and asked for a demo.',
  interest: { level: 'buying_signal', signals: [{ kind: 'demo_request', quote: 'Can you show us a demo?', line: 2 }] },
  commitments: [{ speaker: 'you', quote: 'I will send you a calendar link today', line: 3, due_phrase: 'today' }],
});

describe('the post-call analysis API (slice 3a, A-6)', () => {
  let fixture: AuthFixture;
  let server: IntegrationServer;
  let adminToken = '';
  let salespersonToken = '';
  let identityId = '';
  let requests = 0;

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

  const transport: AnthropicMessagesTransport = {
    countTokens: async () => await Promise.resolve(1),
    create: async (): Promise<AnthropicMessageResponse> => {
      requests += 1;
      return await Promise.resolve({
        model: 'claude-haiku-4-5-20251001',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: GOOD }],
        usage: { input_tokens: 2_000, output_tokens: 600 },
      });
    },
  };
  const registry = (): HandlerRegistry => {
    const built = new HandlerRegistry();
    for (const handler of callAnalyzeHandlers({ analyzer: messagesCallAnalyzer({ transport }), model: 'claude-haiku-4-5-20251001' })) built.register(handler);
    return built;
  };
  async function drain(): Promise<void> {
    for (let pass = 0; pass < 10; pass += 1) {
      if ((await runOnce(fixture.db, { registry: registry(), owner: 'analysis-api-test', limit: 5 })).claimed === 0) return;
    }
  }
  async function transcribed(call: { readonly sessionId: string }): Promise<void> {
    await fixture.db.query(
      `INSERT INTO call_transcripts (workspace_id, call_session_id, provider, model, language, duration_seconds, utterances)
       VALUES ($1, $2, 'aws_transcribe', 'standard', 'en-US', 180, $3::jsonb)`,
      [fixture.alpha.workspaceId, call.sessionId, JSON.stringify(UTTERANCES)],
    );
  }
  const jobsOf = async (sessionId: string): Promise<string[]> =>
    (
      await fixture.db.query<{ idempotency_key: string }>(
        "SELECT idempotency_key FROM jobs WHERE kind = 'call.analyze' AND payload ->> 'callSessionId' = $1 ORDER BY created_at",
        [sessionId],
      )
    ).rows.map(row => row.idempotency_key);

  let fresh = { firmId: '', sessionId: '' };
  let historical = { firmId: '', sessionId: '' };

  beforeAll(async () => {
    fixture = await createAuthFixture();
    server = await startIntegrationServer(fixture, { callerIdE164: CALLER_ID });
    adminToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)).accessToken;
    salespersonToken = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)).accessToken;
    for (const [settingKey, value] of [
      ['calling_provider', { provider: 'twilio' }],
      ['telephony_budget', { dailyCeilingCents: 500, maxMinutesPerCall: 30, unitPriceMicros: 14_000 }],
      ['call_transcription', { enabled: true, dailyCeilingCents: 100, unitPriceMicros: 4_300 }],
      ['monthly_cash_ceiling_cents', { cents: 5_000 }],
    ] as const) {
      const saved = await post('/settings/update', adminToken, command({ settingKey, value }));
      expect(saved.status, saved.text).toBe(200);
    }
    const identity = await post('/calling-identities/register', salespersonToken, command({ e164: CALLER_ID }));
    identityId = String((resultOf(identity)['identity'] as { id?: string } | undefined)?.id);
    expect((await post('/postures/allow', adminToken, command({ states: ['RI'], confirmed: true }))).status).toBe(200);
    fresh = await placeCall('Fresh', { answered: true, seconds: 180, phone: '+14015550187' });
    historical = await placeCall('Historical', { answered: true, seconds: 180, phone: '+14015550186' });
    await transcribed(fresh);
    await transcribed(historical);
    // The historical call has a summary from before the release: it is on the summary path.
    await fixture.db.query(
      `INSERT INTO call_summaries (workspace_id, call_session_id, model, prompt_version, summary, next_steps, commitments)
       VALUES ($1, $2, 'claude-haiku-4-5-20251001', 'c3b.summary.1', $3, '[]'::jsonb, '[]'::jsonb)`,
      [fixture.alpha.workspaceId, historical.sessionId, 'You reached the office. They asked for pricing.'],
    );
  });

  afterAll(async () => {
    await server.close();
    await fixture.stop();
  });

  it('POST /calls/analysis/retry queues one job per command; a replay queues nothing more; a pending version is in flight', async () => {
    const body = command({ callSessionId: fresh.sessionId, reason: 'retry' });
    const queued = await post('/calls/analysis/retry', salespersonToken, body);
    expect(queued.status, queued.text).toBe(200);
    expect(queued.body).toMatchObject({ status: 'accepted', replayed: false, result: { callSessionId: fresh.sessionId, queued: true } });
    const replay = await post('/calls/analysis/retry', salespersonToken, body);
    expect(replay.body).toMatchObject({ status: 'accepted', replayed: true, result: { callSessionId: fresh.sessionId, queued: true } });
    expect(await jobsOf(fresh.sessionId)).toEqual([`call-analyze:${fresh.sessionId}:c:${String(body['commandId'])}`]);
    await drain();
    expect(requests).toBe(1);
    const read = await get(`/calls/analysis?callSessionId=${fresh.sessionId}`, salespersonToken);
    expect(read.status, read.text).toBe(200);
    expect(read.body).toMatchObject({ callSessionId: fresh.sessionId, current: { version: 1, origin: 'model' }, pending: null });
    expect((read.body['authoritative'] as { proposals: { key: string }[] }).proposals.map(proposal => proposal.key)).toEqual(
      expect.arrayContaining(['outcome', 'buying_signal']),
    );
    // With the switch off, a retry's job holds a new pending version; a second retry is in flight.
    const off = await post('/settings/update', adminToken, command({ settingKey: 'call_transcription', value: { enabled: false, dailyCeilingCents: 100, unitPriceMicros: 4_300 } }));
    expect(off.status, off.text).toBe(200);
    try {
      expect((await post('/calls/analysis/retry', salespersonToken, command({ callSessionId: fresh.sessionId, reason: 'reanalysis' }))).body).toMatchObject({ status: 'accepted' });
      await drain();
      expect(requests).toBe(1);
      expect((await get(`/calls/analysis?callSessionId=${fresh.sessionId}`, salespersonToken)).body).toMatchObject({ pending: { version: 2 } });
      const inFlight = await post('/calls/analysis/retry', salespersonToken, command({ callSessionId: fresh.sessionId, reason: 'retry' }));
      expect(inFlight.body).toMatchObject({ status: 'refused', reason: 'analysis_in_flight' });
    } finally {
      await post('/settings/update', adminToken, command({ settingKey: 'call_transcription', value: { enabled: true, dailyCeilingCents: 100, unitPriceMicros: 4_300 } }));
    }
  });

  it('a historical call is refused a retry and queued for a reanalysis; until it completes, the history keeps its summary', async () => {
    const refused = await post('/calls/analysis/retry', salespersonToken, command({ callSessionId: historical.sessionId, reason: 'retry' }));
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ status: 'refused', reason: 'reanalysis_required' });
    expect(await jobsOf(historical.sessionId)).toEqual([]);
    const queued = await post('/calls/analysis/retry', salespersonToken, command({ callSessionId: historical.sessionId, reason: 'reanalysis' }));
    expect(queued.body).toMatchObject({ status: 'accepted', result: { queued: true } });
    const before = await get(`/calls/history?firmId=${historical.firmId}&include=summary`, salespersonToken);
    expect(before.body['calls']).toEqual([expect.objectContaining({ summary: expect.objectContaining({ summary: 'You reached the office. They asked for pricing.' }) as unknown })]);
    await drain();
    const after = await get(`/calls/history?firmId=${historical.firmId}&include=summary`, salespersonToken);
    expect(after.body['calls']).toEqual([
      expect.objectContaining({
        summary: {
          summary: 'You reached Dana. She is evaluating tools and asked for a demo.',
          nextSteps: [],
          commitments: [{ speaker: 'you', quote: 'I will send you a calendar link today' }],
          model: 'claude-haiku-4-5-20251001',
          createdAt: expect.any(String) as unknown,
        },
      }),
    ]);
  });

  it('the history maps David’s notes over the model’s reading', async () => {
    const edited = await post(
      '/calls/analysis/edit',
      salespersonToken,
      command({ callSessionId: fresh.sessionId, notes: { summary: 'Dana wants a demo next week.', facts: ['240 doors'] } }),
    );
    expect(edited.status, edited.text).toBe(200);
    const history = await get(`/calls/history?firmId=${fresh.firmId}&include=summary`, salespersonToken);
    expect(history.body['calls']).toEqual([
      expect.objectContaining({
        sessionId: fresh.sessionId,
        summary: expect.objectContaining({ summary: 'Dana wants a demo next week.', model: 'user', commitments: [{ speaker: 'you', quote: 'I will send you a calendar link today' }] }) as unknown,
      }),
    ]);
    // Without the opt-in, nothing of it.
    expect(JSON.stringify((await get(`/calls/history?firmId=${fresh.firmId}`, salespersonToken)).body)).not.toContain('summary');
  });

  it('refuses another firm’s salesperson, another workspace and a malformed body', async () => {
    expect((await post('/calls/analysis/retry', salespersonToken, command({ callSessionId: fresh.sessionId }))).status).toBe(400);
    expect((await post('/calls/analysis/retry', salespersonToken, command({ callSessionId: fresh.sessionId, reason: 'later' }))).status).toBe(400);
    const beta = (await issueSessionFor(fixture, fixture.beta, fixture.beta.admin)).accessToken;
    expect((await post('/settings/update', beta, command({ settingKey: 'calling_provider', value: { provider: 'twilio' } }))).status).toBe(200);
    const elsewhere = await post('/calls/analysis/retry', beta, command({ callSessionId: fresh.sessionId, reason: 'reanalysis' }));
    expect(elsewhere.body).toMatchObject({ status: 'refused', reason: 'not_found' });
    await fixture.db.query('UPDATE firms SET assigned_user_id = $2 WHERE id = $1', [fresh.firmId, fixture.alpha.admin.userId]);
    try {
      const other = await post('/calls/analysis/retry', salespersonToken, command({ callSessionId: fresh.sessionId, reason: 'reanalysis' }));
      expect(other.body).toMatchObject({ status: 'refused', reason: 'not_found' });
    } finally {
      await fixture.db.query('UPDATE firms SET assigned_user_id = $2 WHERE id = $1', [fresh.firmId, fixture.alpha.salesperson.userId]);
    }
  });
});
