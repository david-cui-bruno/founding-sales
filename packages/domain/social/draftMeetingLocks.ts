import type {RepositoryContext} from '../db/workspaceScope.ts';
/** Match the normal completion owner's firm → meeting → recording serialization.
 * Eligibility and latest-version queries must run in a separate statement after
 * these waits, with the association locks retained by the caller's transaction. */
export async function lockSocialMeetingSource(ctx:RepositoryContext,transcriptId:string):Promise<string|null>{
 const w=ctx.scope.workspaceId;
 const before=(await ctx.db.query<{recording_id:string;meeting_id:string;firm_id:string}>(`SELECT r.id AS recording_id,m.id AS meeting_id,m.firm_id FROM meeting_transcripts t JOIN meeting_recordings r ON r.workspace_id=t.workspace_id AND r.id=t.recording_id JOIN meetings m ON m.workspace_id=r.workspace_id AND m.id=r.meeting_id WHERE t.workspace_id=$1 AND t.id=$2`,[w,transcriptId])).rows[0];
 if(!before?.firm_id)return null;
 await ctx.db.query('SELECT id FROM firms WHERE workspace_id=$1 AND id=$2 FOR SHARE',[w,before.firm_id]);
 await ctx.db.query('SELECT id FROM meetings WHERE workspace_id=$1 AND id=$2 FOR SHARE',[w,before.meeting_id]);
 await ctx.db.query('SELECT id FROM meeting_recordings WHERE workspace_id=$1 AND id=$2 FOR SHARE',[w,before.recording_id]);
 const current=(await ctx.db.query(`SELECT r.id FROM meeting_recordings r JOIN meetings m ON m.workspace_id=r.workspace_id AND m.id=r.meeting_id WHERE r.workspace_id=$1 AND r.id=$2 AND m.id=$3 AND m.firm_id=$4`,[w,before.recording_id,before.meeting_id,before.firm_id])).rows[0];
 return current?before.recording_id:null;
}
