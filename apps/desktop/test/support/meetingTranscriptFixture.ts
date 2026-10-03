import type { MeetingTranscriptPage } from '@fss/contracts';
export const MID = '44444444-4444-4444-8444-444444444401';
export const RID = (n: number) => `55555555-5555-4555-8555-${String(n).padStart(12,'0')}`;
export function transcriptPage(mode: 'ready' | 'partial' | 'funding' = 'ready'): MeetingTranscriptPage {
  const ready = mode === 'ready' ? 2 : mode === 'partial' ? 1 : 0;
  return { meetingId: MID, coverage: { sourceRevision: 2, total: 2, ready, held: mode === 'funding' ? 2 : 0, pending: 0, failed: 0, unavailable: mode === 'partial' ? 1 : 0 },
    recordings: [1,2].map(n => ({ recordingId: RID(n), meetingId: MID, participantLabel: n === 1 ? 'audioJordanPlaceholder.m4a' : 'audioDavidExample.m4a', segment: 1, sourceKind: 'participant',
      status: mode === 'funding' ? 'funding_unverified' : mode === 'partial' && n === 2 ? 'needs_reupload' : 'ready', reason: mode === 'funding' ? 'funding_unverified' : mode === 'partial' && n === 2 ? 'source_missing' : null,
      transcriptId: n <= ready ? RID(n+2) : null, transcriptVersion: n <= ready ? 1 : null, durationMs: n <= ready ? 1200000 : null })), recordingsTruncated: false,
    utterances: Array.from({ length: ready }, (_,i) => ({ id: `${RID(i+3)}:0`, recordingId: RID(i+1), transcriptId: RID(i+3), transcriptVersion: 1, startMs: i*3000, endMs: i*3000+2000, text: i === 0 ? 'We get several maintenance requests after hours each week.' : 'Can you walk me through what happens when a tenant calls?', speaker: null, attribution: 'source_label' })),
    nextCursor: null, timing: 'file_relative' };
}
