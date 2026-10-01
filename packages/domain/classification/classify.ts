import type { RepositoryContext } from '../db/workspaceScope.ts';
import { readMessage, readMessageBody } from '../mail/messages.ts';
import { applyModelSuggestion, authoredText, type ReplyClassification } from '../src/rules/replyClassification.ts';
import type { ReplyClassifierPort } from './adapter.ts';
import type { ClassifierInput } from './prompt.ts';
import type { ProviderErrorDetail } from './providerError.ts';
import {
  listClassifications,
  recordClassifierCall,
  recordModelClassification,
  type ClassificationRow,
} from './store.ts';
import { lockClassifierSwitch, readClassifierSettings } from './settings.ts';
import { transportOfProviderKey, type ModelTransportKind } from './modelTransport.ts';
import {
  classifierCallCeilingCents,
  classifierCallCents,
  classifierInputTokenBound,
  classifierProviderKey,
} from './pricing.ts';
import { databaseNow } from '../policy/clock.ts';
import { localDate } from '../src/rules/localClock.ts';
import { lockMonthlySpend, recordProviderCall, workspaceBusinessZone } from '../research/ledger.ts';
import { listAttempts, markCalling, readAttempt, reserveAttempt, settleAttempt, type ReservationRow } from '../research/reservations.ts';
import { clearMonthlyCash, monthWithinCeiling } from '../settings/cashCeiling.ts';
import { providerFunding } from '../settings/funding.ts';
import {
  CLASSIFIER_PROMPT_VERSION,
  MODEL_CAPABILITIES,
  type ClassifierCallOutcome,
  type ClassifierCallRecord,
  type ClassifierSettings,
} from './types.ts';

/**
 * The second opinion, for one message (specification 12.4, Appendix A's
 * "LLM classification may be queued", Appendix G 34 and 35).
 *
 * The order the brief states, and the order this function runs in:
 *
 * 1. **Deterministic first, and its result is final** for `bounce`, `opt_out` with
 *    explicit phrases, and header-proven `automated`. This function reads the
 *    deterministic row and stops if it is anything but `uncertain`. It does not
 *    re-run the rules and it does not look at the message: the row was written in
 *    the same transaction as the message's effects, and asking again could get a
 *    different answer from a body that has since been discarded.
 * 2. **The model, for the remainder**, once, with its outcome recorded whatever it
 *    was.
 * 3. **The conservative merge** — `applyModelSuggestion` in the deterministic rules
 *    file, which returns the class unchanged. "Any human or uncertain signal holds;
 *    `automated` from the model alone never releases" is not a branch here; it is
 *    the absence of a branch, and `mail_message_classifications_model_cannot_decide`
 *    is the database saying the same thing.
 *
 * **Nothing in this file applies an effect.** No hold opens, no suppression is
 * recorded, no opportunity changes mode, no today item moves. Every one of those
 * already happened in `applyClassificationEffects` when the message arrived, and the
 * model's job is to put a label on a card. That is the authority boundary, and the
 * test suite for it (`test/classification/authority.test.ts`) asserts the row counts
 * of all four tables are unchanged across a classification.
 */

/** Why no request was sent, or null when one was. */
export type SkipReason = Extract<ClassifierCallOutcome, 'disabled' | 'capped' | 'not_applicable'>;

export interface ClassifyReplyOutcome {
  readonly messageId: string;
  /** What the card will show after this call: deterministic, merged with the model. */
  readonly classification: ReplyClassification | null;
  readonly outcome: ClassifierCallOutcome;
  /** True when this call was the one that wrote the model row. */
  readonly recorded: boolean;
  readonly call: ClassifierCallRecord | null;
  /** For a `provider_error`: what the API said (status, type, bounded message), when it said anything. */
  readonly provider?: ProviderErrorDetail | undefined;
}

