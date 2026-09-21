import type { Queryable } from '../db/queryable.ts';

/**
 * The reconciliation counts of Appendix E steps 0 and 8 (Appendix G 11).
 *
 * "A restore predating an accepted send, reply, suppression, ordinary CRM edit and
 * migration: protected effects reconstruct, the accepted CRM RPO is reported, no send
 * repeats." Those five nouns are the five counts, and the drill refuses to report a
 * pass when any of them is zero — so this is the function whose answer decides whether
 * the drill was set up at all.
 *
 * ## Why these reads are session-level rather than workspace-scoped
 *
 * Every business read in this repository goes through a `WorkspaceScope`, and these do
 * not: they aggregate across every workspace, which is what a restore is about — the
 * database was restored, not a workspace. `listWatchesDue`, `listIncompleteRecoveries`
 * and `listMailboxesToReconcile` are the same shape and the same reason. The safety
 * this gives up is real, so it is bought back twice: nothing here writes, and every
 * count is also reported per workspace, which is what makes a query that lost its
 * `workspace_id` show up as a doubling rather than as a plausible number.
 *
 * ## Why `--as-of` is a parameter and not `now()`
 *
 * The baseline is measured at the instant the restore will be taken to, before the
 * restore, and compared with the same instant afterwards. A count of "now" on each
 * side would be two different questions and their difference would be meaningless.
 */

/**
 * What an ordinary CRM edit's audit action looks like.
 *
 * `read.firm_detail` and `export.firms` are reads and are deliberately absent: the
 * drill's fifth kind is "an ordinary CRM edit with no protected effect", and an
 * export is neither ordinary nor an edit.
 */
export const CRM_EDIT_ACTION_PREFIXES: readonly string[] = Object.freeze([
  'firm.',
  'contact.',
  'opportunity.',
  'pipeline.',
]);

/** The effect kinds that say a reply reapplied its effect (12.3, 12.4). */
export const REPLY_EFFECT_KINDS: readonly string[] = Object.freeze(['opportunity_manual', 'reply_lane_entry']);
/** The effect kinds that say an opt-out reapplied (10.2). */
export const OPT_OUT_EFFECT_KINDS: readonly string[] = Object.freeze(['handle_suppressed', 'firm_suppressed']);

export interface WorkspaceRestoreCounts {
  readonly workspaceId: string;
  readonly sends: number;
  readonly replies: number;
  readonly suppressions: number;
  readonly crm_edits: number;
}

export interface RestoreCounts extends Omit<WorkspaceRestoreCounts, 'workspaceId'> {
  /** The instant every count is measured at. Echoed so a report cannot lose it. */
  readonly asOf: string;
  /** `schema_versions` has no workspace, so the migrations are counted once. */
  readonly migrations: number;
  readonly workspaces: readonly WorkspaceRestoreCounts[];
}

const number = (value: string | null | undefined): number => Number(value ?? '0');

/** Every workspace id, in a stable order. The same read the worker's sources make. */
export async function listWorkspaceIds(db: Queryable): Promise<readonly string[]> {
  const { rows } = await db.query<{ id: string }>('SELECT id FROM workspaces ORDER BY id');
  return rows.map(row => row.id);
}

export interface RestoreCountsOptions {
  /** Defaults to database time, which is the "at failure" reading of step 0.1. */
  readonly asOf?: string | undefined;
}

