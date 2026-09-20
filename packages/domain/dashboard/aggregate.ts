import type { RepositoryContext } from '../db/workspaceScope.ts';
import {
  unavailableDashboardSources,
  type ClassifierFacts,
  type DashboardAudience,
  type DashboardSources,
  type DashboardWindow,
  type EnrollmentFacts,
  type SendingFacts,
  type Unavailable,
} from './sources.ts';

/**
 * The minimum performance dashboard (specification 13.4, Appendix F).
 *
 * "Dashboard queries use aggregate/redacted DTOs and respect the read matrix."
 *
 * Two rules make that true here.
 *
 * **Nothing in the DTO names a firm, a contact or a person.** Every field is a count,
 * a duration or a key from a closed set — an outcome, a stage key, a hold reason
 * code. There is no field a name, an address or a message body could go in, which is
 * the same "redaction by construction" `FirmIdentityDto` uses: a later change cannot
 * leak one by forgetting to strip it.
 *
 * **The figures are computed over the firms the caller may see at row-2 visibility.**
 * An admin's dashboard is the workspace; a salesperson's is their own assigned firms.
 * Appendix F does not say what an aggregate is, and the conservative reading is the
 * one where an aggregate is never a way to learn about a colleague's firm — a
 * workspace of two salespeople with one firm each is a workspace where a
 * workspace-wide count *is* the other person's count. See
 * `docs/decisions/g9-dashboard-visibility.md`.
 *
 * The whole read is one function of a window and an audience, with no `now()` of its
 * own: every comparison is made by PostgreSQL against the window the caller named, so
 * two runs over the same window give the same answer.
 */

export interface CountByKey {
  readonly key: string;
  readonly count: number;
}

export interface HoldSummary {
  readonly reasonCode: string;
  readonly count: number;
  readonly oldestAgeSeconds: number;
}

/** 13.4's "time from reply receipt to salesperson handling". */
export interface ReplyHandling {
  readonly replies: number;
  readonly handled: number;
  readonly medianSecondsToHandle: number | null;
  readonly slowestSecondsToHandle: number | null;
}

export interface MessageCounts {
  readonly incomingMatched: number;
  readonly human: number;
  readonly uncertain: number;
  readonly automated: number;
  readonly bounces: number;
  readonly optOuts: number;
}

export interface DashboardDto {
  readonly window: DashboardWindow;
  /** `workspace` for an admin, `assigned` for a salesperson. Shown, never chosen. */
  readonly audience: 'workspace' | 'assigned';
  readonly firmsInScope: number;
  readonly messages: MessageCounts;
  readonly replyHandling: ReplyHandling;
  readonly calls: readonly CountByKey[];
  readonly stageMovement: readonly CountByKey[];
  readonly holds: { readonly open: number; readonly byReason: readonly HoldSummary[] };
  readonly suppressions: readonly CountByKey[];
  readonly sending: SendingFacts | Unavailable;
  readonly enrollments: EnrollmentFacts | Unavailable;
  readonly classifier: ClassifierFacts | Unavailable;
}

function audienceOf(context: RepositoryContext): { readonly label: 'workspace' | 'assigned'; readonly userId: string | null } {
  const actor = context.scope.actor;
  if (actor.kind === 'system' || actor.role === 'admin') return { label: 'workspace', userId: null };
  return { label: 'assigned', userId: actor.userId };
}

const toCount = (rows: readonly { key: string | null; count: string }[]): readonly CountByKey[] =>
  rows
    .filter((row): row is { key: string; count: string } => row.key !== null)
    .map(row => ({ key: row.key, count: Number(row.count) }));