export interface ClassifyReplyDeps {
  readonly classifierFor: (settings: ClassifierSettings) => ReplyClassifierPort;
  /**
   * The process-level off switch (`FSS_CLASSIFIER=off`). Distinct from the
   * workspace's `enabled`: one is a deployment that has no key, the other is an
   * admin who turned it off. Either one means no request.
   */
  readonly processEnabled?: boolean | undefined;
  /**
   * The transport `classifierFor`'s adapters send through (slice BR1): which `provider_key`
   * an attempt is reserved under, which price table bounds it, and whether the month's cash
   * ceiling applies (`aws_bedrock.classifier` is credit-funded, so it does not). Absent is
   * the direct API.
   */
  readonly transport?: ModelTransportKind | undefined;
}

function deterministicOf(rows: readonly ClassificationRow[]): ClassificationRow | undefined {
  return rows.find(row => row.layer === 'deterministic');
}

function asReplyClassification(messageId: string, row: ClassificationRow): ReplyClassification {
  return {
    class: row.class,
    suggestedDisposition: row.suggestedDisposition,
    signals: row.signals,
    requiresConfirmation: row.requiresConfirmation,
    messageId,
  };
}

/** An attempt that never left the process. Zero tokens, zero latency; the CHECK agrees. */
function unsentCall(settings: ClassifierSettings, outcome: SkipReason): ClassifierCallRecord {
  return {
    modelName: settings.modelName,
    promptVersion: CLASSIFIER_PROMPT_VERSION,
    effort: MODEL_CAPABILITIES[settings.modelName].effort ? settings.effort : null,
    requestSent: false,
    outcome,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    latencyMs: 0,
    stopReason: null,
    refusalCategory: null,
  };
}

// ---------------------------------------------------------------------------
// The paid-call pattern (slice P1, fix round 2)
// ---------------------------------------------------------------------------

/** `provider_reservations.subject_kind` for one reply's classification (admitted by 0031). */
export const CLASSIFICATION_SUBJECT_KIND = 'reply_classification';
/** Paid attempts one reply may ever hold: the first and one retry of an ambiguous one. */
export const CLASSIFY_MAX_PAID_ATTEMPTS = 2;
/** Reservation rows one reply may ever have, released (paused) ones included. */
export const CLASSIFY_MAX_ROWS = 6;
/** An open classifier reservation older than this has outlived every lease that could use it. */
export const CLASSIFY_SWEEP_MINUTES = 30;

const subjectOf = (messageId: string) => ({ subjectKind: CLASSIFICATION_SUBJECT_KIND, subjectId: messageId }) as const;

/** The per-reply lock every chunk and the sweep take: one decides about a reply's money at a time. */
async function lockReply(context: RepositoryContext, messageId: string): Promise<void> {
  await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `${context.scope.workspaceId}:reply_classification:${messageId}`,
  ]);
}

async function tryLockReply(context: RepositoryContext, messageId: string): Promise<boolean> {
  const { rows } = await context.db.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked',
    [`${context.scope.workspaceId}:reply_classification:${messageId}`],
  );
  return rows[0]?.locked === true;
}

/** The workspace's classifier budget lock: the daily count, serialised. Before the monthly lock. */
async function lockClassifierBudget(context: RepositoryContext): Promise<void> {
  await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `${context.scope.workspaceId}:classifier_budget`,
  ]);
}

/** Attempts that may have reached the provider: every row but a released one. */
const paidAttempts = (rows: readonly ReservationRow[]): number => rows.filter(row => row.state !== 'released').length;
const isOpen = (row: ReservationRow): boolean => row.state === 'reserved' || row.state === 'calling';

/**
 * The daily cap's count for one business date (P1 final round, #3): the classifier's paid
 * reservations dated that day, plus that day's sent requests recorded with no reservation
 * at all for their reply — the requests made before 0031, which reserved nothing. Every
 * request since has a reservation, so the two populations are disjoint and add. Both are
 * read on the reservation's business date, in the workspace's zone.
 */
