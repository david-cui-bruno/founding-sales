import type { Queryable } from '../db/queryable.ts';
import type { RestoreCounts } from './counts.ts';

/**
 * Appendix E step 8: "produce reconciliation counts and unresolved exceptions for
 * operator review", and section 11 of `docs/greenfield/restore-drill.md`, which is
 * the table this report answers.
 *
 * Two of its numbers fail the release outright — a repeated send and a lost
 * suppression — and one is a loss the design accepts and the runbook insists is
 * reported rather than hidden: the CRM recovery point objective. So
 * `crm_rpo_seconds` is never optional and never absent; an unknown one is an error,
 * not a zero. The drill asserts `isinstance(report["crm_rpo_seconds"], int)`.
 */

export interface UnresolvedFence {
  readonly workspaceId: string;
  readonly outboundMessageId: string;
  readonly mailboxId: string;
  /** For a `reconciling` fence, when its bounded observation window closes. */
  readonly deadlineAt: string | null;
}

export interface UnresolvedAmbiguity {
  readonly workspaceId: string;
  readonly holdId: string;
  readonly reasonCode: string;
  readonly startedAt: string;
}

export interface UnresolvedExceptions {
  /** Fences inside their 24-hour observation window (Appendix B). Listed, never resolved. */
  readonly reconciling: readonly UnresolvedFence[];
  /** Fences awaiting an admin's delivered/skipped decision (12.5). */
  readonly unknownTerminal: readonly UnresolvedFence[];
  /** Ambiguous or uncertain replies still holding work (12.4). They must still hold. */
  readonly ambiguousHeld: readonly UnresolvedAmbiguity[];
  /** Carried over and still visible to admins (13.2). */
  readonly deadJobs: number;
}

/** The hold reasons an ambiguous or uncertain reply opens (12.4, section 15). */
const AMBIGUITY_REASONS = ['reply_ambiguous', 'reply_uncertain', 'ambiguous_reply', 'uncertain_reply'] as const;

export async function readUnresolvedExceptions(db: Queryable): Promise<UnresolvedExceptions> {
  const fences = await db.query<{
    workspace_id: string;
    id: string;
    mailbox_id: string;
    state: string;
    reconcile_deadline_at: Date | null;
  }>(
    `SELECT workspace_id, id, mailbox_id, state, reconcile_deadline_at
       FROM outbound_messages
      WHERE state IN ('reconciling', 'unknown_terminal')
        AND (state <> 'unknown_terminal' OR admin_resolution IS NULL)
      ORDER BY workspace_id, id`,
  );
  const toFence = (row: {
    workspace_id: string;
    id: string;
    mailbox_id: string;
    reconcile_deadline_at: Date | null;
  }): UnresolvedFence => ({
    workspaceId: row.workspace_id,
    outboundMessageId: row.id,
    mailboxId: row.mailbox_id,
    deadlineAt: row.reconcile_deadline_at === null ? null : row.reconcile_deadline_at.toISOString(),
  });

  const holds = await db.query<{
    workspace_id: string;
    id: string;
    reason_code: string;
    started_at: Date;
  }>(
    `SELECT workspace_id, id, reason_code, started_at
       FROM active_holds
      WHERE released_at IS NULL AND reason_code = ANY ($1::text[])
      ORDER BY workspace_id, started_at`,
    [[...AMBIGUITY_REASONS]],
  );

  const dead = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM jobs WHERE state = 'dead'");

  return {
    reconciling: fences.rows.filter(row => row.state === 'reconciling').map(toFence),
    unknownTerminal: fences.rows.filter(row => row.state === 'unknown_terminal').map(toFence),
    ambiguousHeld: holds.rows.map(row => ({
      workspaceId: row.workspace_id,
      holdId: row.id,
      reasonCode: row.reason_code,
      startedAt: row.started_at.toISOString(),
    })),
    deadJobs: Number(dead.rows[0]?.count ?? '0'),
  };
}

