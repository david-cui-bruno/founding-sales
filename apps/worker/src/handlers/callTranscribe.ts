import { repositoryContext } from '@fss/domain/db/workspaceScope.ts';
import type { JobChunk, JobHandler } from '@fss/domain/jobs/handlerRegistry.ts';
import { databaseNow } from '@fss/domain/policy/clock.ts';
import {
  CALL_TRANSCRIBE_JOB_MAX_ATTEMPTS,
  beginCallTranscription,
  collectCallTranscription,
  ensureTranscriptionCalling,
  finishCallTranscription,
  listHeldTranscriptions,
  listTranscriptionJobsDue,
  type TranscriptionProvider,
} from '@fss/domain/calls/transcription.ts';
import type { TwilioRecordingFetcher } from '@fss/domain/calls/twilioRecording.ts';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { jobIdempotencyKey } from '@fss/domain/jobs/jobKinds.ts';
import type { JobSpecification } from '@fss/domain/jobs/jobStore.ts';
import type { DueWorkSource } from '../scheduler/schedulerPass.ts';

/**
 * The `call.transcribe` job (slice C2): one answered, recorded call's transcript.
 *
 * Chunked in three, and the boundaries are where the money is — exactly the shape of
 * `research.firm` (`handlers/research.ts`), with the body in `@fss/domain/calls/
 * transcription.ts`:
 *
 *   * chunk 1 — `beginCallTranscription`: the switch, the key, the call and the day's
 *     ceiling, then attempt 1's reservation. Nothing is asked of a provider;
 *   * chunk 2 — `ensureTranscriptionCalling`: the reservation moves to `calling` and
 *     nothing else is written. A cursor written by another claim (its fencing token is not
 *     this claim's) means that claim died after marking its attempt: the attempt is
 *     estimated, and a fresh one reserved, at most two for one call;
 *   * chunk 3 — `finishCallTranscription`: Twilio's recording, Deepgram, the utterances,
 *     and the reservation settled by id. An ambiguous attempt is estimated there and the
 *     cursor goes back to chunk 2 (`step: 'retry'`) for the one bounded retry.
 *
 * Registered only in a worker that has both the `transcription` key and the Twilio
 * recording credentials; without either the kind stays unclaimed in the queue, which is
 * what a worker without a key does by design (the API does not queue one while the key
 * is missing either).
 *
 * The provider's outcome completes the job whatever it was; `maxAttempts` is about a
 * poison payload or a lost lease, never about Deepgram.
 */

export interface CallTranscribeOptions {
  /** The provider new attempts use. */
  readonly provider: TranscriptionProvider;
  /**
   * The Amazon Transcribe adapter, present whenever the call-audio bucket is configured,
   * whichever provider new attempts use (review C3-F, finding 3): recorded jobs are always
   * collected, so switching to Deepgram strands nothing.
   */
  readonly collector?: TranscriptionProvider | undefined;
  readonly recordings: TwilioRecordingFetcher;
  /** The line a run leaves: a code and counts, never a transcript, a URL or a key. */
  readonly log?: ((event: string, fields: Readonly<Record<string, string | number | boolean | null>>) => void) | undefined;
  readonly leaseSeconds?: number | undefined;
}

/** `submit`: an asynchronous provider's job names are committed; this claim sends the request next. */
type Step = 'reserved' | 'calling' | 'retry' | 'submit';

interface TranscribeProgress {
  readonly attempt: number;
  readonly step: Step;
  readonly fencing: string;
  readonly [key: string]: unknown;
}

export function parseTranscribeProgress(progress: unknown): TranscribeProgress | null {
  if (typeof progress !== 'object' || progress === null) return null;
  const row = progress as Record<string, unknown>;
  const attempt = row['attempt'];
  const step = row['step'];
  const fencing = row['fencing'];
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1) return null;
  if (step !== 'reserved' && step !== 'calling' && step !== 'retry' && step !== 'submit') return null;
  if (typeof fencing !== 'string' || fencing === '') return null;
  return { attempt, step, fencing };
}