async function classifierRequestsOn(context: RepositoryContext, businessDate: string): Promise<number> {
  const { rows } = await context.db.query<{ n: string }>(
    `SELECT ((SELECT count(*) FROM provider_reservations
               WHERE workspace_id = $1 AND subject_kind = $2 AND business_date = $3::date AND state <> 'released')
           + (SELECT count(*) FROM mail_classification_calls c
               WHERE c.workspace_id = $1 AND c.request_sent AND c.business_date = $3::date
                 AND NOT EXISTS (
                   SELECT 1 FROM provider_reservations r
                    WHERE r.workspace_id = c.workspace_id AND r.subject_kind = $2 AND r.subject_id = c.mail_message_id)))::text AS n`,
    [context.scope.workspaceId, CLASSIFICATION_SUBJECT_KIND, businessDate],
  );
  return Number(rows[0]?.n ?? '0');
}

/** The exact request one attempt sends: built before the attempt is marked `calling`. */
export interface ClassifierRequestPlan {
  readonly settings: ClassifierSettings;
  readonly input: ClassifierInput;
  readonly deterministicSignals: readonly { readonly rule: string; readonly evidence: string }[];
}

type Prepared =
  | { readonly kind: 'ready'; readonly deterministic: ClassificationRow; readonly input: ClassifierInput }
  | { readonly kind: 'done'; readonly report: ClassifyReplyOutcome };

/** What the reply is now: nothing to ask, already answered, or the input a request would carry. */
async function prepare(context: RepositoryContext, messageId: string, settings: ClassifierSettings): Promise<Prepared> {
  const message = await readMessage(context, messageId);
  if (message === null) {
    return { kind: 'done', report: { messageId, classification: null, outcome: 'not_applicable', recorded: false, call: null } };
  }
  const rows = await listClassifications(context, messageId);
  const deterministic = deterministicOf(rows);
  // The deterministic layer has already decided, or has not run at all. Either way
  // there is nothing to ask about, and the attempt is recorded as such rather than
  // silently not happening: a sudden run of `not_applicable` is a mail lane that has
  // stopped classifying, and that is worth seeing in the same place as the cost.
  if (deterministic === undefined || deterministic.class !== 'uncertain') {
    const call = unsentCall(settings, 'not_applicable');
    await recordClassifierCall(context, { messageId, call });
    return {
      kind: 'done',
      report: {
        messageId,
        classification: deterministic === undefined ? null : asReplyClassification(messageId, deterministic),
        outcome: 'not_applicable',
        recorded: false,
        call,
      },
    };
  }
  // Already answered. A replayed job is the ordinary case, not an error.
  if (rows.some(row => row.layer === 'model')) {
    return {
      kind: 'done',
      report: { messageId, classification: asReplyClassification(messageId, deterministic), outcome: 'accepted', recorded: false, call: null },
    };
  }
  const body = await readMessageBody(context, messageId);
  return {
    kind: 'ready',
    deterministic,
    input: {
      subject: message.subject,
      from: message.headerFrom,
      // The authored text, not the raw body: the quote boundary and the signature
      // boundary are the deterministic layer's and the model is asked about the same
      // words a rule was asked about. It is also what `excerptIsVerbatim` checks
      // against, so a quote from a signature block cannot verify.
      bodyText: body === null ? '' : authoredText(body.text),
      truncated: body?.truncated ?? false,
      deterministicSignals: deterministic.signals.map(signal => signal.rule),
    },
  };
}

/** A recorded attempt that sent nothing, and the card unchanged. */
async function skipped(
  context: RepositoryContext,
  messageId: string,
  deterministic: ClassificationRow,
  settings: ClassifierSettings,
  outcome: SkipReason,
): Promise<ClassifyReplyOutcome> {
  const call = unsentCall(settings, outcome);
  await recordClassifierCall(context, { messageId, call });
  return {
    messageId,
    classification: applyModelSuggestion(asReplyClassification(messageId, deterministic), null),
    outcome,
    recorded: false,
    call,
  };
}

export type BeginClassificationOutcome =
  | { readonly kind: 'reserved'; readonly attempt: number }
  | { readonly kind: 'done'; readonly report: ClassifyReplyOutcome };

