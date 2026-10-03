import { randomUUID } from 'node:crypto';
import type { MeetingTranscriptionSetting } from '@fss/contracts';
import { updateSetting } from '../../../settings/store.ts';
import { meetingTranscriptionFixture } from './meetingTranscriptionFixture.ts';
export const at = '2026-10-03T03:00:00.000Z';
export const accountId = '123456789012';
export const jobPrefix = 'fss-test';
export const coverage = { accountId, service: 'transcribe' as const, evidenceRef: 'test-only-credit-evidence', verifiedAt: '2026-10-01T00:00:00.000Z', validUntil: '2026-11-01T00:00:00.000Z', status: 'verified' as const };
export function prepared(recordingId: string, durationMs = 1200000) {
  return { inputKey: `meetings-processing/${recordingId}/${randomUUID()}.flac`, durationMs, sizeBytes: 500, sha256: 'a'.repeat(64), mediaFormat: 'flac' as const };
}
export async function meetingProcessingFixture() {
  const f = await meetingTranscriptionFixture();
  const configure = async (patch: Partial<MeetingTranscriptionSetting> = {}) => {
    const result = await updateSetting(f.context, { settingKey: 'meeting_transcription', value: { enabled: true, dailyCeilingCents: 50, creditCoverage: coverage, ...patch } });
    if (!result.ok) throw new Error(result.reason);
  };
  await configure();
  return { ...f, configure };
}
