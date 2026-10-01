import { CHANNEL_LABELLED_TRANSCRIPTS, transcriptIsChannelLabelled, type CallSummaryDto, type CallTranscriptUtterance } from '@fss/contracts';
import type { Queryable } from '../db/queryable.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { databaseNow } from '../policy/clock.ts';
import { lockMonthlySpend, recordProviderCall, workspaceBusinessZone } from '../research/ledger.ts';
import {
  listAttempts,
  markCalling,
  readAttempt,
  reserveAttempt,
  settleAttempt,
  type ReservationRow,
} from '../research/reservations.ts';
import { clearMonthlyCash, monthWithinCeiling } from '../settings/cashCeiling.ts';
import { providerFunding } from '../settings/funding.ts';
import { DIRECT_ROUTE, transportOfProviderKey, type ModelRoute } from '../classification/modelTransport.ts';
import { readCallTranscription } from '../settings/integrations.ts';
import { settingLockName } from '../settings/store.ts';
import { localDate } from '../src/rules/localClock.ts';
import type { CallSummaryAttempt, CallSummaryOutcome, CallSummaryPort, ProviderErrorDetail } from './summaryAdapter.ts';
import {
  CALL_SUMMARY_MAX_TRANSCRIPT_BYTES,
  CALL_SUMMARY_MODEL_TABLE,
  CALL_SUMMARY_PROMPT_VERSION,
  buildCallSummaryRequest,
  callSummaryCeilingCents,
  callSummaryCents,
  callSummaryInputTokenBound,
  callSummaryProviderKey,
  isCallSummaryModel,
  transcriptText,
  type CallSummaryInput,
  type CallSummaryModel,
} from './summaryModel.ts';

/**
 * After-call summaries (slice C3b, migration 0032): one summary per transcribed call,
 * with suggested next steps and the commitments heard. Suggestions only — nothing here
 * sends, books or schedules anything.
 *
 * ## Which switch governs it
 *
 * The transcription switch, `call_transcription` (`enabled` with a daily ceiling above 0),
 * because a summary is part of after-call transcription (David, 1 October 2026: "after-call
 * transcription, with a summary and suggested next steps"). There is no second
 * user-facing switch: off holds summaries exactly as it holds transcriptions, and back on
 * resumes them. The deployment's own switch is whether its worker has the Anthropic key
 * (the classifier's, read once: `classifyWorkerOptions`); without one `call.summarize` is
 * not registered and its source materializes nothing.
 *
 * ## The money: the paid-call pattern, as the classifier applies it
 *
 * `provider_reservations`, subject `call_summary` (0032), subject id the call session,
 * priced by model and tokens. `call.summarize` is chunked in three, each its own commit:
 *
 *   1. `beginCallSummary` — the switch, the lifetime cap (two paid attempts per call), the
 *      day's count (`CALL_SUMMARY_DAILY_CAP`) under the summary budget lock, the month's
 *      cash ceiling under the monthly lock, and a reservation at the request's upper
 *      bound. At most one open reservation per call (the session lock here, and
 *      `provider_reservations_one_open_summary` in the database). Nothing is sent.
 *   2. `ensureCallSummaryCalling` — the request built, the month read again, then the
 *      final read of the switch under its setting lock SHARED, held to the commit that
 *      marks the attempt `calling`. A turn-off that committed first is read here and holds
 *      the call; one that commits after counts this request as submitted.
 *   3. `finishCallSummary` — the request first, then the record: settled by reservation id
 *      at the answer's reported usage, or kept at the estimate when the answer reported
 *      none or the transport threw. An unusable answer (malformed, outside the schema) or
 *      an ambiguous failure goes back to chunk 1 for one more paid attempt, if the call
 *      has had fewer than two.
 *
 * The input bound is the request's UTF-8 byte length, which no tokenizer exceeds, so the
 * reservation is a true upper bound without a count call between chunk 2 and the request.
 *
 * ## The one lock order (`docs/greenfield/calling.md`)
 *
 * firm → the subject's own lock (here: the call's summary lock, then its session row) →
 * the kind's budget lock (`call_summary_budget`) → the workspace monthly lock → rows. Chunk
 * 1 takes summary → budget → monthly; chunk 2 summary → monthly → the switch's setting lock
 * SHARED (a leaf); chunk 3 summary → the session row (KEY SHARE) → monthly → reservation,
 * ledger and summary rows. The deletion workflow takes the summary locks of every session it
 * removes after the firm and before the sessions' own locks and rows
 * (`lockSummariesForDeletion`), so a claim mid-request finishes before the deletion measures
 * anything, and one that has not reached its lock finds the session gone.
 */