/**
 * Chunk 1, its own commit: the switch, the lifetime and daily bounds, the month's cash
 * ceiling, and the attempt's reservation at the request's upper bound. Nothing is sent.
 *
 * One active paid obligation per reply: under the reply's lock, an open reservation means
 * another job holds it (`provider_reservations_one_open_reply` is the database's word for
 * the same thing), and a fresh obligation — not this job's own retry — whose latest attempt
 * was paid has been answered for already. Both finish without paying.
 */
export async function beginClassification(
  context: RepositoryContext,
  deps: ClassifyReplyDeps,
  input: { readonly messageId: string; readonly retry: boolean },
): Promise<BeginClassificationOutcome> {
  await lockReply(context, input.messageId);
  const settings = await readClassifierSettings(context);
  const prepared = await prepare(context, input.messageId, settings);
  if (prepared.kind === 'done') return prepared;
  const { deterministic } = prepared;
  const done = async (outcome: SkipReason): Promise<BeginClassificationOutcome> => ({
    kind: 'done',
    report: await skipped(context, input.messageId, deterministic, settings, outcome),
  });
  const quiet: ClassifyReplyOutcome = {
    messageId: input.messageId,
    classification: applyModelSuggestion(asReplyClassification(input.messageId, deterministic), null),
    outcome: 'not_applicable',
    recorded: false,
    call: null,
  };

  const rows = await listAttempts(context, subjectOf(input.messageId));
  if (rows.some(isOpen)) return { kind: 'done', report: quiet };
  const latest = rows[0];
  if (!input.retry && latest !== undefined && latest.state !== 'released') return { kind: 'done', report: quiet };

  // The brief: "a `FSS_CLASSIFIER=off` configuration makes every message `uncertain`
  // with no call". It already is `uncertain`; what this adds is the record that nothing
  // was asked — and a `disabled` attempt is what re-owes the reply once it is back on.
  if (!settings.enabled || deps.processEnabled === false) return await done('disabled');
  if (paidAttempts(rows) >= CLASSIFY_MAX_PAID_ATTEMPTS || rows.length >= CLASSIFY_MAX_ROWS) return await done('capped');

  // The one lock order: this reply, the classifier's daily budget, then the month.
  await lockClassifierBudget(context);
  const at = await databaseNow(context);
  const zone = await workspaceBusinessZone(context);
  const today = await classifierRequestsOn(context, localDate(at, zone));
  if (settings.dailyCallCap === 0 || today >= settings.dailyCallCap) return await done('capped');
  const transport = deps.transport ?? 'anthropic';
  const providerKey = classifierProviderKey(transport);
  const cents = classifierCallCeilingCents(settings, prepared.input, transport);
  // The month's cash ceiling is for cash (slice BR1): a credit-funded attempt is not cleared
  // against it, as Amazon Transcribe's is not (`calls/transcription.ts`).
  if (providerFunding(providerKey) === 'cash' && !(await clearMonthlyCash(context, { at, zone, cents }))) return await done('capped');
  const attempt = rows.reduce((highest, row) => Math.max(highest, row.attempt), 0) + 1;
  await reserveAttempt(context, {
    providerKey,
    ...subjectOf(input.messageId),
    attempt,
    at,
    businessTimeZone: zone,
    cents,
    modelName: settings.modelName,
    maxInputTokens: classifierInputTokenBound(settings, prepared.input),
    maxOutputTokens: settings.maxOutputTokens,
  });
  return { kind: 'reserved', attempt };
}

export type EnsureClassificationOutcome =
  | { readonly kind: 'calling'; readonly attempt: number; readonly plan: ClassifierRequestPlan }
  /**
   * The reservation was made for the other transport (slice BR1: a worker that changed
   * `FSS_MODEL_TRANSPORT` between chunk 1 and chunk 2). Released, nothing sent; chunk 1
   * reserves again under this worker's transport.
   */
  | { readonly kind: 'retry' }
  | { readonly kind: 'done'; readonly report: ClassifyReplyOutcome };

