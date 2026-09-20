import type { RepositoryContext } from '../db/workspaceScope.ts';
import { RETENTION_POLICY_KINDS, type RetentionPolicyKind } from './kinds.ts';

/**
 * Reading the workspace's retention policy rows (specification 10.3).
 *
 * The rows are seeded by migration 0014's trigger, so a workspace always has all ten
 * and a missing one is a fact rather than a default to invent. `runRetentionBatch`
 * reports `no_policy` when it finds none, which is the conservative option the common
 * rules ask for: a sweep with no stated horizon deletes nothing.
 *
 * The interval is returned in days as well as in its stored form, because everything
 * that reads it — the report, the API, a person checking the 10.3 table against what
 * the database says — thinks in days, and `interval` arrives from `pg` as an object.
 */

export type RetentionDisposition = 'delete' | 'tombstone' | 'retain_indefinitely' | 'retain_with_business_record';

export interface RetentionPolicyRow {
  readonly dataKind: RetentionPolicyKind;
  readonly disposition: RetentionDisposition;
  /** Null for the two indefinite dispositions, which the database enforces. */
  readonly retentionDays: number | null;
  readonly effectiveFrom: string;
}

interface Row {
  readonly data_kind: RetentionPolicyKind;
  readonly disposition: RetentionDisposition;
  readonly retention_days: string | null;
  readonly effective_from: Date;
  readonly [column: string]: unknown;
}

// `extract(epoch from interval)` is exact for the day- and year-valued intervals the
// seeding function writes, and division by 86400 turns it into the unit the table is
// written in. It is computed by PostgreSQL rather than by parsing pg's interval
// object, so "7 years" is whatever PostgreSQL says it is.
const POLICY_COLUMNS = `data_kind, disposition,
  CASE WHEN retention_interval IS NULL THEN NULL
       ELSE (extract(epoch FROM retention_interval) / 86400)::text END AS retention_days,
  effective_from`;

function toPolicy(row: Row): RetentionPolicyRow {
  return {
    dataKind: row.data_kind,
    disposition: row.disposition,
    retentionDays: row.retention_days === null ? null : Number(row.retention_days),
    effectiveFrom: row.effective_from.toISOString(),
  };
}

export async function readRetentionPolicies(context: RepositoryContext): Promise<readonly RetentionPolicyRow[]> {
  const { rows } = await context.db.query<Row>(
    `SELECT ${POLICY_COLUMNS} FROM retention_policies WHERE workspace_id = $1 ORDER BY data_kind`,
    [context.scope.workspaceId],
  );
  return rows.map(toPolicy);
}

export async function readRetentionPolicy(
  context: RepositoryContext,
  dataKind: string,
): Promise<RetentionPolicyRow | null> {
  if (!(RETENTION_POLICY_KINDS as readonly string[]).includes(dataKind)) return null;
  const { rows } = await context.db.query<Row>(
    `SELECT ${POLICY_COLUMNS} FROM retention_policies WHERE workspace_id = $1 AND data_kind = $2`,
    [context.scope.workspaceId, dataKind],
  );
  const row = rows[0];
  return row === undefined ? null : toPolicy(row);
}

/**
 * The instant a sweep deletes up to: database time minus the policy's interval,
 * computed by PostgreSQL from the stored interval rather than in JavaScript.
 *
 * It matters. "30 days" is an interval, not 2 592 000 seconds, and PostgreSQL is the
 * thing that knows the difference across a daylight-saving boundary. A worker in
 * another region computing it locally would sweep an hour early twice a year.
 */
export async function retentionBoundary(
  context: RepositoryContext,
  input: { readonly dataKind: string; readonly now: string },
): Promise<string | null> {
  const { rows } = await context.db.query<{ boundary_at: Date | null }>(
    `SELECT ($2::timestamptz - retention_interval) AS boundary_at
       FROM retention_policies
      WHERE workspace_id = $1 AND data_kind = $3 AND retention_interval IS NOT NULL`,
    [context.scope.workspaceId, input.now, input.dataKind],
  );
  const boundary = rows[0]?.boundary_at;
  return boundary === undefined || boundary === null ? null : boundary.toISOString();
}