/** `provider_reservations.subject_kind` for one call's summary (admitted by 0032). */
export const CALL_SUMMARY_SUBJECT_KIND = 'call_summary';
/** Paid attempts one call may ever hold: the first, and one retry of an unusable or ambiguous one. */
export const CALL_SUMMARY_MAX_PAID_ATTEMPTS = 2;
/** Reservation rows one call may ever have, released (paused) ones included. */
export const CALL_SUMMARY_MAX_ROWS = 6;
/** Paid summary attempts one workspace may reserve on one business date. */
export const CALL_SUMMARY_DAILY_CAP = 40;
/** An open summary reservation older than this has outlived every lease that could use it. */
export const CALL_SUMMARY_SWEEP_MINUTES = 30;
/** How long after its transcript a call is still summarized (and a held summary resumed). */
export const CALL_SUMMARY_RESUME_DAYS = 7;
/** The job's own attempts: a poison payload or a lost lease, never the provider. */
export const CALL_SUMMARIZE_JOB_MAX_ATTEMPTS = 3;

const subjectOf = (sessionId: string) => ({ subjectKind: CALL_SUMMARY_SUBJECT_KIND, subjectId: sessionId }) as const;

function summaryLockName(workspaceId: string, sessionId: string): string {
  return `${workspaceId}:call_summary:${sessionId}`;
}

/** The per-call lock every chunk and the sweep take: one decides about a call's summary money at a time. */
async function lockSummary(context: RepositoryContext, sessionId: string): Promise<void> {
  await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    summaryLockName(context.scope.workspaceId, sessionId),
  ]);
}

async function tryLockSummary(context: RepositoryContext, sessionId: string): Promise<boolean> {
  const { rows } = await context.db.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked', [
    summaryLockName(context.scope.workspaceId, sessionId),
  ]);
  return rows[0]?.locked === true;
}

/** The workspace's summary budget lock: the daily count, serialised. Before the monthly lock. */
async function lockSummaryBudget(context: RepositoryContext): Promise<void> {
  await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${context.scope.workspaceId}:call_summary_budget`]);
}

const paidAttempts = (rows: readonly ReservationRow[]): number => rows.filter(row => row.state !== 'released').length;
const isOpen = (row: ReservationRow): boolean => row.state === 'reserved' || row.state === 'calling';

/** Paid summary attempts reserved on one business date: the daily cap's count. */
async function reservedOn(context: RepositoryContext, businessDate: string): Promise<number> {
  const { rows } = await context.db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM provider_reservations
      WHERE workspace_id = $1 AND subject_kind = $2 AND business_date = $3::date AND state <> 'released'`,
    [context.scope.workspaceId, CALL_SUMMARY_SUBJECT_KIND, businessDate],
  );
  return Number(rows[0]?.n ?? '0');
}

/** Whether summaries are on now: the transcription switch, with a ceiling above 0. */
async function summariesOn(context: RepositoryContext): Promise<boolean> {
  const setting = await readCallTranscription(context);
  return setting.enabled && setting.dailyCeilingCents > 0;
}

