import type { RepositoryContext } from '../db/workspaceScope.ts';
import type { SessionQueryable } from '../db/queryable.ts';
import type { ReplyClass, ReplyDisposition } from '@fss/contracts';
import { CLASSIFIER_PROMPT_VERSION, type ClassifierCallRecord, type ModelSuggestion } from './types.ts';

/**
 * Reading and writing the two classification layers and the call log
 * (specification 12.4, 13.4).
 *
 * The one rule this file exists to make structural: **nothing here ever writes a
 * class other than `uncertain` into a model row.** The value is a literal in the
 * INSERT rather than a parameter, so it is not possible to pass the wrong thing, and
 * `mail_message_classifications_model_cannot_decide` refuses it in the database
 * anyway. Two walls, because it is the wall.
 *
 * The suggestion's own class is kept in `signals` as
 * `{ rule: 'model_class', evidence: 'automated@0.92' }`. That is 12.4's "automated
 * messages are evidence" applied to the model itself: a confident wrong label is
 * something a person reading the card should be able to see, and something a drift
 * report should be able to count, without it ever being the row's class.
 */

export interface ClassificationRow {
  readonly layer: 'deterministic' | 'model';
  readonly class: ReplyClass;
  readonly suggestedDisposition: ReplyDisposition | null;
  readonly signals: readonly { readonly rule: string; readonly evidence: string }[];
  readonly requiresConfirmation: boolean;
  readonly rulesVersion: string;
  readonly modelName: string | null;
  readonly promptVersion: string | null;
  readonly confidence: number | null;
  readonly supportingExcerpt: string | null;
  readonly callbackProposal: { readonly localDateTime: string; readonly timeZone: string | null } | null;
  readonly effort: string | null;
  readonly classifiedAt: string;
}

interface ClassificationDbRow {
  readonly layer: 'deterministic' | 'model';
  readonly class: ReplyClass;
  readonly suggested_disposition: ReplyDisposition | null;
  readonly signals: unknown;
  readonly requires_confirmation: boolean;
  readonly rules_version: string;
  readonly model_name: string | null;
  readonly prompt_version: string | null;
  readonly confidence: string | null;
  readonly supporting_excerpt: string | null;
  readonly callback_proposal: { readonly localDateTime?: string; readonly timeZone?: string | null } | null;
  readonly effort: string | null;
  readonly classified_at: Date;
  readonly [column: string]: unknown;
}

function toRow(row: ClassificationDbRow): ClassificationRow {
  const signals = Array.isArray(row.signals)
    ? (row.signals as { rule?: unknown; evidence?: unknown }[])
        .filter(signal => typeof signal.rule === 'string')
        .map(signal => ({ rule: String(signal.rule), evidence: String(signal.evidence ?? '') }))
    : [];
  const proposal = row.callback_proposal;
  return {
    layer: row.layer,
    class: row.class,
    suggestedDisposition: row.suggested_disposition,
    signals,
    requiresConfirmation: row.requires_confirmation,
    rulesVersion: row.rules_version,
    modelName: row.model_name,
    promptVersion: row.prompt_version,
    // numeric(4,3) arrives as a string; a number is what a card shows.
    confidence: row.confidence === null ? null : Number(row.confidence),
    supportingExcerpt: row.supporting_excerpt,
    callbackProposal:
      proposal === null || typeof proposal.localDateTime !== 'string'
        ? null
        : { localDateTime: proposal.localDateTime, timeZone: proposal.timeZone ?? null },
    effort: row.effort,
    classifiedAt: row.classified_at.toISOString(),
  };
}

const CLASSIFICATION_COLUMNS = `layer, class, suggested_disposition, signals, requires_confirmation,
  rules_version, model_name, prompt_version, confidence, supporting_excerpt, callback_proposal, effort,
  classified_at`;

