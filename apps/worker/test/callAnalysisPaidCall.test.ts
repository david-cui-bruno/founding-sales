import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { completeCallAnalysis, readCallAnalysis, readPolicyContext } from '@fss/domain/calls/analysis.ts';
import { messagesCallAnalyzer } from '@fss/domain/calls/analysisAdapter.ts';
import { callAnalysisProviderKey } from '@fss/domain/calls/analysisModel.ts';
import {
  CALL_ANALYSIS_DAILY_CAP,
  CALL_ANALYSIS_SUBJECT_KIND,
  beginCallAnalysis,
  ensureCallAnalysisCalling,
  postCallModelPath,
  requestCallAnalysis,
  sweepCallAnalysisReservations,
} from '@fss/domain/calls/analysisPaid.ts';
import { beginCallSummary } from '@fss/domain/calls/summary.ts';
import type { AnthropicMessageResponse, AnthropicMessagesTransport } from '@fss/domain/classification/anthropicClient.ts';
import { withTransaction, type QueryResultRowLike, type SessionQueryable } from '@fss/domain/db/queryable.ts';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '@fss/domain/db/workspaceScope.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { JOB_KIND_CLASS } from '@fss/domain/jobs/jobKinds.ts';
import { enqueueJob } from '@fss/domain/jobs/jobStore.ts';
import { commitDeletion, previewDeletion } from '@fss/domain/retention/deletion.ts';
import { providerFunding } from '@fss/domain/settings/funding.ts';
import { updateSetting } from '@fss/domain/settings/store.ts';
import { recordingSuppressionJournal } from '@fss/domain/suppression/journal.ts';
import { answer } from '@fss/domain/test/calls/analysisFixtures.ts';
import { transcribedCall as placeTranscribedCall } from '@fss/domain/test/calls/support/transcribedCall.ts';
import { seedCrm, type SeededCrm } from '@fss/domain/test/db/support/crmFixtures.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '@fss/domain/test/db/support/fixtures.ts';
import { seedPolicy, type SeededPolicy } from '@fss/domain/test/db/support/policyFixtures.ts';
import { registerHandlers } from '../src/bootstrap/main.ts';
import { callAnalysisSource, callAnalyzeHandlers, readCallAnalysisComposition } from '../src/handlers/callAnalyze.ts';
import { callSummarySource } from '../src/handlers/callSummarize.ts';
import { runOnce } from '../src/runner/jobRunner.ts';
import { runSchedulerPass } from '../src/scheduler/schedulerPass.ts';

/**
 * Slice 3a, A-4 and A-5: the post-call analysis on the paid-call pattern, through the real
 * runner — `call.analyze` claimed, chunked and committed by `runOnce` — against the real
 * schema. Chunk 3 ends in A1's `completeCallAnalysis`; nothing here writes a version by hand.
 *
 * A-4, the money:
 *   * the control: an `analysis`-path call is owed once, one request, settled at its usage,
 *     version 1 completed with its proposals, owed no more; the summary source and the
 *     summary handler leave it alone;
 *   * a historical (summary-path) call is never owed an analysis; David's `retry` is refused
 *     and his `reanalysis` is the one way in;
 *   * the switch holds a version (pending, nothing reserved) and resumes it once per change;
 *     a turn-off while chunk 2 waits releases the reservation unsent;
 *   * two paid attempts per version, three model versions per call, forty a day;
 *   * an unreadable answer is charged and retried once; no usage is the estimate; a 400 is
 *     settled at 0 and not retried;
 *   * the sweep estimates a lost `calling` attempt and skips a call whose lock is held.
 *
 * A-5, the deletion lock: a deletion that commits while a request is in flight leaves no
 * version and the attempt estimated; a deletion waits for a chunk 3 holding
 * `call_analysis:<session>`.
 */

const UTTERANCES = [
  { speaker: 0, start: 1.1, end: 5.0, text: 'Hi Dana, this is David from Callie.' },
  { speaker: 1, start: 5.5, end: 10.0, text: "We're evaluating a couple of tools. Can you show us a demo?" },
  { speaker: 0, start: 10.5, end: 15.0, text: 'Absolutely. I will send you a calendar link today.' },
];

