import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { messagesCallAnalyzer } from '@fss/domain/calls/analysisAdapter.ts';
import { postCallModelPath, sweepCallAnalysisReservations } from '@fss/domain/calls/analysisPaid.ts';
import { CALL_SUMMARY_SUBJECT_KIND, sweepCallSummaryReservations } from '@fss/domain/calls/summary.ts';
import { anthropicCallSummarizer } from '@fss/domain/calls/summaryAdapter.ts';
import { CALL_SUMMARY_PROMPT_VERSION } from '@fss/domain/calls/summaryModel.ts';
import type { AnthropicMessageResponse, AnthropicMessagesTransport } from '@fss/domain/classification/anthropicClient.ts';
import { readAppliedSchemaVersion } from '@fss/domain/db/migrationRunner.ts';
import { withTransaction, type SessionQueryable } from '@fss/domain/db/queryable.ts';
import { createTestDatabase, type TestDatabase } from '@fss/domain/db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '@fss/domain/db/workspaceScope.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { enqueueJob } from '@fss/domain/jobs/jobStore.ts';
import { updateSetting } from '@fss/domain/settings/store.ts';
import { answer } from '@fss/domain/test/calls/analysisFixtures.ts';
import { transcribedCall as placeTranscribedCall } from '@fss/domain/test/calls/support/transcribedCall.ts';
import { seedCrm, type SeededCrm } from '@fss/domain/test/db/support/crmFixtures.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '@fss/domain/test/db/support/fixtures.ts';
import { seedPolicy, type SeededPolicy } from '@fss/domain/test/db/support/policyFixtures.ts';
import { callAnalysisSource, callAnalyzeHandlers } from '../src/handlers/callAnalyze.ts';
import { callSummarizeHandlers, callSummarySource } from '../src/handlers/callSummarize.ts';
import { runOnce } from '../src/runner/jobRunner.ts';
import { runSchedulerPass } from '../src/scheduler/schedulerPass.ts';

/**
 * Slice 3a, A-7: the summary cutover over an upgrade. The rows are written at schema 34 —
 * the shapes production holds before the release — then migration 0035 is applied, and the
 * real runner, both sources and both handlers take them through a pause and a resume:
 *
 *   * a **held** legacy job (done, no summary, switched off before it reserved);
 *   * a **queued** job;
 *   * a job whose chunk 1 left a **reserved** summary reservation, and one whose chunk 2
 *     left it **calling** (both claims gone);
 *   * a **completed** summary.
 *
 * Every one of them stays on the summary path: none is ever owed an analysis, none gets an
 * analysis job or version, and the legacy source re-owes each unfinished one once the switch
 * is back on, until it has its summary. The control: a call transcribed after the release is
 * owed an analysis, gets one, and is never owed a summary.
 */

const UTTERANCES = [
  { speaker: 0, start: 1.1, end: 6.1, text: 'Hi, is this Marisol? This is David, calling from Callie.' },
  { speaker: 1, start: 6.9, end: 11.0, text: 'Yes, this is Marisol. Who did you say you were with?' },
  { speaker: 0, start: 11.6, end: 20.0, text: 'Callie. We make maintenance software. I will send the proposal by Friday.' },
  { speaker: 1, start: 21.0, end: 26.0, text: 'Thursday the ninth at two thirty works. Put it on the calendar.' },
];
const SUMMARY = JSON.stringify({
  summary: 'You reached Marisol at the firm. She asked who you were with and you explained Callie. You promised a proposal by Friday.',
  next_steps: [{ action: 'Send the proposal', owner: 'you', due: 'by Friday' }],
  commitments: [{ speaker: 'you', quote: 'I will send the proposal by Friday' }],
  prompt_version: CALL_SUMMARY_PROMPT_VERSION,
});
const ANALYSIS = answer({
  summary: 'You reached Marisol. You promised a proposal by Friday.',
  commitments: [{ speaker: 'you', quote: 'I will send the proposal by Friday', line: 3, due_phrase: 'by Friday' }],
});

