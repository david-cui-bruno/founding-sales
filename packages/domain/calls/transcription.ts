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
import { localDate } from '../src/rules/localClock.ts';
import type { TwilioRecordingFetcher } from './twilioRecording.ts';
import { boundMp3 } from './mp3Bound.ts';

/**
 * Call transcription (slice C2, migration 0030).
 *
 * After a connected call of at least `TRANSCRIPTION_MINIMUM_SECONDS` the worker sends its
 * recording to the transcription provider — Deepgram Nova-3, pre-recorded, diarized, with
 * `mip_opt_out=true` — and stores the utterances in `call_transcripts`, one row per call
 * session. The provider sits behind `TranscriptionProvider`, so another one (OpenAI's
 * `gpt-4o-mini-transcribe`) is a second implementation of that port, not a change here.
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
/** Paid attempts one call may ever hold: the first, and one bounded retry of an ambiguous one. */
export const TRANSCRIPTION_MAX_ATTEMPTS = 2;
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
      /** The audio's length as the provider measured it, in seconds. What is settled. */
      readonly durationSeconds: number;
      readonly language: string;
      readonly utterances: readonly CallTranscriptUtterance[];
    }
  /**
   * The provider answered and refused (an HTTP 4xx): the request was not processed, so
   * nothing was billed. `code` is a word of ours (`deepgram_http_401`), never a body.
   */
  | { readonly ok: false; readonly kind: 'refused'; readonly code: string }
  /**
   * Nobody knows whether the provider processed it: a timeout, a dropped connection, a
   * 5xx, an answer that could not be read. It may have been billed.
   */
  | { readonly ok: false; readonly kind: 'ambiguous'; readonly code: string };

