import { createHash } from 'node:crypto';
import { z } from 'zod';
import { accountInstantSchema } from '../../../../../src/shared/contracts/accountContract';
import { attemptReasonSchema } from '../../../../../src/shared/contracts/v1Contract';
import { keyPart, type DynamoStore } from '../dynamoStore';

/**
 * The job vocabulary of the rebuilt core (FSS target design section 4; slice S3). Every piece of work the
 * worker does after S3 is one job on one FIFO queue: the scheduler decides what is due and enqueues, the
 * runner consumes one job per message. Nothing here sends, dials or books; it only names work and records
 * whether a claim on that work is ours.
 *
 * A job id is deterministic text (`send:<firmId>:<stepId>`, `poll:<tickSeq>`, `reconcile:<date>T<HH>`): the
 * same due work always produces the same id, so two schedulers five minutes apart cannot enqueue two sends.
 * SQS caps a deduplication id at 128 characters over a restricted alphabet and a firm id alone is 72, so the
 * deduplication id is the sha256 of exactly the job id: 64 hex characters, always inside both limits.
 *
 * Three message groups (`mail`, `research`, `day`) so a slow research page never holds a due send behind it,
 * and one `JOB#<jobId>` record with a lease so a runner killed mid-job is retried and a failed job backs off
 * instead of hot-looping every tick. FIFO deduplication covers a repeat inside five minutes; the `JOB#` claim
 * covers everything after that. The claim admits an absent record, a failed one, or a running one whose lease
 * has expired, and nothing else.
 */

export const JOB_GROUPS = ['mail', 'research', 'day'] as const;
export const jobGroupSchema = z.enum(JOB_GROUPS);
export type JobGroup = z.infer<typeof jobGroupSchema>;

export const JOB_KINDS = ['day.build', 'research.backfill_page', 'research.firm', 'mail.poll', 'mail.send_step',
  'mail.send_followup', 'mail.reconcile'] as const;
export const jobKindSchema = z.enum(JOB_KINDS);
export type JobKind = z.infer<typeof jobKindSchema>;

/** Which lane each kind runs in (design section 4). Closed: a kind without a group cannot be enqueued. */
export const JOB_GROUP_OF: Readonly<Record<JobKind, JobGroup>> = Object.freeze({
  'day.build': 'day',
  'research.backfill_page': 'research',
  'research.firm': 'research',
  'mail.poll': 'mail',
  'mail.send_step': 'mail',
  'mail.send_followup': 'mail',
  'mail.reconcile': 'mail',
});

/** SQS refuses a deduplication id over 128 characters; the group id has the same ceiling. */
export const SQS_ID_MAX_LENGTH = 128;

const date = z.iso.date();
const idPart = z.string().min(1).max(200);

/** `day:<date>`: the morning list for one Eastern date. */
export const dayBuildJobId = (day: string): string => `day:${date.parse(day)}`;
/** `send:<firmId>:<stepId>`: the due template step of one firm. */
export const sendStepJobId = (firmId: string, stepId: string): string => `send:${keyPart(firmId)}:${idPart.parse(stepId)}`;
/** `followup:<firmId>:<draftId>`: one approved draft. */
export const sendFollowupJobId = (firmId: string, draftId: string): string => `followup:${keyPart(firmId)}:${idPart.parse(draftId)}`;
/** `poll:<tickSeq>`: one mailbox read, identified by the scheduler's own tick sequence, never by a clock bucket. */
export const pollJobId = (tickSeq: number): string => `poll:${z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(tickSeq)}`;
/** `reconcile:<date>T<HH>`: the hourly settlement of stale sends. */
export const reconcileJobId = (day: string, hour: number): string =>
  `reconcile:${date.parse(day)}T${String(z.number().int().min(0).max(23).parse(hour)).padStart(2, '0')}`;
/** `research:<firmId>:<revision>` and `backfill:<queryHash>:<pageHash>` are S4's; their ids are fixed here so both slices agree. */
export const researchFirmJobId = (firmId: string, revision: number): string => `research:${keyPart(firmId)}:${z.number().int().nonnegative().parse(revision)}`;
export const researchBackfillJobId = (queryHash: string, pageHash: string): string => `backfill:${idPart.parse(queryHash)}:${idPart.parse(pageHash)}`;

