import {
  CHANNEL_LABELLED_TRANSCRIPTS,
  localParts,
  type CallAnalysisFailureReason,
  type CallAnalysisNotes,
  type CallAnalysisResult,
  type CallSummaryDto,
} from '@fss/contracts';
import type { Queryable } from '../db/queryable.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { enqueueJob } from '../jobs/jobStore.ts';
import { jobIdempotencyKey } from '../jobs/jobKinds.ts';
import { databaseNow } from '../policy/clock.ts';
import { lockMonthlySpend, recordProviderCall, workspaceBusinessZone } from '../research/ledger.ts';
import { listAttempts, markCalling, readAttempt, reserveAttempt, settleAttempt, type ReservationRow } from '../research/reservations.ts';
import { clearMonthlyCash, monthWithinCeiling } from '../settings/cashCeiling.ts';
import { providerFunding } from '../settings/funding.ts';
import { readCallTranscription } from '../settings/integrations.ts';
import { settingLockName } from '../settings/store.ts';
import { DIRECT_ROUTE, transportOfProviderKey, type ModelRoute } from '../classification/modelTransport.ts';
import { localDate } from '../src/rules/localClock.ts';
import {
  completeCallAnalysis,
  createAnalysisVersion,
  failCallAnalysis,
  lockCallAnalysis,
  lockCallAnalysisForSession,
  readPolicyContext,
  readStoredTranscript,
} from './analysis.ts';
import type { CallAnalysisAttempt, CallAnalysisOutcome, CallAnalysisPort } from './analysisAdapter.ts';
import {
  CALL_ANALYSIS_MAX_TRANSCRIPT_BYTES,
  CALL_ANALYSIS_MODEL_TABLE,
  buildCallAnalysisRequest,
  callAnalysisCeilingCents,
  callAnalysisCents,
  callAnalysisInputTokenBound,
  callAnalysisProviderKey,
  isCallAnalysisModel,
  numberedTranscriptText,
  readCallAnalysisAnswer,
  type CallAnalysisInput,
  type CallAnalysisModel,
} from './analysisModel.ts';
import type { ProviderErrorDetail } from '../classification/providerError.ts';

/**
 * The post-call analysis on the paid-call pattern (slice 3a, A2), copied from the summary's
 * (`calls/summary.ts`), with an analysis **version** as the subject.
 *
 * ## The money
 *
 * `provider_reservations`, subject `call_analysis` (0035), subject id the analysis version,
 * priced by model and tokens. `call.analyze` is chunked in three, each its own commit:
 *
 *   1. `beginCallAnalysis` — the version (a pending one, or a new one), the switch, the
 *      per-version caps (two paid attempts, six rows), the day's count
 *      (`CALL_ANALYSIS_DAILY_CAP`) under `call_analysis_budget`, the month's cash ceiling, and a
 *      reservation at the request's byte bound (one open per version,
 *      `provider_reservations_one_open_analysis`). Nothing is sent.
 *   2. `ensureCallAnalysisCalling` — the request rebuilt, the month read again, then the
 *      switch under its setting lock SHARED, held to the commit that marks `calling`.
 *   3. `finishCallAnalysis` — the request first, then the record: settled by id at the
 *      reported usage (or the estimate), then `completeCallAnalysis` in the same
 *      transaction, under the same lock. An answer that does not read, or an ambiguous
 *      failure, goes back to chunk 1 for the version's one more paid attempt; without one
 *      left, the version is `failed`.
 *
 * ## The one lock order
 *
 * firm → `call_analysis:<session>` → session KEY SHARE (`lockCallAnalysisForSession`) →
 * `call_analysis_budget` → the workspace monthly lock → rows. The deletion workflow takes the
 * analysis lock of every session it removes beside the summary lock: after the firm, before
 * the sessions' own locks (`lockAnalysesForDeletion`).
 *
 * ## Which calls
 *
 * `postCallModelPath`: a call that has any analysis version is on the `analysis` path; one
 * with a `call.summarize` job, a `call_summary` reservation or a summary is on the `summary`
 * path (every obligation started before this release finishes as a summary); any other is on
 * the `analysis` path. The `call-analyze` source admits only `analysis`-path calls; a
 * historical one reaches an analysis only by David's explicit reanalysis
 * (`requestCallAnalysis`, reason `reanalysis`).
 */

export const CALL_ANALYSIS_SUBJECT_KIND = 'call_analysis';
/** Paid attempts one version may hold: the first, and one retry of an unusable or ambiguous one. */
export const CALL_ANALYSIS_MAX_PAID_ATTEMPTS = 2;
/** Reservation rows one version may ever have, released ones included. */
export const CALL_ANALYSIS_MAX_ROWS = 6;
/** Paid analysis attempts one workspace may reserve on one business date. */
export const CALL_ANALYSIS_DAILY_CAP = 40;
/** An open analysis reservation older than this has outlived every lease that could use it. */
export const CALL_ANALYSIS_SWEEP_MINUTES = 30;
/** How long after its transcript a call is still analysed (and a held version resumed). */
export const CALL_ANALYSIS_RESUME_DAYS = 7;
/** The job's own attempts: a poison payload or a lost lease, never the provider. */
export const CALL_ANALYZE_JOB_MAX_ATTEMPTS = 3;

const subjectOf = (analysisId: string) => ({ subjectKind: CALL_ANALYSIS_SUBJECT_KIND, subjectId: analysisId }) as const;
const paidAttempts = (rows: readonly ReservationRow[]): number => rows.filter(row => row.state !== 'released').length;
const isOpen = (row: ReservationRow): boolean => row.state === 'reserved' || row.state === 'calling';

