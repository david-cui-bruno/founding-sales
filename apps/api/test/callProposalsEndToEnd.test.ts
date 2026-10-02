import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { callAnalysisResponseSchema, todayFirmResponseSchema, type CallTranscriptUtterance } from '@fss/contracts';
import { completeCallAnalysis, createAnalysisVersion, readPolicyContext } from '@fss/domain/calls/analysis.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import type { TwilioRecordingFetcher } from '@fss/domain/calls/twilioRecording.ts';
import { answer } from '@fss/domain/test/calls/analysisFixtures.ts';
import { silentMp3 } from '@fss/domain/test/calls/mp3Fixture.ts';
import { createAuthFixture, CURRENT_CLIENT_VERSION, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedContact, seedFirm } from './support/crmSeed.ts';
import { PUBLIC_ORIGIN, startIntegrationServer, type IntegrationServer } from './support/integrationServer.ts';
import { runOnce } from '../../worker/src/runner/jobRunner.ts';
import { callTranscribeJobHandler } from '../../worker/src/handlers/callTranscribe.ts';
import { deepgramTranscription, type DeepgramHttp } from '../../worker/src/transcription/deepgramClient.ts';

/**
 * Slice 3a, lane B — B-9: apply-on-click, end to end.
 *
 * Fakes for the two providers only (Twilio's recording bytes and Deepgram's answer) and a
 * canned model reading handed to lane A's production writers (`createAnalysisVersion`,
 * `completeCallAnalysis`), as the analysis job will. Everything else is the real API on a
 * real port, its signed Twilio callbacks and the worker's own runner:
 *
 *   1. a call placed through `/calls/session` and answered for three minutes: the status and
 *      recording callbacks admit the pending-review hold, which holds e-mail at the firm;
 *   2. the worker transcribes it; the analysis reads "Could you send me an overview?" and
 *      "I'll send you the pricing sheet today";
 *   3. `GET /calls/analysis` shows the proposals; one click on `/calls/proposals/apply` logs
 *      the call, grants the single e-mail, and writes the overview and promise tasks; the
 *      hold is released at the log;
 *   4. the same click again (same command id) is answered from its receipt; a second click
 *      (new id) is `call_already_logged`; one log, one permission, two tasks;
 *   5. Today shows the tasks only to a reader that negotiated `include=tasks`; completing
 *      one marks it done; Needs review lists nothing for the call.
 */

const CALLER_ID = '+14015550100';
const AUDIO = silentMp3(180);
// Assembled at runtime so no scanner mistakes a fixture for a credential.
const FAKE_KEY = ['FAKE', 'dg', 'key', '0123456789'].join('-');
const PROMISE = "I'll send you the pricing sheet today";

const DEEPGRAM_ANSWER = {
  metadata: { request_id: 'request-b9', duration: 180.4, models: ['nova-3'] },
  results: {
    utterances: [
      { start: 0.4, end: 1.2, confidence: 0.98, channel: 1, transcript: 'Hello, Apply Test Law.' },
      { start: 1.6, end: 4.9, confidence: 0.97, channel: 0, transcript: 'Hi Dana, this is David from Callie.' },
      { start: 5.2, end: 8.0, confidence: 0.95, channel: 1, transcript: 'Sounds good. Could you send me an overview by email?' },
      { start: 8.4, end: 11.0, confidence: 0.96, channel: 0, transcript: `Absolutely. ${PROMISE}.` },
    ],
  },
};

const READING = answer({
  summary: 'You reached Dana. She asked for an overview by e-mail; you promised the pricing sheet.',
  interest: { level: 'curious', signals: [] },
  follow_up_request: { kind: 'overview_email', quote: 'Could you send me an overview by email?', line: 3 },
  commitments: [{ speaker: 'you', quote: PROMISE, line: 4, due_phrase: 'today' }],
});

