import type { MeetingAnalysisInput } from '../../../../meetings/analysisInput.ts';
export const meetingId = '11111111-1111-4111-8111-111111111111';
export const recordingId = '22222222-2222-4222-8222-222222222222';
export const transcriptId = '33333333-3333-4333-8333-333333333333';
export function sampleInput(): MeetingAnalysisInput {
  return { meetingId, firmId: '44444444-4444-4444-8444-444444444444', sourceHash: 'a'.repeat(64), transcriptRevision: 1,
    startsAt: '2026-10-03T14:00:00.000Z', businessZone: 'America/New_York', complete: true,
    notes: { meetingId, revision: 1, debrief: '', sufficient: false, savedAt: '2026-10-03T15:00:00.000Z', itemOverrides: [], speakerMappings: [] },
    utterances: [{ id: `${transcriptId}:1`, recordingId, transcriptId, transcriptVersion: 1, startMs: 0, endMs: 1000,
      text: 'I will send the guide tomorrow.', speaker: null, attribution: 'source_label' }],
    recordings: [{ recordingId, meetingId, participantLabel: 'David', segment: 1, sourceKind: 'participant', status: 'ready', reason: null, transcriptId, transcriptVersion: 1, durationMs: 1000 }],
  };
}
export function sampleAnswer() {
  return { overview: 'The guide was requested.', items: [{ id: 'suggestion-1', kind: 'commitment', text: 'Send the guide', provenance: 'stated', owner: 'you', deadline: null,
    deadlineText: 'tomorrow', reviewReasons: [], evidence: [{ kind: 'transcript', recordingId, transcriptId, transcriptVersion: 1, utteranceId: `${transcriptId}:1`, quote: 'I will send the guide tomorrow.', startMs: 0, endMs: 1000 }] }], reviewReasons: [] };
}