async function lockAnalysisBudget(context: RepositoryContext): Promise<void> {
  await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${context.scope.workspaceId}:call_analysis_budget`]);
}

async function reservedOn(context: RepositoryContext, businessDate: string): Promise<number> {
  const { rows } = await context.db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM provider_reservations
      WHERE workspace_id = $1 AND subject_kind = $2 AND business_date = $3::date AND state <> 'released'`,
    [context.scope.workspaceId, CALL_ANALYSIS_SUBJECT_KIND, businessDate],
  );
  return Number(rows[0]?.n ?? '0');
}

/** The transcription switch, with a ceiling above 0: the analysis is part of after-call transcription. */
async function analysesOn(context: RepositoryContext): Promise<boolean> {
  const setting = await readCallTranscription(context);
  return setting.enabled && setting.dailyCeilingCents > 0;
}

// ---------------------------------------------------------------------------
// The path
// ---------------------------------------------------------------------------

export type PostCallModelPath = 'summary' | 'analysis';

/**
 * Which post-call model a call is on (see the file note). Only model work counts: a model
 * version puts it on the analysis path; a `call.summarize` job, a summary reservation or a
 * summary on the summary path. David's notes (an `origin = 'user'` version) never decide the
 * path (review S3A2, P1): they only take display precedence.
 */
