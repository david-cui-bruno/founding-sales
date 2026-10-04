import { meetingFollowThroughSettingSchema } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { readSetting } from '../settings/store.ts';
export async function meetingRecapChoices(context:RepositoryContext):Promise<{id:string;label:string}[]> {
  return (await context.db.query<{id:string;label:string}>(`SELECT v.id,left(s.name || ' · version ' || v.version::text,240) AS label FROM sequence_versions v JOIN sequences s ON s.workspace_id=v.workspace_id AND s.id=v.sequence_id
    WHERE v.workspace_id=$1 AND v.state='published'
    AND (SELECT count(*) FROM sequence_steps x WHERE x.workspace_id=v.workspace_id AND x.sequence_version_id=v.id) BETWEEN 1 AND 3
    AND EXISTS(SELECT 1 FROM sequence_steps x JOIN template_versions t ON t.workspace_id=x.workspace_id AND t.id=x.template_version_id WHERE x.workspace_id=v.workspace_id AND x.sequence_version_id=v.id AND x.ordinal=1 AND 'meeting_recap'=ANY(t.required_variables))
    AND NOT EXISTS(SELECT 1 FROM sequence_steps x LEFT JOIN template_versions t ON t.workspace_id=x.workspace_id AND t.id=x.template_version_id WHERE x.workspace_id=v.workspace_id AND x.sequence_version_id=v.id AND (x.channel<>'email' OR t.id IS NULL OR t.approved_at IS NULL OR t.retired_at IS NOT NULL OR (x.ordinal>1 AND 'meeting_recap'=ANY(t.required_variables))))
    ORDER BY s.name,v.version DESC LIMIT 100`,[context.scope.workspaceId])).rows;
}
export async function readMeetingFollowThroughConfiguration(context:RepositoryContext) {
  return {setting:meetingFollowThroughSettingSchema.parse((await readSetting(context,'meeting_follow_through')).value),choices:await meetingRecapChoices(context)};
}
