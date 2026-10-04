import type { MeetingFollowThroughView } from '@fss/contracts';
import { MID,RID } from './meetingTranscriptFixture.ts';
export function followThroughView(): MeetingFollowThroughView {
  return {meetingId:MID,firmId:RID(9),contactId:RID(2),planId:RID(3),version:1,sourceHash:'a'.repeat(64),notesRevision:1,sequenceVersionId:RID(4),status:'scheduled',
    currentDraft:{id:RID(5),version:1,ordinal:1,subject:'Our maintenance discussion',body:'Thanks for meeting. You mentioned after-hours interruptions.\n\nDavid',renderedHash:'b'.repeat(64),templateVersionId:RID(6),sourceHash:'a'.repeat(64),materialReferences:[],createdAt:'2026-10-04T14:00:00.000Z',notBefore:'2026-10-04T14:30:00.000Z',state:'ready'},scope:null,blockers:['sending_paused'],sendingPaused:true,plannedSteps:[],sentMessages:[]};
}
