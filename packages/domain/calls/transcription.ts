import {enqueueNativeCrmExtraction} from '../crm/processingCapture.ts';
import {
  CALL_TRANSCRIPT_MAX_UTTERANCES,
  TRANSCRIPTION_MINIMUM_SECONDS,
  type CallTranscriptResponse,
  type CallTranscriptUtterance,
  type TranscriptionRefusalCode,
} from '@fss/contracts';
import type { Queryable } from '../db/queryable.ts';
import { repositoryContext, workspaceScope, type RepositoryContext } from '../db/workspaceScope.ts';
import { decideFirmMutation } from '../crm/authorization.ts';
import { readFirm } from '../crm/firms.ts';
import { enqueueJob } from '../jobs/jobStore.ts';
import { HEARTBEAT_GRACE_SECONDS } from '../jobs/heartbeats.ts';
import { jobIdempotencyKey } from '../jobs/jobKinds.ts';
import { databaseNow } from '../policy/clock.ts';
import { workspaceBusinessZone } from '../research/ledger.ts';
import { markCalling, settleAttempt, type ReservationState } from '../research/reservations.ts';
import { readCallTranscription } from '../settings/integrations.ts';
import { clearMonthlyCash } from '../settings/cashCeiling.ts';
import { providerFunding } from '../settings/funding.ts';
import { localDate } from '../src/rules/localClock.ts';
import type { TwilioRecordingFetcher } from './twilioRecording.ts';
import { boundMp3 } from './mp3Bound.ts';

/**
 * Call transcription (slice C2, migration 0030).
 *
 * After a connected call of at least `TRANSCRIPTION_MINIMUM_SECONDS` the worker sends its
 * recording to the transcription provider and stores the utterances in `call_transcripts`,
 * one row per call session. The provider sits behind `TranscriptionProvider`. Since slice
 * C3a (1 October 2026) the primary one is Amazon Transcribe with channel identification
 * (`apps/worker/src/transcription/awsTranscribeClient.ts`), paid from AWS credits;
 * Deepgram Nova-3, multichannel, stays selectable for comparison. Both label each
 * utterance by its recording channel (`RECORDING_CHANNEL_ROLES`: 0 you, 1 them), never by
 * diarization.
 *
 * ## When a call is transcribed
 *
 * `enqueueCallTranscription`, from the final recording callback (`POST
 * /integrations/twilio/recording`, `RecordingStatus=completed`), in its transaction, and
 * only when all of these hold: `call_transcription.enabled` with a ceiling above 0, the
 * `transcription` key in place, the call answered (`answered_at` set), and the recording
 * at least twenty seconds. A short or unanswered call is never transcribed. The job is
 * `call.transcribe`, keyed by the session, so a repeated callback queues nothing more.
 *
 * ## The money: the paid-call pattern, as research and telephony apply it
 *
 * `provider_reservations`, subject `call_transcription`, subject id the call session,
 * priced by the minute. Three chunks, each its own commit (`call.transcribe` is chunked):
 *
 *   1. `beginCallTranscription` — every condition above asked again, then the day's
 *      transcription ceiling, serialised per workspace: `ceil(recording seconds / 60) ×
 *      unitPriceMicros`, refused with `transcription_budget_exhausted` when it does not
 *      fit. Attempt 1 is reserved. No provider has been asked anything.
 *   2. `ensureTranscriptionCalling` — the reservation moves to `calling`, and nothing
 *      else: from this commit on a provider call may have happened. A row still `calling`
 *      that another claim marked (the cursor's fencing token is not this claim's) is
 *      ambiguous: it is settled `estimated` first, and a fresh attempt is reserved and
 *      cleared against the ceiling again — at most `TRANSCRIPTION_MAX_ATTEMPTS` (two: one
 *      bounded retry) for one call.
 *   3. `finishCallTranscription` — the recording read from Twilio, the provider call, the
 *      utterances stored, and the reservation settled by id at the duration the provider
 *      reports. A provider that answered with a refusal (4xx) billed nothing: settled at 0.
 *      A timeout, a network failure, a 5xx or an unreadable answer is ambiguous: the
 *      attempt is `estimated` at its reservation **before** the one bounded retry is
 *      reserved in chunk 2.
 *
 * The three take one per-session advisory lock (`lockTranscription`) for their whole
 * transaction, the provider call included, so the sweep and the deletion workflow never
 * decide about a reservation while a claim is calling against it. The lock is not the
 * session row's: Twilio's callbacks lock that row, and must not wait on a transcription.
 *
 * `sweepTranscriptionReservations`, run by `telephony.sweep`, finalises a lost lease: a
 * reservation still open `TRANSCRIPTION_SWEEP_MINUTES` after it was written is `released`
 * when `reserved` (no call can have happened) and `estimated` when `calling` (one may
 * have), skipping a session whose lock a live claim holds.
 */

/** `provider_reservations.subject_kind` (admitted by 0028). */
export const TRANSCRIPTION_SUBJECT_KIND = 'call_transcription';
/**
 * Paid attempts one call may ever hold: the first, and one bounded retry of an ambiguous one.
 * An attempt released without a provider call (the switch turned off before it, slice P1)
 * is not paid and does not count; `TRANSCRIPTION_MAX_ROWS` bounds those.
 */
export const TRANSCRIPTION_MAX_ATTEMPTS = 2;
/** Reservation rows one call may ever have, released ones included (slice P1). */
export const TRANSCRIPTION_MAX_ROWS = 6;
/** How long after a call a transcription the switch held is still resumed (slice P1). */
export const TRANSCRIPTION_RESUME_DAYS = 7;
/** A reservation older than this has outlived every lease that could still be using it. */
export const TRANSCRIPTION_SWEEP_MINUTES = 30;
/**
 * Seconds added to Twilio's recording duration before it is priced (review fold 1, P1):
 * Twilio reports whole seconds, and the audio a provider measures can run a fraction past
 * them. The reserved minutes are the bound; the audio is cut to them before upload.
 */
export const TRANSCRIPTION_DURATION_MARGIN_SECONDS = 2;
/** The longest call the reservation shape admits (`provider_reservations_priced_shape`). */
const MAX_PRICED_MINUTES = 240;

// ---------------------------------------------------------------------------
// The provider port
// ---------------------------------------------------------------------------

export type TranscriptionOutcome =
  | {
      readonly ok: true;
      /** The audio's length as the provider measured it, in seconds. Stored with the transcript. */
      readonly durationSeconds: number;
      /**
       * The duration the provider's answer reports billing, when it differs from
       * `durationSeconds` (slice C3a). Absent: `durationSeconds` is what is settled. Null:
       * the answer reports none (Amazon Transcribe's job carries no media duration), so the
       * attempt is settled at its reservation — never at a computed figure.
       */
      readonly billedSeconds?: number | null | undefined;
      readonly language: string;
      readonly utterances: readonly CallTranscriptUtterance[];
    }
  /**
   * The final settings read, immediately before the request (slice C3a: a provider with
   * work before its request, as Amazon Transcribe's upload is, asks `finalCheck` after it),
   * said transcription is off: nothing was sent, nothing billed.
   */
  | { readonly ok: false; readonly kind: 'withdrawn'; readonly reason: TranscriptionRefusalCode }
  /**
   * The provider answered and refused (an HTTP 4xx): the request was not processed, so
   * nothing was billed. `code` is a word of ours (`deepgram_http_401`), never a body.
   */
  | { readonly ok: false; readonly kind: 'refused'; readonly code: string }
  /**
   * Nobody knows whether the provider processed it: a timeout, a dropped connection, a
   * 5xx, an answer that could not be read. It may have been billed.
   */
  | { readonly ok: false; readonly kind: 'ambiguous'; readonly code: string }
  /**
   * An asynchronous provider (Amazon Transcribe, slice C3a fix round) was asked to start
   * its job — accepted, or perhaps accepted (`code` says which). Nothing is settled now:
   * the recorded job is collected later by `collectCallTranscription`, which finds out.
   */
  | { readonly ok: false; readonly kind: 'started'; readonly code: string };

/** What one look at a recorded provider job found (`TranscriptionJobs.collect`). */
export type CollectOutcome =
  /** Queued or in progress: look again later. */
  | { readonly kind: 'running' }
  /** The provider has no job of this name: it was never started. */
  | { readonly kind: 'not_found' }
  /** The look itself failed (a timeout, a 5xx): says nothing about the job. */
  | { readonly kind: 'unknown'; readonly code: string }
  /** The job ended FAILED: terminal, not billed. */
  | { readonly kind: 'failed'; readonly code: string }
  /** The job COMPLETED but its transcript is missing, cannot be read or is not two channels: it was billed. */
  | { readonly kind: 'unreadable'; readonly code: string }
  | {
      readonly kind: 'completed';
      readonly durationSeconds: number;
      readonly billedSeconds?: number | null | undefined;
      readonly language: string;
      readonly utterances: readonly CallTranscriptUtterance[];
    };

/**
 * The asynchronous half of a provider whose paid request starts a job it finishes later
 * (Amazon Transcribe, slice C3a). Chunk 3 records the job's names and commits BEFORE the
 * request (`submitting`), commits the start right after it (`started`), and never waits:
 * the job is collected by later, short claims. Nothing is owed to the provider afterwards:
 * the job writes its transcript next to its input, where the bucket's one-day lifecycle
 * expires both.
 */
