import { repositoryContext } from '@fss/domain/db/workspaceScope.ts';
import type { JobChunk, JobHandler } from '@fss/domain/jobs/handlerRegistry.ts';
import { databaseNow } from '@fss/domain/policy/clock.ts';
import {
  CALL_TRANSCRIBE_JOB_MAX_ATTEMPTS,
  beginCallTranscription,
  ensureTranscriptionCalling,
  finishCallTranscription,
  type TranscriptionProvider,
} from '@fss/domain/calls/transcription.ts';
import type { TwilioRecordingFetcher } from '@fss/domain/calls/twilioRecording.ts';

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
  readonly provider: TranscriptionProvider;
  readonly recordings: TwilioRecordingFetcher;
  /** The line a run leaves: a code and counts, never a transcript, a URL or a key. */
  readonly log?: ((event: string, fields: Readonly<Record<string, string | number | boolean | null>>) => void) | undefined;
  readonly leaseSeconds?: number | undefined;
}

type Step = 'reserved' | 'calling' | 'retry';

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
  if (step !== 'reserved' && step !== 'calling' && step !== 'retry') return null;
  if (typeof fencing !== 'string' || fencing === '') return null;
  return { attempt, step, fencing };
}

export class CallTranscribeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CallTranscribeError';
  }
}

export function callTranscribeJobHandler(options: CallTranscribeOptions): JobHandler {
  return {
    kind: 'call.transcribe',
    protection: 'business_uniqueness',
    maxAttempts: CALL_TRANSCRIBE_JOB_MAX_ATTEMPTS,
    // The recording read plus Deepgram's two minutes, with room to spare.
    leaseSeconds: options.leaseSeconds ?? 240,
    chunked: true,
    handle: async (input): Promise<void | JobChunk> => {
      const sessionId = input.job.payload['callSessionId'];
      if (typeof sessionId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(sessionId)) {
        throw new CallTranscribeError('a call.transcribe payload names a call session');
      }
      const context = repositoryContext(input.scope, input.session);
      const at = await databaseNow(context);
      const fencing = input.job.fencingToken;
      const common = { sessionId, at, keyConfigured: true, providerKey: options.provider.providerKey };
      const log = (event: string, fields: Readonly<Record<string, string | number | boolean | null>>): void => {
        options.log?.(event, { workspace_id: input.scope.workspaceId, call_session_id: sessionId, ...fields });
      };
      const carried = parseTranscribeProgress(input.job.payload['progress']);

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

      if (carried.step !== 'calling' || carried.fencing !== fencing) {
        // Chunk 2: "a call may now have happened", durable, and nothing else.
        const calling = await ensureTranscriptionCalling(context, common);
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
      if (finished.kind === 'transcribed') {
        log('call_transcription', { attempt: carried.attempt, settled_cents: finished.settledCents, utterances: finished.utterances });
      } else {
        log('call_transcription_skipped', { reason: finished.reason, code: finished.code ?? null });
      }
      return { progress: { ...carried }, done: true };
    },
  };
}