export async function postCallModelPath(db: Queryable, workspaceId: string, sessionId: string): Promise<PostCallModelPath> {
  const { rows } = await db.query<{ analysed: boolean; summarised: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM call_analyses WHERE workspace_id = $1 AND call_session_id = $2 AND origin = 'model') AS analysed,
            (EXISTS (SELECT 1 FROM jobs WHERE workspace_id = $1 AND kind = 'call.summarize' AND payload ->> 'callSessionId' = $2::text)
             OR EXISTS (SELECT 1 FROM provider_reservations
                         WHERE workspace_id = $1 AND subject_kind = 'call_summary' AND subject_id = $2)
             OR EXISTS (SELECT 1 FROM call_summaries WHERE workspace_id = $1 AND call_session_id = $2)) AS summarised`,
    [workspaceId, sessionId],
  );
  const row = rows[0];
  if (row?.analysed === true) return 'analysis';
  return row?.summarised === true ? 'summary' : 'analysis';
}

// ---------------------------------------------------------------------------
// The version and its request
// ---------------------------------------------------------------------------

interface PendingVersion {
  readonly id: string;
  readonly version: number;
  readonly requestedReason: string;
  readonly transcriptSha256: string;
}

async function pendingVersionOf(context: RepositoryContext, sessionId: string): Promise<PendingVersion | null> {
  const { rows } = await context.db.query<{ id: string; version: number; requested_reason: string; transcript_sha256: string }>(
    `SELECT id, version, requested_reason, transcript_sha256 FROM call_analyses
      WHERE workspace_id = $1 AND call_session_id = $2 AND origin = 'model' AND state = 'pending'`,
    [context.scope.workspaceId, sessionId],
  );
  const row = rows[0];
  return row === undefined
    ? null
    : { id: row.id, version: row.version, requestedReason: row.requested_reason, transcriptSha256: row.transcript_sha256 };
}

async function versionSession(context: RepositoryContext, analysisId: string): Promise<string | null> {
  const { rows } = await context.db.query<{ call_session_id: string }>(
    'SELECT call_session_id FROM call_analyses WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, analysisId],
  );
  return rows[0]?.call_session_id ?? null;
}

type Prepared = { readonly kind: 'ready'; readonly call: CallAnalysisInput } | { readonly kind: 'fail'; readonly reason: CallAnalysisFailureReason };

/** The request's input for a pending version: its own transcript revision, or why not. */
async function prepare(context: RepositoryContext, sessionId: string, pending: PendingVersion): Promise<Prepared> {
  const transcript = await readStoredTranscript(context, sessionId);
  if (transcript === null || transcript.utterances.length === 0) return { kind: 'fail', reason: 'transcript_missing' };
  if (!transcript.channelLabelled) return { kind: 'fail', reason: 'not_channel_labelled' };
  if (transcript.sha256 !== pending.transcriptSha256) return { kind: 'fail', reason: 'transcript_changed' };
  if (Buffer.byteLength(numberedTranscriptText(transcript.utterances), 'utf8') > CALL_ANALYSIS_MAX_TRANSCRIPT_BYTES) {
    return { kind: 'fail', reason: 'transcript_too_long' };
  }
  const { rows } = await context.db.query<{ firm_name: string; contact_name: string | null; started: Date; time_zone: string | null }>(
    `SELECT f.name AS firm_name, c.full_name AS contact_name, coalesce(s.answered_at, s.started_at, s.created_at) AS started, f.time_zone
       FROM call_sessions s
       JOIN firms f ON f.workspace_id = s.workspace_id AND f.id = s.firm_id
       LEFT JOIN contacts c ON c.workspace_id = s.workspace_id AND c.id = s.contact_id
      WHERE s.workspace_id = $1 AND s.id = $2`,
    [context.scope.workspaceId, sessionId],
  );
  const row = rows[0];
  if (row === undefined) return { kind: 'fail', reason: 'transcript_missing' };
  return {
    kind: 'ready',
    call: {
      firmName: row.firm_name,
      contactName: row.contact_name,
      callLocalTime: row.time_zone === null ? null : callLocalTimeOf(row.started.toISOString(), row.time_zone),
      utterances: transcript.utterances,
    },
  };
}

const WEEKDAY_WORDS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** `Monday 2026-10-05 10:15`: the call's start as the model reads "tomorrow" against. */
export function callLocalTimeOf(instant: string, zone: string): string | null {
  try {
    const parts = localParts(instant, zone);
    return `${WEEKDAY_WORDS[parts.weekday] ?? ''} ${parts.date} ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Chunk 1
// ---------------------------------------------------------------------------

export interface CallAnalysisDeps {
  readonly analyzer: CallAnalysisPort;
  /** The deployment's model (`FSS_CALL_ANALYSIS_MODEL`); Haiku 4.5 unless set. */
  readonly model: CallAnalysisModel;
  /** Which transport carries each model (slice BR1); absent is every model through the direct API. */
  readonly route?: ModelRoute | undefined;
}

export type AnalysisSkip =
  | 'session_gone'
  | 'summary_path'
  | 'already_analyzed'
  | 'disabled'
  | 'capped'
  | 'in_flight'
  | 'not_applicable'
  | 'failed';

export type BeginAnalysisOutcome =
  | { readonly kind: 'reserved'; readonly analysisId: string; readonly attempt: number }
  | { readonly kind: 'done'; readonly reason: AnalysisSkip; readonly analysisId?: string | undefined };

/**
 * Chunk 1. A pending version is used as it is (a held one, or one David's retry made);
 * without one, a call on the `analysis` path with no model version yet gets its first.
 * The switch holds a version (it stays pending, with no reservation), and resumes it once
 * per change of the setting (`listOwedAnalyses`).
 */
export async function beginCallAnalysis(
  context: RepositoryContext,
  deps: Pick<CallAnalysisDeps, 'model' | 'route'>,
  input: {
    readonly sessionId: string;
    readonly reason?: 'transcript' | 'retry' | 'reanalysis' | undefined;
    /** The held version this job was queued for (a resume sweep, or David's retry of it). */
    readonly analysisId?: string | undefined;
  },
): Promise<BeginAnalysisOutcome> {
  const locked = await lockCallAnalysisForSession(context, input.sessionId);
  if (locked === null) return { kind: 'done', reason: 'session_gone' };
  let pending = await pendingVersionOf(context, input.sessionId);
  // A job for a named version is a no-op once that version is no longer pending (completed,
  // failed or replaced), whatever order its jobs ran in (review S3A2F): no second purchase.
  if (input.analysisId !== undefined && pending?.id !== input.analysisId) {
    return { kind: 'done', reason: 'not_applicable', analysisId: input.analysisId };
  }
  const path = await postCallModelPath(context.db, context.scope.workspaceId, input.sessionId);

  if (pending === null) {
    const requested = input.reason ?? 'transcript';
    if (path === 'summary' && requested !== 'reanalysis') return { kind: 'done', reason: 'summary_path' };
    if (requested !== 'reanalysis') {
      // The first reading once only; and a plain retry after a success is no new version
      // (enforced here as well as in the route, S3A2F): only a reanalysis reads again.
      const transcript = await readStoredTranscript(context, input.sessionId);
      const { rows } = await context.db.query(
        requested === 'transcript'
          ? "SELECT 1 FROM call_analyses WHERE workspace_id = $1 AND call_session_id = $2 AND origin = 'model'"
          : `SELECT 1 FROM call_analyses WHERE workspace_id = $1 AND call_session_id = $2 AND origin = 'model'
               AND state = 'completed' AND transcript_sha256 = $3`,
        requested === 'transcript'
          ? [context.scope.workspaceId, input.sessionId]
          : [context.scope.workspaceId, input.sessionId, transcript?.sha256 ?? ''],
      );
      if (rows.length > 0) return { kind: 'done', reason: 'already_analyzed' };
    }
    // Created even while the switch is off: a version the switch holds is pending, and a
    // write that turns the switch on resumes it (`call-analyze-sweep`).
    const created = await createAnalysisVersion(context, { sessionId: input.sessionId, origin: 'model', reason: requested, model: deps.model });
    if (created.kind === 'capped') return { kind: 'done', reason: 'capped' };
    if (created.kind !== 'created' && created.kind !== 'in_flight') return { kind: 'done', reason: 'not_applicable' };
    pending = await pendingVersionOf(context, input.sessionId);
    if (pending === null) return { kind: 'done', reason: 'not_applicable' };
  } else if (path === 'summary' && pending.requestedReason !== 'reanalysis') {
    return { kind: 'done', reason: 'summary_path', analysisId: pending.id };
  }

  const rows = await listAttempts(context, subjectOf(pending.id));
  if (rows.some(isOpen)) return { kind: 'done', reason: 'in_flight', analysisId: pending.id };
  if (!(await analysesOn(context))) return { kind: 'done', reason: 'disabled', analysisId: pending.id };
  if (paidAttempts(rows) >= CALL_ANALYSIS_MAX_PAID_ATTEMPTS || rows.length >= CALL_ANALYSIS_MAX_ROWS) {
    await failCallAnalysis(context, { analysisId: pending.id, reason: 'budget_exhausted' });
    return { kind: 'done', reason: 'failed', analysisId: pending.id };
  }
  const prepared = await prepare(context, input.sessionId, pending);
  if (prepared.kind === 'fail') {
    await failCallAnalysis(context, { analysisId: pending.id, reason: prepared.reason });
    return { kind: 'done', reason: 'failed', analysisId: pending.id };
  }

  // The one lock order: the call's analysis (held), the analysis budget, then the month.
  await lockAnalysisBudget(context);
  const at = await databaseNow(context);
  const zone = await workspaceBusinessZone(context);
  if ((await reservedOn(context, localDate(at, zone))) >= CALL_ANALYSIS_DAILY_CAP) return { kind: 'done', reason: 'capped', analysisId: pending.id };
  const maxOutputTokens = CALL_ANALYSIS_MODEL_TABLE[deps.model].maxOutputTokens;
  const request = buildCallAnalysisRequest({ model: deps.model, maxOutputTokens, call: prepared.call });
  const maxInputTokens = callAnalysisInputTokenBound(request);
  const transport = (deps.route ?? DIRECT_ROUTE)(deps.model);
  if (transport === null) return { kind: 'done', reason: 'disabled', analysisId: pending.id };
  const providerKey = callAnalysisProviderKey(transport);
  const cents = callAnalysisCeilingCents(deps.model, maxInputTokens, maxOutputTokens, transport);
  // The month's cash ceiling is for cash: a credit-funded analysis is not cleared against it.
  if (providerFunding(providerKey) === 'cash' && !(await clearMonthlyCash(context, { at, zone, cents }))) {
    return { kind: 'done', reason: 'capped', analysisId: pending.id };
  }
  const attempt = rows.reduce((highest, row) => Math.max(highest, row.attempt), 0) + 1;
  await reserveAttempt(context, {
    providerKey,
    ...subjectOf(pending.id),
    attempt,
    at,
    businessTimeZone: zone,
    cents,
    modelName: deps.model,
    maxInputTokens,
    maxOutputTokens,
  });
  return { kind: 'reserved', analysisId: pending.id, attempt };
}

// ---------------------------------------------------------------------------
// Chunk 2
// ---------------------------------------------------------------------------

export interface CallAnalysisPlan {
  readonly analysisId: string;
  readonly model: CallAnalysisModel;
  readonly maxOutputTokens: number;
  readonly call: CallAnalysisInput;
}

export type EnsureAnalysisOutcome =
  | { readonly kind: 'calling'; readonly attempt: number; readonly plan: CallAnalysisPlan }
  | { readonly kind: 'retry' }
  | { readonly kind: 'done'; readonly reason: AnalysisSkip | 'not_reserved' };

export async function ensureCallAnalysisCalling(
  context: RepositoryContext,
  input: { readonly analysisId: string; readonly attempt: number },
  deps: Pick<CallAnalysisDeps, 'route'> = {},
): Promise<EnsureAnalysisOutcome> {
  const sessionId = await versionSession(context, input.analysisId);
  if (sessionId === null || (await lockCallAnalysisForSession(context, sessionId)) === null) return { kind: 'done', reason: 'session_gone' };
  const row = await readAttempt(context, { ...subjectOf(input.analysisId), attempt: input.attempt });
  if (row === null || row.state !== 'reserved') return { kind: 'done', reason: 'not_reserved' };
  const release = async (): Promise<void> => {
    await settleAttempt(context, { reservationId: row.id, at: await databaseNow(context), outcome: { kind: 'released' } });
  };
  const route = (deps.route ?? DIRECT_ROUTE)(row.modelName);
  if (route === null || row.providerKey !== callAnalysisProviderKey(route)) {
    await release();
    return { kind: 'retry' };
  }
  const pending = await pendingVersionOf(context, sessionId);
  if (pending === null || pending.id !== input.analysisId) {
    await release();
    return { kind: 'done', reason: 'not_applicable' };
  }
  const prepared = await prepare(context, sessionId, pending);
  if (prepared.kind === 'fail' || !isCallAnalysisModel(row.modelName)) {
    await release();
    if (prepared.kind === 'fail') await failCallAnalysis(context, { analysisId: pending.id, reason: prepared.reason });
    return { kind: 'done', reason: 'failed' };
  }
  const plan: CallAnalysisPlan = { analysisId: pending.id, model: row.modelName, maxOutputTokens: row.maxOutputTokens, call: prepared.call };
  if (callAnalysisInputTokenBound(buildCallAnalysisRequest(plan)) > row.maxInputTokens) {
    await release();
    return { kind: 'done', reason: 'not_applicable' };
  }
  const at = await databaseNow(context);
  const zone = await workspaceBusinessZone(context);
  const withinMonth = providerFunding(row.providerKey) === 'cash' ? await monthWithinCeiling(context, { at, zone }) : true;
  // The switch's own setting lock, SHARED, held to the commit that marks `calling`.
  await context.db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [
    settingLockName(context.scope.workspaceId, 'call_transcription'),
  ]);
  if (!(await analysesOn(context))) {
    await release();
    return { kind: 'done', reason: 'disabled' };
  }
  if (!withinMonth) {
    await release();
    return { kind: 'done', reason: 'capped' };
  }
  if (!(await markCalling(context, row.id))) return { kind: 'done', reason: 'not_reserved' };
  return { kind: 'calling', attempt: input.attempt, plan };
}