export interface TranscriptionJobs {
  /** The job name and the input and output object keys an attempt's job will have, before anything is sent. */
  names(subject: { readonly sessionId: string; readonly attempt: number }): {
    readonly jobName: string;
    readonly inputKey: string;
    readonly outputKey: string;
  };
  /** One status read and, once it completed, one read of its output object: never a wait. */
  collect(job: { readonly jobName: string; readonly outputKey: string }): Promise<CollectOutcome>;
}

/**
 * How a provider prices audio (slice C3a). A provider without one is priced as C2's
 * Deepgram was: the setting's `unitPriceMicros` for every started minute.
 */
export interface TranscriptionPricing {
  /** Micro-dollars per minute of audio, in place of the setting's; null keeps the setting's. */
  readonly unitPriceMicros: number | null;
  /**
   * How many times one minute of recording is billed: 2 for a provider that may bill each
   * channel of the stereo recording separately. Folded into the reservation's
   * `unit_price_micros`, so the reservation and its settlement agree.
   */
  readonly billedChannels: number;
  /**
   * Billed by the second with this minimum (Amazon Transcribe: 15 s), rather than by the
   * started minute. Null: by the started minute.
   */
  readonly perSecondMinimumSeconds: number | null;
}

export const PER_MINUTE_PRICING: TranscriptionPricing = Object.freeze({
  unitPriceMicros: null,
  billedChannels: 1,
  perSecondMinimumSeconds: null,
});

export interface TranscriptionProvider {
  /** `provider_reservations.provider_key` and `provider_ledger.provider_key`, e.g. `deepgram.nova-3`. */
  readonly providerKey: string;
  /** `call_transcripts.provider`, e.g. `deepgram`. */
  readonly provider: string;
  /** `call_transcripts.model`, e.g. `nova-3`. */
  readonly model: string;
  /** Slice C3a. Absent: `PER_MINUTE_PRICING`. */
  readonly pricing?: TranscriptionPricing | undefined;
  /** Slice C3a fix round: present for a provider whose paid request starts a job (Amazon Transcribe). */
  readonly jobs?: TranscriptionJobs | undefined;
  /**
   * The longest one `transcribe` may take, in seconds, every wait and timeout included
   * (slice C3a). The job's lease is sized from it. Absent: C2's 120.
   */
  readonly maxCallSeconds?: number | undefined;
  /**
   * `subject` names the call and the paid attempt, so a provider that stores anything (a
   * job name, an object key) can make it unique to this attempt (slice C3a).
   */
  transcribe(input: {
    readonly audio: Buffer;
    readonly contentType: 'audio/mpeg';
    readonly subject?: { readonly sessionId: string; readonly attempt: number } | undefined;
    /**
     * The pause boundary (slice P1, `docs/greenfield/calling.md`, "What the pause
     * guarantees"): the final settings read. A provider that does anything slow before its
     * paid request calls this immediately before the request, and on a refusal sends
     * nothing and answers `withdrawn` with it. Null: still authorized.
     */
    readonly finalCheck?: (() => Promise<TranscriptionRefusalCode | null>) | undefined;
  }): Promise<TranscriptionOutcome>;
}

// ---------------------------------------------------------------------------
// Pricing and spend
// ---------------------------------------------------------------------------

/** Minutes a recording of `seconds` is priced as: started minutes, at least one, at most 240. */
export function transcriptionMinutes(seconds: number): number {
  return Math.min(MAX_PRICED_MINUTES, Math.max(1, Math.ceil(Math.max(0, seconds) / 60)));
}

/** Cents `minutes` cost at `unitPriceMicros` a minute, rounded up. */
export function transcriptionCents(minutes: number, unitPriceMicros: number): number {
  return Math.ceil((Math.trunc(minutes) * Math.trunc(unitPriceMicros)) / 10_000);
}

/** The reservation's price per minute of recording: the provider's or the setting's, times its billed channels. */
export function reservationUnitPriceMicros(pricing: TranscriptionPricing, settingMicros: number): number {
  const base = pricing.unitPriceMicros ?? settingMicros;
  return Math.min(10_000_000, Math.trunc(base) * Math.max(1, Math.trunc(pricing.billedChannels)));
}

/**
 * What one attempt settles at, from the duration the provider (or the audio sent to it)
 * measured, never past what was cleared: the audio was cut to the reserved minutes, so a
 * longer measure is rounding, not more audio.
 *
 *   * by the minute (C2): the started minutes, at least one, at most the reservation's;
 *   * by the second (Amazon Transcribe, C3a): `ceil(seconds)`, at least the provider's
 *     minimum (15 s), at most the reserved minutes' seconds, at `unitPriceMicros / 60` a
 *     second, rounded up to the cent.
 */
export function transcriptionSettledCents(
  pricing: TranscriptionPricing,
  durationSeconds: number,
  reservation: { readonly maxUnits: number; readonly unitPriceMicros: number },
): number {
  const maxMinutes = Math.max(1, Math.trunc(reservation.maxUnits));
  if (pricing.perSecondMinimumSeconds === null) {
    return transcriptionCents(Math.min(transcriptionMinutes(durationSeconds), maxMinutes), reservation.unitPriceMicros);
  }
  const measured = Math.ceil(Math.max(0, Number.isFinite(durationSeconds) ? durationSeconds : maxMinutes * 60));
  const seconds = Math.min(maxMinutes * 60, Math.max(Math.trunc(pricing.perSecondMinimumSeconds), measured));
  return Math.ceil((seconds * Math.trunc(reservation.unitPriceMicros)) / 600_000);
}

/**
 * Cents of transcription on one business date: what settled, plus what is reserved or
 * calling. Read from the reservations of the subject, so it is the same number whichever
 * provider the rows name. The ceiling check and Settings' "spent today" both ask this.
 */
export async function transcriptionSpentCents(context: RepositoryContext, businessDate: string): Promise<number> {
  const { rows } = await context.db.query<{ cents: string | null }>(
    `SELECT sum(CASE WHEN state IN ('reserved', 'calling') THEN cents ELSE settled_cents END)::text AS cents
       FROM provider_reservations
      WHERE workspace_id = $1 AND subject_kind = $2 AND business_date = $3::date`,
    [context.scope.workspaceId, TRANSCRIPTION_SUBJECT_KIND, businessDate],
  );
  return Number(rows[0]?.cents ?? 0);
}

export async function transcriptionSpentToday(context: RepositoryContext): Promise<number> {
  const zone = await workspaceBusinessZone(context);
  return await transcriptionSpentCents(context, localDate(await databaseNow(context), zone));
}

// ---------------------------------------------------------------------------
// Whether a worker can transcribe (review fold 1, P2)
// ---------------------------------------------------------------------------

/**
 * The key in a worker heartbeat's `detail` that says the beating runner has
 * `call.transcribe` registered — which it has only when its task was given both the
 * `transcription` key and the Twilio recording credentials. The API reads this instead of
 * the secret: the Deepgram key reaches the worker's process and no other.
 */
export const TRANSCRIPTION_HEARTBEAT_FLAG = 'call_transcribe';

/**
 * Whether some worker that is alive now (its heartbeat fresh, as `heartbeatIsFresh`
 * defines it) can run `call.transcribe`. The recording callback asks this before it
 * queues a transcription, and Settings asks it for "the key is in place".
 */
export async function transcriptionWorkerAvailable(db: Queryable): Promise<boolean> {
  const { rows } = await db.query<{ available: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM heartbeats
        WHERE component = 'worker' AND detail ->> $1 = 'true'
          AND observed_at + make_interval(secs => expected_interval_seconds + $2) >= now()
     ) AS available`,
    [TRANSCRIPTION_HEARTBEAT_FLAG, HEARTBEAT_GRACE_SECONDS.worker],
  );
  return rows[0]?.available === true;
}

// ---------------------------------------------------------------------------
// Eligibility and the enqueue
// ---------------------------------------------------------------------------

function systemContext(db: Queryable, workspaceId: string): RepositoryContext {
  return repositoryContext(workspaceScope(workspaceId, { kind: 'system', component: 'worker' }), db);
}

interface SessionFacts {
  readonly answered: boolean;
  readonly recordingPath: string | null;
  readonly recordingSeconds: number | null;
}

async function sessionFacts(context: RepositoryContext, sessionId: string): Promise<SessionFacts | null> {
  const { rows } = await context.db.query<{
    answered_at: Date | null;
    recording_path: string | null;
    recording_duration_seconds: number | null;
  }>(
    `SELECT answered_at, recording_path, recording_duration_seconds FROM call_sessions
      WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, sessionId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return {
    answered: row.answered_at !== null,
    recordingPath: row.recording_path,
    recordingSeconds: row.recording_duration_seconds === null ? null : Number(row.recording_duration_seconds),
  };
}

/** Answered, with a recording of at least twenty seconds. */
function eligible(facts: SessionFacts | null): facts is SessionFacts & { readonly recordingPath: string; readonly recordingSeconds: number } {
  return (
    facts !== null &&
    facts.answered &&
    facts.recordingPath !== null &&
    facts.recordingSeconds !== null &&
    facts.recordingSeconds >= TRANSCRIPTION_MINIMUM_SECONDS
  );
}