/**
 * Chunk 2, its own commit: the request is built, then the final pause read and the
 * month's ceiling, then the attempt moves to `calling` — and nothing that can block comes
 * between that commit and the request (chunk 3 sends first and reads after).
 *
 * The final read comes **after** the monthly lock, and under the classifier switch lock
 * that every write of `classifier_settings` takes exclusively: a turn-off that commits
 * while this chunk waits for the month is read here, and one that commits after this
 * chunk's commit counts it as submitted (the e-mail fence's reading). Off releases the
 * reservation and records `disabled`, which leaves the reply owed for when it is back on.
 *
 * The request is the one the reservation priced: its model and its output bound, so a
 * settings change between the chunks cannot send something the cents did not cover.
 */
export async function ensureClassificationCalling(
  context: RepositoryContext,
  deps: ClassifyReplyDeps,
  input: { readonly messageId: string; readonly attempt: number },
): Promise<EnsureClassificationOutcome> {
  await lockReply(context, input.messageId);
  const row = await readAttempt(context, { ...subjectOf(input.messageId), attempt: input.attempt });
  if (row === null || row.state !== 'reserved') {
    return { kind: 'done', report: { messageId: input.messageId, classification: null, outcome: 'not_applicable', recorded: false, call: null } };
  }
  const release = async (): Promise<void> => {
    await settleAttempt(context, { reservationId: row.id, at: await databaseNow(context), outcome: { kind: 'released' } });
  };
  // Never one transport against money reserved — and priced, and funded — for the other.
  if (row.providerKey !== classifierProviderKey(deps.transport ?? 'anthropic')) {
    await release();
    return { kind: 'retry' };
  }
  const before = await readClassifierSettings(context);
  const prepared = await prepare(context, input.messageId, before);
  if (prepared.kind === 'done') {
    await release();
    return prepared;
  }
  const at = await databaseNow(context);
  const zone = await workspaceBusinessZone(context);
  // The month, then the switch: the last two things read before the commit.
  // A credit-funded attempt was never cleared against the cash ceiling, so it is not
  // stopped by it either (slice BR1).
  const withinMonth = providerFunding(row.providerKey) === 'cash' ? await monthWithinCeiling(context, { at, zone }) : true;
  await lockClassifierSwitch(context, 'shared');
  const settings = await readClassifierSettings(context);
  if (!settings.enabled || deps.processEnabled === false) {
    await release();
    return { kind: 'done', report: await skipped(context, input.messageId, prepared.deterministic, settings, 'disabled') };
  }
  if (!withinMonth) {
    await release();
    return { kind: 'done', report: await skipped(context, input.messageId, prepared.deterministic, settings, 'capped') };
  }
  const priced: ClassifierSettings = {
    ...settings,
    modelName: row.modelName as ClassifierSettings['modelName'],
    maxOutputTokens: row.maxOutputTokens,
  };
  if (!(await markCalling(context, row.id))) {
    return { kind: 'done', report: { messageId: input.messageId, classification: null, outcome: 'not_applicable', recorded: false, call: null } };
  }
  return {
    kind: 'calling',
    attempt: input.attempt,
    plan: { settings: priced, input: prepared.input, deterministicSignals: prepared.deterministic.signals },
  };
}

export type FinishClassificationOutcome =
  | { readonly kind: 'done'; readonly report: ClassifyReplyOutcome }
  /** Ambiguous and estimated; another paid attempt is allowed and goes through chunk 1. */
  | { readonly kind: 'retry'; readonly report: ClassifyReplyOutcome };

/**
 * Chunk 3: the request first, then the record. The reservation is settled by id at the
 * answer's reported cost; an ambiguous failure keeps its reservation as an estimate; a
 * request that never left the process is released. A rollback of this chunk (a database
 * error, a lost lease) leaves the row `calling`, committed by chunk 2, and the sweep
 * estimates it — so the money is recorded whatever happens to the handler.
 */
