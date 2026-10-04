import { DEFAULT_MEETING_ANALYSIS, meetingAnalysisSettingSchema, type MeetingAnalysisSetting } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { readSetting } from '../settings/store.ts';
export async function readMeetingAnalysisSetting(context: RepositoryContext): Promise<MeetingAnalysisSetting> {
  const parsed = meetingAnalysisSettingSchema.safeParse((await readSetting(context, 'meeting_analysis')).value);
  return parsed.success ? parsed.data : { ...DEFAULT_MEETING_ANALYSIS };
}