export class CallTranscribeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CallTranscribeError';
  }
}

/** The Twilio recording read's own timeout (`readTranscriptionComposition`), in seconds. */
const RECORDING_READ_SECONDS = 30;
/** Room for the chunk's database work on top of the two network waits. */
const LEASE_MARGIN_SECONDS = 90;

/**
 * The lease chunk 3 needs: the recording read, the provider's longest call, and room to
 * spare — at least C2's 240 s (Deepgram's two minutes). Amazon Transcribe's upload, job and
 * poll (slice C3a) take longer than Deepgram's one request, so its lease is longer.
 */
/**
 * A collection claim (slice C3a) is one status read and one output read, each bounded by
 * `AWS_REQUEST_TIMEOUT_MS` (20 s), and a commit: at most about 40 s plus database time,
 * well inside the 240 s lease. A submitting claim is the recording read (30 s), the upload
 * and Start (20 s each) and at most one best-effort delete (20 s): about 90 s.
 */
export function callTranscribeLeaseSeconds(provider: Pick<TranscriptionProvider, 'maxCallSeconds'> | undefined): number {
  // Read defensively: a registry listing (`fss admin release idle-check`) builds handlers without ports.
  return Math.max(240, RECORDING_READ_SECONDS + Math.ceil(provider?.maxCallSeconds ?? 120) + LEASE_MARGIN_SECONDS);
}

export function callTranscribeJobHandler(options: CallTranscribeOptions): JobHandler {
  return {
    kind: 'call.transcribe',
    protection: 'business_uniqueness',
    maxAttempts: CALL_TRANSCRIBE_JOB_MAX_ATTEMPTS,
    leaseSeconds: options.leaseSeconds ?? callTranscribeLeaseSeconds(options.provider),
    chunked: true,
    handle: async (input): Promise<void | JobChunk> => {
      const sessionId = input.job.payload['callSessionId'];
      if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(sessionId)) {
        throw new CallTranscribeError('a call.transcribe payload names a call session');
      }
      const context = repositoryContext(input.scope, input.session);
      const at = await databaseNow(context);
      const fencing = input.job.fencingToken;
      const common = { sessionId, at, keyConfigured: true, providerKey: options.provider.providerKey, pricing: options.provider.pricing };
      const log = (event: string, fields: Readonly<Record<string, string | number | boolean | null>>): void => {
        options.log?.(event, { workspace_id: input.scope.workspaceId, call_session_id: sessionId, ...fields });
      };
      const carried = parseTranscribeProgress(input.job.payload['progress']);

      // Slice C3a. A claim that is not continuing its own cursor looks first at the call's
      // recorded provider job, whoever started it: a crash or a lost lease after the request
      // resumes collecting that job, never estimates it and buys another. One status read and
      // at most one output read, then the commit; a job still running is looked at again by
      // a later `call.transcribe` (`transcriptionJobsSource`), never waited for.
      const ownCursor = carried !== null && carried.fencing === fencing;
      if (!ownCursor && options.collector !== undefined) {
        const collected = await collectCallTranscription(context, { sessionId, at, collector: options.collector });
        if (collected.kind === 'retry') {
          // The ordinary ambiguous rule: chunk 2 may reserve the one retry within the cap.
          log('call_transcription_retry', { code: collected.code });
          return { progress: { attempt: 1, step: 'retry', fencing }, done: false };
        }
        if (collected.kind !== 'none') {
          if (collected.kind === 'transcribed') {
            log('call_transcription', { settled_cents: collected.settledCents, utterances: collected.utterances });
          } else if (collected.kind === 'pending') {
            log('call_transcription_pending', {});
          } else {
            log('call_transcription_skipped', { reason: collected.reason, code: collected.code });
          }
          // Terminal or pending: this claim buys nothing (review C3-F, finding 4).
          return { progress: { step: collected.kind }, done: true };
        }
      }

      if (carried === null) {
        // Chunk 1, or a lost cursor: if attempts already exist the rows say where the job
        // got to, and chunk 2 is where an attempt of unknown standing is resolved.
        const begun = await beginCallTranscription(context, common);
        if (begun.kind === 'done') {
          log('call_transcription_skipped', { reason: begun.reason });
          return;
        }
        return { progress: { attempt: begun.attempt, step: 'reserved', fencing }, done: false };
      }

      if ((carried.step !== 'calling' && carried.step !== 'submit') || carried.fencing !== fencing) {
        // Chunk 2: "a call may now have happened", durable, and nothing else.
        const calling = await ensureTranscriptionCalling(context, common);
        if (calling.kind === 'collecting') {
          log('call_transcription_pending', {});
          return { progress: { ...carried }, done: true };
        }
        if (calling.kind === 'closed') {
          log('call_transcription_skipped', { reason: calling.reason });
          return { progress: { ...carried }, done: true };
        }
        return { progress: { attempt: calling.attempt, step: 'calling', fencing }, done: false };
      }

      // Chunk 3, from this claim's own cursor.
      const finished = await finishCallTranscription(context, {
        sessionId,
        attempt: carried.attempt,
        at,
        recordings: options.recordings,
        provider: options.provider,
      });
      if (finished.kind === 'retry') {
        log('call_transcription_retry', { attempt: carried.attempt, code: finished.code });
        return { progress: { attempt: carried.attempt, step: 'retry', fencing }, done: false };
      }
      if (finished.kind === 'prepared') {
        // The job's names are committed; the request goes in the next chunk, this claim's.
        return { progress: { attempt: carried.attempt, step: 'submit', fencing }, done: false };
      }
      if (finished.kind === 'started') {
        log('call_transcription_started', { attempt: carried.attempt, code: finished.code });
        return { progress: { ...carried }, done: true };
      }
      if (finished.kind === 'transcribed') {
        log('call_transcription', { attempt: carried.attempt, settled_cents: finished.settledCents, utterances: finished.utterances });
      } else {
        log('call_transcription_skipped', { reason: finished.reason, code: finished.code ?? null });
      }
      return { progress: { ...carried }, done: true };
    },
  };
}

