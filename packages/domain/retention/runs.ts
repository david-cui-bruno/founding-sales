import type { RepositoryContext } from '../db/workspaceScope.ts';
import { isRetentionLedgerKind, retentionPeriodOf, type RetentionLedgerKind } from './kinds.ts';
import { readRetentionPolicy, retentionBoundary } from './policies.ts';
import { RETENTION_BATCH_LIMIT, retentionTargetFor } from './targets.ts';
import { databaseNow } from './result.ts';

/**
 * The retention run ledger (Appendix C, specification 10.3).
 *
 * Appendix C's effect protection for `retention.batch` is "deletion tombstone and
 * bounded range", and `retention_runs_one_per_period` is both: the row is the
 * tombstone, `boundary_at` is the range. It is also the `business_uniqueness` the
 * handler registry makes the handler declare, and it is real rather than nominal —
 * the insert happens first, and a second worker that loses the race is told the
 * period is already claimed and sweeps nothing.
 *
 * The order matters and is the whole design. Claim the period, then sweep, then
 * complete the row. A sweep that ran before the claim could run twice; a claim that
 * was rolled back with a failed sweep would leave a period that nothing had swept
 * and nothing recorded, which is the honest state and the one the retry repairs.
 */

export type RetentionRunOutcome = 'swept' | 'retained' | 'declared_pending' | 'external' | 'no_policy';

export interface RetentionRunReport {
  readonly dataKind: RetentionLedgerKind;
  readonly period: string;
  readonly outcome: RetentionRunOutcome;
  readonly boundaryAt: string | null;
  readonly rowsDeleted: number;
  readonly rowsRedacted: number;
  /** True when the period had already been claimed. Nothing was swept by this call. */
  readonly replayed: boolean;
  readonly detail: Readonly<Record<string, number>>;
}

export interface RunRetentionBatchInput {
  readonly dataKind: string;
  readonly period?: string | undefined;
  /** Database time. Read from the database when the caller does not supply it. */
  readonly now?: string | undefined;
  readonly limit?: number | undefined;
}

export class RetentionKindError extends Error {
  constructor(readonly dataKind: string) {
    super(`${dataKind} is not a retention kind`);
    this.name = 'RetentionKindError';
  }
}

/**
 * Run one retention batch for one workspace, one kind and one period.
 *
 * Every path writes a ledger row, including the ones that delete nothing. A kind
 * that was retained, a kind whose table belongs to a lane still in flight and a kind
 * enforced outside the database each leave a row saying so, because the alternative
 * is a retention report with gaps that look identical to a retention job that never
 * ran.
 */