describe('B-9: apply-on-click, end to end', () => {
  let fixture: AuthFixture;
  let server: IntegrationServer;
  let adminToken = '';
  let salespersonToken = '';
  let identityId = '';
  let templateVersionId = '';
  let firmId = '';
  let sessionId = '';

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

  const resultOf = (answered: { body: Record<string, unknown> }): Record<string, unknown> =>
    (answered.body['result'] ?? {}) as Record<string, unknown>;
  const count = async (sql: string, values: unknown[]): Promise<number> =>
    Number((await fixture.db.query<{ n: string }>(sql, values)).rows[0]?.n ?? 0);
  const openPendingHolds = async (): Promise<number> =>
    await count(
      `SELECT count(*)::text AS n FROM active_holds
        WHERE source_event_kind = 'call_analysis_pending' AND source_event_id = $1 AND released_at IS NULL`,
      [sessionId],
    );

  const deepgramHttp: DeepgramHttp = async () =>
    await Promise.resolve(new Response(JSON.stringify(DEEPGRAM_ANSWER), { status: 200, headers: { 'content-type': 'application/json' } }));
  const recordings: TwilioRecordingFetcher = {
    fetchRecording: async () => await Promise.resolve({ ok: true as const, contentType: 'audio/mpeg' as const, bytes: AUDIO }),
  };
  const registry = (): HandlerRegistry =>
    new HandlerRegistry().register(callTranscribeJobHandler({ provider: deepgramTranscription({ apiKey: FAKE_KEY, http: deepgramHttp }), recordings }));

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
    const { rows: template } = await fixture.db.query<{ id: string }>(
      `INSERT INTO template_versions (workspace_id, template_id, version, name, subject, body,
                                      content_hash, footer_sign_off, approved_at, approved_by_user_id)
       VALUES ($1, gen_random_uuid(), 1, 'The overview', 'A question about {firm_name}',
               'Hello {contact_first_name}.', encode(sha256(random()::text::bytea), 'hex'), 'Sam Example', now(), $2)
       RETURNING id`,
      [fixture.alpha.workspaceId, fixture.alpha.admin.userId],
    );
    templateVersionId = template[0]?.id ?? '';
    // One idle pass of a worker that can transcribe publishes it in its heartbeat; until
    // then a recording queues nothing.
    await runOnce(fixture.db, { registry: registry(), owner: 'b9-test', limit: 1 });
  });

  afterAll(async () => {
    await server.close();
    await fixture.stop();
  });

  it('1: the answered call admits the pending-review hold from its callbacks, holding e-mail at the firm', async () => {
    firmId = await seedFirm(fixture, {
      name: 'Apply Test Law',
      regionCode: 'RI',
      postalCode: '02903',
      website: 'https://www.apply-test-law.example',
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    expect((await post('/firms/resolve-zone', adminToken, command({ firmId }))).status).toBe(200);
    const contactId = await seedContact(fixture, { firmId, fullName: 'Dana Example' });
    const phone = await post(
      '/contacts/routes/add',
      salespersonToken,
      command({ firmId, contactId, routeKind: 'phone', value: '+14015550177', source: 'salesperson', technicalValidation: 'passed', associationConfidence: 0.95 }),
    );
    expect(phone.status, phone.text).toBe(200);
    const created = await post(
      '/calls/session',
      salespersonToken,
      command({ firmId, contactId, routeId: String(resultOf(phone)['id']), routeVersion: 1, callingIdentityId: identityId }),
    );
    expect(created.status, created.text).toBe(200);
    sessionId = String(resultOf(created)['sessionId']);
    const parent = `CA${randomBytes(16).toString('hex')}`;
    const child = `CA${randomBytes(16).toString('hex')}`;
    const caller = `client:${fixture.alpha.salesperson.userId}`;
    expect(await twilio('/integrations/twilio/voice', { AccountSid: server.accountSid, CallSid: parent, From: caller, Caller: caller, sessionId })).toBe(200);
    expect(
      await twilio('/integrations/twilio/status', { AccountSid: server.accountSid, CallSid: child, ParentCallSid: parent, CallStatus: 'in-progress' }),
    ).toBe(200);
    expect(
      await twilio('/integrations/twilio/status', {
        AccountSid: server.accountSid,
        CallSid: parent,
        DialCallSid: child,
        DialCallStatus: 'completed',
        DialCallDuration: '180',
      }),
    ).toBe(200);
    const recordingSid = `RE${randomBytes(16).toString('hex')}`;
    expect(
      await twilio('/integrations/twilio/recording', {
        AccountSid: server.accountSid,
        CallSid: parent,
        RecordingSid: recordingSid,
        RecordingUrl: `https://api.twilio.com/2010-04-01/Accounts/${server.accountSid}/Recordings/${recordingSid}`,
        RecordingDuration: '180',
        RecordingStatus: 'completed',
      }),
    ).toBe(200);
    expect(await openPendingHolds()).toBe(1);
    const { rows: hold } = await fixture.db.query<{ scope_key: string; blocked: string[]; recovery: string }>(
      `SELECT scope_key, blocked_action_kinds AS blocked, recovery_action AS recovery FROM active_holds
        WHERE source_event_kind = 'call_analysis_pending' AND source_event_id = $1`,
      [sessionId],
    );
    expect(hold[0]).toMatchObject({ scope_key: firmId, recovery: 'review_call' });
    expect(hold[0]?.blocked).toContain('email_send');
  });

  let shown = { analysisId: '', transcriptSha256: '', proposalHash: '', keys: [] as string[] };

  it('2–3: transcribed and analysed, the analysis is read at GET /calls/analysis', async () => {
    expect(await runOnce(fixture.db, { registry: registry(), owner: 'b9-test', limit: 5 })).toMatchObject({ claimed: 1, completed: 1 });
    const { rows: transcript } = await fixture.db.query<{ utterances: CallTranscriptUtterance[] }>(
      'SELECT utterances FROM call_transcripts WHERE call_session_id = $1',
      [sessionId],
    );
    const utterances = transcript[0]?.utterances;
    if (utterances === undefined) throw new Error('not transcribed');
    const system = repositoryContext(workspaceScope(fixture.alpha.workspaceId, { kind: 'system', component: 'worker' }), fixture.db);
    const version = await withTransaction(fixture.db, async () =>
      await createAnalysisVersion(system, { sessionId, origin: 'model', reason: 'transcript', model: 'claude-haiku-4-5-20251001' }),
    );
    if (version.kind !== 'created') throw new Error(`createAnalysisVersion: ${version.kind}`);
    const completed = await withTransaction(fixture.db, async () => {
      const policyContext = await readPolicyContext(system, sessionId);
      if (policyContext === null) throw new Error('no policy context');
      return await completeCallAnalysis(system, { analysisId: version.analysisId, rawAnswer: READING, utterances, policyContext });
    });
    expect(completed.kind, JSON.stringify(completed)).toBe('completed');

    const read = await get(`/calls/analysis?callSessionId=${sessionId}`, salespersonToken);
    expect(read.status, read.text).toBe(200);
    const authoritative = callAnalysisResponseSchema.parse(read.body).authoritative;
    if (authoritative === null) throw new Error('no authoritative analysis');
    shown = {
      analysisId: authoritative.analysisId,
      transcriptSha256: authoritative.transcriptSha256,
      proposalHash: authoritative.proposalHash,
      keys: authoritative.proposals.filter(proposal => proposal.mode === 'apply').map(proposal => proposal.key),
    };
    expect(shown.keys).toEqual(expect.arrayContaining(['outcome', 'follow_up']));
    expect(shown.keys.filter(key => key.startsWith('task:'))).toHaveLength(2);
    // Still held: nothing has been decided.
    expect(await openPendingHolds()).toBe(1);
  });

  it('3–4: one click logs, grants and writes the tasks; the same click is its receipt; a second click is call_already_logged', async () => {
    const body = command({
      analysisId: shown.analysisId,
      transcriptSha256: shown.transcriptSha256,
      proposalHash: shown.proposalHash,
      keys: shown.keys,
      edits: { follow_up: { templateVersionId } },
    });
    const first = await post('/calls/proposals/apply', salespersonToken, body);
    expect(first.status, first.text).toBe(200);
    const results = resultOf(first)['results'] as { key: string; result: string }[];
    expect(results.map(entry => entry.result).every(result => result === 'applied')).toBe(true);

    const again = await post('/calls/proposals/apply', salespersonToken, body);
    expect(again.status, again.text).toBe(200);
    expect(again.body['replayed']).toBe(true);
    expect(resultOf(again)).toEqual(resultOf(first));

    const second = await post('/calls/proposals/apply', salespersonToken, { ...body, commandId: randomUUID() });
    expect(second.status, second.text).toBe(409);
    expect(second.body).toMatchObject({ status: 'refused', reason: 'call_already_logged' });

    expect(await count('SELECT count(*)::text AS n FROM call_logs WHERE firm_id = $1', [firmId])).toBe(1);
    expect(await count('SELECT count(*)::text AS n FROM call_sessions WHERE id = $1 AND call_log_id IS NOT NULL', [sessionId])).toBe(1);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM follow_up_permissions p JOIN call_logs l ON l.id = p.call_log_id
          WHERE l.firm_id = $1 AND p.scope = 'single_email'`,
        [firmId],
      ),
    ).toBe(1);
    expect(await count("SELECT count(*)::text AS n FROM call_tasks WHERE call_session_id = $1 AND status = 'open'", [sessionId])).toBe(2);
    // Released at the log.
    expect(await openPendingHolds()).toBe(0);
  });

  it('5: Today shows the tasks only with include=tasks; completing one marks it done; Needs review lists nothing for the call', async () => {
    const plain = await post('/today/firm', salespersonToken, { firmId, cardVersion: 2 });
    expect(plain.status, plain.text).toBe(200);
    expect(todayFirmResponseSchema.parse(plain.body).tasks.some(task => task.kind === 'task')).toBe(false);

    const withTasks = await post('/today/firm', salespersonToken, { firmId, cardVersion: 2, include: ['tasks'] });
    expect(withTasks.status, withTasks.text).toBe(200);
    const tasks = todayFirmResponseSchema.parse(withTasks.body).tasks.filter(task => task.kind === 'task');
    expect(tasks.map(task => task.taskText).sort()).toEqual([PROMISE, 'Send overview to Dana Example']);
    const listed = await get('/today?include=tasks', salespersonToken);
    expect((listed.body['cards'] as { firmId: string }[]).some(card => card.firmId === firmId)).toBe(true);

    const overview = tasks.find(task => task.taskText?.startsWith('Send overview') === true);
    const done = await post('/today/tasks/complete', salespersonToken, command({ taskId: overview?.callTaskId }));
    expect(done.status, done.text).toBe(200);
    const after = todayFirmResponseSchema.parse((await post('/today/firm', salespersonToken, { firmId, cardVersion: 2, include: ['tasks'] })).body);
    expect(after.tasks.filter(task => task.kind === 'task').map(task => task.taskText)).toEqual([PROMISE]);

    const review = await get('/review', salespersonToken);
    expect(review.status, review.text).toBe(200);
    expect(JSON.stringify(review.body)).not.toContain(sessionId);
  });
});