export type EnqueueTranscriptionOutcome =
  | { readonly enqueued: true; readonly jobId: string }
  | { readonly enqueued: false; readonly reason: TranscriptionRefusalCode };

/**
 * Queue the transcription of one call, from the final recording callback, in its
 * transaction. `keyConfigured` is whether this process found the `transcription` key in
 * place (`transcriptionSecret.ts`); the worker asks again with its own.
 */
export async function enqueueCallTranscription(
  db: Queryable,
  input: { readonly workspaceId: string; readonly sessionId: string; readonly keyConfigured: boolean },
): Promise<EnqueueTranscriptionOutcome> {
  const context = systemContext(db, input.workspaceId);
  const setting = await readCallTranscription(context);
  if (!setting.enabled || setting.dailyCeilingCents <= 0) return { enqueued: false, reason: 'transcription_off' };
  if (!input.keyConfigured) return { enqueued: false, reason: 'transcription_unconfigured' };
  if (!eligible(await sessionFacts(context, input.sessionId))) return { enqueued: false, reason: 'transcription_not_eligible' };
  const queued = await enqueueJob(db, {
    workspaceId: input.workspaceId,
    kind: 'call.transcribe',
    idempotencyKey: jobIdempotencyKey.callTranscribe(input.sessionId),
    payload: { callSessionId: input.sessionId },
    maxAttempts: CALL_TRANSCRIBE_JOB_MAX_ATTEMPTS,
  });
  return { enqueued: true, jobId: queued.jobId };
}

/**
 * The job's own attempts: a poison payload or a database error, never the provider (a
 * provider outcome completes the job; the money's retry is `TRANSCRIPTION_MAX_ATTEMPTS`).
 */
export const CALL_TRANSCRIBE_JOB_MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// The chunks
// ---------------------------------------------------------------------------

/** The per-session lock all three chunks, the sweep and the deletion take. */
function transcriptionLockName(workspaceId: string, sessionId: string): string {
  return `${workspaceId}:call_transcription:${sessionId}`;
}

export async function lockTranscription(context: RepositoryContext, sessionId: string): Promise<void> {
  await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    transcriptionLockName(context.scope.workspaceId, sessionId),
  ]);
}

/**
 * The workspace's transcription budget lock (re-entrant). Taken by every clearance, and by
 * chunk 2 before it settles anything (slice P1, fix round 2): a settlement takes the monthly
 * spend lock, which comes after this one in the one lock order.
 */
async function lockTranscriptionBudget(context: RepositoryContext): Promise<void> {
  await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `${context.scope.workspaceId}:transcription_budget`,
  ]);
}

async function tryLockTranscription(context: RepositoryContext, sessionId: string): Promise<boolean> {
  const { rows } = await context.db.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked',
    [transcriptionLockName(context.scope.workspaceId, sessionId)],
  );
  return rows[0]?.locked === true;
}

interface AttemptRow {
  readonly id: string;
  readonly attempt: number;
  /** The provider the attempt was reserved and priced for (C3a fix round: never settled under another). */
  readonly providerKey: string;
  readonly state: ReservationState;
  readonly cents: number;
  readonly unitPriceMicros: number;
  /** The minutes this attempt was priced at: the most audio it may send and be settled at. */
  readonly maxUnits: number;
}

async function listTranscriptionAttempts(context: RepositoryContext, sessionId: string): Promise<readonly AttemptRow[]> {
  const { rows } = await context.db.query<{
    id: string;
    attempt: number;
    provider_key: string;
    state: ReservationState;
    cents: number;
    unit_price_micros: number | null;
    max_units: number | null;
  }>(
    `SELECT id, attempt, provider_key, state, cents, unit_price_micros, max_units FROM provider_reservations
      WHERE workspace_id = $1 AND subject_kind = $2 AND subject_id = $3
      ORDER BY attempt DESC`,
    [context.scope.workspaceId, TRANSCRIPTION_SUBJECT_KIND, sessionId],
  );
  return rows.map(row => ({
    id: row.id,
    attempt: Number(row.attempt),
    providerKey: row.provider_key,
    state: row.state,
    cents: Number(row.cents),
    unitPriceMicros: Number(row.unit_price_micros ?? 0),
    maxUnits: Number(row.max_units ?? 0),
  }));
}

/** Attempts that may have reached the provider: every row but a released one. */
function paidAttempts(rows: readonly AttemptRow[]): number {
  return rows.filter(row => row.state !== 'released').length;
}

/** Whether the call already has a transcript. */
async function transcribed(context: RepositoryContext, sessionId: string): Promise<boolean> {
  const { rows } = await context.db.query('SELECT 1 FROM call_transcripts WHERE workspace_id = $1 AND call_session_id = $2', [
    context.scope.workspaceId,
    sessionId,
  ]);
  return rows.length > 0;
}

/**
 * Close open attempts from outside a claim: `reserved` is released, `calling` estimated.
 * `olderThanMinutes` (the sweep) closes only rows written at least that long ago, read
 * under the session's lock: a fresh retry a recovering claim wrote after the sweep chose
 * the session is a live attempt, not a lost one (review fold 1, P2).
 */
async function finaliseOpenAttempts(
  context: RepositoryContext,
  sessionId: string,
  at: string,
  options: { readonly olderThanMinutes?: number } = {},
): Promise<{ released: number; estimated: number }> {
  let released = 0;
  let estimated = 0;
  const old =
    options.olderThanMinutes === undefined
      ? null
      : new Set(
          (
            await context.db.query<{ id: string }>(
              `SELECT id FROM provider_reservations
                WHERE workspace_id = $1 AND subject_kind = $2 AND subject_id = $3
                  AND created_at + make_interval(mins => $4) <= clock_timestamp()`,
              [context.scope.workspaceId, TRANSCRIPTION_SUBJECT_KIND, sessionId, options.olderThanMinutes],
            )
          ).rows.map(row => row.id),
        );
  // The sweep leaves alone an attempt whose provider job is still being collected: the
  // collect claims settle it from the job's own answer (slice C3a fix round).
  const collecting = old === null ? new Set<string>() : await reservationsBeingCollected(context, sessionId);
  for (const row of await listTranscriptionAttempts(context, sessionId)) {
    if (old !== null && !old.has(row.id)) continue;
    if (collecting.has(row.id)) continue;
    if (row.state === 'reserved') {
      if ((await settleAttempt(context, { reservationId: row.id, at, outcome: { kind: 'released' } })) !== null) released += 1;
    } else if (row.state === 'calling') {
      if ((await settleAttempt(context, { reservationId: row.id, at, outcome: { kind: 'estimated' } })) !== null) estimated += 1;
    }
  }
  return { released, estimated };
}

/**
 * Whether a paid call is still authorized now: the switch on, a ceiling above 0, the key
 * in place. Asked again immediately before the provider is called, so a reservation made
 * while it was on does not outlive a later "off" or a $0 ceiling (review fold 1, P2).
 */
async function stillAuthorized(
  context: RepositoryContext,
  keyConfigured: boolean,
): Promise<TranscriptionRefusalCode | null> {
  const setting = await readCallTranscription(context);
  if (!setting.enabled || setting.dailyCeilingCents <= 0) return 'transcription_off';
  return keyConfigured ? null : 'transcription_unconfigured';
}

type Clearance =
  | { readonly ok: true; readonly cents: number; readonly minutes: number; readonly unitPriceMicros: number; readonly businessDate: string; readonly zone: string }
  | { readonly ok: false; readonly reason: TranscriptionRefusalCode };

/**
 * Every condition for one paid attempt, asked now: the switch, the key, the call, and the
 * day's ceiling under the workspace's transcription budget lock.
 */
async function clearAttempt(
  context: RepositoryContext,
  input: {
    readonly sessionId: string;
    readonly at: string;
    readonly keyConfigured: boolean;
    readonly providerKey: string;
    readonly pricing?: TranscriptionPricing | undefined;
  },
): Promise<Clearance> {
  const setting = await readCallTranscription(context);
  if (!setting.enabled) return { ok: false, reason: 'transcription_off' };
  if (!input.keyConfigured) return { ok: false, reason: 'transcription_unconfigured' };
  const facts = await sessionFacts(context, input.sessionId);
  if (!eligible(facts)) return { ok: false, reason: 'transcription_not_eligible' };
  // Serialised per workspace, so two calls cannot both fit the last cents.
  await lockTranscriptionBudget(context);
  const zone = await workspaceBusinessZone(context);
  const businessDate = localDate(input.at, zone);
  // Priced with the margin; these minutes are the bound the audio is cut to before upload.
  const minutes = transcriptionMinutes(facts.recordingSeconds + TRANSCRIPTION_DURATION_MARGIN_SECONDS);
  // The provider's price where it has one (Amazon Transcribe, slice C3a), else the setting's.
  const unitPriceMicros = reservationUnitPriceMicros(input.pricing ?? PER_MINUTE_PRICING, setting.unitPriceMicros);
  const cents = transcriptionCents(minutes, unitPriceMicros);
  if (setting.dailyCeilingCents <= 0) return { ok: false, reason: 'transcription_budget_exhausted' };
  const spent = await transcriptionSpentCents(context, businessDate);
  if (spent + cents > setting.dailyCeilingCents) return { ok: false, reason: 'transcription_budget_exhausted' };
  // And the month's cash ceiling (slice P1, invariant I2), under the workspace's monthly
  // lock taken inside the daily one; the caller inserts the reservation in this transaction.
  // A credit-funded provider (Amazon Transcribe, slice C3a) is not cash: its cents count
  // against the day's transcription cap above and never against the month's cash.
  if (providerFunding(input.providerKey) === 'cash' && !(await clearMonthlyCash(context, { at: input.at, zone, cents }))) {
    return { ok: false, reason: 'monthly_cash_ceiling' };
  }
  return { ok: true, cents, minutes, unitPriceMicros, businessDate, zone };
}