export async function finishClassification(
  context: RepositoryContext,
  deps: ClassifyReplyDeps,
  input: { readonly messageId: string; readonly attempt: number; readonly plan: ClassifierRequestPlan },
): Promise<FinishClassificationOutcome> {
  const attempt = await deps.classifierFor(input.plan.settings).classify(input.plan.input);

  await lockReply(context, input.messageId);
  // The month before the message's rows (P1 final round, #4): the deletion workflow takes the
  // monthly lock before it deletes a message, so recording this attempt (its rows reference
  // the message) comes after the monthly lock here too.
  await lockMonthlySpend(context);
  const row = await readAttempt(context, { ...subjectOf(input.messageId), attempt: input.attempt });
  await recordClassifierCall(context, { messageId: input.messageId, call: attempt.call });
  const at = await databaseNow(context);
  const failed = attempt.call.outcome === 'provider_error';
  // A 4xx other than 408 is the API refusing the request before generation: it billed
  // nothing and would refuse the next one the same way. Settled at 0, terminal.
  const refused = failed && attempt.provider?.refused === true;
  const ambiguous = failed && !refused;
  if (row !== null) {
    await settleAttempt(context, {
      reservationId: row.id,
      at,
      outcome: !attempt.call.requestSent
        ? { kind: 'released_not_called' }
        : refused
          ? { kind: 'settled', cents: 0 }
          : ambiguous || !attempt.usageReported
          ? // No reported counts: the reservation is the cost, never a computed zero.
            { kind: 'estimated' }
          : {
              kind: 'settled',
              // At the price of the transport the reservation was made for, which chunk 2
              // checked is this worker's.
              cents: classifierCallCents(input.plan.settings.modelName, attempt.call, transportOfProviderKey(row.providerKey)),
            },
    });
    if (attempt.call.requestSent) {
      // A count and a failure code for the ledger's day; the cents are the reservation's.
      await recordProviderCall(context, {
        providerKey: row.providerKey,
        at,
        businessTimeZone: row.businessTimeZone,
        costCents: 0,
        ...(refused ? { failureCode: 'provider_refused' } : ambiguous ? { failureCode: 'provider_error' } : {}),
      });
    }
  }

  const deterministic = (await listClassifications(context, input.messageId)).find(r => r.layer === 'deterministic');
  const base = deterministic === undefined ? null : asReplyClassification(input.messageId, deterministic);
  if (!attempt.ok) {
    // Appendix G 34: "Malformed output becomes uncertain." So does a refusal, a
    // schema failure, a fabricated quote and a provider error. The card keeps the
    // deterministic answer and says the model had nothing to add.
    const report: ClassifyReplyOutcome = {
      messageId: input.messageId,
      classification: base === null ? null : applyModelSuggestion(base, null),
      outcome: attempt.call.outcome,
      recorded: false,
      call: attempt.call,
      ...(attempt.provider === undefined ? {} : { provider: attempt.provider }),
    };
    if (ambiguous) {
      const rows = await listAttempts(context, subjectOf(input.messageId));
      if (paidAttempts(rows) < CLASSIFY_MAX_PAID_ATTEMPTS && rows.length < CLASSIFY_MAX_ROWS) return { kind: 'retry', report };
    }
    return { kind: 'done', report };
  }

  const recorded = await recordModelClassification(context, {
    messageId: input.messageId,
    suggestion: attempt.suggestion,
    effort: attempt.call.effort,
    deterministicSignals: input.plan.deterministicSignals,
  });
  return {
    kind: 'done',
    report: {
      messageId: input.messageId,
      classification:
        base === null
          ? null
          : applyModelSuggestion(base, {
              class: attempt.suggestion.class,
              ...(attempt.suggestion.disposition === null ? {} : { disposition: attempt.suggestion.disposition }),
              confidence: attempt.suggestion.confidence,
            }),
      outcome: 'accepted',
      recorded,
      call: attempt.call,
    },
  };
}

/**
 * Settle a `calling` attempt this job marked under an earlier claim (its cursor says
 * `calling` and the fencing token is not this claim's): the call may have happened, so it
 * is estimated, and a retry goes through chunk 1's bounds again.
 */
