import type { MeetingOutcomesView } from '@fss/contracts';
import { MID, RID } from './meetingTranscriptFixture.ts';
export function outcomesView(state: MeetingOutcomesView['state'] = 'current'): MeetingOutcomesView {
  return { meetingId: MID, firmId: RID(9), sourceHash: 'a'.repeat(64), analysisId: RID(8), state, attendance: 'attended',
    notes: { meetingId: MID, revision: 1, debrief: 'I will send the setup guide tomorrow.', speakerMappings: [], itemOverrides: [], sufficient: true, savedAt: '2026-10-03T15:00:00.000Z' },
    overview: 'The team wants fewer after-hours interruptions and less manual follow-up.',
    items: [{ id: 'promise-guide', kind: 'commitment', text: 'Send the setup guide', provenance: 'stated', owner: 'you', deadline: { precision: 'date', localDate: '2026-10-04', zone: 'America/New_York' }, deadlineText: 'tomorrow', reviewReasons: [], evidence: [{ kind: 'debrief', revision: 1, quote: 'I will send the setup guide tomorrow.', startOffset: 0, endOffset: 36 }] }],
    tasks: [{ id: RID(10), meetingId: MID, firmId: RID(9), source: { kind: 'promise', commitmentId: 'promise-guide' }, label: 'Send the setup guide', ownerUserId: RID(11), deadline: { precision: 'date', localDate: '2026-10-04', zone: 'America/New_York' }, status: 'open', version: 1, userEdited: false, evidence: [] }], holds: [] };
}