// ---------------------------------------------------------------------------
// Chunk 3
// ---------------------------------------------------------------------------

export type FinishAnalysisOutcome =
  | { readonly kind: 'completed'; readonly settledCents: number; readonly proposals: number; readonly dropped: number; readonly version: number }
  | { readonly kind: 'retry'; readonly outcome: CallAnalysisOutcome | 'unreadable'; readonly provider?: ProviderErrorDetail | undefined }
  | {
      readonly kind: 'done';
      readonly outcome: CallAnalysisOutcome | 'unreadable' | 'session_gone' | 'not_pending' | 'failed';
      readonly failure?: CallAnalysisFailureReason | undefined;
      readonly provider?: ProviderErrorDetail | undefined;
    };

const FAILURE_OF: Readonly<Record<CallAnalysisOutcome, CallAnalysisFailureReason>> = Object.freeze({
  answered: 'schema_invalid',
  refusal: 'refused',
  malformed: 'malformed',
  provider_refused: 'provider_error',
  provider_error: 'provider_error',
});

export async function finishCallAnalysis(
  context: RepositoryContext,
  deps: Pick<CallAnalysisDeps, 'analyzer'>,
  input: { readonly analysisId: string; readonly attempt: number; readonly plan: CallAnalysisPlan },
): Promise<FinishAnalysisOutcome> {
  let attempt: CallAnalysisAttempt;
  try {
    attempt = await deps.analyzer.analyze(input.plan);
  } catch {
    attempt = { outcome: 'provider_error', usage: null, text: null, answeredBy: null };
  }

  const sessionId = await versionSession(context, input.analysisId);
  const locked = sessionId === null ? null : await lockCallAnalysisForSession(context, sessionId);
  await lockMonthlySpend(context);
  const row = await readAttempt(context, { ...subjectOf(input.analysisId), attempt: input.attempt });
  const at = await databaseNow(context);
  let settledCents = 0;
  if (row !== null) {
    const settled = await settleAttempt(context, {
      reservationId: row.id,
      at,
      outcome:
        attempt.outcome === 'provider_refused'
          ? { kind: 'settled', cents: 0 }
          : attempt.usage === null
            ? { kind: 'estimated' }
            : { kind: 'settled', cents: callAnalysisCents(input.plan.model, attempt.usage, transportOfProviderKey(row.providerKey)) },
    });
    settledCents = settled?.recordedCents ?? 0;
    await recordProviderCall(context, {
      providerKey: row.providerKey,
      at,
      businessTimeZone: row.businessTimeZone,
      costCents: 0,
      ...(attempt.outcome === 'answered' ? {} : { failureCode: attempt.outcome }),
    });
  }
  if (sessionId === null || locked === null) return { kind: 'done', outcome: 'session_gone' };

  // An answer that does not read is billed and unusable: like an ambiguous failure, one more
  // paid attempt of this version is allowed. Read here only to decide; the version's own
  // completion reads it again under the same lock.
  const readable = attempt.outcome === 'answered' && attempt.text !== null && readCallAnalysisAnswer(attempt.text, input.plan.call.utterances).ok;
  const provider = attempt.provider === undefined ? {} : { provider: attempt.provider };
  if (!readable) {
    const outcome = attempt.outcome === 'answered' ? ('unreadable' as const) : attempt.outcome;
    const retryable = outcome === 'unreadable' || outcome === 'malformed' || outcome === 'provider_error';
    if (retryable) {
      const rows = await listAttempts(context, subjectOf(input.analysisId));
      if (paidAttempts(rows) < CALL_ANALYSIS_MAX_PAID_ATTEMPTS && rows.length < CALL_ANALYSIS_MAX_ROWS) {
        return { kind: 'retry', outcome, ...provider };
      }
    }
    const failure: CallAnalysisFailureReason =
      attempt.outcome === 'answered' && attempt.text !== null
        ? (() => {
            const read = readCallAnalysisAnswer(attempt.text, input.plan.call.utterances);
            return read.ok ? 'schema_invalid' : read.failure;
          })()
        : FAILURE_OF[attempt.outcome];
    const failed = await failCallAnalysis(context, { analysisId: input.analysisId, reason: failure });
    return { kind: 'done', outcome: failed.kind === 'failed' ? 'failed' : 'not_pending', failure, ...provider };
  }

  const policyContext = await readPolicyContext(context, sessionId);
  if (policyContext === null || attempt.text === null) return { kind: 'done', outcome: 'session_gone' };
  const completed = await completeCallAnalysis(context, {
    analysisId: input.analysisId,
    rawAnswer: attempt.text,
    utterances: input.plan.call.utterances,
    policyContext,
    answeredBy: attempt.answeredBy ?? undefined,
  });
  if (completed.kind === 'completed') {
    return { kind: 'completed', settledCents, proposals: completed.proposals, dropped: completed.dropped, version: completed.version };
  }
  if (completed.kind === 'failed') return { kind: 'done', outcome: 'failed', failure: completed.reason };
  return { kind: 'done', outcome: completed.kind === 'gone' ? 'session_gone' : 'not_pending' };
}

