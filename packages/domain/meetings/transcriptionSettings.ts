import { DEFAULT_MEETING_TRANSCRIPTION, meetingTranscriptionSettingSchema, type MeetingTranscriptionSetting } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { readSetting } from '../settings/store.ts';
export async function readMeetingTranscription(context: RepositoryContext): Promise<MeetingTranscriptionSetting> {
    const parsed = meetingTranscriptionSettingSchema.safeParse((await readSetting(context, 'meeting_transcription')).value);
    return parsed.success ? parsed.data : { ...DEFAULT_MEETING_TRANSCRIPTION };
}
