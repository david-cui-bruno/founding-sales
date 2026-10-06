import type {SocialDraftWorkspace,SocialDraftView} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {SocialDraftRow} from './drafts.ts';
export const socialDraftView=(row:SocialDraftRow):SocialDraftView=>({id:row.id,state:row.state,sourceRefs:row.source_selection.sourceRefs,factBlocks:row.source_selection.factBlocks,concepts:row.concepts,reason:row.reason,createdAt:row.created_at.toISOString(),deadlineAt:row.deadline_at.toISOString()});
/** Recent source metadata only; transcript bytes never reach the picker. */
export async function readSocialDraftWorkspace(ctx:RepositoryContext):Promise<SocialDraftWorkspace>{
 const empty:SocialDraftWorkspace={sources:[],facts:[],requests:[]};if(ctx.scope.actor.kind!=='user')return empty;
 return readForOwner(ctx,ctx.scope.actor.userId);
}
export async function readSocialDraftWorkspaceForScheduler(ctx:RepositoryContext,ownerUserId:string):Promise<SocialDraftWorkspace>{
 if(ctx.scope.actor.kind!=='system'||ctx.scope.actor.component!=='scheduler')throw new Error('scheduler_required');
 return readForOwner(ctx,ownerUserId);
}
async function readForOwner(ctx:RepositoryContext,u:string):Promise<SocialDraftWorkspace>{
 const empty:SocialDraftWorkspace={sources:[],facts:[],requests:[]};
 const w=ctx.scope.workspaceId;
 if(!(await ctx.db.query("SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active'",[w,u])).rows.length)return empty;
 type Source={id:string;revision:number;label:string;observed_at:Date};
 const calls=(await ctx.db.query<Source>(`SELECT c.id,1 AS revision,f.name AS label,c.created_at AS observed_at FROM call_sessions c JOIN firms f ON f.workspace_id=c.workspace_id AND f.id=c.firm_id WHERE c.workspace_id=$1 AND c.actor_user_id=$2 AND f.status='active' AND EXISTS(SELECT 1 FROM call_transcripts t WHERE t.workspace_id=c.workspace_id AND t.call_session_id=c.id) ORDER BY c.created_at DESC,c.id DESC LIMIT 20`,[w,u])).rows;
 const meetings=(await ctx.db.query<Source>(`SELECT t.id,t.version AS revision,f.name AS label,t.created_at AS observed_at FROM meeting_transcripts t JOIN meeting_recordings r ON r.workspace_id=t.workspace_id AND r.id=t.recording_id JOIN meetings m ON m.workspace_id=r.workspace_id AND m.id=r.meeting_id JOIN firms f ON f.workspace_id=m.workspace_id AND f.id=m.firm_id WHERE t.workspace_id=$1 AND f.assigned_user_id=$2 AND f.status='active' AND NOT EXISTS(SELECT 1 FROM meeting_transcripts n WHERE n.workspace_id=t.workspace_id AND n.original_recording_id=t.original_recording_id AND n.version>t.version) ORDER BY t.created_at DESC,t.id DESC LIMIT 20`,[w,u])).rows;
 const research=(await ctx.db.query<Source>(`SELECT id,revision,COALESCE(NULLIF(left(payload->>'firmName',200),''),'Public research') AS label,created_at AS observed_at FROM sourcing_candidates WHERE workspace_id=$1 AND status<>'dismissed' ORDER BY created_at DESC,id DESC LIMIT 20`,[w])).rows;
 const facts=(await ctx.db.query<{id:string;version:number;text:string}>(`SELECT v.block_id AS id,v.version,v.text FROM outreach_answer_blocks b JOIN outreach_answer_block_versions v ON v.workspace_id=b.workspace_id AND v.block_id=b.id AND v.version=b.current_version WHERE b.workspace_id=$1 AND v.approved_at IS NOT NULL AND v.retired_at IS NULL AND v.kind IN ('product','pricing') ORDER BY v.approved_at DESC,v.block_id LIMIT 20`,[w])).rows;
 const requests=(await ctx.db.query<SocialDraftRow>('SELECT * FROM social_draft_requests WHERE workspace_id=$1 AND owner_user_id=$2 ORDER BY created_at DESC,id DESC LIMIT 20',[w,u])).rows;
 const map=(rows:Source[],kind:'call'|'meeting'|'public')=>rows.map(r=>({kind,id:r.id,revision:r.revision,label:r.label,observedAt:r.observed_at.toISOString()}));
 return {sources:[...map(calls,'call'),...map(meetings,'meeting'),...map(research,'public')],facts,requests:requests.map(socialDraftView)};
}