export interface TranscriptionProvider {
  /** `provider_reservations.provider_key` and `provider_ledger.provider_key`, e.g. `deepgram.nova-3`. */
  readonly providerKey: string;
  /** `call_transcripts.provider`, e.g. `deepgram`. */
  readonly provider: string;
  /** `call_transcripts.model`, e.g. `nova-3`. */
  readonly model: string;
  transcribe(input: { readonly audio: Buffer; readonly contentType: 'audio/mpeg' }): Promise<TranscriptionOutcome>;
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
    state: ReservationState;
    cents: number;
    unit_price_micros: number | null;
    max_units: number | null;
  }>(
    `SELECT id, attempt, state, cents, unit_price_micros, max_units FROM provider_reservations
      WHERE workspace_id = $1 AND subject_kind = $2 AND subject_id = $3
      ORDER BY attempt DESC`,
    [context.scope.workspaceId, TRANSCRIPTION_SUBJECT_KIND, sessionId],
  );
  return rows.map(row => ({
    id: row.id,
    attempt: Number(row.attempt),
    state: row.state,
    cents: Number(row.cents),
    unitPriceMicros: Number(row.unit_price_micros ?? 0),
    maxUnits: Number(row.max_units ?? 0),
  }));
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
  for (const row of await listTranscriptionAttempts(context, sessionId)) {
    if (old !== null && !old.has(row.id)) continue;
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
  input: { readonly sessionId: string; readonly at: string; readonly keyConfigured: boolean },
): Promise<Clearance> {
  const setting = await readCallTranscription(context);
  if (!setting.enabled) return { ok: false, reason: 'transcription_off' };
  if (!input.keyConfigured) return { ok: false, reason: 'transcription_unconfigured' };
  const facts = await sessionFacts(context, input.sessionId);
  if (!eligible(facts)) return { ok: false, reason: 'transcription_not_eligible' };
  // Serialised per workspace, so two calls cannot both fit the last cents.
  await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `${context.scope.workspaceId}:transcription_budget`,
  ]);
  const zone = await workspaceBusinessZone(context);
  const businessDate = localDate(input.at, zone);
  // Priced with the margin; these minutes are the bound the audio is cut to before upload.
  const minutes = transcriptionMinutes(facts.recordingSeconds + TRANSCRIPTION_DURATION_MARGIN_SECONDS);
  const cents = transcriptionCents(minutes, setting.unitPriceMicros);
  if (setting.dailyCeilingCents <= 0) return { ok: false, reason: 'transcription_budget_exhausted' };
  const spent = await transcriptionSpentCents(context, businessDate);
  if (spent + cents > setting.dailyCeilingCents) return { ok: false, reason: 'transcription_budget_exhausted' };
  return { ok: true, cents, minutes, unitPriceMicros: setting.unitPriceMicros, businessDate, zone };
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
  input: { readonly sessionId: string; readonly at: string; readonly keyConfigured: boolean; readonly providerKey: string },
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
  input: { readonly sessionId: string; readonly at: string; readonly keyConfigured: boolean; readonly providerKey: string },
): Promise<CallingOutcome> {
  await lockTranscription(context, input.sessionId);
  if ((await sessionFacts(context, input.sessionId)) === null || (await transcribed(context, input.sessionId))) {
    await finaliseOpenAttempts(context, input.sessionId, input.at);
    return { kind: 'closed', reason: 'already_transcribed' };
  }
  const rows = await listTranscriptionAttempts(context, input.sessionId);
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
  if (rows.length >= TRANSCRIPTION_MAX_ATTEMPTS) return { kind: 'closed', reason: 'transcription_failed' };
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
  | { readonly kind: 'done'; readonly reason: TranscriptionRefusalCode | 'already_transcribed' | 'not_calling'; readonly code?: string };

/**
 * Chunk 3: the recording, the provider call, the utterances, and this attempt's
 * reservation settled by id. Every exit closes the reservation — released when nothing
 * was asked of the provider, settled at the reported duration, settled at 0 for a
 * refusal the provider answered with, estimated for an ambiguous attempt. The one exit
 * that closes nothing is a database error, which rolls this chunk back and leaves the row
 * `calling` for the next claim to estimate.
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
  const releaseNotCalled = async (): Promise<void> => {
    await settleAttempt(context, { reservationId: reservation.id, at: input.at, outcome: { kind: 'released_not_called' } });
  };
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
    outcome = await input.provider.transcribe({ audio: bounded.bytes, contentType: recording.contentType });
  } catch {
    // A port that throws is a port whose call may have gone out. Never the error's text:
    // it is the provider adapter's, and the adapter is the one place a key could be.
    outcome = { ok: false, kind: 'ambiguous', code: 'provider_threw' };
  }

  if (!outcome.ok) {
    if (outcome.kind === 'refused') {
      await settleAttempt(context, { reservationId: reservation.id, at: input.at, outcome: { kind: 'settled', cents: 0 } });
      return { kind: 'done', reason: 'transcription_failed', code: outcome.code };
    }
    // Ambiguous: estimated at the reservation first, then the bounded retry (chunk 2).
    await settleAttempt(context, { reservationId: reservation.id, at: input.at, outcome: { kind: 'estimated' } });
    if (rows.length >= TRANSCRIPTION_MAX_ATTEMPTS) return { kind: 'done', reason: 'transcription_failed', code: outcome.code };
    return { kind: 'retry', code: outcome.code };
  }

  const durationSeconds = Math.max(0, Math.min(86_400, Math.round(outcome.durationSeconds)));
  const utterances = outcome.utterances.slice(0, CALL_TRANSCRIPT_MAX_UTTERANCES);
  await context.db.query(
    `INSERT INTO call_transcripts (workspace_id, call_session_id, provider, model, language, duration_seconds, utterances)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT ON CONSTRAINT call_transcripts_pkey DO NOTHING`,
    [
      context.scope.workspaceId,
      input.sessionId,
      input.provider.provider,
      input.provider.model,
      outcome.language,
      durationSeconds,
      JSON.stringify(utterances),
    ],
  );
  // Settled at the provider's duration, never past the minutes that were cleared: the audio
  // was cut to them, so a longer report is the provider's rounding, not more audio.
  const minutes = Math.min(transcriptionMinutes(outcome.durationSeconds), Math.max(1, reservation.maxUnits));
  const cents = transcriptionCents(minutes, reservation.unitPriceMicros);
  const settled = await settleAttempt(context, { reservationId: reservation.id, at: input.at, outcome: { kind: 'settled', cents } });
  return { kind: 'transcribed', settledCents: settled?.recordedCents ?? 0, utterances: utterances.length };
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

/** The workspaces the transcription sweep would find work in now; the scheduler's question. */
export async function workspacesOwingTranscriptionSweep(db: Queryable): Promise<readonly string[]> {
  const { rows } = await db.query<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id FROM provider_reservations
      WHERE subject_kind = $1 AND state IN ('reserved', 'calling')
        AND created_at + make_interval(mins => $2) <= now()
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
