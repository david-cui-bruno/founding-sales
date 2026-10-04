import { DEFAULT_MEETING_AUTO_RECORDING, meetingAutoRecordingSettingSchema, type MeetingAutoRecordingSetting } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { readSetting } from '../settings/store.ts';
export async function readMeetingAutoRecordingSetting(context:RepositoryContext):Promise<{setting:MeetingAutoRecordingSetting;version:number}> {
  const row=await readSetting(context,'meeting_auto_recording'); const parsed=meetingAutoRecordingSettingSchema.safeParse(row.value);
  return {setting:parsed.success?parsed.data:{...DEFAULT_MEETING_AUTO_RECORDING},version:row.version};
}
