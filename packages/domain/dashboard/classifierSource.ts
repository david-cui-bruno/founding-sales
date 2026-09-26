import { readClassifierSettings } from '../classification/settings.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import type {
  ClassifierFacts,
  DashboardAudience,
  DashboardWindow,
  KeyedCount,
} from './sources.ts';

/**
 * 13.4's "classifier cost and drift", read from G7b's tables (migration 0011).
 *
 * ## Cost is tokens, because tokens are what was measured
 *
 * `mail_classification_calls` records input, cached-input and output tokens and a
 * latency. It records no price, and nothing else in this build does either. The
 * obvious move — multiply by a rate and report dollars — would put a price list in
 * a dashboard query, where it would go stale the next time one changed and nobody
 * would notice, because a plausible wrong number looks exactly like a right one.
 * So the figures are the ones the table holds. A price belongs beside the model
 * configuration if it is ever wanted, not here.
 *
 * Every attempt is counted, including the ones that deliberately sent nothing:
 * `disabled`, `capped` and `not_applicable` are rows too. That is G7b's design and
 * it is the useful one — a sudden run of `not_applicable` is a mail lane that has
 * stopped classifying, and it shows up next to the spend rather than nowhere.
 *
 * ## Drift is corrected against accepted, not corrected alone
 *
 * `mail_reply_confirmations.corrected` is a stored boolean the database keeps
 * honest: a CHECK ties it to `suggested_disposition IS DISTINCT FROM disposition`,
 * so it cannot drift from the two columns it summarises. On its own it says nothing
 * — ten corrections is excellent out of a thousand and alarming out of twelve — so
 * the DTO carries `confirmations`, `accepted`, `corrected` and the rate, and the
 * rate is null rather than zero when nobody confirmed anything.
 *
 * `correctedBySuggester` splits it by who proposed: `deterministic`, `model` or
 * `none`. 12.4 lets the model say only `uncertain`, so a correction against a
 * deterministic suggestion and one against the model's are different bugs in
 * different places.
 *
 * ## The read matrix
 *
 * Two different rules, because these are two different kinds of row.
 *
 * A classification call hangs off a mail message, which belongs to a mailbox, and
 * Appendix F row 3 gives mailbox facts to the mailbox's owner or an admin. A
 * confirmation names a firm, so it follows the dashboard's own audience rule at row
 * 2. In the one-mailbox-per-member workspace these coincide; they are written
 * separately because they would not in a workspace with a shared mailbox, and the
 * rule should be right before that happens rather than after.
 *
 * The settings — model, effort, cap — are not gated at all, deliberately: G7b's
 * `/replies/settings` is a read every salesperson may make, because a reply card
 * names the model that produced its suggestion and the person reading it is
 * entitled to know which.
 */

type CallsRow = {
  readonly [column: string]: unknown;
  attempted: string;
  sent: string;
  input_tokens: string;
  cached_input_tokens: string;
  output_tokens: string;
  latency_ms: string;
};

type KeyedRow = {
  readonly [column: string]: unknown;
  dimension: string;
  key: string;
  count: string;
};

type ConfirmationRow = {
  readonly [column: string]: unknown;
  confirmations: string;
  corrected: string;
};

