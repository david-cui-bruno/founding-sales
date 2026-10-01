import { describe, expect, it } from 'vitest';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { loadCallAudioRemover, removeDeletedCallAudio, type CallAudioSdk } from '../src/integrations/callAudio.ts';

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
    await removeDeletedCallAudio({
      session: sessionAnswering([{ input_key: input, output_key: output }]),
      workspaceId: '00000000-0000-4000-8000-000000000001',
      remover,
      log: { log: (level, event, fields) => lines.push({ level, event, fields }) },
    });
    expect(fake.deleted).toEqual([input]);
    expect(fake.configurations).toEqual([{ region: 'us-east-1', maxAttempts: 1 }]);
    expect(lines).toEqual([{ level: 'warn', event: 'call_audio_deleted', fields: { deleted: 1, failed: 1 } }]);
    expect(JSON.stringify(lines)).not.toContain(SESSION);
  });

  it('does nothing when no deleted call has objects, and survives a failed read', async () => {
    const fake = fakeSdk(new Set());
    const remover = await loadCallAudioRemover({ bucket: 'b-test-bucket', region: 'us-east-1', sdk: fake.sdk });
    await removeDeletedCallAudio({ session: sessionAnswering([]), workspaceId: 'w', remover });
    const broken = { query: async () => await Promise.reject(new Error('connection lost')) } as unknown as SessionQueryable;
    await expect(removeDeletedCallAudio({ session: broken, workspaceId: 'w', remover })).resolves.toBeUndefined();
    expect(fake.deleted).toEqual([]);
  });
});