// ---------------------------------------------------------------------------
// The call, as the request will carry it
// ---------------------------------------------------------------------------

export type SummarySkip = 'not_applicable' | 'already_summarized' | 'disabled' | 'capped' | 'too_long';

async function hasSummary(context: RepositoryContext, sessionId: string): Promise<boolean> {
  const { rows } = await context.db.query('SELECT 1 FROM call_summaries WHERE workspace_id = $1 AND call_session_id = $2', [
    context.scope.workspaceId,
    sessionId,
  ]);
  return rows.length > 0;
}

type Prepared = { readonly kind: 'ready'; readonly call: CallSummaryInput } | { readonly kind: 'skip'; readonly reason: SummarySkip };

/** What the call is now: gone, summarized already, too long, or the input a request would carry. */
async function prepare(context: RepositoryContext, sessionId: string): Promise<Prepared> {
  const { rows } = await context.db.query<{
    firm_name: string;
    contact_name: string | null;
    provider: string;
    model: string;
    utterances: unknown;
  }>(
    `SELECT f.name AS firm_name, c.full_name AS contact_name, t.provider, t.model, t.utterances
       FROM call_transcripts t
       JOIN call_sessions s ON s.workspace_id = t.workspace_id AND s.id = t.call_session_id
       JOIN firms f ON f.workspace_id = s.workspace_id AND f.id = s.firm_id
       LEFT JOIN contacts c ON c.workspace_id = s.workspace_id AND c.id = s.contact_id
      WHERE t.workspace_id = $1 AND t.call_session_id = $2`,
    [context.scope.workspaceId, sessionId],
  );
  const row = rows[0];
  if (row === undefined) return { kind: 'skip', reason: 'not_applicable' };
  // Only a channel-labelled transcript: in a diarized one nobody knows which voice is whose.
  if (!transcriptIsChannelLabelled(row)) return { kind: 'skip', reason: 'not_applicable' };
  if (await hasSummary(context, sessionId)) return { kind: 'skip', reason: 'already_summarized' };
  const utterances = Array.isArray(row.utterances) ? (row.utterances as CallTranscriptUtterance[]) : [];
  if (utterances.length === 0) return { kind: 'skip', reason: 'not_applicable' };
  if (Buffer.byteLength(transcriptText(utterances), 'utf8') > CALL_SUMMARY_MAX_TRANSCRIPT_BYTES) {
    return { kind: 'skip', reason: 'too_long' };
  }
  return { kind: 'ready', call: { firmName: row.firm_name, contactName: row.contact_name, utterances } };
}

// ---------------------------------------------------------------------------
// Chunk 1
// ---------------------------------------------------------------------------

export interface CallSummaryDeps {
  readonly summarizer: CallSummaryPort;
  /** The deployment's model (`FSS_CALL_SUMMARY_MODEL`); Haiku 4.5 unless set. */
  readonly model: CallSummaryModel;
  /**
   * Which transport carries each model (slice BR1): the route the `summarizer`'s transport
   * follows, asked before the reservation for its `provider_key`, its price table and
   * whether the month's cash ceiling applies. Null for a model this deployment cannot call:
   * nothing is reserved. Absent is every model through the direct API.
   */
  readonly route?: ModelRoute | undefined;
}

export type BeginSummaryOutcome =
  | { readonly kind: 'reserved'; readonly attempt: number }
  | { readonly kind: 'done'; readonly reason: SummarySkip | 'in_flight' };