export async function listClassifications(
  context: RepositoryContext,
  messageId: string,
): Promise<readonly ClassificationRow[]> {
  const { rows } = await context.db.query<ClassificationDbRow>(
    `SELECT ${CLASSIFICATION_COLUMNS} FROM mail_message_classifications
      WHERE workspace_id = $1 AND mail_message_id = $2
      ORDER BY layer`,
    [context.scope.workspaceId, messageId],
  );
  return rows.map(toRow);
}

export async function readClassification(
  context: RepositoryContext,
  input: { readonly messageId: string; readonly layer: 'deterministic' | 'model' },
): Promise<ClassificationRow | null> {
  const { rows } = await context.db.query<ClassificationDbRow>(
    `SELECT ${CLASSIFICATION_COLUMNS} FROM mail_message_classifications
      WHERE workspace_id = $1 AND mail_message_id = $2 AND layer = $3`,
    [context.scope.workspaceId, input.messageId, input.layer],
  );
  const row = rows[0];
  return row === undefined ? null : toRow(row);
}

export interface RecordModelClassificationInput {
  readonly messageId: string;
  readonly suggestion: ModelSuggestion;
  readonly effort: string | null;
  /** The deterministic signals the row carries forward, so a card reads one list. */
  readonly deterministicSignals: readonly { readonly rule: string; readonly evidence: string }[];
}

/**
 * Write the model layer. Returns true when this call was the one that wrote it.
 *
 * `class` is the literal `'uncertain'`. `suggestion.class` never reaches the column;
 * it is a signal. A replayed job finds the row already there and does nothing, which
 * is the `business_uniqueness` protection `classify.reply` declares.
 */
export async function recordModelClassification(
  context: RepositoryContext,
  input: RecordModelClassificationInput,
): Promise<boolean> {
  const { suggestion } = input;
  const signals = [
    ...input.deterministicSignals,
    { rule: 'model_class', evidence: `${suggestion.class}@${suggestion.confidence.toFixed(2)}` },
  ];
  const { rows } = await context.db.query<{ id: string }>(
    `INSERT INTO mail_message_classifications
       (workspace_id, mail_message_id, layer, class, suggested_disposition, signals,
        requires_confirmation, rules_version, model_name, prompt_version, confidence,
        supporting_excerpt, callback_proposal, effort)
     VALUES ($1, $2, 'model', 'uncertain', $3, $4::jsonb, true, $5, $6, $7, $8, $9, $10::jsonb, $11)
     ON CONFLICT ON CONSTRAINT mail_message_classifications_one_per_layer DO NOTHING
     RETURNING id`,
    [
      context.scope.workspaceId,
      input.messageId,
      suggestion.disposition,
      JSON.stringify(signals),
      CLASSIFIER_PROMPT_VERSION,
      suggestion.modelVersion,
      suggestion.promptVersion,
      Number(suggestion.confidence.toFixed(3)),
      suggestion.supportingExcerpt,
      suggestion.callbackProposal === null ? null : JSON.stringify(suggestion.callbackProposal),
      input.effort,
    ],
  );
  return rows[0] !== undefined;
}

/**
 * Record one attempt (13.4).
 *
 * The business date is computed by PostgreSQL in the workspace's own zone, for the
 * reason `businessDateOf` gives: the daily cap and the dashboard have to agree about
 * which day a call happened on, and two clocks would not.
 */
export async function recordClassifierCall(
  context: RepositoryContext,
  input: { readonly messageId: string; readonly call: ClassifierCallRecord },
): Promise<void> {
  const { call } = input;
  await context.db.query(
    `INSERT INTO mail_classification_calls
       (workspace_id, mail_message_id, model_name, prompt_version, effort, request_sent, outcome,
        input_tokens, cached_input_tokens, output_tokens, latency_ms, stop_reason, refusal_category,
        business_date)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
            (now() AT TIME ZONE w.business_time_zone)::date
       FROM workspaces w WHERE w.id = $1`,
    [
      context.scope.workspaceId,
      input.messageId,
      call.modelName,
      call.promptVersion,
      call.effort,
      call.requestSent,
      call.outcome,
      call.inputTokens,
      call.cachedInputTokens,
      call.outputTokens,
      call.latencyMs,
      call.stopReason,
      call.refusalCategory,
    ],
  );
}