/** The deduplication id SQS sees: the sha256 of exactly this job id. Pure, and always 64 hex characters. */
export function jobDedupId(jobId: string): string {
  return createHash('sha256').update(z.string().min(1).parse(jobId), 'utf8').digest('hex');
}

/**
 * A deterministic RFC 4122 v4-shaped identifier for one job id. The design writes the Message-ID as
 * `<jobId@callie.invalid>`, but a job id carries colons, which RFC 5322 does not allow in a dot-atom local
 * part, and the carried Gmail sender takes a UUID. This derives that UUID from the job id and nothing else,
 * so the header is legal, the value is still a pure function of the work, and the Sent-folder lookup that
 * settles an unknown send finds exactly one message. Same construction as `replyTemplateDraftId`.
 */
export function jobMessageUuid(jobId: string): string {
  const digest = jobDedupId(jobId);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
export const jobMessageId = (jobId: string): string => `<${jobMessageUuid(jobId)}@callie.invalid>`;

/**
 * How a job names itself in the attempt log. A job id spells out the firm and the step and runs past the closed
 * attempt detail's eighty characters, so the log carries the deduplication id instead: the same 64 hex characters
 * SQS saw, unique to exactly this work, and short enough to be a `ref` David can match against the queue.
 */
export const jobRef = (jobId: string): string => jobDedupId(jobId);

export const JOB_PREFIX = 'JOB#';
export const jobKey = (jobId: string): string => `${JOB_PREFIX}${keyPart(jobId)}`;

/** Three attempts, then the dead-letter queue and its alarm (design section 4). */
export const JOB_MAX_ATTEMPTS = 3;
/** The scheduler does not re-enqueue a failed job inside this window: one hour, doubling to a day. */
export const JOB_BACKOFF_START_MS = 3_600_000;
export const JOB_BACKOFF_MAX_MS = 24 * 3_600_000;
/** How long a claim holds the job. Longer than the runner's five-minute budget, shorter than the visibility timeout. */
export const JOB_LEASE_MS = 6 * 60_000;
/**
 * How long a `queued` record is taken to mean the message is still on the queue. Past the queue's own visibility
 * timeout (36 minutes) plus a tick, a message that never reached a runner is gone, and the scheduler offers the
 * work again rather than leaving it queued forever. Re-offering is safe: the claim is what stops a second run.
 */
export const JOB_QUEUED_STALE_MS = 40 * 60_000;

export const jobRecordSchema = z.strictObject({
  version: z.literal(1),
  jobId: z.string().min(1).max(200),
  kind: jobKindSchema,
  group: jobGroupSchema,
  state: z.enum(['queued', 'running', 'done', 'failed']),
  attempt: z.number().int().nonnegative().max(1000),
  leaseUntil: accountInstantSchema.nullable(),
  lastError: attemptReasonSchema.nullable(),
  lastAttemptAt: accountInstantSchema.nullable(),
  enqueuedAt: accountInstantSchema,
});
export type JobRecord = z.infer<typeof jobRecordSchema>;

/** The instant a failed job may be enqueued again: one hour after the failure, doubling with each attempt, capped at a day. */
export function jobBackoffUntil(record: Pick<JobRecord, 'attempt' | 'lastAttemptAt'>): string | null {
  if (record.lastAttemptAt === null || record.attempt < 1) return null;
  const delay = Math.min(JOB_BACKOFF_MAX_MS, JOB_BACKOFF_START_MS * 2 ** (record.attempt - 1));
  return new Date(Date.parse(record.lastAttemptAt) + delay).toISOString();
}

/**
 * Whether this job may be claimed now (design section 4): absent, or failed, or running with an expired lease.
 * `done` is never reclaimed, and a live lease belongs to whoever holds it. Pure.
 */
export function jobClaimable(record: JobRecord | null, now: string): boolean {
  if (record === null) return true;
  if (record.state === 'done') return false;
  if (record.state === 'failed' || record.state === 'queued') return true;
  return record.leaseUntil === null || record.leaseUntil <= now;
}

/** The positive case names the same keys as `undefined` so a reader may check `decision.reason` without narrowing:
 *  the root TypeScript configuration compiles without `strictNullChecks`, where a boolean discriminant does not narrow. */
export type JobEnqueueDecision = { enqueue: true; reason?: undefined; until?: undefined } | { enqueue: false; reason: 'in_flight' | 'already_done' | 'backoff'; until: string | null };
/** Whether the scheduler may enqueue this job now: claimable, and past its backoff window if it failed. Pure. */
export function jobEnqueueable(record: JobRecord | null, now: string): JobEnqueueDecision {
  if (record === null) return { enqueue: true };
  if (record.state === 'done') return { enqueue: false, reason: 'already_done', until: null };
  if (record.state === 'failed') {
    const until = jobBackoffUntil(record);
    return until !== null && until > now ? { enqueue: false, reason: 'backoff', until } : { enqueue: true };
  }
  if (record.state === 'running' && record.leaseUntil !== null && record.leaseUntil > now) return { enqueue: false, reason: 'in_flight', until: record.leaseUntil };
  if (record.state === 'queued') {
    const stale = new Date(Date.parse(record.enqueuedAt) + JOB_QUEUED_STALE_MS).toISOString();
    if (stale > now) return { enqueue: false, reason: 'in_flight', until: stale };
  }
  return { enqueue: true };
}

export type JobClaim = { claimed: true; record: JobRecord; rev: number } | { claimed: false; reason: 'in_flight' | 'already_done' | 'lost_race' };

/**
 * Takes the lease on one job. Reads the record, refuses anything the claim condition does not admit, then
 * writes `running` fenced on exactly the revision it read, so two runners that read the same free job cannot
 * both proceed: the loser's transaction is cancelled and it reports `lost_race`, never a second execution.
 */
export async function claimJob(store: DynamoStore, input: { jobId: string; kind: JobKind; leaseMs?: number }): Promise<JobClaim> {
  const key = jobKey(input.jobId);
  const now = store.now();
  const existing = await store.get<unknown>(key);
  const parsed = existing ? jobRecordSchema.safeParse(existing.data) : null;
  const record = parsed?.success ? parsed.data : null;
  if (existing && !record) return { claimed: false, reason: 'lost_race' };
  if (!jobClaimable(record, now)) return { claimed: false, reason: record?.state === 'done' ? 'already_done' : 'in_flight' };
  const next: JobRecord = jobRecordSchema.parse({
    version: 1, jobId: input.jobId, kind: input.kind, group: JOB_GROUP_OF[input.kind], state: 'running',
    attempt: (record?.attempt ?? 0) + 1, leaseUntil: new Date(Date.parse(now) + (input.leaseMs ?? JOB_LEASE_MS)).toISOString(),
    lastError: record?.lastError ?? null, lastAttemptAt: now, enqueuedAt: record?.enqueuedAt ?? now,
  });
  try { await store.transact([store.put(key, next, existing?.rev ?? null)]); }
  catch { return { claimed: false, reason: 'lost_race' }; }
  return { claimed: true, record: next, rev: (existing?.rev ?? 0) + 1 };
}

/** Settles a claimed job. `failed` keeps the attempt count so the scheduler's backoff doubles; `done` is final. */
export async function settleJob(store: DynamoStore, input: { jobId: string; rev: number; record: JobRecord; state: 'done' | 'failed'; error?: string | null }): Promise<void> {
  const next: JobRecord = jobRecordSchema.parse({ ...input.record, state: input.state, leaseUntil: null,
    lastError: input.state === 'failed' ? (input.error ?? 'job_failed') : null, lastAttemptAt: store.now() });
  await store.transact([store.put(jobKey(input.jobId), next, input.rev)]);
}

/** Records one job as queued, so the scheduler's next tick sees it in flight even before a runner claims it. */
export async function markQueued(store: DynamoStore, input: { jobId: string; kind: JobKind }): Promise<void> {
  const key = jobKey(input.jobId);
  const existing = await store.get<unknown>(key);
  const parsed = existing ? jobRecordSchema.safeParse(existing.data) : null;
  const record = parsed?.success ? parsed.data : null;
  const now = store.now();
  const next: JobRecord = jobRecordSchema.parse({ version: 1, jobId: input.jobId, kind: input.kind, group: JOB_GROUP_OF[input.kind],
    state: 'queued', attempt: record?.attempt ?? 0, leaseUntil: null, lastError: record?.lastError ?? null,
    lastAttemptAt: record?.lastAttemptAt ?? null, enqueuedAt: now });
  await store.transact([store.put(key, next, existing?.rev ?? null)]);
}

/** Every job record now, for the scheduler's backoff decisions and the diagnostics queue counts. One prefix query. */
export async function readJobs(store: DynamoStore): Promise<Map<string, JobRecord>> {
  const jobs = new Map<string, JobRecord>();
  for (const row of await store.list<unknown>(JOB_PREFIX)) {
    const parsed = jobRecordSchema.safeParse(row.stored.data);
    if (parsed.success) jobs.set(parsed.data.jobId, parsed.data);
  }
  return jobs;
}

export type ParsedJob =
  | { kind: 'day.build'; date: string }
  | { kind: 'mail.poll'; tickSeq: number }
  | { kind: 'mail.reconcile'; date: string; hour: number }
  | { kind: 'mail.send_step'; firmId: string; stepId: string }
  | { kind: 'mail.send_followup'; firmId: string; draftId: string }
  | { kind: 'research.firm'; firmId: string; revision: number }
  | { kind: 'research.backfill_page'; queryHash: string; pageHash: string };

/**
 * What one job id says the work is. The parts are percent-encoded on the way in (`keyPart`), so splitting on the
 * colons is exact whatever the firm id, step id or page token contained. Pure; returns null rather than guessing.
 */
export function parseJobId(jobId: string): ParsedJob | null {
  const parts = jobId.split(':');
  const decode = (value: string | undefined): string | null => {
    if (value === undefined || value.length === 0) return null;
    try { return decodeURIComponent(value); } catch { return null; }
  };
  const integer = (value: string | undefined): number | null => value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
  if (parts[0] === 'day' && parts.length === 2) return z.iso.date().safeParse(parts[1]).success ? { kind: 'day.build', date: parts[1]! } : null;
  if (parts[0] === 'poll' && parts.length === 2) { const tickSeq = integer(parts[1]); return tickSeq === null ? null : { kind: 'mail.poll', tickSeq }; }
  if (parts[0] === 'reconcile' && parts.length === 2) {
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})$/.exec(parts[1]!);
    return match ? { kind: 'mail.reconcile', date: match[1]!, hour: Number(match[2]) } : null;
  }
  if (parts[0] === 'send' && parts.length === 3) {
    const firmId = decode(parts[1]); const stepId = decode(parts[2]);
    return firmId && stepId ? { kind: 'mail.send_step', firmId, stepId } : null;
  }
  if (parts[0] === 'followup' && parts.length === 3) {
    const firmId = decode(parts[1]); const draftId = decode(parts[2]);
    return firmId && draftId ? { kind: 'mail.send_followup', firmId, draftId } : null;
  }
  if (parts[0] === 'research' && parts.length === 3) {
    const firmId = decode(parts[1]); const revision = integer(parts[2]);
    return firmId && revision !== null ? { kind: 'research.firm', firmId, revision } : null;
  }
  if (parts[0] === 'backfill' && parts.length === 3) {
    const queryHash = decode(parts[1]); const pageHash = decode(parts[2]);
    return queryHash && pageHash ? { kind: 'research.backfill_page', queryHash, pageHash } : null;
  }
  return null;
}

/** What one message on the queue carries. The runner trusts the job id and re-reads everything else from the table. */
export const queueMessageSchema = z.strictObject({ version: z.literal(1), jobId: z.string().min(1).max(200), kind: jobKindSchema, group: jobGroupSchema });
export type QueueMessage = z.infer<typeof queueMessageSchema>;
export const queueMessage = (jobId: string, kind: JobKind): QueueMessage =>
  queueMessageSchema.parse({ version: 1, jobId, kind, group: JOB_GROUP_OF[kind] });
