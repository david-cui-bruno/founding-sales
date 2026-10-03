import type { MeetingSpeech, RecordingSourceKind } from '@fss/contracts';
export interface PreparedMeetingAudio {
  inputKey: string;
  durationMs: number;
  sizeBytes: number;
  sha256: string;
  mediaFormat: 'flac';
}
export type MeetingProviderResult = { kind: 'pending' }
  | { kind: 'complete'; language: string; utterances: MeetingSpeech[] }
  | { kind: 'failed'; code: string };
export interface MeetingTranscriptionProvider {
  start(input: { jobName: string; inputKey: string; outputKey: string; sourceKind: RecordingSourceKind }): Promise<'started' | 'ambiguous' | 'refused'>;
  collect(input: { jobName: string; outputKey: string }): Promise<MeetingProviderResult>;
}
export interface MeetingMediaPreparer {
  prepare(input: { sourceKey: string; expectedSha256: string; expectedSizeBytes: number; preparedKey: string }, signal: AbortSignal): Promise<PreparedMeetingAudio>;
}