export async function beginCallSummary(
  context: RepositoryContext,
  deps: Pick<CallSummaryDeps, 'model' | 'route'>,
  input: { readonly sessionId: string; readonly retry: boolean },
): Promise<BeginSummaryOutcome> {
  await lockSummary(context, input.sessionId);
  const prepared = await prepare(context, input.sessionId);
  if (prepared.kind === 'skip') return { kind: 'done', reason: prepared.reason };

  const rows = await listAttempts(context, subjectOf(input.sessionId));
  // One active paid obligation per call: an open reservation is another job's.
  if (rows.some(isOpen)) return { kind: 'done', reason: 'in_flight' };
  // There is no "answered" short cut (C3 review, finding 5): a call with no summary is owed
  // its remaining paid attempt whichever job asks — this job's own retry, or the resumed job
  // the source queues after a pause held that retry — and the lifetime cap below is what
  // bounds it. A duplicate job cannot double-pay: the summary lock, the open check above
  // and `provider_reservations_one_open_summary` admit one obligation at a time, and an
  // accepted answer ends the call in `prepare` (it has a summary).

  if (!(await summariesOn(context))) return { kind: 'done', reason: 'disabled' };
  if (paidAttempts(rows) >= CALL_SUMMARY_MAX_PAID_ATTEMPTS || rows.length >= CALL_SUMMARY_MAX_ROWS) {
    return { kind: 'done', reason: 'capped' };
  }

  // The one lock order: this call, the summary budget, then the month.
  await lockSummaryBudget(context);
  const at = await databaseNow(context);
  const zone = await workspaceBusinessZone(context);
  if ((await reservedOn(context, localDate(at, zone))) >= CALL_SUMMARY_DAILY_CAP) return { kind: 'done', reason: 'capped' };
  const maxOutputTokens = CALL_SUMMARY_MODEL_TABLE[deps.model].maxOutputTokens;
  const request = buildCallSummaryRequest({ model: deps.model, maxOutputTokens, call: prepared.call });
  const maxInputTokens = callSummaryInputTokenBound(request);
  const transport = (deps.route ?? DIRECT_ROUTE)(deps.model);
  if (transport === null) return { kind: 'done', reason: 'disabled' };
  const providerKey = callSummaryProviderKey(transport);
  const cents = callSummaryCeilingCents(deps.model, maxInputTokens, maxOutputTokens, transport);
  // The month's cash ceiling is for cash: a credit-funded summary is not cleared against it (slice BR1).
  if (providerFunding(providerKey) === 'cash' && !(await clearMonthlyCash(context, { at, zone, cents }))) {
    return { kind: 'done', reason: 'capped' };
  }
  const attempt = rows.reduce((highest, row) => Math.max(highest, row.attempt), 0) + 1;
  await reserveAttempt(context, {
    providerKey,
    ...subjectOf(input.sessionId),
    attempt,
    at,
    businessTimeZone: zone,
    cents,
    modelName: deps.model,
    maxInputTokens,
    maxOutputTokens,
  });
  return { kind: 'reserved', attempt };
}

// ---------------------------------------------------------------------------
// Chunk 2
// ---------------------------------------------------------------------------

/** The exact request one attempt sends, built before the attempt is marked `calling`. */
export interface CallSummaryPlan {
  readonly model: CallSummaryModel;
  readonly maxOutputTokens: number;
  readonly call: CallSummaryInput;
}

export type EnsureSummaryOutcome =
  | { readonly kind: 'calling'; readonly attempt: number; readonly plan: CallSummaryPlan }
  /** Reserved for the other transport (slice BR1) and released, nothing sent: chunk 1 reserves again. */
  | { readonly kind: 'retry' }
  | { readonly kind: 'done'; readonly reason: SummarySkip | 'not_reserved' };