/**
 * What step 3's Sent-folder scan could not settle (lane g73), carried into step 8 from
 * its report because nothing in the database records it: a send with no fence has no
 * row, and a folder that could not be read has left no trace.
 *
 *   * `unattached_sent_message` — an FSS send whose fence the restore lost and which no
 *     single step could be named for, while a live enrollment could still write to its
 *     recipient. `id` is the hash of its Message-ID.
 *   * `sent_folder_unscanned` — a mailbox whose Sent folder the scan could not finish
 *     reading (a revoked grant, a rate limit, more messages than one pass reads). `id`
 *     is the mailbox.
 *
 * Either one means a send the restored database does not know about may exist, so the
 * restore holds must not come off (Appendix E step 9) until an operator has dealt with it.
 */
export interface UnresolvedSentFolderItem {
  readonly kind: 'unattached_sent_message' | 'sent_folder_unscanned';
  readonly workspaceId: string;
  readonly id: string;
  readonly detail: string;
}

/** One line of the report's `unresolved` list: what it is, and which row it is. */
export interface UnresolvedEntry {
  readonly kind:
    | 'reconciling'
    | 'unknown_terminal'
    | 'ambiguous_hold'
    | 'unattached_sent_message'
    | 'sent_folder_unscanned';
  readonly workspaceId: string;
  readonly id: string;
  readonly detail: string;
}

export interface RestoreReport {
  readonly schema: 'fss.restore-report.v1';
  readonly suppressions_before: number;
  readonly suppressions_after: number;
  readonly sends_before: number;
  readonly sends_after: number;
  readonly replies_before: number;
  readonly replies_after: number;
  readonly crm_edits_before: number;
  readonly crm_edits_after: number;
  readonly migrations_before: number;
  readonly migrations_after: number;
  readonly sends_repeated: number;
  /** The accepted loss, in seconds. Reported, never hidden. */
  readonly crm_rpo_seconds: number;
  readonly dead_jobs: number;
  readonly unresolved: readonly UnresolvedEntry[];
  /**
   * The counts at the moment of failure (restore-drill.md step 8's `--at-failure`, lane
   * g59), present only when they were given. They are what the restore lost measured
   * from: `suppressions_after` may never be below `suppressions_at_failure`, and
   * `crm_edits_lost` is the accepted RPO as a count, beside `crm_rpo_seconds`.
   */
  readonly at_failure_as_of?: string;
  readonly suppressions_at_failure?: number;
  readonly sends_at_failure?: number;
  readonly replies_at_failure?: number;
  readonly crm_edits_at_failure?: number;
  readonly migrations_at_failure?: number;
  /**
   * Ordinary CRM edits the database knew at the failure and does not know now: the
   * accepted RPO as a count, beside `crm_rpo_seconds`. Reported, never hidden, and a
   * floor rather than an exact figure, because a reconstruction that writes a CRM audit
   * row of its own (a recovered reply setting an opportunity manual) offsets one lost.
   * There is deliberately no such figure for sends: a send the restore lost and a fence
   * step 3 reconciled count the same in a total, so a difference of totals would hide a
   * lost send behind a reconstructed one.
   */
  readonly crm_edits_lost?: number;
}

export interface ComposeRestoreReportInput {
  /** The baseline, measured before the restore at the instant it restored to. */
  readonly before: Pick<RestoreCounts, 'asOf' | 'sends' | 'replies' | 'suppressions' | 'crm_edits' | 'migrations'>;
  /** The counts at the moment of failure, when known (lane g59). */
  readonly atFailure?:
    | Pick<RestoreCounts, 'asOf' | 'sends' | 'replies' | 'suppressions' | 'crm_edits' | 'migrations'>
    | undefined;
  readonly after: Pick<RestoreCounts, 'asOf' | 'sends' | 'replies' | 'suppressions' | 'crm_edits' | 'migrations'>;
  readonly sendsRepeated: number;
  readonly crmRpoSeconds: number;
  readonly unresolved: UnresolvedExceptions;
  /** Step 3's unsettled Sent-folder items (lane g73), from its report. */
  readonly sentFolder?: readonly UnresolvedSentFolderItem[] | undefined;
}

/**
 * The accepted CRM recovery point objective, in whole seconds.
 *
 * The baseline instant minus the newest CRM edit the restored database still holds. A
 * database that reaches the baseline has lost nothing and the objective is zero; a
 * database with no CRM edit at all has lost everything measurable and the answer is
 * the whole interval from the earliest instant the caller knows, which is why the
 * caller passes that instant rather than this function inventing one.
 */