const GOOD = answer({
  summary: 'You reached Dana. She is evaluating tools and asked for a demo. You promised a calendar link today.',
  facts: [{ text: 'They are evaluating a couple of tools', line: 2 }],
  interest: { level: 'buying_signal', signals: [{ kind: 'demo_request', quote: 'Can you show us a demo?', line: 2 }] },
  commitments: [{ speaker: 'you', quote: 'I will send you a calendar link today', line: 3, due_phrase: 'today' }],
});

describe('call.analyze on the paid-call pattern (slice 3a, A-4 and A-5)', () => {
  let database: TestDatabase;
  let session: SessionQueryable;
  let other: SessionQueryable;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;
  let policy: SeededPolicy;

  let mode: 'answer' | 'fail' | 'no_usage' | 'unreadable_then_answer' | 'reject_400' = 'answer';
  let requests = 0;
  const transport: AnthropicMessagesTransport = {
    countTokens: async () => await Promise.resolve(1),
    create: async (): Promise<AnthropicMessageResponse> => {
      requests += 1;
      if (mode === 'fail') throw new Error('socket hang up');
      if (mode === 'reject_400') {
        throw Object.assign(new Error('400 invalid_request_error'), {
          status: 400,
          // The canary: a transcript line quoted back in the API's message.
          error: { type: 'error', error: { type: 'invalid_request_error', message: "messages.0.content: near 'Can you show us a demo?'" } },
        });
      }
      const usage = { input_tokens: 2_000, output_tokens: 600 };
      if (mode === 'no_usage') return { model: 'claude-haiku-4-5-20251001', stop_reason: 'end_turn', content: [{ type: 'text', text: GOOD }], usage: {} };
      const text = mode === 'unreadable_then_answer' && requests % 2 === 1 ? 'not json' : GOOD;
      return { model: 'claude-haiku-4-5-20251001', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage };
    },
  };
  const logs: { event: string; fields: Readonly<Record<string, unknown>> }[] = [];
  const options = {
    analyzer: messagesCallAnalyzer({ transport }),
    model: 'claude-haiku-4-5-20251001' as const,
    log: (event: string, fields: Readonly<Record<string, unknown>>) => logs.push({ event, fields }),
  };

  const admin = (db: SessionQueryable = session): RepositoryContext =>
    repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }), db);
  const salesperson = (db: SessionQueryable = session): RepositoryContext =>
    repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.salesperson.userId, role: 'salesperson' }),
      db,
    );
  const system = (db: SessionQueryable = session): RepositoryContext =>
    repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), db);

  async function setting(settingKey: 'call_transcription' | 'telephony_budget' | 'monthly_cash_ceiling_cents', value: unknown, db = session): Promise<void> {
    const saved = await withTransaction(db, async () => await updateSetting(admin(db), { settingKey, value }));
    if (!saved.ok) throw new Error(saved.reason);
  }
  const transcriptionOn = async (enabled: boolean, db = session): Promise<void> =>
    await setting('call_transcription', { enabled, dailyCeilingCents: 500, unitPriceMicros: 4_300 }, db);
  const transcribedCall = async (): Promise<string> => await placeTranscribedCall(session, { seeded, crm, policy }, UTTERANCES);

  const registry = (): HandlerRegistry => {
    const built = new HandlerRegistry();
    for (const handler of callAnalyzeHandlers(options)) built.register(handler);
    return built;
  };
  async function enqueue(sessionId: string, key: string, kind: 'call.analyze' | 'call.summarize' = 'call.analyze', reason?: string): Promise<void> {
    await withTransaction(session, async () => {
      await enqueueJob(session, {
        workspaceId: seeded.alpha.workspaceId,
        kind,
        idempotencyKey: key,
        payload: { callSessionId: sessionId, ...(reason === undefined ? {} : { reason }) },
        maxAttempts: 3,
      });
    });
  }
  async function drain(on: SessionQueryable = session): Promise<void> {
    for (let pass = 0; pass < 12; pass += 1) {
      const report = await runOnce(on, { registry: registry(), owner: 'analysis-test', limit: 5 });
      if (report.claimed === 0) return;
    }
  }
  /** Every attempt of every version of one call, oldest first. */
  async function attempts(sessionId: string): Promise<{ version: number; attempt: number; state: string; cents: number; settled_cents: number }[]> {
    const { rows } = await session.query<{ version: number; attempt: number; state: string; cents: number; settled_cents: number }>(
      `SELECT a.version, r.attempt, r.state, r.cents, r.settled_cents FROM provider_reservations r
         JOIN call_analyses a ON a.id = r.subject_id
        WHERE r.subject_kind = $1 AND a.call_session_id = $2 ORDER BY a.version, r.attempt`,
      [CALL_ANALYSIS_SUBJECT_KIND, sessionId],
    );
    return rows.map(row => ({ version: Number(row.version), attempt: Number(row.attempt), state: row.state, cents: Number(row.cents), settled_cents: Number(row.settled_cents) }));
  }
  async function versions(sessionId: string): Promise<[number, string, string, string | null][]> {
    const { rows } = await session.query<{ version: number; requested_reason: string; state: string; failure_reason: string | null }>(
      'SELECT version, requested_reason, state, failure_reason FROM call_analyses WHERE call_session_id = $1 ORDER BY version',
      [sessionId],
    );
    return rows.map(row => [Number(row.version), row.requested_reason, row.state, row.failure_reason]);
  }
  const owedFor = async (sessionId: string) =>
    (await callAnalysisSource({ enabled: true }).find(session, new Date().toISOString())).filter(spec => spec.payload['callSessionId'] === sessionId);
  const summaryOwedFor = async (sessionId: string) =>
    (await callSummarySource({ enabled: true }).find(session, new Date().toISOString())).filter(spec => spec.payload['callSessionId'] === sessionId);
  async function retry(sessionId: string, reason: 'retry' | 'reanalysis', commandId: string) {
    return await withTransaction(session, async () => await requestCallAnalysis(salesperson(), { sessionId, reason, commandId }));
  }

  async function waitsOn(blockerPid: number): Promise<boolean> {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const { rows } = await session.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_stat_activity
          WHERE pid <> pg_backend_pid() AND $1::int = ANY(pg_blocking_pids(pid))`,
        [blockerPid],
      );
      if (Number(rows[0]?.count ?? 0) > 0) return true;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return false;
  }
  const pidOf = async (db: SessionQueryable): Promise<number> => Number((await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid);

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

  /** One reservation's cents for this transcript: every request here is the same. */
  let C = 0;

  it('is a bulk, chunked job registered only with the Anthropic transport, at the deployment’s model', () => {
    expect(JOB_KIND_CLASS['call.analyze']).toBe('bulk');
    expect(readCallAnalysisComposition(undefined, {})).toEqual({ options: null, problem: 'anthropic:absent' });
    const classifier = { transport, processEnabled: true };
    expect(readCallAnalysisComposition(classifier, { FSS_CALL_ANALYSIS_MODEL: 'claude-opus-5' }).problem).toBe('call_analysis:model_unknown');
    expect(readCallAnalysisComposition(classifier, {}).options?.model).toBe('claude-haiku-4-5-20251001');
    expect(readCallAnalysisComposition(classifier, { FSS_CALL_ANALYSIS_MODEL: 'claude-sonnet-5-5' }).options?.model).toBe('claude-sonnet-5-5');
    const composed = readCallAnalysisComposition(classifier, {}).options ?? undefined;
    const registered = registerHandlers(new HandlerRegistry(), { analysis: composed } as Parameters<typeof registerHandlers>[1]);
    expect(registered.get('call.analyze')?.chunked).toBe(true);
    expect(registered.get('call.analyze')?.protection).toBe('business_uniqueness');
    expect(registerHandlers(new HandlerRegistry(), {} as Parameters<typeof registerHandlers>[1]).get('call.analyze')).toBeUndefined();
  });

  it('the control: owed once, one request, settled at its usage, version 1 completed with its proposals; the summary leaves it alone', async () => {
    mode = 'answer';
    const id = await transcribedCall();
    expect(await postCallModelPath(session, seeded.alpha.workspaceId, id)).toBe('analysis');
    expect((await owedFor(id)).map(spec => spec.idempotencyKey)).toEqual([`call-analyze:${id}`]);
    // The summary source is legacy only: a new call is never owed a first summary.
    expect(await summaryOwedFor(id)).toEqual([]);
    await runSchedulerPass(session, { sources: [callAnalysisSource({ enabled: true })], now: new Date().toISOString(), instanceKey: 'analysis-test' });
    const before = requests;
    await drain();
    expect(requests - before).toBe(1);
    const rows = await attempts(id);
    expect(rows.map(row => row.state)).toEqual(['settled']);
    C = rows[0]?.cents ?? 0;
    expect(C).toBeGreaterThan(0);
    // 2000 input and 600 output tokens at Haiku 4.5's $1 / $5: half a cent, rounded up to one.
    expect(rows[0]?.settled_cents).toBe(1);
    expect(providerFunding(callAnalysisProviderKey('anthropic'))).toBe('cash');
    expect(await versions(id)).toEqual([[1, 'transcript', 'completed', null]]);
    const read = await readCallAnalysis(salesperson(), id);
    expect(read?.authoritative?.proposals.map(proposal => proposal.key)).toEqual(expect.arrayContaining(['outcome', 'buying_signal']));
    expect(read?.current?.notes.summary).toMatch(/^You reached Dana/u);
    expect(logs.find(entry => entry.event === 'call_analysis')?.fields).toMatchObject({ version: 1, settled_cents: 1 });
    expect(JSON.stringify(logs)).not.toContain('demo');
    expect(await owedFor(id)).toEqual([]);
    // A summary job for an analysed call does nothing (the handler refuses the analysis path).
    expect(await withTransaction(session, async () => await beginCallSummary(system(), { summarizer: { summarize: async () => await Promise.reject(new Error('never')) }, model: 'claude-haiku-4-5-20251001' } as unknown as Parameters<typeof beginCallSummary>[1], { sessionId: id, retry: false }))).toEqual({
      kind: 'done',
      reason: 'not_applicable',
    });
  });

  it('a historical call (summary path) is never owed an analysis; David’s retry is refused and his reanalysis is the one way in', async () => {
    mode = 'answer';
    const id = await transcribedCall();
    await enqueue(id, `call-summarize:${id}`, 'call.summarize');
    await session.query("UPDATE jobs SET state = 'done', completed_at = now() WHERE idempotency_key = $1", [`call-summarize:${id}`]);
    expect(await postCallModelPath(session, seeded.alpha.workspaceId, id)).toBe('summary');
    expect(await owedFor(id)).toEqual([]);
    // A call.analyze job for it anyway (a stale one): skipped, nothing reserved.
    await enqueue(id, `call-analyze:${id}`);
    const before = requests;
    await drain();
    expect(requests - before).toBe(0);
    expect(await versions(id)).toEqual([]);
    expect(await retry(id, 'retry', 'historical-retry')).toEqual({ ok: false, reason: 'reanalysis_required' });
    expect(await retry(id, 'reanalysis', 'historical-reanalysis')).toEqual({ ok: true, value: { callSessionId: id, queued: true } });
    // The same command again queues nothing new.
    expect(await retry(id, 'reanalysis', 'historical-reanalysis')).toEqual({ ok: true, value: { callSessionId: id, queued: false } });
    await drain();
    expect(requests - before).toBe(1);
    expect(await versions(id)).toEqual([[1, 'reanalysis', 'completed', null]]);
    // Analysed now, so the call is on the analysis path and the legacy summary never resumes it.
    expect(await postCallModelPath(session, seeded.alpha.workspaceId, id)).toBe('analysis');
    await transcriptionOn(true);
    expect(await summaryOwedFor(id)).toEqual([]);
    expect(await owedFor(id)).toEqual([]);
  });

  it('switched off before chunk 1: the version is held, nothing reserved; back on, resumed once', async () => {
    mode = 'answer';
    const id = await transcribedCall();
    await transcriptionOn(false);
    const before = requests;
    try {
      expect(await owedFor(id)).toEqual([]);
      await enqueue(id, `call-analyze:${id}`);
      await drain();
      expect(requests - before).toBe(0);
      expect(await attempts(id)).toEqual([]);
      expect(await versions(id)).toEqual([[1, 'transcript', 'pending', null]]);
      expect(await retry(id, 'retry', 'while-held')).toEqual({ ok: false, reason: 'analysis_in_flight' });
    } finally {
      await transcriptionOn(true);
    }
    expect((await owedFor(id)).map(spec => spec.idempotencyKey)).toEqual([`call-analyze:${id}:r1`]);
    await enqueue(id, `call-analyze:${id}:r1`);
    await drain();
    expect(requests - before).toBe(1);
    expect(await versions(id)).toEqual([[1, 'transcript', 'completed', null]]);
    // Once per change: completed, so another change owes nothing.
    await transcriptionOn(true);
    expect(await owedFor(id)).toEqual([]);
  });

  it('paused while chunk 2 waits for the switch: no request, released, still pending, and resumed once it is back on', async () => {
    mode = 'answer';
    const id = await transcribedCall();
    await enqueue(id, `call-analyze:${id}`);
    // Chunk 2's read of the switch under its setting lock SHARED, held back until a turn-off
    // has committed on another connection.
    let finalReads = 0;
    const pausing: SessionQueryable = {
      query: async <Row extends QueryResultRowLike = QueryResultRowLike>(text: string, values?: readonly unknown[]) => {
        if (typeof values?.[0] === 'string' && values[0].endsWith(':call_transcription') && text.includes('advisory_xact_lock_shared')) {
          finalReads += 1;
          if (finalReads === 1) await transcriptionOn(false, other);
        }
        return await session.query<Row>(text, values);
      },
    };
    const before = requests;
    try {
      for (let pass = 0; pass < 8; pass += 1) {
        const report = await runOnce(pausing, { registry: registry(), owner: 'analysis-test', limit: 5 });
        if (report.claimed === 0) break;
      }
      expect(finalReads).toBe(1);
      expect(requests - before).toBe(0);
      expect(await attempts(id)).toEqual([{ version: 1, attempt: 1, state: 'released', cents: C, settled_cents: 0 }]);
      expect(await versions(id)).toEqual([[1, 'transcript', 'pending', null]]);
    } finally {
      await transcriptionOn(true);
    }
    expect((await owedFor(id)).map(spec => spec.idempotencyKey)).toEqual([`call-analyze:${id}:r1`]);
    await enqueue(id, `call-analyze:${id}:r1`);
    await drain();
    expect(requests - before).toBe(1);
    expect((await attempts(id)).map(row => row.state)).toEqual(['released', 'settled']);
    expect(await versions(id)).toEqual([[1, 'transcript', 'completed', null]]);
  });

  it('two paid attempts per version, three model versions per call: a failing provider costs at most six requests, whatever is asked later', async () => {
    mode = 'fail';
    const id = await transcribedCall();
    await enqueue(id, `call-analyze:${id}`);
    const before = requests;
    try {
      await drain();
      expect(requests - before).toBe(2);
      expect(await versions(id)).toEqual([[1, 'transcript', 'failed', 'provider_error']]);
      expect(await owedFor(id)).toEqual([]);
      expect(await retry(id, 'retry', 'cap-1')).toMatchObject({ ok: true });
      await drain();
      expect(await retry(id, 'retry', 'cap-2')).toMatchObject({ ok: true });
      await drain();
      expect(requests - before).toBe(6);
      // A fourth version is refused by the cap: queued, but it reserves nothing and asks nothing.
      expect(await retry(id, 'reanalysis', 'cap-3')).toMatchObject({ ok: true });
      await drain();
      expect(requests - before).toBe(6);
      expect((await versions(id)).map(([version, , state]) => [version, state])).toEqual([
        [1, 'failed'],
        [2, 'failed'],
        [3, 'failed'],
      ]);
      expect((await attempts(id)).map(row => [row.version, row.state])).toEqual([
        [1, 'estimated'],
        [1, 'estimated'],
        [2, 'estimated'],
        [2, 'estimated'],
        [3, 'estimated'],
        [3, 'estimated'],
      ]);
    } finally {
      mode = 'answer';
    }
  });

  it('an unreadable answer is charged and retried once; the second answer completes the version', async () => {
    mode = 'unreadable_then_answer';
    requests = 0;
    const id = await transcribedCall();
    await enqueue(id, `call-analyze:${id}`);
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
    expect(await versions(id)).toEqual([[1, 'transcript', 'completed', null]]);
  });

  it('an answer that reports no usage settles at the reservation, never at zero', async () => {
    mode = 'no_usage';
    const id = await transcribedCall();
    await enqueue(id, `call-analyze:${id}`);
    try {
      await drain();
    } finally {
      mode = 'answer';
    }
    expect(await attempts(id)).toEqual([{ version: 1, attempt: 1, state: 'estimated', cents: C, settled_cents: C }]);
    expect(await versions(id)).toEqual([[1, 'transcript', 'completed', null]]);
  });

  it('a 400 is refused before generation: one request, settled at 0, no retry, the version failed, and the API’s words never logged', async () => {
    mode = 'reject_400';
    const id = await transcribedCall();
    await enqueue(id, `call-analyze:${id}`);
    const before = requests;
    logs.length = 0;
    try {
      await drain();
    } finally {
      mode = 'answer';
    }
    expect(requests - before).toBe(1);
    expect(await attempts(id)).toEqual([{ version: 1, attempt: 1, state: 'settled', cents: C, settled_cents: 0 }]);
    expect(await versions(id)).toEqual([[1, 'transcript', 'failed', 'provider_error']]);
    expect(logs.find(entry => entry.event === 'call_analysis_skipped')?.fields).toMatchObject({ provider_status: 400, provider_error_type: 'invalid_request_error' });
    expect(JSON.stringify(logs)).not.toContain('demo');
  });

  it('the day’s cap: the forty-first paid attempt of a business date is refused, and the version stays pending', async () => {
    mode = 'answer';
    const template = await transcribedCall();
    await enqueue(template, `call-analyze:${template}`);
    await drain();
    const { rows: done } = await session.query<{ id: string }>("SELECT id FROM call_analyses WHERE call_session_id = $1 AND state = 'completed'", [template]);
    const analysisId = done[0]?.id ?? '';
    const { rows: counted } = await session.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM provider_reservations r
        WHERE r.subject_kind = $1 AND r.state <> 'released'
          AND r.business_date = (SELECT business_date FROM provider_reservations WHERE subject_kind = $1 AND subject_id = $2)`,
      [CALL_ANALYSIS_SUBJECT_KIND, analysisId],
    );
    const fill = CALL_ANALYSIS_DAILY_CAP - (counted[0]?.n ?? 0);
    expect(fill).toBeGreaterThan(0);
    // Copies of the template's settled row, under attempts no version uses.
    const { rows: columns } = await session.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'provider_reservations' AND column_name NOT IN ('id', 'attempt') AND is_generated = 'NEVER'",
    );
    const names = columns.map(column => column.column_name).join(', ');
    await session.query(
      `INSERT INTO provider_reservations (${names}, attempt)
       SELECT ${names}, 100 + n FROM provider_reservations, generate_series(1, $3::int) AS n WHERE subject_kind = $1 AND subject_id = $2`,
      [CALL_ANALYSIS_SUBJECT_KIND, analysisId, fill],
    );
    try {
      const id = await transcribedCall();
      const begun = await withTransaction(session, async () => await beginCallAnalysis(system(), options, { sessionId: id }));
      expect(begun).toMatchObject({ kind: 'done', reason: 'capped' });
      expect(await attempts(id)).toEqual([]);
      expect(await versions(id)).toEqual([[1, 'transcript', 'pending', null]]);
    } finally {
      await session.query('DELETE FROM provider_reservations WHERE subject_kind = $1 AND subject_id = $2 AND attempt > 100', [CALL_ANALYSIS_SUBJECT_KIND, analysisId]);
    }
  });

  it('the sweep estimates a lost calling attempt and releases a lost reserved one, half an hour on, skipping a call whose lock is held', async () => {
    mode = 'answer';
    const lost = await transcribedCall();
    const held = await transcribedCall();
    const reserve = async (sessionId: string) => {
      const begun = await withTransaction(session, async () => await beginCallAnalysis(system(), options, { sessionId }));
      if (begun.kind !== 'reserved') throw new Error(begun.reason);
      return begun;
    };
    const lostBegun = await reserve(lost);
    const calling = await withTransaction(session, async () => await ensureCallAnalysisCalling(system(), { analysisId: lostBegun.analysisId, attempt: lostBegun.attempt }));
    expect(calling.kind).toBe('calling');
    await reserve(held);
    await session.query("UPDATE provider_reservations SET created_at = now() - interval '31 minutes' WHERE subject_kind = $1 AND state IN ('reserved', 'calling')", [
      CALL_ANALYSIS_SUBJECT_KIND,
    ]);
    // A live claim holds `held`'s analysis lock: the sweep's try-lock skips it.
    await other.query('BEGIN');
    await other.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${seeded.alpha.workspaceId}:call_analysis:${held}`]);
    try {
      const swept = await withTransaction(session, async () => await sweepCallAnalysisReservations(system()));
      expect(swept).toEqual({ released: 0, estimated: 1 });
    } finally {
      await other.query('COMMIT');
    }
    expect(await attempts(lost)).toEqual([{ version: 1, attempt: 1, state: 'estimated', cents: C, settled_cents: C }]);
    expect((await attempts(held)).map(row => row.state)).toEqual(['reserved']);
    expect(await withTransaction(session, async () => await sweepCallAnalysisReservations(system()))).toEqual({ released: 1, estimated: 0 });
  });

  it('A-5: a deletion waits for a chunk 3 that holds call_analysis:<session>, then removes the version it completed', async () => {
    mode = 'answer';
    const id = await transcribedCall();
    const worker = system(other);
    const begun = await withTransaction(other, async () => await beginCallAnalysis(worker, options, { sessionId: id }));
    if (begun.kind !== 'reserved') throw new Error(begun.reason);
    const calling = await withTransaction(other, async () => await ensureCallAnalysisCalling(worker, { analysisId: begun.analysisId, attempt: begun.attempt }));
    if (calling.kind !== 'calling') throw new Error(calling.kind);
    const preview = await withTransaction(session, async () => await previewDeletion(admin(), { targetKind: 'firm', firmId: crm.alpha.firmId }));
    const { rows: counted } = await session.query<{ n: number }>('SELECT count(*)::int AS n FROM call_analyses WHERE workspace_id = $1', [seeded.alpha.workspaceId]);
    // Every version of the firm's calls is counted in its own right (all of this file's calls are the one firm's).
    expect(preview.value?.removes['call_analyses']).toBe(counted[0]?.n);
    expect(counted[0]?.n).toBeGreaterThan(1);
    // Chunk 3's transaction, open, with the version completed under its lock.
    await other.query('BEGIN');
    const policyContext = await readPolicyContext(worker, id);
    if (policyContext === null) throw new Error('no policy context');
    expect(await completeCallAnalysis(worker, { analysisId: begun.analysisId, rawAnswer: GOOD, utterances: UTTERANCES, policyContext })).toMatchObject({ kind: 'completed' });
    const blocker = await pidOf(other);
    const third = await database.appRuntimeSession();
    const deletion = withTransaction(third, async () =>
      await commitDeletion(admin(third), {
        requestId: preview.value?.requestId ?? '',
        previewHash: preview.value?.previewHash ?? '',
        commandId: 'deletion-beside-analysis',
        journal: recordingSuppressionJournal(),
      }),
    );
    try {
      expect(await waitsOn(blocker)).toBe(true);
    } finally {
      await other.query('COMMIT');
    }
    const outcome = await deletion;
    expect(outcome.ok, outcome.ok ? '' : outcome.reason).toBe(true);
    expect(await versions(id)).toEqual([]);
    // The open attempt was finalised by the deletion as the sweep does it.
    const { rows } = await session.query<{ state: string }>('SELECT state FROM provider_reservations WHERE subject_kind = $1 AND subject_id = $2', [
      CALL_ANALYSIS_SUBJECT_KIND,
      begun.analysisId,
    ]);
    expect(rows.map(row => row.state)).toEqual(['estimated']);
  });
});
