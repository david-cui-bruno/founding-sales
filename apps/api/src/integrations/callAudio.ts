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
  readonly S3Client: new (configuration: { region: string; maxAttempts: number }) => { send(command: unknown): Promise<unknown> };
  readonly DeleteObjectCommand: new (input: Record<string, unknown>) => unknown;
}

export async function loadCallAudioRemover(options: {
  readonly bucket: string;
  readonly region: string;
  readonly sdk?: CallAudioSdk | undefined;
}): Promise<CallAudioRemover> {
  const specifier = '@aws-sdk/client-s3';
  const sdk = options.sdk ?? ((await import(specifier)) as CallAudioSdk);
  const client = new sdk.S3Client({ region: options.region, maxAttempts: 1 });
  return {
    deleteObjects: async keys => {
      let deleted = 0;
      let failed = 0;
      for (const key of keys) {
        try {
          await client.send(new sdk.DeleteObjectCommand({ Bucket: options.bucket, Key: key }));
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
 * After a committed deletion: the workspace's deleted calls' objects, deleted. Never throws
 * and never changes the deletion's answer; the log line has counts only, never a key.
 */
export async function removeDeletedCallAudio(input: {
  readonly session: SessionQueryable;
  readonly workspaceId: string;
  readonly remover: CallAudioRemover;
  readonly log?: Logger | undefined;
}): Promise<void> {
  try {
    const keys = await callAudioKeysOfDeletedCalls(input.session, input.workspaceId);
    if (keys.length === 0) return;
    const result = await input.remover.deleteObjects(keys);
    input.log?.log(result.failed > 0 ? 'warn' : 'info', 'call_audio_deleted', { deleted: result.deleted, failed: result.failed });
  } catch {
    input.log?.log('warn', 'call_audio_delete_skipped', {});
  }
}