export async function classifierFacts(
  context: RepositoryContext,
  window: DashboardWindow,
  audience: DashboardAudience,
): Promise<ClassifierFacts> {
  const scope = [context.scope.workspaceId, window.from, window.to, audience.onlyAssignedTo];
  const settings = await readClassifierSettings(context);

  const calls = await context.db.query<CallsRow>(
    `SELECT count(*)::text AS attempted,
            count(*) FILTER (WHERE c.request_sent)::text AS sent,
            coalesce(sum(c.input_tokens), 0)::text AS input_tokens,
            coalesce(sum(c.cached_input_tokens), 0)::text AS cached_input_tokens,
            coalesce(sum(c.output_tokens), 0)::text AS output_tokens,
            coalesce(sum(c.latency_ms), 0)::text AS latency_ms
       FROM mail_classification_calls c
       JOIN mail_messages m ON m.workspace_id = c.workspace_id AND m.id = c.mail_message_id
       JOIN mailboxes mb ON mb.workspace_id = m.workspace_id AND mb.id = m.mailbox_id
      WHERE c.workspace_id = $1
        AND c.called_at >= $2::timestamptz AND c.called_at < $3::timestamptz
        AND ($4::uuid IS NULL OR mb.owner_user_id = $4::uuid)`,
    scope,
  );

  const keyed = await context.db.query<KeyedRow>(
    `SELECT 'outcome' AS dimension, c.outcome AS key, count(*)::text AS count
       FROM mail_classification_calls c
       JOIN mail_messages m ON m.workspace_id = c.workspace_id AND m.id = c.mail_message_id
       JOIN mailboxes mb ON mb.workspace_id = m.workspace_id AND mb.id = m.mailbox_id
      WHERE c.workspace_id = $1
        AND c.called_at >= $2::timestamptz AND c.called_at < $3::timestamptz
        AND ($4::uuid IS NULL OR mb.owner_user_id = $4::uuid)
      GROUP BY 1, 2
     UNION ALL
     SELECT 'prompt', c.prompt_version, count(*)::text
       FROM mail_classification_calls c
       JOIN mail_messages m ON m.workspace_id = c.workspace_id AND m.id = c.mail_message_id
       JOIN mailboxes mb ON mb.workspace_id = m.workspace_id AND mb.id = m.mailbox_id
      WHERE c.workspace_id = $1
        AND c.called_at >= $2::timestamptz AND c.called_at < $3::timestamptz
        AND ($4::uuid IS NULL OR mb.owner_user_id = $4::uuid)
      GROUP BY 1, 2
     UNION ALL
     SELECT 'corrected_by', r.suggested_by, count(*)::text
       FROM mail_reply_confirmations r
       JOIN firms f ON f.workspace_id = r.workspace_id AND f.id = r.firm_id
      WHERE r.workspace_id = $1 AND r.corrected
        AND r.created_at >= $2::timestamptz AND r.created_at < $3::timestamptz
        AND ($4::uuid IS NULL OR f.assigned_user_id = $4::uuid)
      GROUP BY 1, 2
     ORDER BY 1, 2`,
    scope,
  );

  const confirmations = await context.db.query<ConfirmationRow>(
    `SELECT count(*)::text AS confirmations,
            count(*) FILTER (WHERE r.corrected)::text AS corrected
       FROM mail_reply_confirmations r
       JOIN firms f ON f.workspace_id = r.workspace_id AND f.id = r.firm_id
      WHERE r.workspace_id = $1
        AND r.created_at >= $2::timestamptz AND r.created_at < $3::timestamptz
        AND ($4::uuid IS NULL OR f.assigned_user_id = $4::uuid)`,
    scope,
  );

  const call = calls.rows[0];
  const confirmed = Number(confirmations.rows[0]?.confirmations ?? '0');
  const corrected = Number(confirmations.rows[0]?.corrected ?? '0');
  const of = (dimension: string): readonly KeyedCount[] =>
    keyed.rows
      .filter(entry => entry.dimension === dimension)
      .map(entry => ({ key: entry.key, count: Number(entry.count) }));

  return {
    available: true,
    enabled: settings.enabled,
    modelName: settings.modelName,
    effort: settings.effort,
    dailyCallCap: settings.dailyCallCap,
    promptVersions: of('prompt').map(entry => entry.key),
    callsAttempted: Number(call?.attempted ?? '0'),
    callsSent: Number(call?.sent ?? '0'),
    byOutcome: of('outcome'),
    inputTokens: Number(call?.input_tokens ?? '0'),
    cachedInputTokens: Number(call?.cached_input_tokens ?? '0'),
    outputTokens: Number(call?.output_tokens ?? '0'),
    totalLatencyMs: Number(call?.latency_ms ?? '0'),
    confirmations: confirmed,
    accepted: confirmed - corrected,
    corrected,
    // Null, not zero: "nobody has corrected anything" and "nobody has confirmed
    // anything" are the same number and very different sentences.
    correctionRate: confirmed === 0 ? null : corrected / confirmed,
    correctedBySuggester: of('corrected_by'),
  };
}
