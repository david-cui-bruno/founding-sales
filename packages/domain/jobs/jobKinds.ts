/**
 * The job kinds of Appendix C, and the idempotency key each one is materialized by.
 *
 * Appendix C is a table of three columns: the work, the idempotency key, and the
 * effect protection. All three are written down here, because the scheduler that
 * builds a key and the handler that relies on the protection are different files and
 * the table is the only thing that keeps them agreeing.
 *
 * `UNIQUE(workspace_id, kind, idempotency_key)` in migration 0001 is what makes a key
 * a key. Everything below composes one; nothing invents one at the call site.
 */

/**
 * How a handler survives being run twice. Specification 13.2: "Every handler is
 * protected by business uniqueness, a monotonic fencing token, or the outbound
 * at-most-once fence." There is no fourth option and no "the lease protects it".
 */
export const IDEMPOTENCY_PROTECTIONS = ['business_uniqueness', 'fencing_token', 'outbound_fence'] as const;
export type IdempotencyProtection = (typeof IDEMPOTENCY_PROTECTIONS)[number];

export const JOB_KINDS = [
  'sequence.action',
  'mail.sync',
  'mail.reconcile',
  'mail.recover',
  'mail.watch_renew',
  'today.build',
  'research.page',
  'research.firm',
  'suppression.finalize',
  'retention.batch',
  'import.batch',
  'canary',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

const KIND_SET: ReadonlySet<string> = new Set(JOB_KINDS);

export function isJobKind(value: string): value is JobKind {
  return KIND_SET.has(value);
}

/** Appendix C, third column: the protection each kind's handler must carry. */
export const JOB_KIND_PROTECTION: Readonly<Record<JobKind, IdempotencyProtection>> = Object.freeze({
  // Execution state and the outbound fence; the send itself cannot be rolled back.
  'sequence.action': 'outbound_fence',
  // Message uniqueness and a compare-and-set cursor.
  'mail.sync': 'business_uniqueness',
  // The fence state machine decides; a second reconcile observes, it does not send.
  'mail.reconcile': 'outbound_fence',
  // Message uniqueness and the coverage watermark.
  'mail.recover': 'business_uniqueness',
  // "Stored expiry and generation": the mailbox generation is a monotonic counter, and
  // a renewal carrying a stale one must not overwrite a newer watch. That is a fencing
  // token in Appendix C's own words, and the runner enforces it on the job row too.
  'mail.watch_renew': 'fencing_token',
  // Snapshot uniqueness, UNIQUE(workspace_id, snapshot_date, firm_id).
  'today.build': 'business_uniqueness',
  'research.page': 'business_uniqueness',
  'research.firm': 'business_uniqueness',
  // Event lock and terminal marker.
  'suppression.finalize': 'business_uniqueness',
  // Deletion tombstone over a bounded range.
  'retention.batch': 'business_uniqueness',
  // Command receipt and canonical keys.
  'import.batch': 'business_uniqueness',
  // The completion timestamp, written once.
  canary: 'business_uniqueness',
});

/** Appendix C, second column. Each builder produces the whole key, dotted prefix and all. */
export const jobIdempotencyKey = Object.freeze({
  sequenceAction: (stepExecutionId: string): string => `step-execution:${stepExecutionId}`,
  mailSync: (mailboxId: string): string => `mail-sync:${mailboxId}`,
  mailReconcile: (mailboxId: string, minuteIso: string): string => `mail-reconcile:${mailboxId}:${minuteIso}`,
  mailRecover: (mailboxId: string, generation: number): string =>
    `mail-recover:${mailboxId}:${String(generation)}`,
  watchRenew: (mailboxId: string, generation: number): string => `watch:${mailboxId}:${String(generation)}`,
  todayList: (workspaceSlug: string, businessDate: string, algorithmVersion: string): string =>
    `today:${workspaceSlug}:${businessDate}:${algorithmVersion}`,
  researchPage: (queryHash: string, pageHash: string): string => `research:${queryHash}:${pageHash}`,
  researchFirm: (firmId: string, revision: number): string => `research-firm:${firmId}:${String(revision)}`,
  suppressionFinalize: (eventId: string): string => `suppression-finalize:${eventId}`,
  retentionBatch: (dataKind: string, period: string): string => `retention:${dataKind}:${period}`,
  importBatch: (batchId: string, rowNumber: number): string => `import:${batchId}:${String(rowNumber)}`,
  canary: (quarterHourIso: string): string => `canary:${quarterHourIso}`,
});

/** Fifteen minutes in milliseconds; the canary's period (13.3). */
export const CANARY_PERIOD_MILLISECONDS = 15 * 60 * 1000;

/**
 * The quarter hour an instant falls in, as an ISO string. The canary's identity, and
 * therefore its idempotency key, so it has to be computed the same way everywhere.
 */
export function quarterHourOf(instant: string | number): string {
  const milliseconds = typeof instant === 'number' ? instant : Date.parse(instant);
  if (!Number.isFinite(milliseconds)) throw new RangeError('a quarter hour is derived from a real instant');
  return new Date(milliseconds - (milliseconds % CANARY_PERIOD_MILLISECONDS)).toISOString();
}
