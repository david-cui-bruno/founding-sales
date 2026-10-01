import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consumeCallSession, createCallSession, recordCallRecording, recordCallStatus } from '@fss/domain/calls/sessions.ts';
import {
  CALL_SUMMARY_SUBJECT_KIND,
  beginCallSummary,
  ensureCallSummaryCalling,
  finishCallSummary,
  readCallSummaries,
  sweepCallSummaryReservations,
} from '@fss/domain/calls/summary.ts';
import { anthropicCallSummarizer } from '@fss/domain/calls/summaryAdapter.ts';
import { CALL_SUMMARY_PROMPT_VERSION } from '@fss/domain/calls/summaryModel.ts';
import type { AnthropicMessageResponse, AnthropicMessagesTransport } from '@fss/domain/classification/anthropicClient.ts';
import { withTransaction, type QueryResultRowLike, type SessionQueryable } from '@fss/domain/db/queryable.ts';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '@fss/domain/db/workspaceScope.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { JOB_KIND_CLASS } from '@fss/domain/jobs/jobKinds.ts';
import { enqueueJob } from '@fss/domain/jobs/jobStore.ts';
import { databaseNow } from '@fss/domain/policy/clock.ts';
import { readSpend, workspaceBusinessZone } from '@fss/domain/research/ledger.ts';
import { commitDeletion, previewDeletion } from '@fss/domain/retention/deletion.ts';
import { updateSetting } from '@fss/domain/settings/store.ts';
import { readFinishing } from '@fss/domain/settings/finishing.ts';
import { providerFunding } from '@fss/domain/settings/funding.ts';
import { CALL_SUMMARY_PROVIDER_KEY } from '@fss/domain/calls/summaryModel.ts';
import { recordingSuppressionJournal } from '@fss/domain/suppression/journal.ts';
import { seedCrm, type SeededCrm } from '@fss/domain/test/db/support/crmFixtures.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '@fss/domain/test/db/support/fixtures.ts';
import { seedPolicy, type SeededPolicy } from '@fss/domain/test/db/support/policyFixtures.ts';
import { registerHandlers } from '../src/bootstrap/main.ts';
import { callSummarizeHandlers, callSummarySource, readCallSummaryComposition } from '../src/handlers/callSummarize.ts';
import { runOnce } from '../src/runner/jobRunner.ts';
import { runSchedulerPass } from '../src/scheduler/schedulerPass.ts';

/**
 * Slice C3b: the after-call summary on the paid-call pattern, through the real runner —
 * `call.summarize` claimed, chunked and committed by `runOnce` — against the real schema:
 *
 *   * the control: one request, settled at its usage, the summary stored, owed no more;
 *   * paused while chunk 2 waits for the month → no request, released, and owed once when
 *     the switch is back on;
 *   * a provider error's estimate is committed and the next call sees the smaller headroom;
 *     a chunk 3 rolled back after its request still leaves the attempt charged;
 *   * two jobs for one call, run at once → one request;
 *   * the lifetime cap: two paid attempts per call, whatever is queued later;
 *   * an answer with no usage → the reservation's estimate, never zero;
 *   * an answer outside the schema → one more paid attempt, then the summary;
 *   * a firm deletion while a request is in flight → no summary, the attempt estimated.
 */

const UTTERANCES = [
  { speaker: 0, start: 1.1, end: 6.1, text: 'Hi, is this Marisol? This is David, calling from Callie.' },
  { speaker: 1, start: 6.9, end: 11.0, text: 'Yes, this is Marisol. Who did you say you were with?' },
  { speaker: 0, start: 11.6, end: 20.0, text: 'Callie. We make maintenance software. I will send the proposal by Friday.' },
  { speaker: 1, start: 21.0, end: 26.0, text: 'Thursday the ninth at two thirty works. Put it on the calendar.' },
];