export function crmRecoveryPointSeconds(baselineAt: string, newestCrmEditAt: string | null): number {
  const baseline = Date.parse(baselineAt);
  if (newestCrmEditAt === null) return 0;
  const newest = Date.parse(newestCrmEditAt);
  if (!Number.isFinite(baseline) || !Number.isFinite(newest)) return 0;
  return Math.max(0, Math.round((baseline - newest) / 1000));
}

export function composeRestoreReport(input: ComposeRestoreReportInput): RestoreReport {
  const unresolved: UnresolvedEntry[] = [
    ...input.unresolved.reconciling.map(fence => ({
      kind: 'reconciling' as const,
      workspaceId: fence.workspaceId,
      id: fence.outboundMessageId,
      detail: `mailbox ${fence.mailboxId}, observation deadline ${fence.deadlineAt ?? 'unset'}`,
    })),
    ...input.unresolved.unknownTerminal.map(fence => ({
      kind: 'unknown_terminal' as const,
      workspaceId: fence.workspaceId,
      id: fence.outboundMessageId,
      detail: `mailbox ${fence.mailboxId}, awaiting an admin delivered/skipped decision`,
    })),
    ...input.unresolved.ambiguousHeld.map(hold => ({
      kind: 'ambiguous_hold' as const,
      workspaceId: hold.workspaceId,
      id: hold.holdId,
      detail: `${hold.reasonCode} since ${hold.startedAt}, still held`,
    })),
    ...(input.sentFolder ?? []).map(item => ({ ...item })),
  ];

  return {
    schema: 'fss.restore-report.v1',
    suppressions_before: input.before.suppressions,
    suppressions_after: input.after.suppressions,
    sends_before: input.before.sends,
    sends_after: input.after.sends,
    replies_before: input.before.replies,
    replies_after: input.after.replies,
    crm_edits_before: input.before.crm_edits,
    crm_edits_after: input.after.crm_edits,
    migrations_before: input.before.migrations,
    migrations_after: input.after.migrations,
    sends_repeated: input.sendsRepeated,
    crm_rpo_seconds: input.crmRpoSeconds,
    dead_jobs: input.unresolved.deadJobs,
    unresolved,
    ...(input.atFailure === undefined
      ? {}
      : {
          at_failure_as_of: input.atFailure.asOf,
          suppressions_at_failure: input.atFailure.suppressions,
          sends_at_failure: input.atFailure.sends,
          replies_at_failure: input.atFailure.replies,
          crm_edits_at_failure: input.atFailure.crm_edits,
          migrations_at_failure: input.atFailure.migrations,
          crm_edits_lost: Math.max(0, input.atFailure.crm_edits - input.after.crm_edits),
        }),
  };
}

/**
 * Whether a report permits step 9. The runbook: "refuses unless the step 8 report
 * exists and has no unresolved exception."
 *
 * Read from the file rather than recomputed, because the report is the artefact
 * attached to the release record and the thing an operator read. A tool that
 * recomputed it could advance the generation on a database that had changed since.
 */
export type ReportVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'malformed' | 'send_repeated' | 'suppression_lost' | 'unresolved' };

export function verifyRestoreReport(parsed: unknown): ReportVerdict {
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, reason: 'malformed' };
  const report = parsed as Record<string, unknown>;
  const number = (name: string): number | null =>
    typeof report[name] === 'number' ? (report[name] as number) : null;
  const repeated = number('sends_repeated');
  const before = number('suppressions_before');
  const after = number('suppressions_after');
  if (repeated === null || before === null || after === null || typeof report['crm_rpo_seconds'] !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if (repeated !== 0) return { ok: false, reason: 'send_repeated' };
  if (after < before) return { ok: false, reason: 'suppression_lost' };
  // Lane g59: when the report knows the moment of failure, a suppression acknowledged
  // between the restore target and the failure that did not come back is lost too.
  const atFailure = report['suppressions_at_failure'];
  if (atFailure !== undefined) {
    if (typeof atFailure !== 'number') return { ok: false, reason: 'malformed' };
    if (after < atFailure) return { ok: false, reason: 'suppression_lost' };
  }
  const unresolved = report['unresolved'];
  if (!Array.isArray(unresolved)) return { ok: false, reason: 'malformed' };
  if (unresolved.length > 0) return { ok: false, reason: 'unresolved' };
  return { ok: true };
}
