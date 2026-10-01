import { describe, expect, it } from 'vitest';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { loadCallAudioRemover, startDeletedCallAudioRemoval, type CallAudioSdk } from '../src/integrations/callAudio.ts';

/**
 * Slice C3a: the deletion workflow's best-effort delete of a deleted call's audio and
 * transcript objects, after its commit. Never owed, never retried, never fails the deletion.
 */

const SESSION = '0f6b7a52-5d43-4c3e-9b8a-2a0d1e3f4c5b';

function sessionAnswering(rows: readonly Record<string, unknown>[]): SessionQueryable {
  return { query: async () => await Promise.resolve({ rows, rowCount: rows.length }) } as unknown as SessionQueryable;
}

function fakeSdk(fail: ReadonlySet<string>): { sdk: CallAudioSdk; deleted: string[]; configurations: unknown[] } {
  const deleted: string[] = [];
  const configurations: unknown[] = [];
  class DeleteObjectCommand {
    constructor(readonly input: Record<string, unknown>) {}
  }
  class S3Client {
    constructor(configuration: unknown) {
      configurations.push(configuration);
    }
    async send(command: unknown): Promise<unknown> {
      const key = String((command as DeleteObjectCommand).input['Key']);
      if (fail.has(key)) throw Object.assign(new Error('denied'), { name: 'AccessDenied' });
      deleted.push(key);
      return await Promise.resolve({});
    }
  }
  return { sdk: { S3Client, DeleteObjectCommand }, deleted, configurations };
}

describe('the deletion workflow’s call-audio delete', () => {
  it('deletes every object of the deleted calls, logs counts only, and never throws', async () => {
    const input = `calls/${SESSION}/attempt-1.mp3`;
    const output = `calls/${SESSION}/attempt-1.json`;
    const fake = fakeSdk(new Set([output]));
    const remover = await loadCallAudioRemover({ bucket: 'fss-test-call-audio-123456789012', region: 'us-east-1', sdk: fake.sdk });
    const lines: { level: string; event: string; fields: unknown }[] = [];
    const started = await startDeletedCallAudioRemoval({
      session: sessionAnswering([{ input_key: input, output_key: output }]),
      workspaceId: '00000000-0000-4000-8000-000000000001',
      remover,
      log: { log: (level, event, fields) => lines.push({ level, event, fields }) },
    });
    await started.settled;
    expect(fake.deleted).toEqual([input]);
    expect(fake.configurations).toEqual([{ region: 'us-east-1', maxAttempts: 1 }]);
    expect(lines).toEqual([{ level: 'warn', event: 'call_audio_deleted', fields: { deleted: 1, failed: 1 } }]);
    expect(JSON.stringify(lines)).not.toContain(SESSION);
  });

  it('does nothing when no deleted call has objects, and survives a failed read', async () => {
    const fake = fakeSdk(new Set());
    const remover = await loadCallAudioRemover({ bucket: 'b-test-bucket', region: 'us-east-1', sdk: fake.sdk });
    await (await startDeletedCallAudioRemoval({ session: sessionAnswering([]), workspaceId: 'w', remover })).settled;
    const broken = { query: async () => await Promise.reject(new Error('connection lost')) } as unknown as SessionQueryable;
    await (await startDeletedCallAudioRemoval({ session: broken, workspaceId: 'w', remover })).settled;
    expect(fake.deleted).toEqual([]);
  });

  it('bounds every delete and the whole batch: a stalled S3 transport ends as failures, one attempt each', async () => {
    const sends: { key: string; signal: AbortSignal | undefined }[] = [];
    class DeleteObjectCommand {
      constructor(readonly input: Record<string, unknown>) {}
    }
    class S3Client {
      async send(command: unknown, options?: { readonly abortSignal?: AbortSignal }): Promise<unknown> {
        sends.push({ key: String((command as DeleteObjectCommand).input['Key']), signal: options?.abortSignal });
        // A transport that never answers: only the abort signal ends it.
        return await new Promise((_resolve, reject) => {
          options?.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
    }
    const perRequest = await loadCallAudioRemover({
      bucket: 'b-test-bucket', region: 'us-east-1', sdk: { S3Client, DeleteObjectCommand }, requestTimeoutMs: 30, totalTimeoutMs: 10_000,
    });
    expect(await perRequest.deleteObjects(['calls/a/attempt-1.mp3', 'calls/a/attempt-1.json'])).toEqual({ deleted: 0, failed: 2 });
    expect(sends.map(send => send.signal !== undefined)).toEqual([true, true]);

    sends.length = 0;
    const capped = await loadCallAudioRemover({
      bucket: 'b-test-bucket', region: 'us-east-1', sdk: { S3Client, DeleteObjectCommand }, requestTimeoutMs: 10_000, totalTimeoutMs: 40,
    });
    const keys = ['calls/b/attempt-1.mp3', 'calls/b/attempt-1.json', 'calls/b/attempt-2.mp3', 'calls/b/attempt-2.json'];
    expect(await capped.deleteObjects(keys)).toEqual({ deleted: 0, failed: 4 });
    // The cap ended the first send; the rest were never sent.
    expect(sends).toHaveLength(1);
  });

  it('returns once the keys are read, before a stalled delete answers, and never queries the session again', async () => {
    let queries = 0;
    const session = {
      query: async () => {
        queries += 1;
        return await Promise.resolve({ rows: [{ input_key: `calls/${SESSION}/attempt-1.mp3`, output_key: `calls/${SESSION}/attempt-1.json` }], rowCount: 1 });
      },
    } as unknown as SessionQueryable;
    let release: (value: { deleted: number; failed: number }) => void = () => undefined;
    let deleteCalls = 0;
    const remover = {
      deleteObjects: async () => {
        deleteCalls += 1;
        return await new Promise<{ deleted: number; failed: number }>(resolve => {
          release = resolve;
        });
      },
    };
    const started = await startDeletedCallAudioRemoval({ session, workspaceId: 'w', remover });
    expect(deleteCalls).toBe(1);
    expect(queries).toBe(1);
    let settled = false;
    void started.settled.then(() => {
      settled = true;
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    release({ deleted: 2, failed: 0 });
    await started.settled;
    expect(queries).toBe(1);
  });
});