describe('A-7: legacy summary work through migration 0035, a pause and a resume', () => {
  let database: TestDatabase;
  let session: SessionQueryable;
  let seeded: TwoWorkspaces;
  let crm: SeededCrm;
  let policy: SeededPolicy;
  const asked: { kind: 'summary' | 'analysis' }[] = [];

  // One transport for both models: the request's schema says which one is being asked.
  const transport: AnthropicMessagesTransport = {
    countTokens: async () => await Promise.resolve(1),
    create: async (request: Parameters<AnthropicMessagesTransport['create']>[0]): Promise<AnthropicMessageResponse> => {
      const analysis = JSON.stringify(request).includes('follow_up_request');
      asked.push({ kind: analysis ? 'analysis' : 'summary' });
      return await Promise.resolve({
        model: 'claude-haiku-4-5-20251001',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: analysis ? ANALYSIS : SUMMARY }],
        usage: { input_tokens: 900, output_tokens: 300 },
      });
    },
  };
  const registry = (): HandlerRegistry => {
    const built = new HandlerRegistry();
    for (const handler of callSummarizeHandlers({ summarizer: anthropicCallSummarizer({ transport }), model: 'claude-haiku-4-5-20251001' })) built.register(handler);
    for (const handler of callAnalyzeHandlers({ analyzer: messagesCallAnalyzer({ transport }), model: 'claude-haiku-4-5-20251001' })) built.register(handler);
    return built;
  };
  async function drain(): Promise<void> {
    for (let pass = 0; pass < 12; pass += 1) {
      if ((await runOnce(session, { registry: registry(), owner: 'cutover-test', limit: 10 })).claimed === 0) return;
    }
  }
  const admin = (): RepositoryContext =>
    repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'user', userId: seeded.alpha.admin.userId, role: 'admin' }), session);
  const system = (): RepositoryContext => repositoryContext(workspaceScope(seeded.alpha.workspaceId, { kind: 'system', component: 'worker' }), session);
  async function setting(settingKey: 'call_transcription' | 'telephony_budget' | 'monthly_cash_ceiling_cents', value: unknown): Promise<void> {
    const saved = await withTransaction(session, async () => await updateSetting(admin(), { settingKey, value }));
    if (!saved.ok) throw new Error(saved.reason);
  }
  const transcriptionOn = async (enabled: boolean): Promise<void> =>
    await setting('call_transcription', { enabled, dailyCeilingCents: 500, unitPriceMicros: 4_300 });
  const owedAnalyses = async (): Promise<string[]> =>
    (await callAnalysisSource({ enabled: true }).find(session, new Date().toISOString())).map(spec => String(spec.payload['callSessionId']));
  const owedSummaries = async (): Promise<string[]> =>
    (await callSummarySource({ enabled: true }).find(session, new Date().toISOString())).map(spec => String(spec.payload['callSessionId']));
  async function legacyJob(sessionId: string, state: 'queued' | 'done'): Promise<void> {
    await withTransaction(session, async () => {
      await enqueueJob(session, {
        workspaceId: seeded.alpha.workspaceId,
        kind: 'call.summarize',
        idempotencyKey: `call-summarize:${sessionId}`,
        payload: { callSessionId: sessionId },
        maxAttempts: 3,
      });
    });
    if (state === 'done') {
      await session.query(
        "UPDATE jobs SET state = 'done', completed_at = now() - interval '1 hour', updated_at = now() - interval '1 hour' WHERE idempotency_key = $1",
        [`call-summarize:${sessionId}`],
      );
    }
  }
  async function legacyReservation(sessionId: string, state: 'reserved' | 'calling' | 'settled'): Promise<void> {
    await session.query(
      `INSERT INTO provider_reservations
         (workspace_id, provider_key, subject_kind, subject_id, attempt, business_date, business_time_zone,
          cents, model_name, max_input_tokens, max_output_tokens, state, settled_cents, settled_at, created_at)
       VALUES ($1, 'anthropic_call_summary', 'call_summary', $2, 1, current_date, 'America/New_York',
               1, 'claude-haiku-4-5-20251001', 4000, 1500, $3, $4, $5, now() - interval '40 minutes')`,
      [seeded.alpha.workspaceId, sessionId, state, state === 'settled' ? 1 : 0, state === 'settled' ? new Date().toISOString() : null],
    );
  }
  const analysesOf = async (ids: readonly string[]): Promise<number> =>
    Number((await session.query<{ n: number }>('SELECT count(*)::int AS n FROM call_analyses WHERE call_session_id = ANY($1::uuid[])', [[...ids]])).rows[0]?.n);
  const analyzeJobsOf = async (ids: readonly string[]): Promise<number> =>
    Number(
      (await session.query<{ n: number }>("SELECT count(*)::int AS n FROM jobs WHERE kind = 'call.analyze' AND payload ->> 'callSessionId' = ANY($1::text[])", [[...ids]]))
        .rows[0]?.n,
    );
  const summarized = async (ids: readonly string[]): Promise<string[]> =>
    (await session.query<{ id: string }>('SELECT call_session_id AS id FROM call_summaries WHERE call_session_id = ANY($1::uuid[])', [[...ids]])).rows
      .map(row => row.id)
      .sort();

  const legacy = { held: '', queued: '', reserved: '', calling: '', completed: '' };
  let all: string[] = [];

  beforeAll(async () => {
    database = await createTestDatabase({ throughVersion: 34 });
    session = database.session;
    seeded = await seedTwoWorkspaces(session);
    crm = await seedCrm(session, seeded);
    policy = await seedPolicy(session, seeded, crm);
    await setting('telephony_budget', { dailyCeilingCents: 10_000, maxMinutesPerCall: 30, unitPriceMicros: 14_000 });
    await setting('monthly_cash_ceiling_cents', { cents: 5000 });
    // At schema 34: production's shapes, written before the release.
    for (const key of Object.keys(legacy) as (keyof typeof legacy)[]) legacy[key] = await placeTranscribedCall(session, { seeded, crm, policy }, UTTERANCES);
    all = Object.values(legacy);
    await legacyJob(legacy.held, 'done');
    await legacyJob(legacy.queued, 'queued');
    await legacyJob(legacy.reserved, 'queued');
    await legacyReservation(legacy.reserved, 'reserved');
    await legacyJob(legacy.calling, 'queued');
    await legacyReservation(legacy.calling, 'calling');
    await legacyJob(legacy.completed, 'done');
    await legacyReservation(legacy.completed, 'settled');
    await session.query(
      `INSERT INTO call_summaries (workspace_id, call_session_id, model, prompt_version, summary, next_steps, commitments)
       VALUES ($1, $2, 'claude-haiku-4-5-20251001', $3, 'You reached Marisol. A summary from before the release.', '[]'::jsonb, '[]'::jsonb)`,
      [seeded.alpha.workspaceId, legacy.completed, CALL_SUMMARY_PROMPT_VERSION],
    );
    const { applyMigrations } = await import('@fss/domain/db/migrationRunner.ts');
    await applyMigrations(session, { throughVersion: 35 });
  });

  afterAll(async () => {
    await database.drop();
  });

  it('after the upgrade, every legacy call is on the summary path and owed no analysis', async () => {
    expect(await readAppliedSchemaVersion(session)).toBe(35);
    for (const id of all) expect(await postCallModelPath(session, seeded.alpha.workspaceId, id), id).toBe('summary');
    await transcriptionOn(true);
    const owed = await owedAnalyses();
    expect(owed.filter(id => all.includes(id))).toEqual([]);
  });

  it('paused: the queued and stranded jobs run to a hold, the stranded reservations are swept, and nothing is analysed', async () => {
    await transcriptionOn(false);
    await drain();
    // The summary handler held the queued job; the two whose reservation is still open found it in flight.
    expect(asked).toEqual([]);
    const swept = await withTransaction(session, async () => await sweepCallSummaryReservations(system()));
    expect(swept).toMatchObject({ released: 1, estimated: 1 });
    expect(await withTransaction(session, async () => await sweepCallAnalysisReservations(system()))).toEqual({ released: 0, estimated: 0 });
    const { rows } = await session.query<{ state: string }>(
      "SELECT state FROM jobs WHERE kind = 'call.summarize' AND payload ->> 'callSessionId' = ANY($1::text[]) ORDER BY state",
      [all],
    );
    expect(rows.every(row => row.state === 'done')).toBe(true);
    expect(await analysesOf(all)).toBe(0);
    expect(await analyzeJobsOf(all)).toBe(0);
  });

  it('resumed: the legacy source re-owes each unfinished call a summary, never an analysis, until each has its summary', async () => {
    await transcriptionOn(true);
    const control = await placeTranscribedCall(session, { seeded, crm, policy }, UTTERANCES);
    const summaries = await owedSummaries();
    expect(summaries.filter(id => all.includes(id)).sort()).toEqual([legacy.calling, legacy.held, legacy.queued, legacy.reserved].sort());
    // The control is never owed a first summary; it is owed an analysis, and only it is.
    expect(summaries).not.toContain(control);
    expect((await owedAnalyses()).filter(id => all.includes(id) || id === control)).toEqual([control]);
    await runSchedulerPass(session, { sources: [callSummarySource({ enabled: true }), callAnalysisSource({ enabled: true })], now: new Date().toISOString(), instanceKey: 'cutover-test' });
    await drain();
    expect(await summarized(all)).toEqual([...all].sort());
    expect(await analysesOf(all)).toBe(0);
    expect(await analyzeJobsOf(all)).toBe(0);
    expect(await summarized([control])).toEqual([]);
    const { rows } = await session.query<{ state: string }>('SELECT state FROM call_analyses WHERE call_session_id = $1', [control]);
    expect(rows.map(row => row.state)).toEqual(['completed']);
    expect(asked.filter(entry => entry.kind === 'summary')).toHaveLength(4);
    expect(asked.filter(entry => entry.kind === 'analysis')).toHaveLength(1);
    // And then nothing more for anyone.
    await transcriptionOn(true);
    expect((await owedSummaries()).filter(id => all.includes(id) || id === control)).toEqual([]);
    expect((await owedAnalyses()).filter(id => all.includes(id) || id === control)).toEqual([]);
    const { rows: stranded } = await session.query<{ state: string }>(
      'SELECT r.state FROM provider_reservations r WHERE r.subject_kind = $1 AND r.subject_id = ANY($2::uuid[]) ORDER BY r.subject_id, r.attempt',
      [CALL_SUMMARY_SUBJECT_KIND, [legacy.reserved, legacy.calling]],
    );
    expect(stranded.map(row => row.state).sort()).toEqual(['estimated', 'released', 'settled', 'settled']);
  });
});