export async function ensureCallSummaryCalling(
  context: RepositoryContext,
  input: { readonly sessionId: string; readonly attempt: number },
  deps: Pick<CallSummaryDeps, 'route'> = {},
): Promise<EnsureSummaryOutcome> {
  await lockSummary(context, input.sessionId);
  const row = await readAttempt(context, { ...subjectOf(input.sessionId), attempt: input.attempt });
  if (row === null || row.state !== 'reserved') return { kind: 'done', reason: 'not_reserved' };
  const release = async (): Promise<void> => {
    await settleAttempt(context, { reservationId: row.id, at: await databaseNow(context), outcome: { kind: 'released' } });
  };
  // Never one transport against money reserved — and priced, and funded — for the other.
  const route = (deps.route ?? DIRECT_ROUTE)(row.modelName);
  if (route === null || row.providerKey !== callSummaryProviderKey(route)) {
    await release();
    return { kind: 'retry' };
  }
  const prepared = await prepare(context, input.sessionId);
  if (prepared.kind === 'skip') {
    await release();
    return { kind: 'done', reason: prepared.reason };
  }
  if (!isCallSummaryModel(row.modelName)) {
    await release();
    return { kind: 'done', reason: 'not_applicable' };
  }
  // The request the reservation priced: its model and its output bound. The transcript
  // does not change after it is stored, so the input bound still holds; asked anyway.
  const plan: CallSummaryPlan = { model: row.modelName, maxOutputTokens: row.maxOutputTokens, call: prepared.call };
  if (callSummaryInputTokenBound(buildCallSummaryRequest(plan)) > row.maxInputTokens) {
    await release();
    return { kind: 'done', reason: 'not_applicable' };
  }
  const at = await databaseNow(context);
  const zone = await workspaceBusinessZone(context);
  // The month, then the switch: the last two things read before the commit.
  // A credit-funded attempt was never cleared against the cash ceiling, so it is not stopped by it (slice BR1).
  const withinMonth = providerFunding(row.providerKey) === 'cash' ? await monthWithinCeiling(context, { at, zone }) : true;
  // The switch's own setting lock, SHARED, held to the commit that marks `calling`: a save
  // of `call_transcription` takes it EXCLUSIVE, so a turn-off either committed before this
  // read (and holds the call) or waits for this commit (and this request is submitted).
  await context.db.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))', [
    settingLockName(context.scope.workspaceId, 'call_transcription'),
  ]);
  if (!(await summariesOn(context))) {
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

export type FinishSummaryOutcome =
  | { readonly kind: 'summarized'; readonly settledCents: number; readonly nextSteps: number; readonly commitments: number; readonly droppedCommitments: number }
  | { readonly kind: 'retry'; readonly outcome: CallSummaryOutcome; readonly provider?: ProviderErrorDetail | undefined }
  | {
      readonly kind: 'done';
      readonly outcome: CallSummaryOutcome | 'session_gone' | 'not_calling';
      readonly provider?: ProviderErrorDetail | undefined;
    };

/** Ambiguous (may have been billed, nobody said what) or unusable (billed, nothing to keep): one more attempt is allowed. */
const RETRYABLE: ReadonlySet<CallSummaryOutcome> = new Set(['provider_error', 'malformed', 'schema_invalid']);

export async function finishCallSummary(
  context: RepositoryContext,
  deps: Pick<CallSummaryDeps, 'summarizer'>,
  input: { readonly sessionId: string; readonly attempt: number; readonly plan: CallSummaryPlan },
): Promise<FinishSummaryOutcome> {
  let attempt: CallSummaryAttempt;
  try {
    attempt = await deps.summarizer.summarize(input.plan);
  } catch {
    attempt = { outcome: 'provider_error', usage: null, content: null, answeredBy: null };
  }

  await lockSummary(context, input.sessionId);
  // The session row, KEY SHARE (the summary's foreign key needs it to stay), then the month,
  // both before any reservation, ledger or summary row is written: the one lock order.
  const { rows: live } = await context.db.query(
    'SELECT 1 FROM call_sessions WHERE workspace_id = $1 AND id = $2 FOR KEY SHARE',
    [context.scope.workspaceId, input.sessionId],
  );
  await lockMonthlySpend(context);
  const row = await readAttempt(context, { ...subjectOf(input.sessionId), attempt: input.attempt });
  const at = await databaseNow(context);
  let settledCents = 0;
  if (row !== null) {
    // A 4xx refusal billed nothing (refused before generation, as C2 settles Deepgram's 4xx);
    // missing usage (or no answer at all) is the estimate, never zero.
    const settled = await settleAttempt(context, {
      reservationId: row.id,
      at,
      outcome:
        attempt.outcome === 'provider_refused'
          ? { kind: 'settled', cents: 0 }
          : attempt.usage === null
            ? { kind: 'estimated' }
            : { kind: 'settled', cents: callSummaryCents(input.plan.model, attempt.usage, transportOfProviderKey(row.providerKey)) },
    });
    settledCents = settled?.recordedCents ?? 0;
    await recordProviderCall(context, {
      providerKey: row.providerKey,
      at,
      businessTimeZone: row.businessTimeZone,
      costCents: 0,
      ...(attempt.outcome === 'accepted' ? {} : { failureCode: attempt.outcome }),
    });
  }

  if (attempt.outcome !== 'accepted' || attempt.content === null) {
    const provider = attempt.provider === undefined ? {} : { provider: attempt.provider };
    if (RETRYABLE.has(attempt.outcome) && live.length > 0) {
      const rows = await listAttempts(context, subjectOf(input.sessionId));
      if (paidAttempts(rows) < CALL_SUMMARY_MAX_PAID_ATTEMPTS && rows.length < CALL_SUMMARY_MAX_ROWS) {
        return { kind: 'retry', outcome: attempt.outcome, ...provider };
      }
    }
    return { kind: 'done', outcome: attempt.outcome, ...provider };
  }
  if (live.length === 0) return { kind: 'done', outcome: 'session_gone' };

  const content = attempt.content;
  await context.db.query(
    `INSERT INTO call_summaries (workspace_id, call_session_id, model, prompt_version, summary, next_steps, commitments)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
     ON CONFLICT ON CONSTRAINT call_summaries_pkey DO NOTHING`,
    [
      context.scope.workspaceId,
      input.sessionId,
      (attempt.answeredBy ?? input.plan.model).toLowerCase(),
      CALL_SUMMARY_PROMPT_VERSION,
      content.summary,
      JSON.stringify(content.nextSteps),
      JSON.stringify(content.commitments),
    ],
  );
  return {
    kind: 'summarized',
    settledCents,
    nextSteps: content.nextSteps.length,
    commitments: content.commitments.length,
    droppedCommitments: content.droppedCommitments,
  };
}

/**
 * A `calling` attempt this job marked under an earlier claim (its cursor's fencing token is
 * not this claim's): the request may have gone, so it is estimated; a retry goes through
 * chunk 1's bounds again.
 */
export async function estimateAbandonedSummary(
  context: RepositoryContext,
  input: { readonly sessionId: string; readonly attempt: number },
): Promise<void> {
  await lockSummary(context, input.sessionId);
  await lockMonthlySpend(context);
  const row = await readAttempt(context, { ...subjectOf(input.sessionId), attempt: input.attempt });
  if (row !== null && row.state === 'calling') {
    await settleAttempt(context, { reservationId: row.id, at: await databaseNow(context), outcome: { kind: 'estimated' } });
  }
}

/** An attempt this claim marked and does not hold the request for: it was not sent. */
export async function releaseUnsentSummary(
  context: RepositoryContext,
  input: { readonly sessionId: string; readonly attempt: number },
): Promise<void> {
  await lockSummary(context, input.sessionId);
  const row = await readAttempt(context, { ...subjectOf(input.sessionId), attempt: input.attempt });
  if (row !== null && row.state === 'calling') {
    await settleAttempt(context, { reservationId: row.id, at: await databaseNow(context), outcome: { kind: 'released_not_called' } });
  }
}

// ---------------------------------------------------------------------------
// The sweep, the deletion step
// ---------------------------------------------------------------------------

/**
 * Finalise summary reservations whose claim is gone: open `CALL_SUMMARY_SWEEP_MINUTES` after
 * they were written. `reserved` is released (nothing was sent), `calling` estimated (a
 * request may have been). A call whose lock a live claim holds is skipped.
 */
export async function sweepCallSummaryReservations(
  context: RepositoryContext,
): Promise<{ readonly released: number; readonly estimated: number }> {
  const { rows } = await context.db.query<{ id: string; subject_id: string; state: string }>(
    `SELECT id, subject_id, state FROM provider_reservations
      WHERE workspace_id = $1 AND subject_kind = $2 AND state IN ('reserved', 'calling')
        AND created_at + make_interval(mins => $3) <= now()
      ORDER BY subject_id`,
    [context.scope.workspaceId, CALL_SUMMARY_SUBJECT_KIND, CALL_SUMMARY_SWEEP_MINUTES],
  );
  let released = 0;
  let estimated = 0;
  const at = new Date().toISOString();
  for (const row of rows) {
    if (!(await tryLockSummary(context, row.subject_id))) continue;
    const outcome = row.state === 'calling' ? ({ kind: 'estimated' } as const) : ({ kind: 'released' } as const);
    if ((await settleAttempt(context, { reservationId: row.id, at, outcome })) === null) continue;
    if (row.state === 'calling') estimated += 1;
    else released += 1;
  }
  return { released, estimated };
}

/** The workspaces the summary sweep would find work in now. */
export async function workspacesOwingSummarySweep(db: Queryable): Promise<readonly string[]> {
  const { rows } = await db.query<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id FROM provider_reservations
      WHERE subject_kind = $1 AND state IN ('reserved', 'calling')
        AND created_at + make_interval(mins => $2) <= now()
      ORDER BY workspace_id`,
    [CALL_SUMMARY_SUBJECT_KIND, CALL_SUMMARY_SWEEP_MINUTES],
  );
  return rows.map(row => row.workspace_id);
}

/**
 * The deletion workflow's lock on the summaries of the sessions it is about to remove:
 * each one's summary lock, in id order, after the firm and before the sessions' own locks
 * and rows (`lockSessionsForDeletion`). A claim mid-request (chunk 3 sends before it takes
 * its lock) waits for the deletion and then finds the session gone; a claim holding the
 * lock finishes first. Held to the commit.
 */
export async function lockSummariesForDeletion(context: RepositoryContext, sessionIds: readonly string[]): Promise<void> {
  for (const sessionId of [...new Set(sessionIds)].sort()) await lockSummary(context, sessionId);
}

/**
 * The deletion workflow's step for the sessions it removes, under the locks above and the
 * monthly lock: their open summary attempts finalised as the sweep does it — `reserved`
 * released, `calling` estimated. The summaries themselves are deleted by the workflow (and
 * would cascade with their sessions).
 */
export async function finaliseSummariesOfSessions(context: RepositoryContext, sessionIds: readonly string[], at: string): Promise<void> {
  for (const sessionId of [...new Set(sessionIds)].sort()) {
    await lockSummary(context, sessionId);
    for (const row of await listAttempts(context, subjectOf(sessionId))) {
      if (row.state === 'reserved') await settleAttempt(context, { reservationId: row.id, at, outcome: { kind: 'released' } });
      else if (row.state === 'calling') await settleAttempt(context, { reservationId: row.id, at, outcome: { kind: 'estimated' } });
    }
  }
}

// ---------------------------------------------------------------------------
// Discovery: the job source's query
// ---------------------------------------------------------------------------

export interface OwedSummary {
  readonly workspaceId: string;
  readonly sessionId: string;
  /** How many `call.summarize` jobs the call already has; the next job's key revision. */
  readonly revision: number;
}

/**
 * Calls owed a summary, for the `call-summarize` source. A channel-labelled transcript of the last
 * `CALL_SUMMARY_RESUME_DAYS`, no summary, the transcription switch on with a ceiling above
 * 0, no open summary reservation, fewer than two paid summary attempts, and either no
 * `call.summarize` job yet or — a held summary (paused work is held, not completed) —
 * every earlier job finished before the setting was last written. So a call is resumed at
 * most once for each change of the setting, and pays only if its earlier attempts did not.
 */
export async function listOwedSummaries(db: Queryable, limit = 50): Promise<readonly OwedSummary[]> {
  const { rows } = await db.query<{ workspace_id: string; session_id: string; jobs: string }>(
    `SELECT t.workspace_id, t.call_session_id AS session_id, j.jobs::text AS jobs
       FROM call_transcripts t
       JOIN workspace_settings s
         ON s.workspace_id = t.workspace_id AND s.setting_key = 'call_transcription' AND s.superseded_at IS NULL
       CROSS JOIN LATERAL (
         SELECT count(*) AS jobs, max(updated_at) AS finished_at, bool_and(state = 'done') AS all_done
           FROM jobs
          WHERE workspace_id = t.workspace_id AND kind = 'call.summarize'
            AND payload ->> 'callSessionId' = t.call_session_id::text
       ) j
      WHERE t.created_at > now() - make_interval(days => $1)
        AND t.provider || '/' || t.model = ANY($5::text[])
        AND (s.value ->> 'enabled')::boolean AND (s.value ->> 'dailyCeilingCents')::integer > 0
        AND (j.jobs = 0 OR (j.all_done AND s.changed_at > j.finished_at))
        AND NOT EXISTS (SELECT 1 FROM call_summaries x WHERE x.workspace_id = t.workspace_id AND x.call_session_id = t.call_session_id)
        AND NOT EXISTS (
          SELECT 1 FROM provider_reservations r
           WHERE r.workspace_id = t.workspace_id AND r.subject_kind = $2 AND r.subject_id = t.call_session_id
             AND r.state IN ('reserved', 'calling')
        )
        AND (
          SELECT count(*) FROM provider_reservations r
           WHERE r.workspace_id = t.workspace_id AND r.subject_kind = $2 AND r.subject_id = t.call_session_id
             AND r.state <> 'released'
        ) < $3
      ORDER BY t.created_at, t.workspace_id, t.call_session_id
      LIMIT $4`,
    [CALL_SUMMARY_RESUME_DAYS, CALL_SUMMARY_SUBJECT_KIND, CALL_SUMMARY_MAX_PAID_ATTEMPTS, limit, [...CHANNEL_LABELLED_TRANSCRIPTS]],
  );
  return rows.map(row => ({ workspaceId: row.workspace_id, sessionId: row.session_id, revision: Number(row.jobs) }));
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

/**
 * The summaries of the given sessions, by session id, for the history read. The caller has
 * already decided the caller may read the firm these sessions belong to.
 */
export async function readCallSummaries(context: RepositoryContext, sessionIds: readonly string[]): Promise<ReadonlyMap<string, CallSummaryDto>> {
  if (sessionIds.length === 0) return new Map();
  const { rows } = await context.db.query<{
    call_session_id: string;
    model: string;
    summary: string;
    next_steps: unknown;
    commitments: unknown;
    created_at: Date;
  }>(
    `SELECT call_session_id, model, summary, next_steps, commitments, created_at FROM call_summaries
      WHERE workspace_id = $1 AND call_session_id = ANY($2::uuid[])`,
    [context.scope.workspaceId, [...sessionIds]],
  );
  return new Map(
    rows.map(row => [
      row.call_session_id,
      {
        summary: row.summary,
        nextSteps: Array.isArray(row.next_steps) ? (row.next_steps as CallSummaryDto['nextSteps']) : [],
        commitments: Array.isArray(row.commitments) ? (row.commitments as CallSummaryDto['commitments']) : [],
        model: row.model,
        createdAt: row.created_at.toISOString(),
      },
    ]),
  );
}