/** How many requests this workspace has actually sent today. The cap reads it. */
export async function countCallsToday(context: RepositoryContext): Promise<number> {
  const { rows } = await context.db.query<{ sent: string }>(
    `SELECT count(*)::text AS sent
       FROM mail_classification_calls c
       JOIN workspaces w ON w.id = c.workspace_id
      WHERE c.workspace_id = $1
        AND c.request_sent
        AND c.business_date = (now() AT TIME ZONE w.business_time_zone)::date`,
    [context.scope.workspaceId],
  );
  return Number(rows[0]?.sent ?? '0');
}

export interface PendingClassification {
  readonly workspaceId: string;
  readonly messageId: string;
}

/**
 * The messages whose second opinion is still owed: an incoming, matched message
 * whose deterministic layer said `uncertain` and which has no model row.
 *
 * Unscoped, because the scheduler pass runs on one connection for every workspace
 * and materializes a job per row; the *job* carries the workspace and everything it
 * then does goes through a `RepositoryContext`. This is the same shape
 * `listMailboxesDueForSync` has, for the same reason.
 */
export async function listPendingModelClassifications(
  session: SessionQueryable,
  limit: number,
): Promise<readonly PendingClassification[]> {
  const { rows } = await session.query<{ workspace_id: string; id: string }>(
    `SELECT m.workspace_id, m.id
       FROM mail_messages m
       JOIN mail_message_classifications d
         ON d.workspace_id = m.workspace_id AND d.mail_message_id = m.id AND d.layer = 'deterministic'
      WHERE m.direction = 'incoming'
        AND m.matched
        AND d.class = 'uncertain'
        AND NOT EXISTS (
          SELECT 1 FROM mail_message_classifications g
           WHERE g.workspace_id = m.workspace_id AND g.mail_message_id = m.id AND g.layer = 'model'
        )
      ORDER BY m.internal_date, m.id
      LIMIT $1`,
    [Math.max(1, Math.min(limit, 200))],
  );
  return rows.map(row => ({ workspaceId: row.workspace_id, messageId: row.id }));
}

export interface ProposedDisposition {
  readonly disposition: ReplyDisposition | null;
  readonly by: 'deterministic' | 'model' | 'none';
}

/**
 * Which layer's disposition the card proposes, and therefore which one a correction
 * is a correction *of* (8.3, 12.4).
 *
 * The rule is not "deterministic first". It is **whichever layer proved something
 * first**, and the deterministic layer only proves a disposition when it also proved
 * a class: an explicit opt-out, or a salesperson's earlier confirmation. When its
 * class is `uncertain`, its disposition is a keyword heuristic — "this sentence
 * contains a question mark, so perhaps interested" — and a heuristic guess is not
 * evidence the way a header is.
 *
 * So a proven deterministic disposition wins, then the model's, then the
 * deterministic guess as a last resort. Getting this the other way round would have
 * made the corpus's ambiguous opt-out propose `interested`, because the sentence
 * "Could you take me off this thread?" ends in a question mark.
 */
export function proposedDispositionOf(
  deterministic: ClassificationRow | undefined,
  model: ClassificationRow | undefined,
): ProposedDisposition {
  const proved = deterministic !== undefined && deterministic.class !== 'uncertain';
  if (proved && deterministic.suggestedDisposition != null) {
    return { disposition: deterministic.suggestedDisposition, by: 'deterministic' };
  }
  if (model?.suggestedDisposition != null) return { disposition: model.suggestedDisposition, by: 'model' };
  if (deterministic?.suggestedDisposition != null) {
    return { disposition: deterministic.suggestedDisposition, by: 'deterministic' };
  }
  return { disposition: null, by: 'none' };
}
