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
  'canary',
  'route.validate',
  'research.firm',
  'research.sweep',
  'telephony.sweep',
  'calcom.reconcile',
  'call.transcribe',
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
  // Appendix C does not name this work, because revision 3 describes the
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
  // Appendix C does not name this work, because revision 3 describes the
  // classification and not the queue it runs on; Appendix A's "Record uncertain or
  // ambiguous reply" row does say where it belongs — "LLM classification may be
  // queued". One model row per message, refused a second time by
  // `mail_message_classifications_one_per_layer`, which is business uniqueness in
  // the same sense as every row above it.
  'classify.reply': 'business_uniqueness',
  // Deletion tombstone over a bounded range.
  'retention.batch': 'business_uniqueness',
  // `mailbox_send_days.closed_at` and `mailbox_send_ramp.last_advanced_on`
  // are the uniqueness: the advance is `WHERE last_advanced_on IS NULL OR
  // last_advanced_on < $date`, so closing the same day twice advances the ramp once.
  // A ramp that could be advanced twice would reach fifty a day in half the time 12.7
  // allows, which is the outcome the ramp exists to prevent.
  'outbound.close_send_day': 'business_uniqueness',
  // The completion timestamp, written once.
  canary: 'business_uniqueness',
  // Appendix C does not name this work, because revision 3's 7.4 says a route
  // needs "technical validation" without saying which process performs it. The effect
  // is one compare-and-set on the route: the handler writes only while the route is
  // still the `candidate` at the version the job names, with `technical_validation =
  // 'unknown'`, and the write bumps the version, so a second run finds a route that has
  // moved on and writes nothing. That is business uniqueness in the same sense as
  // `sequence.terminal_stop` above. See docs/decisions/g90-email-technical-validation.md.
  'route.validate': 'business_uniqueness',
  // Appendix C's `research-firm:{firm}:{revision}` and its "firm/evidence revision".
  // The run row is unique on `(workspace, firm, revision)` and the handler's first
  // write is that insert, so a second claim finds the row it already opened and
  // fetches nothing. See `packages/domain/research/runs.ts`.
  'research.firm': 'business_uniqueness',
  // One sweep per workspace per business date. The key carries the date and the
  // sweep's own effect is enqueueing, which is itself unique on the run's revision,
  // so a sweep that ran twice materializes the same jobs rather than twice as many.
  'research.sweep': 'business_uniqueness',
  // Call-to-booking (slice W). The effect is `settleAttempt` on a reservation still
  // `reserved` or `calling`, a compare-and-set on its state: a second run finds it
  // `released` or `estimated` and settles nothing twice.
  'telephony.sweep': 'business_uniqueness',
  // Slice M1. Every effect is a synthesized Cal.com event recorded at
  // `calcom_events_once` under a deterministic id before it is applied, so a second run
  // over the same bookings inserts nothing and applies nothing; and the meeting's own
  // `last_event_at` ordering refuses anything older than what was applied.
  'calcom.reconcile': 'business_uniqueness',
  // Slice C2. One transcript per call session (`call_transcripts_pkey`), inserted
  // `ON CONFLICT DO NOTHING`, and every cent goes through a `provider_reservations` row
  // per attempt, closed once by a compare-and-set on its state (`calls/transcription.ts`).
  'call.transcribe': 'business_uniqueness',
});

/**
 * The fixed half of a `research.firm` job key.
 *
 * Exported because `research/runs.ts` rebuilds the key **in SQL**, to join a run row to
 * its job and leave a run whose lease is still live alone. A literal there would be a
 * second copy of this format that nothing compared; `test/research/rules.test.ts`
 * compares the prefix with `jobIdempotencyKey.researchFirm`.
 */
export const RESEARCH_FIRM_JOB_KEY_PREFIX = 'research-firm:';