async function reserve(
  context: RepositoryContext,
  input: { readonly sessionId: string; readonly attempt: number; readonly providerKey: string; readonly clearance: Clearance & { readonly ok: true } },
): Promise<string> {
  await context.db.query(
    `INSERT INTO provider_reservations
       (workspace_id, provider_key, subject_kind, subject_id, attempt, business_date, business_time_zone,
        cents, priced_unit, max_units, unit_price_micros, state)
     VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, 'minute', $9, $10, 'reserved')
     ON CONFLICT ON CONSTRAINT provider_reservations_one_per_attempt DO NOTHING`,
    [
      context.scope.workspaceId,
      input.providerKey,
      TRANSCRIPTION_SUBJECT_KIND,
      input.sessionId,
      input.attempt,
      input.clearance.businessDate,
      input.clearance.zone,
      input.clearance.cents,
      input.clearance.minutes,
      input.clearance.unitPriceMicros,
    ],
  );
  const { rows } = await context.db.query<{ id: string }>(
    `SELECT id FROM provider_reservations WHERE workspace_id = $1 AND subject_kind = $2 AND subject_id = $3 AND attempt = $4`,
    [context.scope.workspaceId, TRANSCRIPTION_SUBJECT_KIND, input.sessionId, input.attempt],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('a transcription reservation just written could not be read back');
  return id;
}

export type BeginOutcome =
  | { readonly kind: 'reserved'; readonly attempt: number }
  /** Nothing to do: transcribed already, or refused (the reason is a code with a sentence). */
  | { readonly kind: 'done'; readonly reason: TranscriptionRefusalCode | 'already_transcribed' };

/** Chunk 1: the conditions, the ceiling, and attempt 1's reservation. No provider is asked anything. */
export async function beginCallTranscription(
  context: RepositoryContext,
  input: {
    readonly sessionId: string;
    readonly at: string;
    readonly keyConfigured: boolean;
    readonly providerKey: string;
    readonly pricing?: TranscriptionPricing | undefined;
  },
): Promise<BeginOutcome> {
  await lockTranscription(context, input.sessionId);
  if (await transcribed(context, input.sessionId)) return { kind: 'done', reason: 'already_transcribed' };
  // A claim whose cursor was lost after chunk 1 committed finds its own attempts here and
  // goes on to chunk 2, which resolves whatever state they are in; it clears nothing twice.
  const existing = await listTranscriptionAttempts(context, input.sessionId);
  const newest = existing[0];
  if (newest !== undefined) return { kind: 'reserved', attempt: newest.attempt };
  const clearance = await clearAttempt(context, input);
  if (!clearance.ok) return { kind: 'done', reason: clearance.reason };
  await reserve(context, { sessionId: input.sessionId, attempt: 1, providerKey: input.providerKey, clearance });
  return { kind: 'reserved', attempt: 1 };
}

export type CallingOutcome =
  | { readonly kind: 'calling'; readonly attempt: number }
  /** A provider job of this call is still being collected (slice C3a fix round). */
  | { readonly kind: 'collecting' }
  | { readonly kind: 'closed'; readonly reason: TranscriptionRefusalCode | 'already_transcribed' };

/**
 * Chunk 2: make "a provider call may now have happened" durable for one attempt.
 *
 * Anything this function finds `calling` was marked by another claim — the handler sends
 * its own straight to chunk 3 — so it is ambiguous, and is settled `estimated` before a
 * fresh attempt is reserved: a retry is a second authorization, cleared against the
 * ceiling like the first, and there are at most `TRANSCRIPTION_MAX_ATTEMPTS`.
 */
export async function ensureTranscriptionCalling(
  context: RepositoryContext,
  input: {
    readonly sessionId: string;
    readonly at: string;
    readonly keyConfigured: boolean;
    readonly providerKey: string;
    readonly pricing?: TranscriptionPricing | undefined;
  },
): Promise<CallingOutcome> {
  await lockTranscription(context, input.sessionId);
  // The budget lock before any settlement below: an estimate takes the monthly spend lock,
  // and a retry's clearance takes this one, so this one comes first (fix round 2, finding 4).
  await lockTranscriptionBudget(context);
  if ((await sessionFacts(context, input.sessionId)) === null || (await transcribed(context, input.sessionId))) {
    await finaliseOpenAttempts(context, input.sessionId, input.at);
    return { kind: 'closed', reason: 'already_transcribed' };
  }
  // A provider job still being collected owns its attempt: nothing here estimates it or
  // buys another (slice C3a fix round). The collect claims settle it.
  if ((await reservationsBeingCollected(context, input.sessionId)).size > 0) return { kind: 'collecting' };
  // A terminal outcome is terminal (review C3-F, finding 4): a job that FAILED or was given
  // up at its deadline closes the call; no later claim buys another.
  if (await providerJobFailed(context, input.sessionId)) {
    await finaliseOpenAttempts(context, input.sessionId, input.at);
    return { kind: 'closed', reason: 'transcription_failed' };
  }
  let rows = await listTranscriptionAttempts(context, input.sessionId);
  // A reservation made for another provider (the deployment switched between Amazon
  // Transcribe and Deepgram) is never called with this one: it is released — nothing was
  // sent — and this provider's own attempt is reserved and cleared below.
  for (const row of rows) {
    if (row.state === 'reserved' && row.providerKey !== input.providerKey) {
      await settleAttempt(context, { reservationId: row.id, at: input.at, outcome: { kind: 'released' } });
    }
  }
  rows = await listTranscriptionAttempts(context, input.sessionId);
  const reserved = rows.find(row => row.state === 'reserved');
  const withdrawn = await stillAuthorized(context, input.keyConfigured);
  if (withdrawn !== null) {
    // Turned off, set to $0 or without a key since the reservation was made: every open
    // attempt is closed — `reserved` released (nothing was called), `calling` estimated.
    await finaliseOpenAttempts(context, input.sessionId, input.at);
    return { kind: 'closed', reason: withdrawn };
  }
  if (reserved !== undefined) {
    await markCalling(context, reserved.id);
    return { kind: 'calling', attempt: reserved.attempt };
  }
  for (const row of rows) {
    if (row.state === 'calling') {
      await settleAttempt(context, { reservationId: row.id, at: input.at, outcome: { kind: 'estimated' } });
    }
  }
  // Paid attempts only: one released before any provider call (paused, slice P1) cost
  // nothing and is no reason to give up; the row cap bounds those.
  if (paidAttempts(rows) >= TRANSCRIPTION_MAX_ATTEMPTS || rows.length >= TRANSCRIPTION_MAX_ROWS) {
    return { kind: 'closed', reason: 'transcription_failed' };
  }
  const clearance = await clearAttempt(context, input);
  if (!clearance.ok) return { kind: 'closed', reason: clearance.reason };
  const attempt = rows.reduce((highest, row) => Math.max(highest, row.attempt), 0) + 1;
  const id = await reserve(context, { sessionId: input.sessionId, attempt, providerKey: input.providerKey, clearance });
  await markCalling(context, id);
  return { kind: 'calling', attempt };
}

export type FinishOutcome =
  | { readonly kind: 'transcribed'; readonly settledCents: number; readonly utterances: number }
  /** The attempt was ambiguous and is estimated; chunk 2 may reserve the bounded retry. */
  | { readonly kind: 'retry'; readonly code: string }
  /**
   * Slice C3a fix round, an asynchronous provider: the job's names are recorded and
   * committed (`submitting`); the next chunk, from this claim's cursor, sends the request.
   */
  | { readonly kind: 'prepared' }
  /** The job was started (or may have been) and is recorded: later claims collect it. */
  | { readonly kind: 'started'; readonly code: string }
  | { readonly kind: 'done'; readonly reason: TranscriptionRefusalCode | 'already_transcribed' | 'not_calling'; readonly code?: string };

/** How long after a look the next one is, by the number of looks so far: 20 s, doubling, at most 5 min. */
export function transcriptionPollDelaySeconds(looks: number): number {
  return Math.min(300, 20 * 2 ** Math.max(0, Math.trunc(looks)));
}
/** A recorded job still unfinished this long after it was written is given up on: estimated, terminal. */
export const TRANSCRIPTION_COLLECT_DEADLINE_MINUTES = 120;
/**
 * The grace a `submitting` row has before a collect look may judge it: long enough for the
 * claim that wrote it to send the request in its very next chunk.
 */
export const TRANSCRIPTION_SUBMIT_GRACE_SECONDS = 300;

type ProviderJobState = 'submitting' | 'started' | 'collected' | 'estimated' | 'failed';

interface ProviderJobRow {
  readonly id: string;
  readonly jobName: string;
  readonly attempt: number;
  readonly reservationId: string;
  readonly providerKey: string;
  readonly outputKey: string;
  readonly state: ProviderJobState;
  readonly looks: number;
  readonly expired: boolean;
}

const PROVIDER_JOB_COLUMNS = `id, job_name, attempt, reservation_id, provider_key, output_key, state, looks,
  created_at + make_interval(mins => ${String(TRANSCRIPTION_COLLECT_DEADLINE_MINUTES)}) <= now() AS expired`;

function providerJobOf(row: Record<string, unknown>): ProviderJobRow {
  return {
    id: String(row['id']),
    jobName: String(row['job_name']),
    attempt: Number(row['attempt']),
    reservationId: String(row['reservation_id']),
    providerKey: String(row['provider_key']),
    outputKey: String(row['output_key']),
    state: row['state'] as ProviderJobState,
    looks: Number(row['looks']),
    expired: row['expired'] === true,
  };
}

async function providerJobsOf(context: RepositoryContext, sessionId: string): Promise<readonly ProviderJobRow[]> {
  const { rows } = await context.db.query<Record<string, unknown>>(
    `SELECT ${PROVIDER_JOB_COLUMNS} FROM transcription_provider_jobs
      WHERE workspace_id = $1 AND call_session_id = $2 ORDER BY attempt DESC`,
    [context.scope.workspaceId, sessionId],
  );
  return rows.map(providerJobOf);
}

/** The reservations whose provider job is recorded and not yet collected. */
async function reservationsBeingCollected(context: RepositoryContext, sessionId: string): Promise<ReadonlySet<string>> {
  return new Set(
    (await providerJobsOf(context, sessionId)).filter(job => job.state === 'submitting' || job.state === 'started').map(job => job.reservationId),
  );
}

/** Whether a recorded job of this call ended terminally (FAILED, or given up at the deadline). */
async function providerJobFailed(context: RepositoryContext, sessionId: string): Promise<boolean> {
  return (await providerJobsOf(context, sessionId)).some(job => job.state === 'failed');
}

async function markProviderJob(
  context: RepositoryContext,
  jobName: string,
  change: { readonly state: ProviderJobState; readonly lookInSeconds?: number },
): Promise<void> {
  const finished = change.state === 'collected' || change.state === 'estimated' || change.state === 'failed';
  await context.db.query(
    `UPDATE transcription_provider_jobs
        SET state = $3,
            started_at = CASE WHEN $3 = 'started' THEN COALESCE(started_at, now()) ELSE started_at END,
            finished_at = CASE WHEN $4 THEN COALESCE(finished_at, now()) ELSE NULL END,
            next_look_at = now() + make_interval(secs => $5)
      WHERE workspace_id = $1 AND job_name = $2`,
    [context.scope.workspaceId, jobName, change.state, finished, change.lookInSeconds ?? 0],
  );
}

/** Store the transcript and settle the attempt by id, once: the one place either is written. */
async function storeAndSettle(
  context: RepositoryContext,
  input: {
    readonly sessionId: string;
    readonly at: string;
    readonly provider: TranscriptionProvider;
    readonly reservation: AttemptRow;
    readonly result: { readonly durationSeconds: number; readonly billedSeconds?: number | null | undefined; readonly language: string; readonly utterances: readonly CallTranscriptUtterance[] };
  },
): Promise<FinishOutcome> {
  const { reservation, result } = input;
  const durationSeconds = Math.max(0, Math.min(86_400, Math.round(result.durationSeconds)));
  const utterances = result.utterances.slice(0, CALL_TRANSCRIPT_MAX_UTTERANCES);
  await context.db.query(
    `INSERT INTO call_transcripts (workspace_id, call_session_id, provider, model, language, duration_seconds, utterances)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT ON CONSTRAINT call_transcripts_pkey DO NOTHING`,
    [
      context.scope.workspaceId,
      input.sessionId,
      input.provider.provider,
      input.provider.model,
      result.language,
      durationSeconds,
      JSON.stringify(utterances),
    ],
  );
  await enqueueNativeCrmExtraction(context,{kind:'call_transcript',sourceId:input.sessionId});
  // Settled at the provider's duration, never past the minutes that were cleared: the audio
  // was cut to them, so a longer report is the provider's rounding, not more audio. By the
  // started minute, or by the second for a provider that bills so (slice C3a).
  // An answer that reports no billed duration is settled at the reservation (slice C3a).
  const billed = result.billedSeconds === undefined ? result.durationSeconds : result.billedSeconds;
  const cents =
    billed === null ? reservation.cents : transcriptionSettledCents(input.provider.pricing ?? PER_MINUTE_PRICING, billed, reservation);
  // By id, and only from `calling`: a second settlement of one attempt changes nothing.
  const settled = await settleAttempt(context, { reservationId: reservation.id, at: input.at, outcome: { kind: 'settled', cents } });
  return { kind: 'transcribed', settledCents: settled?.recordedCents ?? 0, utterances: utterances.length };
}

/**
 * Chunk 3: the recording, the provider call, the utterances, and this attempt's
 * reservation settled by id. Every exit closes the reservation — released when nothing
 * was asked of the provider, settled at the reported duration, settled at 0 for a
 * refusal the provider answered with, estimated for an ambiguous attempt. The one exit
 * that closes nothing is a database error, which rolls this chunk back and leaves the row
 * `calling` for the next claim to estimate.
 *
 * An asynchronous provider (`provider.jobs`, Amazon Transcribe; slice C3a fix round) takes
 * two chunks here, and neither waits for the job: the first records the job's names and
 * commits (`prepared`), so a crash after the request can never forget the job; the second
 * sends it and commits `started` right after. The job is then collected by later, short
 * claims (`collectCallTranscription`), and its attempt is settled there, once, by id.
 */
export async function finishCallTranscription(
  context: RepositoryContext,
  input: {
    readonly sessionId: string;
    readonly attempt: number;
    readonly at: string;
    readonly recordings: TwilioRecordingFetcher;
    readonly provider: TranscriptionProvider;
  },
): Promise<FinishOutcome> {
  await lockTranscription(context, input.sessionId);
  const rows = await listTranscriptionAttempts(context, input.sessionId);
  const reservation = rows.find(row => row.attempt === input.attempt);
  if (reservation === undefined || reservation.state !== 'calling') return { kind: 'done', reason: 'not_calling' };
  const jobs = input.provider.jobs;
  const recorded = jobs === undefined ? undefined : (await providerJobsOf(context, input.sessionId)).find(job => job.attempt === input.attempt);
  if (recorded !== undefined && recorded.state !== 'submitting') return { kind: 'done', reason: 'not_calling' };
  const releaseNotCalled = async (): Promise<void> => {
    await settleAttempt(context, { reservationId: reservation.id, at: input.at, outcome: { kind: 'released_not_called' } });
    // The job never started; what may have been uploaded expires with the bucket's lifecycle.
    if (recorded !== undefined) await markProviderJob(context, recorded.jobName, { state: 'estimated' });
  };
  // Reserved and priced for another provider (the deployment switched): never called or
  // settled under this one's key. Released — nothing was sent — and chunk 2 reserves again.
  if (reservation.providerKey !== input.provider.providerKey) {
    await releaseNotCalled();
    return { kind: 'retry', code: 'provider_changed' };
  }
  if (await transcribed(context, input.sessionId)) {
    await releaseNotCalled();
    return { kind: 'done', reason: 'already_transcribed' };
  }
  // Under the session's lock, which the deletion workflow takes for every session it
  // removes before it reads anything (review fold 1, P1): a session that is gone, or has
  // stopped qualifying, sends nothing.
  const facts = await sessionFacts(context, input.sessionId);
  if (!eligible(facts)) {
    await releaseNotCalled();
    return { kind: 'done', reason: 'transcription_not_eligible' };
  }
  // And still authorized: a reservation does not outlive "off", $0 or a missing key.
  const withdrawn = await stillAuthorized(context, true);
  if (withdrawn !== null) {
    await releaseNotCalled();
    return { kind: 'done', reason: withdrawn };
  }

  if (jobs !== undefined && recorded === undefined) {
    // The job's names, committed before anything is sent: whatever happens after the
    // request, the job is known and is collected and deleted, never forgotten.
    const names = jobs.names({ sessionId: input.sessionId, attempt: input.attempt });
    await context.db.query(
      `INSERT INTO transcription_provider_jobs
         (workspace_id, job_name, call_session_id, attempt, reservation_id, provider_key, input_key, output_key, next_look_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(secs => $9))
       ON CONFLICT DO NOTHING`,
      [
        context.scope.workspaceId,
        names.jobName,
        input.sessionId,
        input.attempt,
        reservation.id,
        input.provider.providerKey,
        names.inputKey,
        names.outputKey,
        TRANSCRIPTION_SUBMIT_GRACE_SECONDS,
      ],
    );
    return { kind: 'prepared' };
  }

  const recording = await input.recordings.fetchRecording(facts.recordingPath);
  if (!recording.ok) {
    // Nothing was sent to the provider, so these cents go back. No retry: the recording
    // is Twilio's, and one that cannot be read now is a call the firm page shows untranscribed.
    await releaseNotCalled();
    return { kind: 'done', reason: 'transcription_failed', code: `recording_${recording.reason}` };
  }

  // The bound made real: the provider is sent at most the minutes this attempt was priced
  // at, cut at a frame boundary, so what it can bill is what was cleared. Audio that cannot
  // be read as MP3 is not sent at all.
  const bounded = boundMp3(recording.bytes, reservation.maxUnits * 60);
  if (bounded === null) {
    await releaseNotCalled();
    return { kind: 'done', reason: 'transcription_failed', code: 'recording_unreadable' };
  }
  if ((await sessionFacts(context, input.sessionId)) === null) {
    await releaseNotCalled();
    return { kind: 'done', reason: 'transcription_not_eligible' };
  }
  // The final pause check (slice P1, invariant I1), immediately before the provider call.
  // The check above ran before the recording was read from Twilio, which is a network
  // round trip; a switch turned off (or a ceiling set to $0) during it is read here.
  const withdrawnLate = await stillAuthorized(context, true);
  if (withdrawnLate !== null) {
    await releaseNotCalled();
    return { kind: 'done', reason: withdrawnLate };
  }

  let outcome: TranscriptionOutcome;
  try {
    outcome = await input.provider.transcribe({
      audio: bounded.bytes,
      contentType: recording.contentType,
      subject: { sessionId: input.sessionId, attempt: input.attempt },
      // Read again where the provider's request actually leaves (after an upload, say).
      finalCheck: async () => await stillAuthorized(context, true),
    });
  } catch {
    // A port that throws is a port whose call may have gone out. Never the error's text:
    // it is the provider adapter's, and the adapter is the one place a key could be.
    outcome = { ok: false, kind: 'ambiguous', code: 'provider_threw' };
  }

  if (recorded !== undefined) {
    // An asynchronous provider: refused or withdrawn means no job was started. Anything
    // else — started, or not known either way — is collected: the job's own status says
    // whether it exists, so an attempt that may have started is never bought twice.
    if (!outcome.ok && outcome.kind === 'withdrawn') {
      await releaseNotCalled();
      return { kind: 'done', reason: outcome.reason };
    }
    if (!outcome.ok && outcome.kind === 'refused') {
      await settleAttempt(context, { reservationId: reservation.id, at: input.at, outcome: { kind: 'settled', cents: 0 } });
      await markProviderJob(context, recorded.jobName, { state: 'failed' });
      return { kind: 'done', reason: 'transcription_failed', code: outcome.code };
    }
    await markProviderJob(context, recorded.jobName, { state: 'started', lookInSeconds: transcriptionPollDelaySeconds(0) });
    return { kind: 'started', code: outcome.ok ? 'started' : outcome.code };
  }

  if (!outcome.ok) {
    if (outcome.kind === 'withdrawn') {
      await releaseNotCalled();
      return { kind: 'done', reason: outcome.reason };
    }
    if (outcome.kind === 'refused') {
      await settleAttempt(context, { reservationId: reservation.id, at: input.at, outcome: { kind: 'settled', cents: 0 } });
      return { kind: 'done', reason: 'transcription_failed', code: outcome.code };
    }
    // Ambiguous (or a synchronous provider answering `started`, which none does): estimated
    // at the reservation first, then the bounded retry (chunk 2).
    await settleAttempt(context, { reservationId: reservation.id, at: input.at, outcome: { kind: 'estimated' } });
    if (paidAttempts(rows) >= TRANSCRIPTION_MAX_ATTEMPTS || rows.length >= TRANSCRIPTION_MAX_ROWS) return { kind: 'done', reason: 'transcription_failed', code: outcome.code };
    return { kind: 'retry', code: outcome.code };
  }

  return await storeAndSettle(context, { sessionId: input.sessionId, at: input.at, provider: input.provider, reservation, result: outcome });
}

// ---------------------------------------------------------------------------
// Collecting a recorded provider job (slice C3a)
// ---------------------------------------------------------------------------

export type CollectTranscriptionOutcome =
  /** No recorded job of this call is waiting to be collected. */
  | { readonly kind: 'none' }
  /** Still running: looked at again later, by another short claim. */
  | { readonly kind: 'pending' }
  | { readonly kind: 'transcribed'; readonly settledCents: number; readonly utterances: number }
  /** Ambiguous: the attempt is estimated, and may be retried once within the cap (chunk 2 decides). */
  | { readonly kind: 'retry'; readonly code: string }
  /** Terminal: nothing more is bought for this call. */
  | { readonly kind: 'done'; readonly reason: TranscriptionRefusalCode | 'already_transcribed'; readonly code: string };

/**
 * The one give-up path: the attempt estimated (when it is still `calling`) and the job
 * `failed`, terminal. The caller holds the session lock and the budget lock, in that order.
 * Used by a look that finds the job past its deadline and by the scheduler, which gives up
 * a job past its deadline itself when no look ever ran.
 */
async function giveUpProviderJob(
  context: RepositoryContext,
  job: ProviderJobRow,
  reservation: { readonly id: string; readonly state: string } | undefined,
  at: string,
): Promise<void> {
  if (reservation?.state === 'calling') {
    await settleAttempt(context, { reservationId: reservation.id, at, outcome: { kind: 'estimated' } });
  }
  await markProviderJob(context, job.jobName, { state: 'failed' });
}

/** How many jobs past their deadline one scheduler pass gives up. */
export const TRANSCRIPTION_GIVE_UPS_PER_PASS = 20;
/** How many expired jobs one pass looks at to find those it can give up: busy ones are passed over, not counted. */
export const TRANSCRIPTION_GIVE_UP_WINDOW = 200;

async function tryAdvisoryLock(db: Queryable, name: string): Promise<boolean> {
  const { rows } = await db.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS locked', [name]);
  return rows[0]?.locked === true;
}

/**
 * Gives up, in the scheduler pass's own transaction, the recorded jobs past
 * `TRANSCRIPTION_COLLECT_DEADLINE_MINUTES` that are still open. A look enforces the deadline
 * only when it runs; a row whose look jobs all die would otherwise be looked at every five
 * minutes for ever. Database writes only (the attempt is estimated at its reservation, as
 * every give-up is); no provider is asked.
 *
 * It never waits (a collector holds the budget lock across its provider request, and the
 * pass's statement timeout would roll the whole pass back): the session lock, the budget lock
 * and the monthly spend lock, in the repo's one lock order, are each only tried. A job whose
 * locks are not all free is skipped, inside a savepoint so that nothing it took stays held,
 * and is given up by a later pass. The scan looks at `TRANSCRIPTION_GIVE_UP_WINDOW` expired
 * jobs, oldest first, and gives up at most `TRANSCRIPTION_GIVE_UPS_PER_PASS` of them, so busy
 * jobs cannot occupy the pass.
 */
async function giveUpExpiredProviderJobs(db: Queryable): Promise<void> {
  const { rows } = await db.query<{ workspace_id: string; call_session_id: string; job_name: string }>(
    `SELECT workspace_id, call_session_id, job_name FROM transcription_provider_jobs
      WHERE state IN ('submitting', 'started')
        AND created_at + make_interval(mins => ${String(TRANSCRIPTION_COLLECT_DEADLINE_MINUTES)}) <= now()
      ORDER BY created_at, id
      LIMIT $1`,
    [TRANSCRIPTION_GIVE_UP_WINDOW],
  );
  let givenUp = 0;
  for (const row of rows) {
    if (givenUp >= TRANSCRIPTION_GIVE_UPS_PER_PASS) return;
    // A savepoint where there is a transaction (the scheduler pass); outside one the locks
    // are released by each statement anyway.
    let savepoint = true;
    try {
      await db.query('SAVEPOINT transcription_give_up');
    } catch {
      savepoint = false;
    }
    try {
      const context = repositoryContext(workspaceScope(row.workspace_id, { kind: 'system', component: 'scheduler' }), db);
      const free =
        (await tryLockTranscription(context, row.call_session_id)) &&
        (await tryAdvisoryLock(db, `${row.workspace_id}:transcription_budget`)) &&
        (await tryAdvisoryLock(db, `${row.workspace_id}:monthly_cash_ceiling`));
      if (!free) {
        if (savepoint) await db.query('ROLLBACK TO SAVEPOINT transcription_give_up');
        continue;
      }
      // Asked again under the locks: a claim may have finished the job since the read.
      const job = (await providerJobsOf(context, row.call_session_id)).find(
        candidate => candidate.jobName === row.job_name && (candidate.state === 'submitting' || candidate.state === 'started') && candidate.expired,
      );
      if (job === undefined) continue;
      const reservation = (await listTranscriptionAttempts(context, row.call_session_id)).find(attempt => attempt.id === job.reservationId);
      await giveUpProviderJob(context, job, reservation, await databaseNow(context));
      givenUp += 1;
    } finally {
      if (savepoint) await db.query('RELEASE SAVEPOINT transcription_give_up').catch(() => undefined);
    }
  }
}

/**
 * One look at the call's recorded provider job, under the session's lock, in a short
 * transaction: one status read and, once it completed, one read of its output object, then
 * the commit — nothing else, so the claim is bounded (`callTranscribeLeaseSeconds`). This is
 * what a claim does first, whoever started the job, so a crash or a lost lease after the
 * request resumes here: the job is collected, not estimated and bought again. If the commit
 * fails, the next look reads the same output again (it lives a day).
 *
 * `collector` is the Amazon Transcribe adapter, present whenever the call-audio bucket is
 * configured, whichever provider new attempts use: a deployment that switched to Deepgram
 * still collects the jobs Transcribe already has.
 *
 *   * running, or the look failed: looked at again when the collect source's schedule says
 *     (`scheduleTranscriptionLooks`, `transcriptionPollDelaySeconds` apart);
 *     after `TRANSCRIPTION_COLLECT_DEADLINE_MINUTES` the attempt is estimated and the job
 *     `failed` — terminal, never retried;
 *   * completed: the transcript stored and the attempt settled, once, by id;
 *   * FAILED: settled at 0 (not billed), `failed` — terminal;
 *   * no such job (the request never left — the claim died between the two commits), or
 *     completed but unreadable: estimated, as every attempt nobody can vouch for is, and
 *     retried once within the two paid attempts — the ordinary ambiguous rule.
 */
export async function collectCallTranscription(
  context: RepositoryContext,
  input: { readonly sessionId: string; readonly at: string; readonly collector: TranscriptionProvider },
): Promise<CollectTranscriptionOutcome> {
  await lockTranscription(context, input.sessionId);
  const job = (await providerJobsOf(context, input.sessionId)).find(row => row.state === 'submitting' || row.state === 'started');
  if (job === undefined) return { kind: 'none' };
  const rows = await listTranscriptionAttempts(context, input.sessionId);
  const reservation = rows.find(row => row.id === job.reservationId);
  // The budget lock before any settlement (the one lock order: an estimate takes the
  // monthly spend lock after it).
  await lockTranscriptionBudget(context);
  const estimate = async (): Promise<void> => {
    if (reservation?.state === 'calling') {
      await settleAttempt(context, { reservationId: reservation.id, at: input.at, outcome: { kind: 'estimated' } });
    }
  };
  const terminal = async (code: string): Promise<CollectTranscriptionOutcome> => {
    await giveUpProviderJob(context, job, reservation, input.at);
    return { kind: 'done', reason: 'transcription_failed', code };
  };
  const ambiguous = async (code: string): Promise<CollectTranscriptionOutcome> => {
    await estimate();
    await markProviderJob(context, job.jobName, { state: 'estimated' });
    if (paidAttempts(rows) >= TRANSCRIPTION_MAX_ATTEMPTS || rows.length >= TRANSCRIPTION_MAX_ROWS) {
      return { kind: 'done', reason: 'transcription_failed', code };
    }
    return { kind: 'retry', code };
  };
  const jobs = input.collector.jobs;
  if (job.providerKey !== input.collector.providerKey || jobs === undefined) return await terminal('provider_unknown');
  if (reservation === undefined || reservation.state !== 'calling') {
    // Closed already (a deletion, the sweep): nothing to settle.
    await markProviderJob(context, job.jobName, { state: 'estimated' });
    return { kind: 'done', reason: 'transcription_failed', code: 'attempt_closed' };
  }

  let seen: CollectOutcome;
  try {
    seen = await jobs.collect({ jobName: job.jobName, outputKey: job.outputKey });
  } catch {
    seen = { kind: 'unknown', code: 'collect_threw' };
  }
  switch (seen.kind) {
    case 'running':
    case 'unknown': {
      if (job.expired) return await terminal('provider_job_deadline');
      // The next look is already scheduled: the collect source moved `looks` and
      // `next_look_at` on when it emitted this look (review C3-N), so nothing to write.
      return { kind: 'pending' };
    }
    case 'not_found':
      return await ambiguous('provider_job_not_started');
    case 'unreadable':
      return await ambiguous(seen.code);
    case 'failed':
      await settleAttempt(context, { reservationId: reservation.id, at: input.at, outcome: { kind: 'settled', cents: 0 } });
      await markProviderJob(context, job.jobName, { state: 'failed' });
      return { kind: 'done', reason: 'transcription_failed', code: seen.code };
    case 'completed': {
      await markProviderJob(context, job.jobName, { state: 'collected' });
      if (await transcribed(context, input.sessionId)) {
        await estimate();
        return { kind: 'done', reason: 'already_transcribed', code: 'already_transcribed' };
      }
      const stored = await storeAndSettle(context, { sessionId: input.sessionId, at: input.at, provider: input.collector, reservation, result: seen });
      return stored.kind === 'transcribed' ? stored : { kind: 'done', reason: 'transcription_failed', code: 'not_settled' };
    }
  }
}

/** A recorded job due a look, with the key of its next `call.transcribe`. */
export interface TranscriptionJobDue {
  readonly workspaceId: string;
  readonly sessionId: string;
  /** `call-transcribe-collect:<row id>:<look>`: one job per look, never a key reused. */
  readonly idempotencyKey: string;
}

/** The key of one look's `call.transcribe`: the row's id and its look number. */
export function transcriptionCollectJobKey(rowId: string, look: number): string {
  return `call-transcribe-collect:${rowId}:${String(Math.trunc(look))}`;
}

/** How many recorded jobs one scheduler pass emits a look for. */
export const TRANSCRIPTION_LOOKS_PER_PASS = 50;

/**
 * The recorded jobs due a look now (slice C3a), with their next look scheduled in the same
 * statement (review C3-N): `submitting` past its grace, or `started`, with `next_look_at`
 * passed. Each emitted look moves `looks` on and sets `next_look_at` to the backoff after it,
 * in the scheduler pass's transaction with the enqueue, so a look job that dies (attempts
 * exhausted, a handler that throws) neither blocks that row's next look after its backoff nor
 * keeps the row at the front of the window: the window moves on to the next due rows. The
 * look's key is the row id and the look number before the move, so every look is a new job
 * however long the job runs. `TRANSCRIPTION_COLLECT_DEADLINE_MINUTES` still ends a job: the
 * scheduler itself gives up a job past it (`giveUpExpiredProviderJobs`, estimated and
 * `failed`) before it looks for due rows, and emits no look for it, so looks that never run
 * cannot keep a row alive; a look already claimed past it does the same. Rows a live claim holds are skipped
 * this pass, not waited for.
 */
export async function scheduleTranscriptionLooks(db: Queryable): Promise<readonly TranscriptionJobDue[]> {
  await giveUpExpiredProviderJobs(db);
  const { rows } = await db.query<{ id: string; workspace_id: string; call_session_id: string; look: number }>(
    `WITH due AS (
       SELECT workspace_id, job_name, looks FROM transcription_provider_jobs
        WHERE state IN ('submitting', 'started') AND next_look_at <= now()
          AND created_at + make_interval(mins => ${String(TRANSCRIPTION_COLLECT_DEADLINE_MINUTES)}) > now()
        ORDER BY next_look_at, id
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE transcription_provider_jobs j
        SET looks = due.looks + 1,
            next_look_at = now() + make_interval(secs => LEAST(300, 20 * power(2, LEAST(due.looks + 1, 8))))
       FROM due
      WHERE j.workspace_id = due.workspace_id AND j.job_name = due.job_name
      RETURNING j.id, j.workspace_id, j.call_session_id, due.looks AS look`,
    [TRANSCRIPTION_LOOKS_PER_PASS],
  );
  return rows.map(row => ({
    workspaceId: row.workspace_id,
    sessionId: row.call_session_id,
    idempotencyKey: transcriptionCollectJobKey(row.id, Number(row.look)),
  }));
}

/**
 * The S3 objects of this workspace's calls that no longer exist (slice C3a), for the
 * deletion workflow to delete after its commit, best effort: the input audio and the
 * transcript of every recorded attempt of a deleted call written in the last two days. Older
 * objects are already gone (the bucket's one-day lifecycle), so nothing is marked or owed.
 */
export async function callAudioKeysOfDeletedCalls(db: Queryable, workspaceId: string): Promise<readonly string[]> {
  const { rows } = await db.query<{ input_key: string; output_key: string }>(
    `SELECT j.input_key, j.output_key FROM transcription_provider_jobs j
      WHERE j.workspace_id = $1 AND j.created_at > now() - interval '2 days'
        AND NOT EXISTS (SELECT 1 FROM call_sessions s WHERE s.workspace_id = j.workspace_id AND s.id = j.call_session_id)
      ORDER BY j.input_key`,
    [workspaceId],
  );
  return rows.flatMap(row => [row.input_key, row.output_key]);
}

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

/**
 * Finalise the transcription reservations of one workspace whose claim is gone: open
 * `TRANSCRIPTION_SWEEP_MINUTES` after they were written. A session whose lock is held is
 * skipped — a live claim is calling against it — and seen again on the next pass.
 */
export async function sweepTranscriptionReservations(
  context: RepositoryContext,
): Promise<{ readonly released: number; readonly estimated: number }> {
  const { rows } = await context.db.query<{ subject_id: string }>(
    `SELECT DISTINCT subject_id FROM provider_reservations
      WHERE workspace_id = $1 AND subject_kind = $2 AND state IN ('reserved', 'calling')
        AND created_at + make_interval(mins => $3) <= now()
        AND NOT EXISTS (SELECT 1 FROM transcription_provider_jobs j
                         WHERE j.workspace_id = provider_reservations.workspace_id AND j.reservation_id = provider_reservations.id
                           AND j.state IN ('submitting', 'started'))
      ORDER BY subject_id`,
    [context.scope.workspaceId, TRANSCRIPTION_SUBJECT_KIND, TRANSCRIPTION_SWEEP_MINUTES],
  );
  let released = 0;
  let estimated = 0;
  const at = new Date().toISOString();
  for (const row of rows) {
    if (!(await tryLockTranscription(context, row.subject_id))) continue;
    const closed = await finaliseOpenAttempts(context, row.subject_id, at, { olderThanMinutes: TRANSCRIPTION_SWEEP_MINUTES });
    released += closed.released;
    estimated += closed.estimated;
  }
  return { released, estimated };
}

/**
 * Transcriptions the switch held (slice P1, invariant I1): paused work is held, not
 * completed, so turning transcription back on runs each of them once.
 *
 * A `call.transcribe` job that met "off" — at chunk 1, at chunk 2, or at the final check
 * before the provider call — completes with its reservation released, and the job store
 * ignores a second enqueue of the same key. So a held call is found from the rows: an
 * eligible call (answered, a recording of at least twenty seconds) of the last
 * `TRANSCRIPTION_RESUME_DAYS`, with no transcript, a `call.transcribe` job that has
 * finished (none queued, running or retryable), no open reservation, fewer than
 * `TRANSCRIPTION_MAX_ATTEMPTS` paid attempts, and a current setting that is on, has a
 * ceiling above 0, and was written **after** the last of those jobs finished. Each such
 * call is owed one job under a new revision key, `call-transcribe:{session}:r{n}`, n the
 * number of jobs the call already has: once that job finishes it is newer than the
 * setting, so a call is resumed at most once for each change of the setting, and a
 * resumed job pays only if the earlier ones did not (chunk 2 counts paid attempts).
 *
 * The same rule resumes a call refused for the day's ceiling once an administrator
 * changes the setting; a call never queued (it ended while transcription was off) is not
 * held work and is not transcribed later.
 */
export interface HeldTranscription {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly revision: number;
}

export async function listHeldTranscriptions(db: Queryable): Promise<readonly HeldTranscription[]> {
  const { rows } = await db.query<{ workspace_id: string; session_id: string; jobs: string }>(
    `SELECT cs.workspace_id, cs.id AS session_id, j.jobs::text AS jobs
       FROM call_sessions cs
       JOIN workspace_settings s
         ON s.workspace_id = cs.workspace_id AND s.setting_key = 'call_transcription' AND s.superseded_at IS NULL
       CROSS JOIN LATERAL (
         SELECT count(*) AS jobs, max(updated_at) AS finished_at,
                bool_and(state = 'done') AS all_done
           FROM jobs
          WHERE workspace_id = cs.workspace_id AND kind = 'call.transcribe'
            AND payload ->> 'callSessionId' = cs.id::text
       ) j
      WHERE cs.answered_at IS NOT NULL AND cs.recording_path IS NOT NULL
        AND cs.recording_duration_seconds >= $1
        AND cs.created_at > now() - make_interval(days => $2)
        AND (s.value ->> 'enabled')::boolean AND (s.value ->> 'dailyCeilingCents')::integer > 0
        AND j.jobs > 0 AND j.all_done AND s.changed_at > j.finished_at
        AND NOT EXISTS (SELECT 1 FROM call_transcripts t WHERE t.workspace_id = cs.workspace_id AND t.call_session_id = cs.id)
        AND NOT EXISTS (SELECT 1 FROM transcription_provider_jobs pj
                         WHERE pj.workspace_id = cs.workspace_id AND pj.call_session_id = cs.id AND pj.state IN ('submitting', 'started', 'failed'))
        AND NOT EXISTS (
          SELECT 1 FROM provider_reservations r
           WHERE r.workspace_id = cs.workspace_id AND r.subject_kind = $3 AND r.subject_id = cs.id
             AND r.state IN ('reserved', 'calling')
        )
        AND (
          SELECT count(*) FROM provider_reservations r
           WHERE r.workspace_id = cs.workspace_id AND r.subject_kind = $3 AND r.subject_id = cs.id
             AND r.state <> 'released'
        ) < $4
      ORDER BY cs.workspace_id, cs.id
      LIMIT 50`,
    [TRANSCRIPTION_MINIMUM_SECONDS, TRANSCRIPTION_RESUME_DAYS, TRANSCRIPTION_SUBJECT_KIND, TRANSCRIPTION_MAX_ATTEMPTS],
  );
  return rows.map(row => ({ workspaceId: row.workspace_id, sessionId: row.session_id, revision: Number(row.jobs) }));
}

/** The workspaces the transcription sweep would find work in now; the scheduler's question. */
export async function workspacesOwingTranscriptionSweep(db: Queryable): Promise<readonly string[]> {
  const { rows } = await db.query<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id FROM provider_reservations
      WHERE subject_kind = $1 AND state IN ('reserved', 'calling')
        AND created_at + make_interval(mins => $2) <= now()
        AND NOT EXISTS (SELECT 1 FROM transcription_provider_jobs j
                         WHERE j.workspace_id = provider_reservations.workspace_id AND j.reservation_id = provider_reservations.id
                           AND j.state IN ('submitting', 'started'))
      ORDER BY workspace_id`,
    [TRANSCRIPTION_SUBJECT_KIND, TRANSCRIPTION_SWEEP_MINUTES],
  );
  return rows.map(row => row.workspace_id);
}

/**
 * The deletion workflow's lock on the sessions it is about to remove (review fold 1,
 * P1): **every** one of them, with or without a transcription yet — each session's
 * transcription lock in id order (a claim mid-call finishes first; a claim that has not
 * begun waits, and then finds the session gone), then the session rows themselves. Taken
 * after the send gate and before anything is measured, and held to the commit.
 */
export async function lockSessionsForDeletion(context: RepositoryContext, sessionIds: readonly string[]): Promise<void> {
  const sorted = [...new Set(sessionIds)].sort();
  for (const sessionId of sorted) await lockTranscription(context, sessionId);
  if (sorted.length > 0) {
    await context.db.query('SELECT id FROM call_sessions WHERE workspace_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE', [
      context.scope.workspaceId,
      sorted,
    ]);
  }
}

/**
 * The deletion workflow's step for the sessions it is about to remove, under the locks
 * `lockSessionsForDeletion` took: their open attempts finalised as the sweep does it. The
 * transcripts themselves are deleted by the workflow (and would cascade).
 */
export async function finaliseTranscriptionsOfSessions(
  context: RepositoryContext,
  sessionIds: readonly string[],
  at: string,
): Promise<void> {
  for (const sessionId of [...sessionIds].sort()) {
    await lockTranscription(context, sessionId);
    await finaliseOpenAttempts(context, sessionId, at);
    // A provider job of a deleted call is never collected. Its rows outlive the session on
    // purpose, so the workflow can name the call's S3 objects after its commit
    // (`callAudioKeysOfDeletedCalls`); the bucket's one-day lifecycle is the backstop.
    await context.db.query(
      `UPDATE transcription_provider_jobs SET state = 'estimated', finished_at = COALESCE(finished_at, now())
        WHERE workspace_id = $1 AND call_session_id = $2 AND state IN ('submitting', 'started')`,
      [context.scope.workspaceId, sessionId],
    );
  }
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

/**
 * One call's transcript, for the firm's assigned salesperson or an admin; null when there
 * is none, or the session is unknown, another workspace's, or a firm the caller may not read.
 */
export async function readCallTranscript(context: RepositoryContext, sessionId: string): Promise<CallTranscriptResponse | null> {
  if (context.scope.actor.kind !== 'user') return null;
  if (!/^[0-9a-f-]{36}$/iu.test(sessionId)) return null;
  const { rows } = await context.db.query<{
    firm_id: string;
    provider: string;
    model: string;
    language: string;
    duration_seconds: number;
    utterances: unknown;
    created_at: Date;
  }>(
    `SELECT s.firm_id, t.provider, t.model, t.language, t.duration_seconds, t.utterances, t.created_at
       FROM call_transcripts t
       JOIN call_sessions s ON s.workspace_id = t.workspace_id AND s.id = t.call_session_id
      WHERE t.workspace_id = $1 AND t.call_session_id = $2`,
    [context.scope.workspaceId, sessionId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  const firm = await readFirm(context, row.firm_id);
  if (firm === null || !decideFirmMutation(context, firm).permitted) return null;
  return {
    callSessionId: sessionId,
    provider: row.provider,
    model: row.model,
    language: row.language,
    durationSeconds: Number(row.duration_seconds),
    createdAt: row.created_at.toISOString(),
    utterances: Array.isArray(row.utterances) ? (row.utterances as CallTranscriptUtterance[]) : [],
  };
}
