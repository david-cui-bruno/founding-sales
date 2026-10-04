import { DEFAULT_MEETING_ANALYSIS, meetingAnalysisSettingSchema, type MeetingAnalysisSetting } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { readSetting } from '../settings/store.ts';
export async function readMeetingAnalysisSetting(context: RepositoryContext): Promise<MeetingAnalysisSetting> {
  const parsed = meetingAnalysisSettingSchema.safeParse((await readSetting(context, 'meeting_analysis')).value);
  return parsed.success ? parsed.data : { ...DEFAULT_MEETING_ANALYSIS };
}

export async function meetingAnalysisSpent(context: RepositoryContext, date: string): Promise<number> {
  return Number((await context.db.query<{ cents: string }>(`SELECT COALESCE(sum(CASE WHEN state IN ('reserved','calling') THEN cents ELSE settled_cents END),0)::text AS cents
    FROM provider_reservations WHERE workspace_id=$1 AND subject_kind='meeting_analysis' AND business_date=$2::date`, [context.scope.workspaceId, date])).rows[0]?.cents ?? 0);
}
