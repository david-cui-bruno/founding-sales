import { createHash } from 'node:crypto';
import type { MeetingNotesRevision } from '@fss/contracts';
export type MeetingResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };
export const emptyMeetingNotes = (meetingId: string): MeetingNotesRevision => ({ meetingId, revision: 0, debrief: '', speakerMappings: [], itemOverrides: [], sufficient: false, savedAt: null });
export function meetingSourceHash(meetingId: string, notesRevision: number, transcriptRevision: number): string {
  return createHash('sha256').update(JSON.stringify([meetingId, notesRevision, transcriptRevision])).digest('hex');
}