/** Appendix C, second column. Each builder produces the whole key, dotted prefix and all. */
export const jobIdempotencyKey = Object.freeze({
  /**
   * Appendix C's `step-execution:{id}`, and the wake it is for (audit C02).
   *
   * The scheduler always passes the wake — the execution row's version, from
   * `listStepWakes` — so a step held by a cap or a pause, or left `dispatched` by a
   * worker that died, gets a new job when its row moves instead of colliding for ever
   * with the `done` one. The bare form is the key of one look at an execution nobody
   * has woken, kept for the callers that name a job by its execution alone.
   */
  sequenceAction: (stepExecutionId: string, wake?: string): string =>
    wake === undefined ? `step-execution:${stepExecutionId}` : `step-execution:${stepExecutionId}:${wake}`,
  /**
   * Appendix C's `mail-sync:{mailbox}`, with the mailbox generation appended (C2B-A1):
   * a `dead` sync of one generation never absorbs the work of the next.
   */
  mailSync: (mailboxId: string, generation: number): string => `mail-sync:${mailboxId}:${String(generation)}`,
  mailReconcile: (mailboxId: string, minuteIso: string): string => `mail-reconcile:${mailboxId}:${minuteIso}`,
  mailRecover: (mailboxId: string, generation: number): string =>
    `mail-recover:${mailboxId}:${String(generation)}`,
  /**
   * Appendix C's `watch:{mailbox}:{generation}` — the renewal counter — with the mailbox
   * generation in front of it (C2B-A1), for the same reason as `mailSync`.
   */
  watchRenew: (mailboxId: string, watchGeneration: number, mailboxGeneration: number): string =>
    `watch:${mailboxId}:${String(mailboxGeneration)}:${String(watchGeneration)}`,
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
  canary: (quarterHourIso: string): string => `canary:${quarterHourIso}`,
  /** `resume` is the turn-on that re-owes a reply the classifier held while off (slice P1). */
  classifyReply: (messageId: string, resume: string | null = null): string =>
    resume === null ? `classify-reply:${messageId}` : `classify-reply:${messageId}:resume-${resume}`,
  /**
   * One look at one email route at one version. The round says which look:
   * `new` when the route is created, `sweep-<UTC hour or day>` for the scheduler's retry
   * of a route still unchecked, `check-<hash>` for a person's "Check again". A route that
   * has moved to a new version is a new key, so nothing about an older version can
   * block it.
   */
  routeValidate: (routeId: string, version: number, round: string): string =>
    `route-validate:${routeId}:${String(version)}:${round}`,
  /** Appendix C: `research-firm:{firm}:{revision}`. The revision is the job's identity. */
  researchFirm: (firmId: string, revision: number): string =>
    `${RESEARCH_FIRM_JOB_KEY_PREFIX}${firmId}:${String(revision)}`,
  /** One sweep per workspace business date, like the Today build's key rule. */
  researchSweep: (workspaceSlug: string, businessDate: string): string =>
    `research-sweep:${workspaceSlug}:${businessDate}`,
  /** One call-session reservation sweep per workspace per quarter hour, when it owes one. */
  telephonySweep: (workspaceSlug: string, quarterHourIso: string): string =>
    `telephony-sweep:${workspaceSlug}:${quarterHourIso}`,
  /** One Cal.com reconciliation per workspace per hour (slice M1). */
  calcomReconcile: (workspaceSlug: string, hourIso: string): string => `calcom-reconcile:${workspaceSlug}:${hourIso}`,
  /** One transcription of one call session (slice C2): the session is the job's identity. */
  callTranscribe: (callSessionId: string): string => `call-transcribe:${callSessionId}`,
});

/** The hour an instant falls in, as an ISO string: the Cal.com reconciliation's period. */
export function hourOf(instant: string | number): string {
  const milliseconds = typeof instant === 'number' ? instant : Date.parse(instant);
  if (!Number.isFinite(milliseconds)) throw new RangeError('an hour is derived from a real instant');
  const hour = 60 * 60 * 1000;
  return new Date(milliseconds - (milliseconds % hour)).toISOString();
}

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

/**
 * The lane a kind runs in.
 *
 * `urgent` is work a person is waiting on, directly or through the clock: a reply to
 * classify, a mailbox to sync, the Today list for the morning, the canary that proves
 * the pipe. `bulk` is work that may take as long as it takes without anybody noticing
 * — a sequence step, a terminal stop, a route check, a retention sweep.
 *
 * The distinction exists because one runner slot claimed every kind by `run_at`, so
 * fifty queued retention batches sat in front of the reply someone had just sent. The
 * runner gives `urgent` a slot of its own, so the queue's depth in one lane cannot
 * become the other lane's latency.
 */
export const JOB_CLASSES = ['urgent', 'bulk'] as const;
export type JobClass = (typeof JOB_CLASSES)[number];

/**
 * Every kind's lane. The type is total over `JobKind`, so a kind added to `JOB_KINDS`
 * without a lane does not typecheck; the registry refuses one at startup as well,
 * because a table that is only enforced by the compiler is enforced only where the
 * compiler runs.
 */
export const JOB_KIND_CLASS: Readonly<Record<JobKind, JobClass>> = Object.freeze({
  // A person or the clock is waiting.
  'mail.sync': 'urgent',
  'mail.reconcile': 'urgent',
  'mail.recover': 'urgent',
  'mail.watch_renew': 'urgent',
  'classify.reply': 'urgent',
  'suppression.finalize': 'urgent',
  'outbound.close_send_day': 'urgent',
  'today.build': 'urgent',
  canary: 'urgent',
  // An abandoned call session holds budget until this releases it, and the next call
  // may be refused for want of it: the salesperson is the one waiting.
  'telephony.sweep': 'urgent',
  // Nobody is waiting on it: a webhook already moved the pipeline when it arrived, and
  // this is the hourly repair of one that did not.
  'calcom.reconcile': 'bulk',
  // Nobody is watching the clock on these, and there can be a great many of them.
  'sequence.action': 'bulk',
  'sequence.terminal_stop': 'bulk',
  'route.validate': 'bulk',
  'retention.batch': 'bulk',
  // Nobody is waiting on a page fetch: the brief is read the next morning, and an
  // import of two hundred firms is two hundred of these.
  'research.firm': 'bulk',
  'research.sweep': 'bulk',
  // Slice C2: nobody is waiting on a transcript; it is read later, on the firm page.
  'call.transcribe': 'bulk',
});

/** The lane a kind runs in, or `undefined` for a kind no table row classifies. */
export function jobClassOf(kind: string): JobClass | undefined {
  return isJobKind(kind) ? JOB_KIND_CLASS[kind] : undefined;
}

/** Every kind of one lane, in `JOB_KINDS` order. */
export function kindsOfClass(jobClass: JobClass): JobKind[] {
  return JOB_KINDS.filter(kind => JOB_KIND_CLASS[kind] === jobClass);
}