/** A `calling` attempt this job marked under an earlier claim: the request may have gone, so it is estimated. */
export async function estimateAbandonedAnalysis(
  context: RepositoryContext,
  input: { readonly analysisId: string; readonly attempt: number },
): Promise<void> {
  const sessionId = await versionSession(context, input.analysisId);
  if (sessionId !== null) await lockCallAnalysisForSession(context, sessionId);
  await lockMonthlySpend(context);
  const row = await readAttempt(context, { ...subjectOf(input.analysisId), attempt: input.attempt });
  if (row !== null && row.state === 'calling') {
    await settleAttempt(context, { reservationId: row.id, at: await databaseNow(context), outcome: { kind: 'estimated' } });
  }
}

/** An attempt this claim marked and does not hold the request for: it was not sent. */
export async function releaseUnsentAnalysis(
  context: RepositoryContext,
  input: { readonly analysisId: string; readonly attempt: number },
): Promise<void> {
  const sessionId = await versionSession(context, input.analysisId);
  if (sessionId !== null) await lockCallAnalysisForSession(context, sessionId);
  const row = await readAttempt(context, { ...subjectOf(input.analysisId), attempt: input.attempt });
  if (row !== null && row.state === 'calling') {
    await settleAttempt(context, { reservationId: row.id, at: await databaseNow(context), outcome: { kind: 'released_not_called' } });
  }
}

// ---------------------------------------------------------------------------
// The sweep and the deletion step
// ---------------------------------------------------------------------------