const GOOD = JSON.stringify({
  summary:
    'You reached Marisol at the firm. She asked who you were with and you explained Callie. You promised a proposal by Friday. A demo is set for Thursday the ninth at two thirty.',
  next_steps: [
    { action: 'Send the proposal', owner: 'you', due: 'by Friday' },
    { action: 'Hold the demo', owner: null, due: 'Thursday the ninth at two thirty' },
    { action: 'Send a contract', owner: 'you', due: 'next Monday' },
  ],
  commitments: [
    { speaker: 'you', quote: 'I will send the proposal by Friday' },
    { speaker: 'them', quote: 'Put it on the calendar.' },
    { speaker: 'them', quote: 'We will sign today' },
  ],
  prompt_version: CALL_SUMMARY_PROMPT_VERSION,
});

describe('call.summarize on the paid-call pattern (slice C3b)', () => {
  let database: TestDatabase;
  let session: SessionQueryable;
  let other: SessionQueryable;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;
  let policy: SeededPolicy;
  let counter = 0;

  let mode: 'answer' | 'fail' | 'no_usage' | 'two_sentences' | 'invalid_then_answer' | 'reject_400' = 'answer';
  let delayMs = 0;
  let requests = 0;
  let onRequest: (() => Promise<void>) | null = null;
  const transport: AnthropicMessagesTransport = {
    countTokens: async () => await Promise.resolve(1),
    create: async (): Promise<AnthropicMessageResponse> => {
      requests += 1;
      if (onRequest !== null) await onRequest();
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
      if (mode === 'fail') throw new Error('socket hang up');
      if (mode === 'reject_400') {
        // The SDK's APIError shape: status, the parsed body.
        throw Object.assign(new Error('400 invalid_request_error'), {
          status: 400,
          // The canary: a transcript line quoted back in the API's message (C3 review, finding 6).
          error: { type: 'error', error: { type: 'invalid_request_error', message: "messages.0.content: near 'Yes, this is Marisol.' and Marisol unquoted" } },
        });
      }
      const usage = { input_tokens: 900, output_tokens: 300 };
      if (mode === 'no_usage') return { model: 'claude-haiku-4-5-20251001', stop_reason: 'end_turn', content: [{ type: 'text', text: GOOD }], usage: {} };
      const invalid = mode === 'two_sentences' || (mode === 'invalid_then_answer' && requests % 2 === 1);
      const text = invalid ? JSON.stringify({ ...(JSON.parse(GOOD) as object), summary: 'Too short. Two sentences.' }) : GOOD;
      return { model: 'claude-haiku-4-5-20251001', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage };
    },
  };
  const summarizer = anthropicCallSummarizer({ transport });
  const logs: { event: string; fields: Readonly<Record<string, unknown>> }[] = [];
  const options = { summarizer, model: 'claude-haiku-4-5-20251001' as const, log: (event: string, fields: Readonly<Record<string, unknown>>) => logs.push({ event, fields }) };

  const admin = (db: SessionQueryable = session): RepositoryContext =>
    repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }), db);
  const salesperson = (): RepositoryContext =>
    repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.salesperson.userId, role: 'salesperson' }),
      session,
    );
  const system = (db: SessionQueryable = session): RepositoryContext =>
    repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), db);

  async function setting(settingKey: 'call_transcription' | 'telephony_budget' | 'monthly_cash_ceiling_cents', value: unknown, db = session): Promise<void> {
    const saved = await withTransaction(db, async () => await updateSetting(admin(db), { settingKey, value }));
    if (!saved.ok) throw new Error(saved.reason);
  }
  const transcriptionOn = async (enabled: boolean, db = session): Promise<void> =>
    await setting('call_transcription', { enabled, dailyCeilingCents: 500, unitPriceMicros: 4_300 }, db);

  /** A placed, answered, recorded call with a stored two-channel transcript. */
  async function transcribedCall(): Promise<string> {
    counter += 1;
    const created = await withTransaction(session, async () =>
      await createCallSession(salesperson(), {
        firmId: crm.alpha.firmId,
        routeId: policy.alpha.phoneRouteId,
        routeVersion: policy.alpha.phoneRouteVersion,
        callingIdentityId: policy.alpha.callingIdentityId,
        deviceId: seeded.alpha.salesperson.deviceId,
        commandId: `summary-${String(counter)}`,
        configuredCallerIdE164: '+14015550100',
        at: policy.insideWindow,
      }),
    );
    if (!created.ok) throw new Error(created.reason);
    const sessionId = created.value.sessionId;
    const sid = `CA${randomBytes(16).toString('hex')}`;
    const consumed = await withTransaction(session, async () =>
      await consumeCallSession(session, {
        workspaceId: seeded.alpha.workspaceId,
        sessionId,
        callSid: sid,
        identity: `client:${seeded.alpha.salesperson.userId}`,
        at: policy.insideWindow,
      }),
    );
    if (!consumed.ok) throw new Error(consumed.reason);
    await session.query(
      "UPDATE call_sessions SET consumed_at = '2026-08-03T14:00:00Z', expires_at = GREATEST(expires_at, '2026-08-03T14:00:00Z') WHERE id = $1",
      [sessionId],
    );
    await withTransaction(session, async () => {
      await recordCallStatus(session, { callSid: sid, providerStatus: 'in-progress' });
      await recordCallStatus(session, { callSid: sid, providerStatus: 'completed', durationSeconds: 125 });
      await recordCallRecording(session, {
        callSid: sid,
        recordingSid: `RE${randomBytes(16).toString('hex')}`,
        recordingUrl: `https://api.twilio.com/2010-04-01/Accounts/AC${'a'.repeat(32)}/Recordings/RE${randomBytes(16).toString('hex')}`,
        durationSeconds: 125,
      });
    });
    await session.query(
      `INSERT INTO call_transcripts (workspace_id, call_session_id, provider, model, language, duration_seconds, utterances)
       VALUES ($1, $2, 'aws_transcribe', 'standard', 'en-US', 125, $3::jsonb)`,
      [seeded.alpha.workspaceId, sessionId, JSON.stringify(UTTERANCES)],
    );
    return sessionId;
  }

  const registry = (): HandlerRegistry => {
    const built = new HandlerRegistry();
    for (const handler of callSummarizeHandlers(options)) built.register(handler);
    return built;
  };
  async function enqueue(sessionId: string, key: string): Promise<void> {
    await withTransaction(session, async () => {
      await enqueueJob(session, {
        workspaceId: seeded.alpha.workspaceId,
        kind: 'call.summarize',
        idempotencyKey: key,
        payload: { callSessionId: sessionId },
        maxAttempts: 3,
      });
    });
  }
  async function drain(on: SessionQueryable = session, limit = 5): Promise<void> {
    for (let pass = 0; pass < 10; pass += 1) {
      const report = await runOnce(on, { registry: registry(), owner: 'summary-test', limit });
      if (report.claimed === 0) return;
    }
  }
  async function attempts(sessionId: string): Promise<{ attempt: number; state: string; cents: number; settled_cents: number }[]> {
    const { rows } = await session.query<{ attempt: number; state: string; cents: number; settled_cents: number }>(
      `SELECT attempt, state, cents, settled_cents FROM provider_reservations
        WHERE subject_kind = $1 AND subject_id = $2 ORDER BY attempt`,
      [CALL_SUMMARY_SUBJECT_KIND, sessionId],
    );
    return rows.map(row => ({ ...row, attempt: Number(row.attempt), cents: Number(row.cents), settled_cents: Number(row.settled_cents) }));
  }
  const summaryOf = async (sessionId: string) => (await readCallSummaries(system(), [sessionId])).get(sessionId);
  const monthSpent = async (): Promise<number> => {
    const zone = await workspaceBusinessZone(system());
    return (await readSpend(system(), { businessTimeZone: zone, at: await databaseNow(system()) })).monthToDateCents;
  };
  const owedFor = async (sessionId: string) =>
    (await callSummarySource({ enabled: true }).find(session, new Date().toISOString())).filter(spec => spec.payload['callSessionId'] === sessionId);

  beforeAll(async () => {
    database = await createTestDatabase();
    session = database.session;
    seeded = await seedTwoWorkspaces(session);
    crm = await seedCrm(session, seeded);
    policy = await seedPolicy(session, seeded, crm);
    await setting('telephony_budget', { dailyCeilingCents: 10_000, maxMinutesPerCall: 30, unitPriceMicros: 14_000 });
    await transcriptionOn(true);
    await setting('monthly_cash_ceiling_cents', { cents: 5000 });
    other = await database.appRuntimeSession();
  });

  afterAll(async () => {
    await database.drop();
  });

  /** One reservation's cents for this transcript: every call here is the same request. */
  let C = 0;

  it('is a bulk, chunked job registered only with the Anthropic transport', () => {
    expect(JOB_KIND_CLASS['call.summarize']).toBe('bulk');
    const none = readCallSummaryComposition(undefined, {});
    expect(none).toEqual({ options: null, problem: 'anthropic:absent' });
    const classifier = { transport, processEnabled: true };
    expect(readCallSummaryComposition(classifier, { FSS_CALL_SUMMARY_MODEL: 'claude-opus-5' }).problem).toBe('call_summary:model_unknown');
    expect(readCallSummaryComposition(classifier, {}).options?.model).toBe('claude-haiku-4-5-20251001');
    expect(readCallSummaryComposition(classifier, { FSS_CALL_SUMMARY_MODEL: 'claude-sonnet-5-5' }).options?.model).toBe('claude-sonnet-5-5');
    const composed = readCallSummaryComposition(classifier, {}).options ?? undefined;
    const registered = registerHandlers(new HandlerRegistry(), { summary: composed } as Parameters<typeof registerHandlers>[1]);
    expect(registered.get('call.summarize')?.chunked).toBe(true);
    expect(registered.get('call.summarize')?.protection).toBe('business_uniqueness');
    expect(registerHandlers(new HandlerRegistry(), {} as Parameters<typeof registerHandlers>[1]).get('call.summarize')).toBeUndefined();
  });

  it('the control: the source owes it once, one request, settled at its usage, the summary stored and verified', async () => {
    mode = 'answer';
    const id = await transcribedCall();
    const owed = await owedFor(id);
    expect(owed.map(spec => spec.idempotencyKey)).toEqual([`call-summarize:${id}`]);
    await runSchedulerPass(session, { sources: [callSummarySource({ enabled: true })], now: new Date().toISOString(), instanceKey: 'summary-test' });
    const before = requests;
    await drain();
    expect(requests - before).toBe(1);
    const rows = await attempts(id);
    expect(rows.map(row => row.state)).toEqual(['settled']);
    C = rows[0]?.cents ?? 0;
    expect(C).toBeGreaterThan(0);
    // 900 input and 300 output tokens at Haiku 4.5's $1 / $5: under a cent, rounded up to one.
    expect(rows[0]?.settled_cents).toBe(1);
    // Cash (slice C3a's funding split): it counts toward the month's cash ceiling.
    expect(providerFunding(CALL_SUMMARY_PROVIDER_KEY)).toBe('cash');
    const stored = await summaryOf(id);
    expect(stored?.summary).toMatch(/^You reached Marisol/u);
    // The invented quote is dropped; the due phrase not said on the call becomes null.
    expect(stored?.commitments).toEqual([
      { speaker: 'you', quote: 'I will send the proposal by Friday' },
      { speaker: 'them', quote: 'Put it on the calendar.' },
    ]);
    expect(stored?.nextSteps.map(step => step.due)).toEqual(['by Friday', 'Thursday the ninth at two thirty', null]);
    expect(await owedFor(id)).toEqual([]);
  });

  it('a diarized transcript (C2’s deepgram/nova-3) is never owed, and a job for it asks nothing', async () => {
    mode = 'answer';
    const id = await transcribedCall();
    await session.query("UPDATE call_transcripts SET provider = 'deepgram', model = 'nova-3' WHERE call_session_id = $1", [id]);
    expect(await owedFor(id)).toEqual([]);
    await enqueue(id, `call-summarize:${id}`);
    const before = requests;
    await drain();
    expect(requests - before).toBe(0);
    expect(await attempts(id)).toEqual([]);
    expect(await summaryOf(id)).toBeUndefined();
  });

  it('switched off before chunk 1: no reservation and no request; back on, owed once', async () => {
    mode = 'answer';
    const id = await transcribedCall();
    await transcriptionOn(false);
    expect(await owedFor(id)).toEqual([]);
    await enqueue(id, `call-summarize:${id}`);
    const before = requests;
    try {
      await drain();
      expect(requests - before).toBe(0);
      expect(await attempts(id)).toEqual([]);
    } finally {
      await transcriptionOn(true);
    }
    const owed = await owedFor(id);
    expect(owed.map(spec => spec.idempotencyKey)).toEqual([`call-summarize:${id}:r1`]);
    await runSchedulerPass(session, { sources: [callSummarySource({ enabled: true })], now: new Date().toISOString(), instanceKey: 'summary-test' });
    await drain();
    expect(requests - before).toBe(1);
    expect(await summaryOf(id)).toBeDefined();
  });

  it('paused while chunk 2 waits for the month: no request, released, and owed again once it is back on', async () => {
    mode = 'answer';
    const id = await transcribedCall();
    await enqueue(id, `call-summarize:${id}`);
    // The worker's session, with chunk 2's monthly-lock acquisition held back until the
    // turn-off has committed on another connection.
    let monthly = 0;
    const pausing: SessionQueryable = {
      query: async <Row extends QueryResultRowLike = QueryResultRowLike>(text: string, values?: readonly unknown[]) => {
        if (typeof values?.[0] === 'string' && values[0].endsWith(':monthly_cash_ceiling') && text.includes('advisory_xact_lock')) {
          monthly += 1;
          if (monthly === 2) {
            await withTransaction(other, async () => {
              await other.query("SET LOCAL lock_timeout = '2s'");
              const saved = await updateSetting(admin(other), {
                settingKey: 'call_transcription',
                value: { enabled: false, dailyCeilingCents: 500, unitPriceMicros: 4_300 },
              });
              if (!saved.ok) throw new Error(saved.reason);
            });
          }
        }
        return await session.query<Row>(text, values);
      },
    };
    const before = requests;
    try {
      for (let pass = 0; pass < 8; pass += 1) {
        const report = await runOnce(pausing, { registry: registry(), owner: 'summary-test', limit: 5 });
        if (report.claimed === 0) break;
      }
      expect(monthly).toBeGreaterThanOrEqual(2);
      expect(requests - before).toBe(0);
      expect(await attempts(id)).toEqual([{ attempt: 1, state: 'released', cents: C, settled_cents: 0 }]);
    } finally {
      await transcriptionOn(true);
    }
    const owed = await owedFor(id);
    expect(owed.map(spec => spec.idempotencyKey)).toEqual([`call-summarize:${id}:r1`]);
    await runSchedulerPass(session, { sources: [callSummarySource({ enabled: true })], now: new Date().toISOString(), instanceKey: 'summary-test' });
    await drain();
    expect(requests - before).toBe(1);
    expect((await attempts(id)).map(row => row.state)).toEqual(['released', 'settled']);
  });

  it('a provider error is charged, committed, and the next call sees the smaller headroom', async () => {
    // Both calls placed first: a placed call reserves telephony cents of its own.
    const failing = await transcribedCall();
    const next = await transcribedCall();
    const spent = await monthSpent();
    // Room for two failed attempts of one call and not one more attempt of another.
    await setting('monthly_cash_ceiling_cents', { cents: spent + 3 * C - 1 });
    try {
      mode = 'fail';
      await enqueue(failing, `call-summarize:${failing}`);
      const before = requests;
      await drain();
      expect(await attempts(failing)).toEqual([
        { attempt: 1, state: 'estimated', cents: C, settled_cents: C },
        { attempt: 2, state: 'estimated', cents: C, settled_cents: C },
      ]);
      expect(await monthSpent()).toBe(spent + 2 * C);
      expect(requests - before).toBe(2);
      mode = 'answer';
      await enqueue(next, `call-summarize:${next}`);
      await drain();
      expect(requests - before).toBe(2);
      expect(await attempts(next)).toEqual([]);
    } finally {
      await setting('monthly_cash_ceiling_cents', { cents: 5000 });
      mode = 'answer';
    }
  });

  it('a chunk 3 rolled back after its request leaves the attempt charged, and the sweep estimates it', async () => {
    mode = 'answer';
    const id = await transcribedCall();
    await enqueue(id, `call-summarize:${id}`);
    const spent = await monthSpent();
    const breaking: SessionQueryable = {
      query: async <Row extends QueryResultRowLike = QueryResultRowLike>(text: string, values?: readonly unknown[]) => {
        if (text.includes('INSERT INTO call_summaries') && values?.[1] === id) throw new Error('disk full');
        return await session.query<Row>(text, values);
      },
    };
    const before = requests;
    for (let pass = 0; pass < 8; pass += 1) {
      const report = await runOnce(breaking, { registry: registry(), owner: 'summary-test', limit: 5 });
      if (report.claimed === 0) break;
    }
    expect(requests - before).toBeGreaterThanOrEqual(1);
    const rows = await attempts(id);
    expect(rows.filter(row => row.state === 'calling' || row.state === 'estimated').length).toBe(requests - before);
    expect(await monthSpent()).toBeGreaterThanOrEqual(spent + C);
    await session.query(
      'UPDATE provider_reservations SET created_at = now() - interval \'31 minutes\' WHERE subject_kind = $1 AND subject_id = $2',
      [CALL_SUMMARY_SUBJECT_KIND, id],
    );
    await withTransaction(session, async () => await sweepCallSummaryReservations(system()));
    expect((await attempts(id)).every(row => row.state === 'estimated' && row.settled_cents === C)).toBe(true);
    expect(await summaryOf(id)).toBeUndefined();
  });

  it('two jobs for one call, run at once, make one request', async () => {
    mode = 'answer';
    const id = await transcribedCall();
    await enqueue(id, `call-summarize:${id}`);
    await enqueue(id, `call-summarize:${id}:r7`);
    delayMs = 300;
    const before = requests;
    const worker = await database.appRuntimeSession();
    try {
      await Promise.all([drain(session, 1), drain(worker, 1)]);
    } finally {
      delayMs = 0;
    }
    expect(requests - before).toBe(1);
    expect((await attempts(id)).map(row => row.state)).toEqual(['settled']);
  });

  it('the lifetime cap: two paid attempts for a call, whatever is queued later', async () => {
    mode = 'fail';
    const id = await transcribedCall();
    await enqueue(id, `call-summarize:${id}`);
    const before = requests;
    try {
      await drain();
      expect(requests - before).toBe(2);
      await enqueue(id, `call-summarize:${id}:r9`);
      await drain();
      await transcriptionOn(true);
      expect(await owedFor(id)).toEqual([]);
      expect(requests - before).toBe(2);
      expect((await attempts(id)).map(row => row.state)).toEqual(['estimated', 'estimated']);
    } finally {
      mode = 'answer';
    }
  });

  it('the lifetime cap counts paid attempts across a pause: a resumed call gets one more, never a third', async () => {
    mode = 'fail';
    const id = await transcribedCall();
    await enqueue(id, `call-summarize:${id}`);
    const before = requests;
    // The first attempt fails (charged); its retry is held by a turn-off before chunk 2 marks it.
    // The switch's final read in chunk 2 (its setting lock, SHARED): the second one is the retry's.
    let finalReads = 0;
    const pausing: SessionQueryable = {
      query: async <Row extends QueryResultRowLike = QueryResultRowLike>(text: string, values?: readonly unknown[]) => {
        if (typeof values?.[0] === 'string' && values[0].endsWith(':call_transcription') && text.includes('advisory_xact_lock_shared')) {
          finalReads += 1;
          if (finalReads === 2) await transcriptionOn(false, other);
        }
        return await session.query<Row>(text, values);
      },
    };
    try {
      for (let pass = 0; pass < 10; pass += 1) {
        const report = await runOnce(pausing, { registry: registry(), owner: 'summary-test', limit: 5 });
        if (report.claimed === 0) break;
      }
      expect(requests - before).toBe(1);
      expect((await attempts(id)).map(row => row.state)).toEqual(['estimated', 'released']);
      await transcriptionOn(true);
      const owed = await owedFor(id);
      expect(owed.map(spec => spec.idempotencyKey)).toEqual([`call-summarize:${id}:r1`]);
      // Only this call's job: earlier cases here leave other calls owed.
      await enqueue(id, owed[0]?.idempotencyKey ?? '');
      await drain();
      // One more paid attempt, which fails too; its retry is refused by the cap.
      expect(requests - before).toBe(2);
      expect((await attempts(id)).map(row => row.state)).toEqual(['estimated', 'released', 'estimated']);
      expect(await owedFor(id)).toEqual([]);
    } finally {
      mode = 'answer';
      await transcriptionOn(true);
    }
  });

  it('a 400 invalid_request is refused before generation: one request, settled at 0, no retry, the API’s words in the log', async () => {
    mode = 'reject_400';
    const id = await transcribedCall();
    await enqueue(id, `call-summarize:${id}`);
    const before = requests;
    logs.length = 0;
    try {
      await drain();
    } finally {
      mode = 'answer';
    }
    expect(requests - before).toBe(1);
    expect(await attempts(id)).toEqual([{ attempt: 1, state: 'settled', cents: C, settled_cents: 0 }]);
    expect(logs.find(line => line.event === 'call_summary_skipped' && line.fields['call_session_id'] === id)?.fields).toMatchObject({
      reason: 'provider_refused',
      provider_status: 400,
      provider_error_type: 'invalid_request_error',
      provider_parameter: 'messages.0.content',
    });
    expect(JSON.stringify(logs)).not.toContain('Marisol');
  });

  it('paused before the retry of an ambiguous attempt reserves: back on, exactly one more request, and the summary', async () => {
    mode = 'fail';
    const id = await transcribedCall();
    await enqueue(id, `call-summarize:${id}`);
    const before = requests;
    // Chunk 3 records the failed request in the ledger; the turn-off commits right then, so the
    // retry's chunk 1 reads "off" before it reserves anything.
    let paused = false;
    const pausing: SessionQueryable = {
      query: async <Row extends QueryResultRowLike = QueryResultRowLike>(text: string, values?: readonly unknown[]) => {
        const result = await session.query<Row>(text, values);
        if (!paused && text.includes('INSERT INTO provider_ledger') && text.includes('calls = provider_ledger.calls + 1')) {
          paused = true;
          await transcriptionOn(false, other);
        }
        return result;
      },
    };
    try {
      for (let pass = 0; pass < 10; pass += 1) {
        const report = await runOnce(pausing, { registry: registry(), owner: 'summary-test', limit: 5 });
        if (report.claimed === 0) break;
      }
      expect(paused).toBe(true);
      expect(requests - before).toBe(1);
      expect((await attempts(id)).map(row => row.state)).toEqual(['estimated']);
      expect(await owedFor(id)).toEqual([]);
    } finally {
      mode = 'answer';
      await transcriptionOn(true);
    }
    const owed = await owedFor(id);
    expect(owed.map(spec => spec.idempotencyKey)).toEqual([`call-summarize:${id}:r1`]);
    await enqueue(id, owed[0]?.idempotencyKey ?? '');
    await drain();
    expect(requests - before).toBe(2);
    expect((await attempts(id)).map(row => row.state)).toEqual(['estimated', 'settled']);
    expect(await summaryOf(id)).toBeDefined();
    // And nothing more after that: the call has its summary.
    await transcriptionOn(true);
    expect(await owedFor(id)).toEqual([]);
  });

  it('a summary request in flight is counted in the transcription switch’s “still finishing” line', async () => {
    mode = 'answer';
    const id = await transcribedCall();
    const worker = system(other);
    const finishing = async (): Promise<number> => (await readFinishing(system())).transcriptionFinishing;
    const base = await finishing();
    const begun = await withTransaction(other, async () => await beginCallSummary(worker, options, { sessionId: id, retry: false }));
    if (begun.kind !== 'reserved') throw new Error(begun.reason);
    expect(await finishing()).toBe(base);
    const calling = await withTransaction(other, async () => await ensureCallSummaryCalling(worker, { sessionId: id, attempt: begun.attempt }));
    if (calling.kind !== 'calling') throw new Error(calling.reason);
    expect(await finishing()).toBe(base + 1);
    await withTransaction(other, async () => await finishCallSummary(worker, options, { sessionId: id, attempt: calling.attempt, plan: calling.plan }));
    expect(await finishing()).toBe(base);
  });

  it('an answer that reports no usage settles at the reservation, never at zero', async () => {
    mode = 'no_usage';
    const id = await transcribedCall();
    await enqueue(id, `call-summarize:${id}`);
    try {
      await drain();
    } finally {
      mode = 'answer';
    }
    expect(await attempts(id)).toEqual([{ attempt: 1, state: 'estimated', cents: C, settled_cents: C }]);
    expect(await summaryOf(id)).toBeDefined();
  });

  it('an answer outside the schema is charged and retried once; the second answer is kept', async () => {
    mode = 'invalid_then_answer';
    requests = 0;
    const id = await transcribedCall();
    await enqueue(id, `call-summarize:${id}`);
    try {
      await drain();
    } finally {
      mode = 'answer';
    }
    expect(requests).toBe(2);
    expect((await attempts(id)).map(row => [row.state, row.settled_cents])).toEqual([
      ['settled', 1],
      ['settled', 1],
    ]);
    expect(await summaryOf(id)).toBeDefined();
  });

  it('two answers outside the schema: two charges, no summary, and nothing more owed', async () => {
    mode = 'two_sentences';
    const id = await transcribedCall();
    await enqueue(id, `call-summarize:${id}`);
    const before = requests;
    try {
      await drain();
    } finally {
      mode = 'answer';
    }
    expect(requests - before).toBe(2);
    expect(await summaryOf(id)).toBeUndefined();
    expect(await owedFor(id)).toEqual([]);
  });

  it('a firm deletion that commits while a request is in flight: the chunk 3 finds the session gone and stores nothing; the attempt is estimated', async () => {
    mode = 'answer';
    const kept = await transcribedCall();
    await enqueue(kept, `call-summarize:${kept}`);
    await drain();
    expect(await summaryOf(kept)).toBeDefined();
    const id = await transcribedCall();
    const worker = system(other);
    const begun = await withTransaction(other, async () => await beginCallSummary(worker, options, { sessionId: id, retry: false }));
    expect(begun.kind).toBe('reserved');
    if (begun.kind !== 'reserved') return;
    const calling = await withTransaction(other, async () => await ensureCallSummaryCalling(worker, { sessionId: id, attempt: begun.attempt }));
    expect(calling.kind).toBe('calling');
    if (calling.kind !== 'calling') return;

    // The deletion commits while the request is on the wire.
    let deleted: Promise<void> | null = null;
    onRequest = async () => {
      onRequest = null;
      const preview = await withTransaction(session, async () => await previewDeletion(admin(), { targetKind: 'firm', firmId: crm.alpha.firmId }));
      const { rows: counted } = await session.query<{ n: number }>('SELECT count(*)::int AS n FROM call_summaries WHERE workspace_id = $1', [
        seeded.alpha.workspaceId,
      ]);
      // Every summary of the firm's calls is counted in its own right (all of this file's calls are the one firm's).
      expect(preview.value?.removes['call_summaries']).toBe(counted[0]?.n);
      expect(counted[0]?.n).toBeGreaterThan(1);
      deleted = withTransaction(session, async () => {
        const outcome = await commitDeletion(admin(), {
          requestId: preview.value?.requestId ?? '',
          previewHash: preview.value?.previewHash ?? '',
          commandId: 'deletion-during-summary',
          journal: recordingSuppressionJournal(),
        });
        expect(outcome.ok, outcome.ok ? '' : outcome.reason).toBe(true);
      });
      await deleted;
    };
    const finished = await withTransaction(other, async () =>
      await finishCallSummary(worker, options, { sessionId: id, attempt: calling.attempt, plan: calling.plan }),
    );
    expect(finished).toEqual({ kind: 'done', outcome: 'session_gone' });
    expect(deleted).not.toBeNull();
    expect(await summaryOf(id)).toBeUndefined();
    expect(await summaryOf(kept)).toBeUndefined();
    expect(await attempts(id)).toEqual([{ attempt: 1, state: 'estimated', cents: C, settled_cents: C }]);
  });
});
