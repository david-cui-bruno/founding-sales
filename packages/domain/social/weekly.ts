import {socialWeeklySaveSchema,type SocialWeekly,type SocialDraftRequest} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import {readSocialDraftWorkspaceForScheduler} from './draftWorkspace.ts';
import {readSocialDraftSourcesForWorker} from './draftSources.ts';
import {SOCIAL_DRAFT_MODEL,SOCIAL_DRAFT_PROMPT_VERSION} from './draftPolicy.ts';
import type {SocialResult} from './posts.ts';
interface Row{[key:string]:unknown;owner_user_id:string;enabled:boolean;revision:number;next_at:Date|null;last_at:Date|null;last_result:SocialWeekly['lastResult']}
const defaults:SocialWeekly={enabled:false,revision:0,nextAt:null,lastAt:null,lastResult:null};
const view=(r:Row):SocialWeekly=>({enabled:r.enabled,revision:r.revision,nextAt:r.next_at?.toISOString()??null,lastAt:r.last_at?.toISOString()??null,lastResult:r.last_result});
export async function readSocialWeekly(ctx:RepositoryContext):Promise<SocialWeekly>{
 if(ctx.scope.actor.kind!=='user')return defaults;
 const r=(await ctx.db.query<Row>('SELECT * FROM social_weekly_settings WHERE workspace_id=$1 AND owner_user_id=$2',[ctx.scope.workspaceId,ctx.scope.actor.userId])).rows[0];return r?view(r):defaults;
}
export async function saveSocialWeekly(ctx:RepositoryContext,raw:{enabled:boolean;expectedRevision:number}):Promise<SocialResult<SocialWeekly>>{
 if(ctx.scope.actor.kind!=='user')return {ok:false,reason:'user_required'};
 const p=socialWeeklySaveSchema.safeParse(raw);if(!p.success)return {ok:false,reason:'invalid_input'};
 const w=ctx.scope.workspaceId,u=ctx.scope.actor.userId;
 await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`social-drafts:${w}:${u}`]);
 if(!(await ctx.db.query("SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' FOR SHARE",[w,u])).rows.length)return {ok:false,reason:'owner_unavailable'};
 const old=await readSocialWeekly(ctx);if(old.revision!==p.data.expectedRevision)return {ok:false,reason:'stale_revision'};
 await ctx.db.query(`INSERT INTO social_weekly_settings(workspace_id,owner_user_id,enabled,next_at) VALUES($1,$2,$3,CASE WHEN $3 THEN now() ELSE NULL END) ON CONFLICT(workspace_id,owner_user_id) DO UPDATE SET enabled=$3,revision=social_weekly_settings.revision+1,next_at=CASE WHEN NOT $3 THEN NULL WHEN social_weekly_settings.enabled THEN social_weekly_settings.next_at ELSE now() END,updated_at=now()`,[w,u,p.data.enabled]);
 await recordCrmAuditEvent(ctx,{action:'social.weekly_changed',subjectKind:'social_weekly',subjectId:u,detail:{enabled:p.data.enabled}});
 return {ok:true,value:await readSocialWeekly(ctx)};
}
/** Read under the request lock at dispatch/acceptance; settings changes invalidate
 * queued periodic work, but never erase an already incurred provider charge. */
export async function socialWeeklyRequestAllowed(ctx:RepositoryContext,owner:string,revision:number|null):Promise<boolean>{
 if(revision===null)return true;
 return (await ctx.db.query('SELECT 1 FROM social_weekly_settings WHERE workspace_id=$1 AND owner_user_id=$2 AND enabled AND revision=$3 FOR SHARE',[ctx.scope.workspaceId,owner,revision])).rows.length>0;
}
/** Scheduler transaction only. One batch at most per seven days; missed weeks do
 * not accumulate, unchanged source revisions are not reused by periodic drafting. */
export async function queueWeeklySocialDrafts(ctx:RepositoryContext):Promise<number>{
 if(ctx.scope.actor.kind!=='system'||ctx.scope.actor.component!=='scheduler')throw new Error('scheduler_required');
 const w=ctx.scope.workspaceId,rows=(await ctx.db.query<Row>(`SELECT s.* FROM social_weekly_settings s JOIN workspace_memberships m ON m.workspace_id=s.workspace_id AND m.user_id=s.owner_user_id WHERE s.workspace_id=$1 AND s.enabled AND s.next_at<=now() AND m.status='active' ORDER BY s.next_at,s.owner_user_id LIMIT 20`,[w])).rows;
 let queued=0;
 for(const setting of rows){
  const owner=setting.owner_user_id;
  const locked=(await ctx.db.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',[`social-drafts:${w}:${owner}`])).rows[0]?.locked;if(!locked)continue;
  const current=(await ctx.db.query<Row>('SELECT * FROM social_weekly_settings WHERE workspace_id=$1 AND owner_user_id=$2 AND enabled AND next_at<=now()',[w,owner])).rows[0];if(!current)continue;
  let result:SocialWeekly['lastResult']='no_new_sources';
  const catalog=await readSocialDraftWorkspaceForScheduler(ctx,owner),refs:SocialDraftRequest['sourceRefs']=[];
  for(const source of catalog.sources){
   if(refs.length>=10)break;
   const ref={kind:source.kind,id:source.id,revision:source.revision};
   if((await ctx.db.query('SELECT 1 FROM social_draft_requests WHERE workspace_id=$1 AND owner_user_id=$2 AND weekly_revision IS NOT NULL AND source_selection->\'sourceRefs\' @> $3::jsonb LIMIT 1',[w,owner,JSON.stringify([ref])])).rows.length)continue;
   if((await readSocialDraftSourcesForWorker(ctx,owner,{sourceRefs:[ref],factBlocks:[]})).ok)refs.push(ref);
  }
  if(refs.length){
   const selection={sourceRefs:refs,factBlocks:catalog.facts.map(({id,version})=>({id,version}))};
   const prepared=await readSocialDraftSourcesForWorker(ctx,owner,selection);
   const count=(await ctx.db.query<{n:number}>("SELECT count(*)::integer AS n FROM social_draft_requests WHERE workspace_id=$1 AND owner_user_id=$2 AND state IN ('queued','calling')",[w,owner])).rows[0]!.n;
   if(count>=3)result='requests_pending';else if(!prepared.ok)result='sources_unavailable';else{
    const inserted=await ctx.db.query(`INSERT INTO social_draft_requests(workspace_id,owner_user_id,source_selection,source_hash,prompt_version,model_name,weekly_revision) VALUES($1,$2,$3::jsonb,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id`,[w,owner,JSON.stringify(selection),prepared.value.hash,SOCIAL_DRAFT_PROMPT_VERSION,SOCIAL_DRAFT_MODEL,current.revision]);
    if(inserted.rows.length){queued++;result='queued';}
   }
  }
  await ctx.db.query("UPDATE social_weekly_settings SET next_at=now()+interval '7 days',last_at=now(),last_result=$3,updated_at=now() WHERE workspace_id=$1 AND owner_user_id=$2",[w,owner,result]);
 }
 return queued;
}