async function tryLockAnalysis(context: RepositoryContext, sessionId: string): Promise<boolean> {
  const { rows } = await context.db.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked', [
    `${context.scope.workspaceId}:call_analysis:${sessionId}`,
  ]);
  return rows[0]?.locked === true;
}

/**
 * Finalise analysis reservations whose claim is gone, `CALL_ANALYSIS_SWEEP_MINUTES` after they
 * were written: `reserved` released, `calling` estimated. A call whose analysis lock a live
 * claim holds is skipped (a try-lock, which never waits).
 */
export async function sweepCallAnalysisReservations(
  context: RepositoryContext,
): Promise<{ readonly released: number; readonly estimated: number }> {
  const { rows } = await context.db.query<{ id: string; state: string; call_session_id: string | null }>(
    `SELECT r.id, r.state, a.call_session_id FROM provider_reservations r
       LEFT JOIN call_analyses a ON a.workspace_id = r.workspace_id AND a.id = r.subject_id
      WHERE r.workspace_id = $1 AND r.subject_kind = $2 AND r.state IN ('reserved', 'calling')
        AND r.created_at + make_interval(mins => $3) <= now()
      ORDER BY a.call_session_id, r.id`,
    [context.scope.workspaceId, CALL_ANALYSIS_SUBJECT_KIND, CALL_ANALYSIS_SWEEP_MINUTES],
  );
  let released = 0;
  let estimated = 0;
  const at = new Date().toISOString();
  for (const row of rows) {
    if (row.call_session_id !== null && !(await tryLockAnalysis(context, row.call_session_id))) continue;
    const outcome = row.state === 'calling' ? ({ kind: 'estimated' } as const) : ({ kind: 'released' } as const);
    if ((await settleAttempt(context, { reservationId: row.id, at, outcome })) === null) continue;
    if (row.state === 'calling') estimated += 1;
    else released += 1;
  }
  return { released, estimated };
}