/**
 * The source that resumes transcriptions the switch held (slice P1, invariant I1): one
 * `call.transcribe` under a new revision key for each call `listHeldTranscriptions`
 * finds. Materializes nothing in a worker without the handler, so a job no handler here
 * could claim never sits in the queue.
 */
export function heldTranscriptionSource(options: { readonly enabled: boolean }): DueWorkSource {
  return {
    name: 'call-transcribe-resume',
    find: async (session: SessionQueryable): Promise<readonly JobSpecification[]> => {
      if (!options.enabled) return [];
      return (await listHeldTranscriptions(session)).map(held => ({
        workspaceId: held.workspaceId,
        kind: 'call.transcribe' as const,
        idempotencyKey: jobIdempotencyKey.callTranscribe(held.sessionId, held.revision),
        payload: { callSessionId: held.sessionId },
        maxAttempts: CALL_TRANSCRIBE_JOB_MAX_ATTEMPTS,
      }));
    },
  };
}

/**
 * The source that keeps recorded Transcribe jobs moving (slice C3a): one `call.transcribe`
 * per look at each recorded job that is due one (`listTranscriptionJobsDue`), keyed by the
 * job row's id and its look number, so no key is ever reused. Materializes nothing without
 * a collector (the call-audio bucket not configured).
 */
export function transcriptionJobsSource(options: { readonly enabled: boolean }): DueWorkSource {
  return {
    name: 'call-transcribe-collect',
    find: async (session: SessionQueryable): Promise<readonly JobSpecification[]> => {
      if (!options.enabled) return [];
      return (await listTranscriptionJobsDue(session)).map(due => ({
        workspaceId: due.workspaceId,
        kind: 'call.transcribe' as const,
        idempotencyKey: due.idempotencyKey,
        payload: { callSessionId: due.sessionId },
        maxAttempts: CALL_TRANSCRIBE_JOB_MAX_ATTEMPTS,
      }));
    },
  };
}