export async function runRetentionBatch(
  context: RepositoryContext,
  input: RunRetentionBatchInput,
): Promise<RetentionRunReport> {
  if (!isRetentionLedgerKind(input.dataKind)) throw new RetentionKindError(input.dataKind);
  const dataKind = input.dataKind;
  const now = input.now ?? (await databaseNow(context.db));
  const period = input.period ?? retentionPeriodOf(now);

  const target = retentionTargetFor(dataKind);
  if (target === undefined) throw new RetentionKindError(dataKind);

  // A policy kind with no policy row sweeps nothing. `job_payloads` is not a policy
  // kind: its window is 13.2's operational window, stated in the target.
  const policy = dataKind === 'job_payloads' ? null : await readRetentionPolicy(context, dataKind);
  const missingPolicy = dataKind !== 'job_payloads' && policy === null;

  // `started_at` defaults to database `now()` rather than taking the caller's
  // instant. The caller's `now` decides the *boundary* — which rows are past their
  // horizon — and the ledger's timestamps are when the sweep actually ran. A test or
  // a recovery replaying an older period must not be able to write a ledger row that
  // claims to have started in the future.
  const claim = await context.db.query<{ id: string }>(
    `INSERT INTO retention_runs (workspace_id, data_kind, period)
     VALUES ($1, $2, $3)
     ON CONFLICT ON CONSTRAINT retention_runs_one_per_period DO NOTHING
     RETURNING id`,
    [context.scope.workspaceId, dataKind, period],
  );
  const runId = claim.rows[0]?.id;
  if (runId === undefined) {
    // Somebody already claimed this period — a second worker, a replayed job, or the
    // same job after a lease was stolen. Report what the ledger says and do nothing.
    const { rows } = await context.db.query<{
      outcome: RetentionRunOutcome | 'running';
      boundary_at: Date | null;
      rows_deleted: number;
      rows_redacted: number;
      detail: Readonly<Record<string, number>>;
    }>(
      `SELECT outcome, boundary_at, rows_deleted, rows_redacted, detail
         FROM retention_runs
        WHERE workspace_id = $1 AND data_kind = $2 AND period = $3`,
      [context.scope.workspaceId, dataKind, period],
    );
    const existing = rows[0];
    return {
      dataKind,
      period,
      // A row still `running` is somebody else's in-flight sweep; from here it is
      // indistinguishable from a finished one and equally not ours to redo.
      outcome: existing === undefined || existing.outcome === 'running' ? 'retained' : existing.outcome,
      boundaryAt: existing?.boundary_at?.toISOString() ?? null,
      rowsDeleted: 0,
      rowsRedacted: 0,
      replayed: true,
      detail: existing?.detail ?? {},
    };
  }

  const complete = async (report: Omit<RetentionRunReport, 'dataKind' | 'period' | 'replayed'>): Promise<RetentionRunReport> => {
    await context.db.query(
      `UPDATE retention_runs
          SET outcome = $3, boundary_at = $4::timestamptz, rows_deleted = $5, rows_redacted = $6,
              detail = $7::jsonb, completed_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [
        context.scope.workspaceId,
        runId,
        report.outcome,
        report.boundaryAt,
        report.rowsDeleted,
        report.rowsRedacted,
        JSON.stringify(report.detail),
      ],
    );
    return { ...report, dataKind, period, replayed: false };
  };

  if (missingPolicy) {
    return await complete({ outcome: 'no_policy', boundaryAt: null, rowsDeleted: 0, rowsRedacted: 0, detail: {} });
  }

  if (target.state !== 'implemented' || target.sweep === null) {
    const outcome: RetentionRunOutcome =
      target.state === 'retained' ? 'retained' : target.state === 'external' ? 'external' : 'declared_pending';
    return await complete({ outcome, boundaryAt: null, rowsDeleted: 0, rowsRedacted: 0, detail: {} });
  }

  const boundaryAt = policy === null ? null : await retentionBoundary(context, { dataKind, now });
  const swept = await target.sweep(context, {
    now,
    boundaryAt,
    limit: Math.trunc(input.limit ?? RETENTION_BATCH_LIMIT),
  });
  return await complete({
    outcome: 'swept',
    boundaryAt: swept.boundaryAt,
    rowsDeleted: swept.rowsDeleted,
    rowsRedacted: swept.rowsRedacted,
    detail: swept.detail,
  });
}

export interface RetentionRunView {
  readonly id: string;
  readonly dataKind: string;
  readonly period: string;
  readonly outcome: string;
  readonly boundaryAt: string | null;
  readonly rowsDeleted: number;
  readonly rowsRedacted: number;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

/** The admin's view of what retention has done. Typed and redacted; counts, never rows. */
export async function listRetentionRuns(
  context: RepositoryContext,
  options: { readonly dataKind?: string | undefined; readonly limit?: number | undefined } = {},
): Promise<readonly RetentionRunView[]> {
  const { rows } = await context.db.query<{
    id: string;
    data_kind: string;
    period: string;
    outcome: string;
    boundary_at: Date | null;
    rows_deleted: number;
    rows_redacted: number;
    started_at: Date;
    completed_at: Date | null;
  }>(
    `SELECT id, data_kind, period, outcome, boundary_at, rows_deleted, rows_redacted, started_at, completed_at
       FROM retention_runs
      WHERE workspace_id = $1 AND ($2::text IS NULL OR data_kind = $2::text)
      ORDER BY started_at DESC, data_kind
      LIMIT $3`,
    [context.scope.workspaceId, options.dataKind ?? null, Math.trunc(options.limit ?? 100)],
  );
  return rows.map(row => ({
    id: row.id,
    dataKind: row.data_kind,
    period: row.period,
    outcome: row.outcome,
    boundaryAt: row.boundary_at === null ? null : row.boundary_at.toISOString(),
    rowsDeleted: Number(row.rows_deleted),
    rowsRedacted: Number(row.rows_redacted),
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at === null ? null : row.completed_at.toISOString(),
  }));
}