export async function workspacesOwingAnalysisSweep(db: Queryable): Promise<readonly string[]> {
  const { rows } = await db.query<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id FROM provider_reservations
      WHERE subject_kind = $1 AND state IN ('reserved', 'calling')
        AND created_at + make_interval(mins => $2) <= now()
      ORDER BY workspace_id`,
    [CALL_ANALYSIS_SUBJECT_KIND, CALL_ANALYSIS_SWEEP_MINUTES],
  );
  return rows.map(row => row.workspace_id);
}

/**
 * The deletion workflow's lock on the analyses of the sessions it is about to remove: each
 * one's `call_analysis:<session>` lock, in id order, beside the summary locks — after the
 * firm and before the sessions' own locks and rows. A chunk 3 mid-request waits for the
 * deletion and then finds the session gone; one holding the lock finishes first.
 */
export async function lockAnalysesForDeletion(context: RepositoryContext, sessionIds: readonly string[]): Promise<void> {
  for (const sessionId of [...new Set(sessionIds)].sort()) await lockCallAnalysis(context, sessionId);
}

/**
 * The deletion workflow's step for the sessions it removes, under the locks above and the
 * monthly lock: the open attempts of their analysis versions finalised as the sweep does it.
 * The versions themselves go with their sessions (ON DELETE CASCADE).
 */
export async function finaliseAnalysesOfSessions(context: RepositoryContext, sessionIds: readonly string[], at: string): Promise<void> {
  if (sessionIds.length === 0) return;
  const { rows } = await context.db.query<{ id: string; state: string }>(
    `SELECT r.id, r.state FROM provider_reservations r
       JOIN call_analyses a ON a.workspace_id = r.workspace_id AND a.id = r.subject_id
      WHERE r.workspace_id = $1 AND r.subject_kind = $2 AND r.state IN ('reserved', 'calling')
        AND a.call_session_id = ANY($3::uuid[])
      ORDER BY a.call_session_id, r.id`,
    [context.scope.workspaceId, CALL_ANALYSIS_SUBJECT_KIND, [...new Set(sessionIds)]],
  );
  for (const row of rows) {
    await settleAttempt(context, { reservationId: row.id, at, outcome: row.state === 'calling' ? { kind: 'estimated' } : { kind: 'released' } });
  }
}

// ---------------------------------------------------------------------------
// Discovery: the job source's query
// ---------------------------------------------------------------------------

export interface OwedAnalysis {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly revision: number;
}

/**
 * Calls owed a first analysis, for the `call-analyze` source: a channel-labelled transcript
 * of the last `CALL_ANALYSIS_RESUME_DAYS`, the transcription switch on, on the `analysis`
 * path (no model version — David's notes do not count — and no summarize job, `call_summary`
 * reservation or summary) and with no `call.analyze` job yet. That is all it finds: a held
 * version is never re-offered here (review S3A2F). It resumes only on an explicit trigger —
 * a write that turns the switch on or raises the cash ceiling (`listResumeSweeps`), or David's
 * Retry.
 */
export async function listOwedAnalyses(db: Queryable, limit = 50): Promise<readonly OwedAnalysis[]> {
  const { rows } = await db.query<{ workspace_id: string; session_id: string }>(
    `SELECT t.workspace_id, t.call_session_id AS session_id
       FROM call_transcripts t
       JOIN workspace_settings s
         ON s.workspace_id = t.workspace_id AND s.setting_key = 'call_transcription' AND s.superseded_at IS NULL
      WHERE t.created_at > now() - make_interval(days => $1)
        AND t.provider || '/' || t.model = ANY($3::text[])
        AND (s.value ->> 'enabled')::boolean AND (s.value ->> 'dailyCeilingCents')::integer > 0
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.workspace_id = t.workspace_id AND j.kind = 'call.analyze'
                         AND j.payload ->> 'callSessionId' = t.call_session_id::text)
        AND NOT EXISTS (SELECT 1 FROM call_analyses a WHERE a.workspace_id = t.workspace_id AND a.call_session_id = t.call_session_id
                         AND a.origin = 'model')
        AND NOT EXISTS (SELECT 1 FROM jobs x WHERE x.workspace_id = t.workspace_id AND x.kind = 'call.summarize'
                         AND x.payload ->> 'callSessionId' = t.call_session_id::text)
        AND NOT EXISTS (SELECT 1 FROM provider_reservations r WHERE r.workspace_id = t.workspace_id
                         AND r.subject_kind = 'call_summary' AND r.subject_id = t.call_session_id)
        AND NOT EXISTS (SELECT 1 FROM call_summaries x WHERE x.workspace_id = t.workspace_id AND x.call_session_id = t.call_session_id)
      ORDER BY t.created_at, t.workspace_id, t.call_session_id
      LIMIT $2`,
    [CALL_ANALYSIS_RESUME_DAYS, limit, [...CHANNEL_LABELLED_TRANSCRIPTS]],
  );
  return rows.map(row => ({ workspaceId: row.workspace_id, sessionId: row.session_id, revision: 0 }));
}

// ---------------------------------------------------------------------------
// Explicit resumption: a settings write, swept once
// ---------------------------------------------------------------------------

/** How far back the sweep source looks for a qualifying write (each is swept once, by its own key). */
export const CALL_ANALYSIS_SWEEP_WRITE_DAYS = 2;

export interface ResumeSweep {
  readonly workspaceId: string;
  /** The `workspace_settings` row the write created: the sweep's identity, never reused. */
  readonly writeId: string;
}

/**
 * The writes that resume held analyses, for the `call-analyze-sweep` source: a write that
 * turned `call_transcription` on (on, with a ceiling above 0, where the version before was
 * not), or one that raised `monthly_cash_ceiling_cents`. Each write is one sweep job, keyed
 * by its own row id (`jobIdempotencyKey.callAnalyzeSweep`), so it is swept exactly once and its
 * key collides with nothing archived.
 */
export async function listResumeSweeps(db: Queryable, limit = 50): Promise<readonly ResumeSweep[]> {
  const { rows } = await db.query<{ workspace_id: string; id: string }>(
    `SELECT n.workspace_id, n.id
       FROM workspace_settings n
       LEFT JOIN workspace_settings p
         ON p.workspace_id = n.workspace_id AND p.setting_key = n.setting_key AND p.version = n.version - 1
      WHERE n.changed_at > now() - make_interval(days => $1)
        AND (
          (n.setting_key = 'call_transcription'
            AND (n.value ->> 'enabled')::boolean AND (n.value ->> 'dailyCeilingCents')::integer > 0
            AND NOT coalesce((p.value ->> 'enabled')::boolean AND (p.value ->> 'dailyCeilingCents')::integer > 0, false))
          OR (n.setting_key = 'monthly_cash_ceiling_cents'
            AND p.id IS NOT NULL AND (n.value ->> 'cents')::bigint > (p.value ->> 'cents')::bigint)
        )
      ORDER BY n.changed_at, n.workspace_id, n.id
      LIMIT $2`,
    [CALL_ANALYSIS_SWEEP_WRITE_DAYS, limit],
  );
  return rows.map(row => ({ workspaceId: row.workspace_id, writeId: row.id }));
}

/**
 * The sweep of one write: every held version of the workspace — pending, model, with no open
 * reservation and no live `call.analyze` job — queued once more, keyed by the version and the
 * write (`call-analyze:<session>:v<N>:w<write>`), with the version named in the payload, so
 * chunk 1 is a no-op if it is no longer pending when the job runs. Nothing while the switch
 * is off. The caps still decide in chunk 1: a version still capped is held again.
 */
export async function sweepHeldAnalyses(context: RepositoryContext, writeId: string): Promise<number> {
  if (!(await analysesOn(context))) return 0;
  const { rows } = await context.db.query<{ id: string; call_session_id: string; version: number }>(
    `SELECT a.id, a.call_session_id, a.version FROM call_analyses a
      WHERE a.workspace_id = $1 AND a.origin = 'model' AND a.state = 'pending'
        AND NOT EXISTS (SELECT 1 FROM provider_reservations r
                         WHERE r.workspace_id = a.workspace_id AND r.subject_kind = $2 AND r.subject_id = a.id
                           AND r.state IN ('reserved', 'calling'))
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.workspace_id = a.workspace_id AND j.kind = 'call.analyze'
                         AND j.payload ->> 'callSessionId' = a.call_session_id::text
                         AND j.state IN ('queued', 'running', 'retryable'))
      ORDER BY a.created_at, a.id`,
    [context.scope.workspaceId, CALL_ANALYSIS_SUBJECT_KIND],
  );
  let queued = 0;
  for (const row of rows) {
    const enqueued = await enqueueJob(context.db, {
      workspaceId: context.scope.workspaceId,
      kind: 'call.analyze',
      idempotencyKey: jobIdempotencyKey.callAnalyzeResume(row.call_session_id, row.version, writeId),
      payload: { callSessionId: row.call_session_id, analysisId: row.id },
      maxAttempts: CALL_ANALYZE_JOB_MAX_ATTEMPTS,
    });
    if (enqueued.inserted) queued += 1;
  }
  return queued;
}

// ---------------------------------------------------------------------------
// David's retry
// ---------------------------------------------------------------------------

export type RequestAnalysisOutcome =
  | { readonly ok: true; readonly value: { readonly callSessionId: string; readonly queued: boolean } }
  | { readonly ok: false; readonly reason: 'not_found' | 'reanalysis_required' | 'analysis_in_flight' | 'transcript_missing' };

/**
 * `POST /calls/analysis/retry`: queue a `call.analyze` for one call, under its analysis lock
 * (reviews S3A2, S3A2F):
 *
 *   * a live `call.analyze` job for the call (queued, running or retryable) is in flight;
 *   * a held version (pending, no live job) is queued again, named in the payload, so chunk 1
 *     is a no-op if anything else finished it first;
 *   * with no held version, a historical call (summary path) or one with a completed model
 *     reading of its current transcript needs `reanalysis` (`reanalysis_required`) — and
 *     chunk 1 enforces the same rule;
 *   * the job's key carries the command id (`call-analyze:<session>:v<N>:c<command>`): unique,
 *     never reused, so it collides with nothing archived.
 *
 * David's notes count for none of these. A new version is created by the job's chunk 1.
 */
export async function requestCallAnalysis(
  context: RepositoryContext,
  input: { readonly sessionId: string; readonly reason: 'retry' | 'reanalysis'; readonly commandId: string },
): Promise<RequestAnalysisOutcome> {
  const locked = await lockCallAnalysisForSession(context, input.sessionId);
  if (locked === null || !locked.permitted) return { ok: false, reason: 'not_found' };
  const transcript = await readStoredTranscript(context, input.sessionId);
  if (transcript === null || !transcript.channelLabelled || transcript.utterances.length === 0) return { ok: false, reason: 'transcript_missing' };
  const { rows: live } = await context.db.query(
    `SELECT 1 FROM jobs WHERE workspace_id = $1 AND kind = 'call.analyze' AND payload ->> 'callSessionId' = $2::text
        AND state IN ('queued', 'running', 'retryable') LIMIT 1`,
    [context.scope.workspaceId, input.sessionId],
  );
  if (live.length > 0) return { ok: false, reason: 'analysis_in_flight' };
  const pending = await pendingVersionOf(context, input.sessionId);
  let version: number;
  if (pending !== null) {
    version = pending.version;
  } else {
    const path = await postCallModelPath(context.db, context.scope.workspaceId, input.sessionId);
    if (path === 'summary' && input.reason !== 'reanalysis') return { ok: false, reason: 'reanalysis_required' };
    const { rows } = await context.db.query<{ done: boolean; next: number }>(
      `SELECT EXISTS (SELECT 1 FROM call_analyses WHERE workspace_id = $1 AND call_session_id = $2
                       AND origin = 'model' AND state = 'completed' AND transcript_sha256 = $3) AS done,
              coalesce(max(version), 0)::int + 1 AS next
         FROM call_analyses WHERE workspace_id = $1 AND call_session_id = $2`,
      [context.scope.workspaceId, input.sessionId, transcript.sha256],
    );
    if (rows[0]?.done === true && input.reason !== 'reanalysis') return { ok: false, reason: 'reanalysis_required' };
    version = rows[0]?.next ?? 1;
  }
  const queued = await enqueueJob(context.db, {
    workspaceId: context.scope.workspaceId,
    kind: 'call.analyze',
    idempotencyKey: jobIdempotencyKey.callAnalyzeRequested(input.sessionId, version, input.commandId),
    payload: { callSessionId: input.sessionId, reason: input.reason, ...(pending === null ? {} : { analysisId: pending.id }) },
    maxAttempts: CALL_ANALYZE_JOB_MAX_ATTEMPTS,
  });
  return { ok: true, value: { callSessionId: input.sessionId, queued: queued.inserted } };
}

// ---------------------------------------------------------------------------
// The history read: `include=summary` maps the current analysis
// ---------------------------------------------------------------------------

/**
 * Each session's current analysis as the history read's `CallSummaryDto`: the current notes'
 * summary, no next steps, and the commitments of the latest completed model version. The
 * caller has already decided the caller may read these sessions' firm.
 */
export async function readAnalysisSummaries(context: RepositoryContext, sessionIds: readonly string[]): Promise<ReadonlyMap<string, CallSummaryDto>> {
  if (sessionIds.length === 0) return new Map();
  const { rows } = await context.db.query<{
    call_session_id: string;
    origin: 'model' | 'user';
    model: string | null;
    result: CallAnalysisResult | null;
    notes: CallAnalysisNotes | null;
    completed_at: Date;
  }>(
    `SELECT call_session_id, origin, model, result, notes, completed_at FROM call_analyses
      WHERE workspace_id = $1 AND call_session_id = ANY($2::uuid[]) AND state = 'completed'
      ORDER BY call_session_id, version DESC`,
    [context.scope.workspaceId, [...sessionIds]],
  );
  const out = new Map<string, CallSummaryDto>();
  for (const sessionId of new Set(rows.map(row => row.call_session_id))) {
    const versions = rows.filter(row => row.call_session_id === sessionId);
    const user = versions.find(row => row.origin === 'user');
    const model = versions.find(row => row.origin === 'model');
    const current = user ?? model;
    const summary = current?.origin === 'user' ? current.notes?.summary : current?.result?.summary;
    if (current === undefined || summary === undefined || summary.trim().length === 0) continue;
    out.set(sessionId, {
      summary: summary.slice(0, 2_000),
      nextSteps: [],
      commitments: (model?.result?.commitments ?? []).slice(0, 10).map(commitment => ({ speaker: commitment.speaker, quote: commitment.ref.quote })),
      model: current.origin === 'user' ? 'user' : (current.model ?? 'model'),
      createdAt: current.completed_at.toISOString(),
    });
  }
  return out;
}
