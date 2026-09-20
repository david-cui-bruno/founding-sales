import { RETENTION_DATA_KINDS } from '@fss/contracts';

/**
 * The vocabulary of section 10.3, and the one thing this lane adds to it.
 *
 * `RETENTION_POLICY_KINDS` is the ten rows of the retention table, and it is not a
 * second copy: it is the contracts enum, which is also the CHECK constraint in
 * migration 0001. `retention_policies` is where a workspace's horizons live and it
 * accepts exactly these.
 *
 * `RETENTION_LEDGER_KINDS` is those ten plus `job_payloads`. Specification 13.2 says
 * "completed payloads are archived after the operational window", which is a sweep on
 * a schedule with a boundary and a run ledger like any other — but a queue payload is
 * not one of 10.3's ten kinds of *prospect* data, and widening the policy table's
 * closed list to hold it would have put the queue's housekeeping in the table an
 * auditor reads to find out what Callie keeps about people. So the ledger's
 * vocabulary is the superset and the policy table's is untouched.
 * See docs/decisions/g14-retention-target-registry.md.
 */

export const RETENTION_POLICY_KINDS = RETENTION_DATA_KINDS;
export type RetentionPolicyKind = (typeof RETENTION_POLICY_KINDS)[number];

export const RETENTION_LEDGER_KINDS = [...RETENTION_POLICY_KINDS, 'job_payloads'] as const;
export type RetentionLedgerKind = (typeof RETENTION_LEDGER_KINDS)[number];

const LEDGER_SET: ReadonlySet<string> = new Set<string>(RETENTION_LEDGER_KINDS);

export function isRetentionLedgerKind(value: string): value is RetentionLedgerKind {
  return LEDGER_SET.has(value);
}

/**
 * The period a retention batch is keyed by: the UTC calendar day.
 *
 * Appendix C's key is `retention:{kind}:{period}` and Appendix D puts "job
 * eligibility, fence times, ticket times" in database UTC, so the period is a UTC
 * day rather than a workspace business date. That is deliberate and it is the
 * difference between a sweep and a Today snapshot: a snapshot is *about* a person's
 * working day, and a horizon is about how long data has existed. A workspace that
 * changed its business zone would otherwise re-run or skip a day's retention.
 */
export function retentionPeriodOf(instant: string | number | Date): string {
  const milliseconds =
    instant instanceof Date ? instant.getTime() : typeof instant === 'number' ? instant : Date.parse(instant);
  if (!Number.isFinite(milliseconds)) throw new RangeError('a retention period is derived from a real instant');
  return new Date(milliseconds).toISOString().slice(0, 10);
}

/** Appendix C, second column, for this lane's kind. */
export function retentionBatchJobKey(dataKind: string, period: string): string {
  return `retention:${dataKind}:${period}`;
}