export async function estimateAbandonedAttempt(
  context: RepositoryContext,
  input: { readonly messageId: string; readonly attempt: number },
): Promise<void> {
  await lockReply(context, input.messageId);
  const row = await readAttempt(context, { ...subjectOf(input.messageId), attempt: input.attempt });
  if (row !== null && row.state === 'calling') {
    await settleAttempt(context, { reservationId: row.id, at: await databaseNow(context), outcome: { kind: 'estimated' } });
  }
}

/**
 * Release an attempt this claim marked and then could not send (its request is not in this
 * process): `released_not_called`, which only the marking claim may write.
 */
export async function releaseUnsentAttempt(
  context: RepositoryContext,
  input: { readonly messageId: string; readonly attempt: number },
): Promise<void> {
  await lockReply(context, input.messageId);
  const row = await readAttempt(context, { ...subjectOf(input.messageId), attempt: input.attempt });
  if (row !== null && row.state === 'calling') {
    await settleAttempt(context, { reservationId: row.id, at: await databaseNow(context), outcome: { kind: 'released_not_called' } });
  }
}

/**
 * The three chunks in one go, in the caller's transaction — for a test or a tool that
 * wants one answer. The job (`handler.ts`) runs them as three commits, which is what makes
 * the money durable; this composition is not how production classifies a reply.
 */
export async function classifyReplyWithModel(
  context: RepositoryContext,
  deps: ClassifyReplyDeps,
  input: { readonly messageId: string },
): Promise<ClassifyReplyOutcome> {
  // One attempt: a retry of an ambiguous answer is the job's (its cursor goes back to chunk 1).
  const begun = await beginClassification(context, deps, { messageId: input.messageId, retry: false });
  if (begun.kind === 'done') return begun.report;
  const calling = await ensureClassificationCalling(context, deps, { messageId: input.messageId, attempt: begun.attempt });
  if (calling.kind === 'done') return calling.report;
  // Reserved for another transport and released (slice BR1): nothing was asked.
  if (calling.kind === 'retry') {
    return { messageId: input.messageId, classification: null, outcome: 'not_applicable', recorded: false, call: null };
  }
  return (await finishClassification(context, deps, { messageId: input.messageId, attempt: begun.attempt, plan: calling.plan })).report;
}

/**
 * Finalise classifier reservations whose claim is gone: open `CLASSIFY_SWEEP_MINUTES`
 * after they were written. `reserved` is released (nothing was sent), `calling` estimated
 * (a request may have been). A reply whose lock a live claim holds is skipped.
 */
export async function sweepClassificationReservations(
  context: RepositoryContext,
): Promise<{ readonly released: number; readonly estimated: number }> {
  const { rows } = await context.db.query<{ id: string; subject_id: string; state: string }>(
    `SELECT id, subject_id, state FROM provider_reservations
      WHERE workspace_id = $1 AND subject_kind = $2 AND state IN ('reserved', 'calling')
        AND created_at + make_interval(mins => $3) <= now()
      ORDER BY subject_id`,
    [context.scope.workspaceId, CLASSIFICATION_SUBJECT_KIND, CLASSIFY_SWEEP_MINUTES],
  );
  let released = 0;
  let estimated = 0;
  const at = new Date().toISOString();
  for (const row of rows) {
    if (!(await tryLockReply(context, row.subject_id))) continue;
    const outcome = row.state === 'calling' ? ({ kind: 'estimated' } as const) : ({ kind: 'released' } as const);
    if ((await settleAttempt(context, { reservationId: row.id, at, outcome })) === null) continue;
    if (row.state === 'calling') estimated += 1;
    else released += 1;
  }
  return { released, estimated };
}

/** The workspaces the classifier sweep would find work in now. */
export async function workspacesOwingClassificationSweep(db: RepositoryContext['db']): Promise<readonly string[]> {
  const { rows } = await db.query<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id FROM provider_reservations
      WHERE subject_kind = $1 AND state IN ('reserved', 'calling')
        AND created_at + make_interval(mins => $2) <= now()
      ORDER BY workspace_id`,
    [CLASSIFICATION_SUBJECT_KIND, CLASSIFY_SWEEP_MINUTES],
  );
  return rows.map(row => row.workspace_id);
}
