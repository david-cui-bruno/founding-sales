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
  'sequence.terminal_stop',
  'mail.sync',
  'mail.reconcile',
  'mail.recover',
  'mail.watch_renew',
  'today.build',
  'suppression.finalize',
  'classify.reply',
  'retention.batch',
  'outbound.close_send_day',
  'import.batch',
  'canary',
  'route.validate',
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
  // Lane G15. Appendix C does not name this work, because revision 3 describes the
  // terminal stop (7.3, 8.1, 10.2) without saying which process performs it. The
  // effect is `stopEnrollments`, which touches only enrollments whose `ended_at IS
  // NULL` and advances its subscriber cursor in the same transaction, so a second run
  // stops nothing a second time. That is business uniqueness in the same sense as
  // every row below it.
  'sequence.terminal_stop': 'business_uniqueness',
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
  // Event lock and terminal marker.
  'suppression.finalize': 'business_uniqueness',
  // Lane G7b. Appendix C does not name this work, because revision 3 describes the
  // classification and not the queue it runs on; Appendix A's "Record uncertain or
  // ambiguous reply" row does say where it belongs — "LLM classification may be
  // queued". One model row per message, refused a second time by
  // `mail_message_classifications_one_per_layer`, which is business uniqueness in
  // the same sense as every row above it.
  'classify.reply': 'business_uniqueness',
  // Deletion tombstone over a bounded range.
  'retention.batch': 'business_uniqueness',
  // Lane G15. `mailbox_send_days.closed_at` and `mailbox_send_ramp.last_advanced_on`
  // are the uniqueness: the advance is `WHERE last_advanced_on IS NULL OR
  // last_advanced_on < $date`, so closing the same day twice advances the ramp once.
  // A ramp that could be advanced twice would reach fifty a day in half the time 12.7
  // allows, which is the outcome the ramp exists to prevent.
  'outbound.close_send_day': 'business_uniqueness',
  // Command receipt and canonical keys.
  'import.batch': 'business_uniqueness',
  // The completion timestamp, written once.
  canary: 'business_uniqueness',
  // Lane g90. Appendix C does not name this work, because revision 3's 7.4 says a route
  // needs "technical validation" without saying which process performs it. The effect
  // is one compare-and-set on the route: the handler writes only while the route is
  // still the `candidate` at the version the job names, with `technical_validation =
  // 'unknown'`, and the write bumps the version, so a second run finds a route that has
  // moved on and writes nothing. That is business uniqueness in the same sense as
  // `sequence.terminal_stop` above. See docs/decisions/g90-email-technical-validation.md.
  'route.validate': 'business_uniqueness',
});

/** Appendix C, second column. Each builder produces the whole key, dotted prefix and all. */
export const jobIdempotencyKey = Object.freeze({
  /**
   * Appendix C's `step-execution:{id}`, and the wake it is for (lane g82, audit C02).
   *
   * The scheduler always passes the wake — the execution row's version, from
   * `listStepWakes` — so a step held by a cap or a pause, or left `dispatched` by a
   * worker that died, gets a new job when its row moves instead of colliding for ever
   * with the `done` one. The bare form is the key of one look at an execution nobody
   * has woken, kept for the callers that name a job by its execution alone.
   */
  sequenceAction: (stepExecutionId: string, wake?: string): string =>
    wake === undefined ? `step-execution:${stepExecutionId}` : `step-execution:${stepExecutionId}:${wake}`,
  mailSync: (mailboxId: string): string => `mail-sync:${mailboxId}`,
  mailReconcile: (mailboxId: string, minuteIso: string): string => `mail-reconcile:${mailboxId}:${minuteIso}`,
  mailRecover: (mailboxId: string, generation: number): string =>
    `mail-recover:${mailboxId}:${String(generation)}`,
  watchRenew: (mailboxId: string, generation: number): string => `watch:${mailboxId}:${String(generation)}`,
  todayList: (workspaceSlug: string, businessDate: string, algorithmVersion: string): string =>
    `today:${workspaceSlug}:${businessDate}:${algorithmVersion}`,
  suppressionFinalize: (eventId: string): string => `suppression-finalize:${eventId}`,
  /**
   * The head of the two terminal-stop streams a workspace has not consumed.
   *
   * Both halves are in the key because either alone would collapse work the other
   * stream is owed, and both advance only when the drain that named them succeeded.
   * A stream with nothing outstanding contributes `none`.
   */
  terminalStop: (outboxHead: string | null, markerHead: string | null): string =>
    `terminal-stop:${outboxHead ?? 'none'}:${markerHead ?? 'none'}`,
  closeSendDay: (mailboxId: string, businessDate: string): string =>
    `send-day-close:${mailboxId}:${businessDate}`,
  retentionBatch: (dataKind: string, period: string): string => `retention:${dataKind}:${period}`,
  importBatch: (batchId: string, rowNumber: number): string => `import:${batchId}:${String(rowNumber)}`,
  canary: (quarterHourIso: string): string => `canary:${quarterHourIso}`,
  classifyReply: (messageId: string): string => `classify-reply:${messageId}`,
  /**
   * One look at one email route at one version (lane g90). The round says which look:
   * `new` when the route is created, `sweep-<UTC hour or day>` for the scheduler's retry
   * of a route still unchecked, `check-<hash>` for a person's "Check again". A route that
   * has moved to a new version is a new key, so nothing about an older version can
   * block it.
   */
  routeValidate: (routeId: string, version: number, round: string): string =>
    `route-validate:${routeId}:${String(version)}:${round}`,
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