export async function readDashboard(
  context: RepositoryContext,
  input: { readonly window: DashboardWindow; readonly sources?: DashboardSources },
): Promise<DashboardDto> {
  const { label, userId } = audienceOf(context);
  const audience: DashboardAudience = { onlyAssignedTo: userId };
  const sources = input.sources ?? unavailableDashboardSources();
  const scope = [context.scope.workspaceId, input.window.from, input.window.to, userId] as const;

  const firms = await context.db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM firms
      WHERE workspace_id = $1 AND status = 'active'
        AND ($2::uuid IS NULL OR assigned_user_id = $2::uuid)`,
    [context.scope.workspaceId, userId],
  );

  // Inbound matched mail, by the class the deterministic layer gave it. The model
  // layer may only ever say `uncertain` (12.4), so counting the deterministic row is
  // counting the decision rather than the suggestion.
  const messages = await context.db.query<{
    incoming: string;
    human: string;
    uncertain: string;
    automated: string;
    bounce: string;
    opt_out: string;
  }>(
    `SELECT count(*)::text AS incoming,
            count(*) FILTER (WHERE c.class = 'human')::text AS human,
            count(*) FILTER (WHERE c.class = 'uncertain')::text AS uncertain,
            count(*) FILTER (WHERE c.class = 'automated')::text AS automated,
            count(*) FILTER (WHERE c.class = 'bounce')::text AS bounce,
            count(*) FILTER (WHERE c.class = 'opt_out')::text AS opt_out
       FROM mail_messages m
       JOIN mail_message_matches mm ON mm.workspace_id = m.workspace_id AND mm.mail_message_id = m.id
       JOIN firms f ON f.workspace_id = m.workspace_id AND f.id = mm.firm_id
       LEFT JOIN mail_message_classifications c
              ON c.workspace_id = m.workspace_id AND c.mail_message_id = m.id AND c.layer = 'deterministic'
      WHERE m.workspace_id = $1 AND m.direction = 'incoming'
        AND m.internal_date >= $2::timestamptz AND m.internal_date < $3::timestamptz
        AND ($4::uuid IS NULL OR f.assigned_user_id = $4::uuid)`,
    [...scope],
  );

  // 8.2's reply lane is where a reply becomes work, and its completion is where a
  // person handled it. The median rather than the mean: one reply handled after a
  // holiday would otherwise move the number more than a week of good days.
  const handling = await context.db.query<{
    replies: string;
    handled: string;
    median: string | null;
    slowest: string | null;
  }>(
    `SELECT count(*)::text AS replies,
            count(*) FILTER (WHERE t.completed_at IS NOT NULL)::text AS handled,
            (percentile_cont(0.5) WITHIN GROUP (
               ORDER BY extract(epoch FROM t.completed_at - t.created_at)))::text AS median,
            (max(extract(epoch FROM t.completed_at - t.created_at)))::text AS slowest
       FROM today_items t
       JOIN firms f ON f.workspace_id = t.workspace_id AND f.id = t.firm_id
      WHERE t.workspace_id = $1 AND t.kind = 'reply'
        AND t.created_at >= $2::timestamptz AND t.created_at < $3::timestamptz
        AND ($4::uuid IS NULL OR f.assigned_user_id = $4::uuid)`,
    [...scope],
  );

  const calls = await context.db.query<{ key: string | null; count: string }>(
    `SELECT c.outcome AS key, count(*)::text AS count
       FROM call_logs c
       JOIN firms f ON f.workspace_id = c.workspace_id AND f.id = c.firm_id
      WHERE c.workspace_id = $1
        AND c.occurred_at >= $2::timestamptz AND c.occurred_at < $3::timestamptz
        AND ($4::uuid IS NULL OR f.assigned_user_id = $4::uuid)
      GROUP BY c.outcome
      ORDER BY c.outcome`,
    [...scope],
  );

  const stageMovement = await context.db.query<{ key: string | null; count: string }>(
    `SELECT s.key AS key, count(*)::text AS count
       FROM opportunity_stage_events e
       JOIN pipeline_stages s ON s.workspace_id = e.workspace_id AND s.id = e.to_stage_id
       JOIN firms f ON f.workspace_id = e.workspace_id AND f.id = e.firm_id
      WHERE e.workspace_id = $1
        AND e.occurred_at >= $2::timestamptz AND e.occurred_at < $3::timestamptz
        AND ($4::uuid IS NULL OR f.assigned_user_id = $4::uuid)
      GROUP BY s.key
      ORDER BY s.key`,
    [...scope],
  );

  // Open holds are "as of now", not "within the window": a hold that is still
  // blocking work is a fact about the present, and its age is what an operator acts
  // on. The owner filter is the hold's own owner column, because a hold scoped to a
  // mailbox or an owner has no firm to join through.
  const holds = await context.db.query<{ reason_code: string; count: string; oldest: string }>(
    `SELECT h.reason_code, count(*)::text AS count,
            max(extract(epoch FROM now() - h.started_at))::text AS oldest
       FROM active_holds h
      WHERE h.workspace_id = $1 AND h.released_at IS NULL
        AND ($2::uuid IS NULL OR h.owner_user_id IS NULL OR h.owner_user_id = $2::uuid)
      GROUP BY h.reason_code
      ORDER BY h.reason_code`,
    [context.scope.workspaceId, userId],
  );

  // Suppressions by scope. Never by key: a canonical key is an address or a number.
  const suppressions = await context.db.query<{ key: string | null; count: string }>(
    `SELECT scope AS key, count(*)::text AS count
       FROM suppression_events
      WHERE workspace_id = $1
        AND recorded_at >= $2::timestamptz AND recorded_at < $3::timestamptz
      GROUP BY scope
      ORDER BY scope`,
    [context.scope.workspaceId, input.window.from, input.window.to],
  );

  const messageRow = messages.rows[0];
  const handlingRow = handling.rows[0];

  return {
    window: input.window,
    audience: label,
    firmsInScope: Number(firms.rows[0]?.count ?? '0'),
    messages: {
      incomingMatched: Number(messageRow?.incoming ?? '0'),
      human: Number(messageRow?.human ?? '0'),
      uncertain: Number(messageRow?.uncertain ?? '0'),
      automated: Number(messageRow?.automated ?? '0'),
      bounces: Number(messageRow?.bounce ?? '0'),
      optOuts: Number(messageRow?.opt_out ?? '0'),
    },
    replyHandling: {
      replies: Number(handlingRow?.replies ?? '0'),
      handled: Number(handlingRow?.handled ?? '0'),
      medianSecondsToHandle:
        handlingRow?.median === null || handlingRow?.median === undefined ? null : Number(handlingRow.median),
      slowestSecondsToHandle:
        handlingRow?.slowest === null || handlingRow?.slowest === undefined ? null : Number(handlingRow.slowest),
    },
    calls: toCount(calls.rows),
    stageMovement: toCount(stageMovement.rows),
    holds: {
      open: holds.rows.reduce((total, row) => total + Number(row.count), 0),
      byReason: holds.rows.map(row => ({
        reasonCode: row.reason_code,
        count: Number(row.count),
        oldestAgeSeconds: Math.round(Number(row.oldest)),
      })),
    },
    suppressions: toCount(suppressions.rows),
    sending: await sources.sending(context, input.window, audience),
    enrollments: await sources.enrollments(context, input.window, audience),
    classifier: await sources.classifier(context, input.window, audience),
  };
}
