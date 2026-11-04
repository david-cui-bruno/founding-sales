import {randomUUID} from 'node:crypto';
import {socialStandingPlanSaveSchema,type SocialStandingPlanSave,type SocialStandingPlanView,type SocialStandingActivity} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {SocialResult} from './posts.ts';
import {currentStandingConfiguration,lockStandingOwner,validateStandingConfiguration} from './standingAuthority.ts';
import {standingWeek} from './standingCadence.ts';
import {readApprovedSocialMediaForOwner} from './approvedMedia.ts';
const user=(ctx:RepositoryContext)=>ctx.scope.actor.kind==='user'?ctx.scope.actor.userId:null;
export async function readSocialStandingPlan(ctx:RepositoryContext):Promise<SocialStandingPlanView|null>{const owner=user(ctx);if(!owner||!await lockStandingOwner(ctx,owner))return null;return (await ctx.db.query<SocialStandingPlanView&Record<string,unknown>>('SELECT id AS "planId",revision,state,configuration FROM social_standing_plans WHERE workspace_id=$1 AND owner_user_id=$2',[ctx.scope.workspaceId,owner])).rows[0]??null;}
export async function saveSocialStandingPlan(ctx:RepositoryContext,raw:SocialStandingPlanSave):Promise<SocialResult<SocialStandingPlanView>>{
 const parsed=socialStandingPlanSaveSchema.safeParse(raw),owner=user(ctx);if(!parsed.success)return {ok:false,reason:'invalid_input'};if(!owner||!await lockStandingOwner(ctx,owner))return {ok:false,reason:'owner_unavailable'};
 const input=parsed.data;if(input.binding.ownerUserId!==owner||input.binding.workspaceId!==ctx.scope.workspaceId)return {ok:false,reason:'owner_mismatch'};
 try{new Intl.DateTimeFormat('en',{timeZone:input.timezone}).format();}catch{return {ok:false,reason:'invalid_timezone'};}
 if(new Set(input.cadence.map(s=>`${s.weekday}:${s.time}`)).size!==3)return {ok:false,reason:'duplicate_cadence'};
 const old=await readSocialStandingPlan(ctx);if((old?.revision??0)!==input.expectedRevision)return {ok:false,reason:'stale_revision'};
 const id=old?.planId??randomUUID(),revision=(old?.revision??0)+1;
 if(!await validateStandingConfiguration(ctx,owner,input))return {ok:false,reason:'standing_plan_scope_unavailable'};
 const count=(await ctx.db.query<{count:string}>("SELECT count(*) FROM social_founder_inputs WHERE workspace_id=$1 AND owner_user_id=$2 AND id=ANY($3::uuid[]) AND public_safe AND reason IS NULL AND expires_at>clock_timestamp()",[ctx.scope.workspaceId,owner,input.inputIds])).rows[0];if(Number(count?.count)!==input.inputIds.length)return {ok:false,reason:'standing_plan_source_unavailable'};
 // Save is atomic with validation: callers MUST retain the transaction until command receipt.
 await ctx.db.query(`INSERT INTO social_standing_plans(workspace_id,id,owner_user_id,revision,state,configuration,budget_timezone) VALUES($1,$2,$3,$4,'active',$5::jsonb,$6) ON CONFLICT(workspace_id,owner_user_id) DO UPDATE SET revision=$4,state='active',configuration=$5::jsonb,updated_at=clock_timestamp()`,[ctx.scope.workspaceId,id,owner,revision,JSON.stringify(input),input.timezone]);
 if(old)await cancelUnsubmitted(ctx,owner,'plan_changed');
 return {ok:true,value:{planId:id,revision,state:'active',configuration:input}};
}
async function cancelUnsubmitted(ctx:RepositoryContext,owner:string,reason:string):Promise<void>{
 await ctx.db.query("UPDATE social_post_revisions r SET text='',images='[]',state='cancelled',reason=$3 FROM social_standing_slots s WHERE s.workspace_id=$1 AND s.owner_user_id=$2 AND s.submission_marked_at IS NULL AND r.workspace_id=s.workspace_id AND r.post_id=s.post_id",[ctx.scope.workspaceId,owner,reason]);
 await ctx.db.query("UPDATE social_standing_slots SET state='cancelled',reason=$3,text=NULL,image=NULL,snapshot=NULL,revision=revision+1 WHERE workspace_id=$1 AND owner_user_id=$2 AND submission_marked_at IS NULL AND state IN ('preparing','queued','held')",[ctx.scope.workspaceId,owner,reason]);
}
export async function pauseSocialStandingPlan(ctx:RepositoryContext,input:{planId:string;expectedRevision:number}):Promise<SocialResult<null>>{
 const p=await readSocialStandingPlan(ctx),owner=user(ctx);if(!p||!owner||p.planId!==input.planId)return {ok:false,reason:'not_found'};if(p.revision!==input.expectedRevision)return {ok:false,reason:'stale_revision'};
 if(p.state==='paused')return {ok:false,reason:'plan_already_paused'};
 await ctx.db.query("UPDATE social_standing_plans SET state='paused',revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[ctx.scope.workspaceId,p.planId]);await cancelUnsubmitted(ctx,owner,'plan_paused');
 if(p.configuration.cancelRemoteOnPause){
  await ctx.db.query("UPDATE social_standing_slots SET state='cancellation_pending',next_inspection_at=clock_timestamp(),inspection_deadline=LEAST(inspection_deadline,clock_timestamp()+interval '24 hours') WHERE workspace_id=$1 AND owner_user_id=$2 AND submission_marked_at IS NOT NULL AND state IN ('submitting','scheduled','unknown')",[ctx.scope.workspaceId,owner]);
  await ctx.db.query("UPDATE social_post_revisions r SET state='cancellation_pending' FROM social_standing_slots s WHERE s.workspace_id=$1 AND s.owner_user_id=$2 AND s.state='cancellation_pending' AND r.workspace_id=s.workspace_id AND r.post_id=s.post_id AND r.revision=s.revision AND r.state<>'published'",[ctx.scope.workspaceId,owner]);
 }return {ok:true,value:null};
}
export async function readSocialStandingActivity(ctx:RepositoryContext):Promise<SocialStandingActivity>{
 const p=await readSocialStandingPlan(ctx),owner=user(ctx);if(!owner||!await lockStandingOwner(ctx,owner))return {items:[],remainingThisWeek:0};
 const items=(await ctx.db.query<SocialStandingActivity['items'][number]&Record<string,unknown>>(`SELECT id AS "slotId",revision,publish_at AS "publishAt",local_target AS "localTarget",local_week::text AS "localWeek",state,reason,text,permalink,input_refs AS "inputRefs",image FROM social_standing_slots WHERE workspace_id=$1 AND owner_user_id=$2 ORDER BY publish_at DESC NULLS LAST,id DESC LIMIT 60`,[ctx.scope.workspaceId,owner])).rows.map(r=>({...r,publishAt:r.publishAt===null?null:new Date(r.publishAt).toISOString()}));
 const zone=p?.configuration.timezone??'America/New_York',week=standingWeek(new Date(),zone),end=new Date(`${week}T12:00:00Z`);end.setUTCDate(end.getUTCDate()+7);
 const count=(await ctx.db.query<{count:string}>('SELECT count(*) FROM social_standing_slots WHERE workspace_id=$1 AND owner_user_id=$2 AND (local_week=$4::date OR ((publish_at AT TIME ZONE $3)::date >= $4::date AND (publish_at AT TIME ZONE $3)::date < $5::date))',[ctx.scope.workspaceId,owner,zone,week,end.toISOString().slice(0,10)])).rows[0];return {items,remainingThisWeek:Math.max(0,3-Number(count?.count??0))};
}
export async function editSocialStandingSlot(ctx:RepositoryContext,input:{slotId:string;expectedRevision:number;text?:string}):Promise<SocialResult<null>>{
 const p=await readSocialStandingPlan(ctx),owner=user(ctx);if(!p||!owner)return {ok:false,reason:'not_found'};
 const s=(await ctx.db.query<{revision:number;submission_marked_at:Date|null;state:string;plan_revision:number;image:null|{assetId:string;version:number;sha256:string;approvalRevision:number;altText:string}}>('SELECT revision,submission_marked_at,state,plan_revision,image FROM social_standing_slots WHERE workspace_id=$1 AND owner_user_id=$2 AND id=$3 FOR UPDATE',[ctx.scope.workspaceId,owner,input.slotId])).rows[0];if(!s)return {ok:false,reason:'not_found'};if(s.revision!==input.expectedRevision)return {ok:false,reason:'stale_revision'};if(s.submission_marked_at)return {ok:false,reason:'cancel_before_edit'};if(!['queued','preparing','held'].includes(s.state))return {ok:false,reason:'slot_closed'};
 if(input.text!==undefined){if(s.state!=='queued'||!await currentStandingConfiguration(ctx,owner,{planId:p.planId,revision:s.plan_revision}))return {ok:false,reason:'standing_authority_changed'};const stale=await ctx.db.query(`SELECT 1 FROM social_standing_slots s,jsonb_array_elements(s.input_refs) x WHERE s.workspace_id=$1 AND s.id=$2 AND NOT EXISTS(SELECT 1 FROM social_founder_inputs i WHERE i.workspace_id=s.workspace_id AND i.owner_user_id=s.owner_user_id AND i.id=(x->>'inputId')::uuid AND i.revision=(x->>'revision')::integer AND i.public_safe AND i.reason IS NULL AND i.expires_at>clock_timestamp())`,[ctx.scope.workspaceId,input.slotId]);if(stale.rows.length)return {ok:false,reason:'source_changed_or_unavailable'};}
 if(input.text!==undefined&&s.image){const media=await readApprovedSocialMediaForOwner(ctx,owner,s.image);if(!media||media.altText!==s.image.altText)return {ok:false,reason:'image_unavailable'};}
 await ctx.db.query("UPDATE social_standing_slots SET text=$4,state=CASE WHEN $4::text IS NULL THEN 'skipped' ELSE 'queued' END,reason=CASE WHEN $4::text IS NULL THEN 'owner_skipped' ELSE NULL END,snapshot=NULL,fingerprint=NULL,revision=revision+1 WHERE workspace_id=$1 AND owner_user_id=$2 AND id=$3",[ctx.scope.workspaceId,owner,input.slotId,input.text??null]);return {ok:true,value:null};
}
