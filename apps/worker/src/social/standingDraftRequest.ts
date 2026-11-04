import {randomUUID} from 'node:crypto';
import {socialDraftRequestSchema,type SocialDraftRequest,type SocialStandingRef} from '@fss/contracts';
import type {RepositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {reserveStandingGenerationRequest,bindStandingGenerationRequest} from '@fss/domain/social/standingAuthority.ts';
import {readSocialDraftSourcesForWorker} from '@fss/domain/social/draftSources.ts';
import {SOCIAL_DRAFT_MODEL,SOCIAL_DRAFT_LIMITS,socialDraftPromptVersion} from '@fss/domain/social/draftPolicy.ts';
import type {SocialResult} from '@fss/domain/social/posts.ts';

/** Caller holds one transaction. This never borrows a user actor or calls a model. */
export async function createStandingDraftRequest(
 ctx:RepositoryContext,ownerUserId:string,ref:SocialStandingRef,selection:SocialDraftRequest,deadlineAt:Date,
):Promise<SocialResult<{requestId:string}>>{
 const reserved=await reserveStandingGenerationRequest(ctx,ownerUserId,ref);
 if(!reserved.ok)return reserved;
 if(reserved.value.requestId)return {ok:true,value:{requestId:reserved.value.requestId}};
 if(selection.standingPlanRef&&JSON.stringify(selection.standingPlanRef)!==JSON.stringify(ref))return {ok:false,reason:'standing_request_changed'};
 const parsed=socialDraftRequestSchema.safeParse({...selection,standingPlanRef:ref});
 if(!parsed.success||parsed.data.mode!=='linkedin_founder')return {ok:false,reason:'invalid_input'};
 // Current plan/slot locks already establish scheduled scope. Initial source
 // preparation is read-only; no dispatch occurs before the persisted association.
 const {standingPlanRef:_ref,...initial}=parsed.data;
 const prepared=await readSocialDraftSourcesForWorker(ctx,ownerUserId,initial);
 if(!prepared.ok)return prepared;
 const promptVersion=socialDraftPromptVersion(parsed.data.mode);
 const pending=(await ctx.db.query<{count:number;matching:boolean}>(`SELECT count(*)::integer AS count,COALESCE(bool_or(source_hash=$3 AND prompt_version=$4),false) AS matching FROM social_draft_requests WHERE workspace_id=$1 AND owner_user_id=$2 AND state IN ('queued','calling')`,[ctx.scope.workspaceId,ownerUserId,prepared.value.hash,promptVersion])).rows[0]!;
 if(pending.count>=3||pending.matching)return {ok:false,reason:'draft_requests_pending'};
 const now=(await ctx.db.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now;
 const deadline=new Date(Math.min(deadlineAt.getTime(),now.getTime()+SOCIAL_DRAFT_LIMITS.deadlineMinutes*60_000));
 if(!Number.isFinite(deadline.getTime())||deadline<=now)return {ok:false,reason:'standing_slot_unavailable'};
 const requestId=randomUUID();
 await ctx.db.query(`INSERT INTO social_draft_requests(workspace_id,id,owner_user_id,source_selection,source_hash,prompt_version,model_name,deadline_at) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8)`,[ctx.scope.workspaceId,requestId,ownerUserId,JSON.stringify(parsed.data),prepared.value.hash,promptVersion,SOCIAL_DRAFT_MODEL,deadline]);
 const bound=await bindStandingGenerationRequest(ctx,ownerUserId,ref,requestId);
 if(!bound.ok){await ctx.db.query('DELETE FROM social_draft_requests WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,requestId]);return bound;}
 const current=await readSocialDraftSourcesForWorker(ctx,ownerUserId,parsed.data);
 if(!current.ok||current.value.hash!==prepared.value.hash){
  await ctx.db.query("UPDATE social_draft_requests SET state='review',concepts=NULL,reason='source_changed_or_unavailable',updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[ctx.scope.workspaceId,requestId]);
  return {ok:false,reason:'source_changed_or_unavailable'};
 }
 return {ok:true,value:{requestId}};
}
