import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { callAudioKeysOfDeletedCalls } from '@fss/domain/calls/transcription.ts';
import type { Logger } from '../bootstrap/log.ts';

/**
 * The deletion workflow's hook on the call-audio bucket (slice C3a, review C3-F): after a
 * deletion commits, the deleted calls' input audio and transcript objects are deleted, best
 * effort. Nothing is marked or owed: an object not deleted here expires with the bucket's
 * one-day lifecycle, which is the guarantee; this only makes it sooner.
 */
export interface CallAudioRemover {
  deleteObjects(keys: readonly string[]): Promise<{ readonly deleted: number; readonly failed: number }>;
}

/** The two pieces of `@aws-sdk/client-s3` used, narrowed so a test can hand in a fake. */
export interface CallAudioSdk {
  readonly S3Client: new (configuration: { region: string; maxAttempts: number }) => {
    send(command: unknown, options?: { readonly abortSignal?: AbortSignal }): Promise<unknown>;
  };
  readonly DeleteObjectCommand: new (input: Record<string, unknown>) => unknown;
}

/**
 * Review C3-N: each delete is bounded on its own, and the whole batch has a cap, so a stalled
 * S3 endpoint cannot keep the detached task (or anything it holds) alive. One attempt each.
 */
export const CALL_AUDIO_REQUEST_TIMEOUT_MS = 5_000;
export const CALL_AUDIO_TOTAL_TIMEOUT_MS = 20_000;

export async function loadCallAudioRemover(options: {
  readonly bucket: string;
  readonly region: string;
  readonly sdk?: CallAudioSdk | undefined;
  /** Tests only: shorter bounds. */
  readonly requestTimeoutMs?: number | undefined;
  readonly totalTimeoutMs?: number | undefined;
}): Promise<CallAudioRemover> {
  const specifier = '@aws-sdk/client-s3';
  const sdk = options.sdk ?? ((await import(specifier)) as CallAudioSdk);
  const client = new sdk.S3Client({ region: options.region, maxAttempts: 1 });
  const requestTimeoutMs = options.requestTimeoutMs ?? CALL_AUDIO_REQUEST_TIMEOUT_MS;
  const totalTimeoutMs = options.totalTimeoutMs ?? CALL_AUDIO_TOTAL_TIMEOUT_MS;
  return {
    deleteObjects: async keys => {
      const total = AbortSignal.timeout(totalTimeoutMs);
      let deleted = 0;
      let failed = 0;
      for (const key of keys) {
        if (total.aborted) {
          failed += 1;
          continue;
        }
        try {
          const abortSignal = AbortSignal.any([total, AbortSignal.timeout(requestTimeoutMs)]);
          await client.send(new sdk.DeleteObjectCommand({ Bucket: options.bucket, Key: key }), { abortSignal });
          deleted += 1;
        } catch {
          failed += 1;
        }
      }
      return { deleted, failed };
    },
  };
}

/** The variable the API reads the bucket under; no secret (the task role is the credential). */
export const CALL_AUDIO_BUCKET_VARIABLE = 'FSS_CALL_AUDIO_BUCKET';

/**
 * After a committed deletion: the workspace's deleted calls' keys are read (one quick query
 * on the request's session), and the S3 deletes are then started DETACHED (review C3-N): the
 * caller's answer never waits for S3, and the detached task never touches the session, so no
 * database connection is held while S3 is slow. Never throws and never changes the deletion's
 * answer; the log line has counts only, never a key. `settled` is for tests; callers ignore it.
 */
export async function startDeletedCallAudioRemoval(input: {
  readonly session: SessionQueryable;
  readonly workspaceId: string;
  readonly remover: CallAudioRemover;
  readonly log?: Logger | undefined;
}): Promise<{ readonly settled: Promise<void> }> {
  let keys: readonly string[];
  try {
    keys = await callAudioKeysOfDeletedCalls(input.session, input.workspaceId);
  } catch {
    input.log?.log('warn', 'call_audio_delete_skipped', {});
    return { settled: Promise.resolve() };
  }
  if (keys.length === 0) return { settled: Promise.resolve() };
  const settled = (async () => {
    try {
      const result = await input.remover.deleteObjects(keys);
      input.log?.log(result.failed > 0 ? 'warn' : 'info', 'call_audio_deleted', { deleted: result.deleted, failed: result.failed });
    } catch {
      input.log?.log('warn', 'call_audio_delete_skipped', {});
    }
  })();
  return { settled };
}