export async function readRestoreCounts(
  db: Queryable,
  options: RestoreCountsOptions = {},
): Promise<RestoreCounts> {
  const asOfRow = await db.query<{ at: Date }>('SELECT coalesce($1::timestamptz, now()) AS at', [
    options.asOf ?? null,
  ]);
  const at = asOfRow.rows[0]?.at;
  if (at === undefined) throw new Error('the database did not answer what time it is');
  const asOf = options.asOf ?? at.toISOString();

  const { rows } = await db.query<{
    workspace_id: string;
    sends: string;
    replies: string;
    suppressions: string;
    crm_edits: string;
  }>(
    `SELECT w.id AS workspace_id,
            (SELECT count(*) FROM outbound_messages o
              WHERE o.workspace_id = w.id AND o.state = 'sent' AND o.sent_at <= $1::timestamptz)::text AS sends,
            (SELECT count(DISTINCT e.mail_message_id) FROM mail_message_effects e
              WHERE e.workspace_id = w.id AND e.applied_at <= $1::timestamptz
                AND e.effect_kind = ANY ($2::text[]))::text AS replies,
            (SELECT count(*) FROM suppression_events s
              WHERE s.workspace_id = w.id AND s.recorded_at <= $1::timestamptz)::text AS suppressions,
            (SELECT count(*) FROM audit_events a
              WHERE a.workspace_id = w.id AND a.occurred_at <= $1::timestamptz
                AND a.action LIKE ANY ($3::text[]))::text AS crm_edits
       FROM workspaces w
      ORDER BY w.id`,
    [asOf, [...REPLY_EFFECT_KINDS], CRM_EDIT_ACTION_PREFIXES.map(prefix => `${prefix}%`)],
  );

  const migrations = await db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM schema_versions WHERE applied_at <= $1::timestamptz',
    [asOf],
  );

  const workspaces = rows.map(row => ({
    workspaceId: row.workspace_id,
    sends: number(row.sends),
    replies: number(row.replies),
    suppressions: number(row.suppressions),
    crm_edits: number(row.crm_edits),
  }));
  const total = (pick: (entry: WorkspaceRestoreCounts) => number): number =>
    workspaces.reduce((sum, entry) => sum + pick(entry), 0);

  return {
    asOf,
    sends: total(entry => entry.sends),
    replies: total(entry => entry.replies),
    suppressions: total(entry => entry.suppressions),
    crm_edits: total(entry => entry.crm_edits),
    migrations: number(migrations.rows[0]?.count),
    workspaces,
  };
}

/**
 * The newest ordinary CRM edit the database still knows about.
 *
 * This is the other half of the accepted CRM recovery point objective: the drill's
 * baseline says which instant it measured, and this says how far the restored database
 * actually reaches. The difference is the number section 8 of the runbook requires to
 * be reported rather than hidden.
 */
export async function newestCrmEditAt(db: Queryable): Promise<string | null> {
  const { rows } = await db.query<{ at: Date | null }>(
    `SELECT max(occurred_at) AS at FROM audit_events WHERE action LIKE ANY ($1::text[])`,
    [CRM_EDIT_ACTION_PREFIXES.map(prefix => `${prefix}%`)],
  );
  const at = rows[0]?.at;
  return at === null || at === undefined ? null : at.toISOString();
}

export interface RecoveryEffectCounts {
  readonly replies: number;
  readonly opt_outs: number;
  readonly direct_sends: number;
  readonly bounces: number;
}

/**
 * What Appendix E step 4 reapplied, in the four names the drill parses.
 *
 * Each is a `mail_message_effects` kind rather than a message count, because the step
 * is about effects: "replies, opt-outs, direct sends and bounces reapply their
 * effects", and a reply whose effect did not reapply is the failure this counts.
 */
export async function countRecoveryEffects(
  db: Queryable,
  options: { readonly since: string },
): Promise<RecoveryEffectCounts> {
  const { rows } = await db.query<{
    replies: string;
    opt_outs: string;
    direct_sends: string;
    bounces: string;
  }>(
    `SELECT count(DISTINCT CASE WHEN effect_kind = ANY ($2::text[]) THEN mail_message_id END)::text AS replies,
            count(DISTINCT CASE WHEN effect_kind = ANY ($3::text[]) THEN mail_message_id END)::text AS opt_outs,
            count(DISTINCT CASE WHEN effect_kind = 'direct_send_manual' THEN mail_message_id END)::text AS direct_sends,
            count(DISTINCT CASE WHEN effect_kind = 'route_invalidated' THEN mail_message_id END)::text AS bounces
       FROM mail_message_effects
      WHERE applied_at >= $1::timestamptz`,
    [options.since, [...REPLY_EFFECT_KINDS], [...OPT_OUT_EFFECT_KINDS]],
  );
  const row = rows[0];
  return {
    replies: number(row?.replies),
    opt_outs: number(row?.opt_outs),
    direct_sends: number(row?.direct_sends),
    bounces: number(row?.bounces),
  };
}

/**
 * How many step executions have more than one accepted send.
 *
 * Invariant 1 of the specification is "no duplicate automated email for the same
 * sequence step", and the fence is what enforces it. This is the count that says
 * whether it held across the restore, and the drill fails the release outright when it
 * is not zero. It is a database question rather than a report field for a reason: a
 * reconciliation report that asserted its own correctness would prove nothing.
 */
export async function countRepeatedSends(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM (SELECT workspace_id, step_execution_id
               FROM outbound_messages
              WHERE state = 'sent' AND step_execution_id IS NOT NULL
              GROUP BY workspace_id, step_execution_id
             HAVING count(*) > 1) AS repeated`,
  );
  return number(rows[0]?.count);
}
