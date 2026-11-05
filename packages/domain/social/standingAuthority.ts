import type {SocialStandingRef,SocialStandingPlanSave,SocialPublisherBinding} from '@fss/contracts';
import {withTransaction} from '../db/queryable.ts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {SocialResult} from './posts.ts';
import {requirePrivateDraftAuthority,type PrivateDraftAuthority} from './privateDrafts.ts';
export async function lockStandingOwner(ctx:RepositoryContext,owner:string):Promise<boolean>{return (await ctx.db.query("SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' AND role='admin' FOR UPDATE",[ctx.scope.workspaceId,owner])).rows.length===1;}
export async function currentStandingConfiguration(ctx:RepositoryContext,owner:string,ref:{planId:string;revision:number}):Promise<SocialStandingPlanSave|null>{
 if(!(await ctx.db.query("SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' AND role='admin' FOR SHARE",[ctx.scope.workspaceId,owner])).rows.length)return null;
 const p=(await ctx.db.query<{configuration:SocialStandingPlanSave}>("SELECT configuration FROM social_standing_plans WHERE workspace_id=$1 AND owner_user_id=$2 AND id=$3 AND revision=$4 AND state='active' FOR SHARE",[ctx.scope.workspaceId,owner,ref.planId,ref.revision])).rows[0];if(!p)return null;
 return validateLockedStandingConfiguration(ctx,owner,p.configuration);
}
export async function validateStandingConfiguration(ctx:RepositoryContext,owner:string,c:SocialStandingPlanSave):Promise<SocialStandingPlanSave|null>{
 if(!await lockStandingOwner(ctx,owner))return null;
 return validateLockedStandingConfiguration(ctx,owner,c);
}
async function validateLockedStandingConfiguration(ctx:RepositoryContext,owner:string,c:SocialStandingPlanSave):Promise<SocialStandingPlanSave|null>{
 const b=c.binding;
 if(b.adapter!=='buffer-linkedin-v1'||b.workspaceId!==ctx.scope.workspaceId||b.ownerUserId!==owner||c.scheduledGenerationGrant!=='bedrock_haiku_founder_scheduled_v1'||c.publicationGrant!=='linkedin_personal_standing_v1')return null;
 const valid=await ctx.db.query(`SELECT 1 FROM social_accounts a JOIN social_publisher_credentials s ON s.workspace_id=a.workspace_id AND s.account_id=a.id JOIN social_founder_calibrations k ON k.workspace_id=a.workspace_id AND k.owner_user_id=a.owner_user_id
 WHERE a.workspace_id=$1 AND a.owner_user_id=$2 AND a.id=$3 AND a.revision=$4 AND a.external_id=$5 AND a.state='connected' AND a.platform='linkedin' AND a.account_kind='profile' AND a.adapter_version='buffer-linkedin-v1' AND a.verified_at IS NOT NULL AND a.max_schedule_days IS NOT NULL AND s.id=$6 AND s.revision=$7 AND s.account_revision=a.revision AND s.owner_user_id=a.owner_user_id AND s.external_id=a.external_id AND s.adapter='buffer-linkedin-v1' AND s.organization_id=$10 AND s.channel_id=$11 AND s.state='usable' AND s.encrypted_state IS NOT NULL AND k.id=$8 AND k.completed_at IS NOT NULL
 AND ($9::jsonb IS NULL OR EXISTS(SELECT 1 FROM social_voice_preferences v WHERE v.workspace_id=a.workspace_id AND v.owner_user_id=a.owner_user_id AND v.id=($9::jsonb->>'guideId')::uuid AND v.revision=($9::jsonb->>'revision')::integer AND v.entries IS NOT NULL)) FOR SHARE OF a,s,k`,[ctx.scope.workspaceId,owner,b.accountId,b.accountRevision,b.externalId,b.credentialId,b.credentialRevision,c.calibrationId,c.guideRef?JSON.stringify(c.guideRef):null,b.organizationId,b.channelId]);
 return valid.rows.length===1?c:null;
}
/** Called BEFORE request insertion in the same transaction. A selection marker alone is never authority. */
export async function reserveStandingGenerationRequest(ctx:RepositoryContext,owner:string,ref:SocialStandingRef):Promise<SocialResult<{requestId:string|null}>>{
 if(ctx.scope.actor.kind!=='system'||ctx.scope.actor.component!=='worker')return {ok:false,reason:'worker_required'};
 if(!await currentStandingConfiguration(ctx,owner,ref))return {ok:false,reason:'standing_authority_changed'};
 const row=(await ctx.db.query<{generation_request_id:string|null}>("SELECT generation_request_id FROM social_standing_slots WHERE workspace_id=$1 AND owner_user_id=$2 AND plan_id=$3 AND plan_revision=$4 AND id=$5 AND state='preparing' AND submission_marked_at IS NULL AND publish_at>clock_timestamp()+interval '30 minutes' FOR UPDATE",[ctx.scope.workspaceId,owner,ref.planId,ref.revision,ref.slotId])).rows[0];
 return row?{ok:true,value:{requestId:row.generation_request_id}}:{ok:false,reason:'standing_slot_unavailable'};
}
export async function bindStandingGenerationRequest(ctx:RepositoryContext,owner:string,ref:SocialStandingRef,requestId:string):Promise<SocialResult<null>>{
 const reserved=await reserveStandingGenerationRequest(ctx,owner,ref);if(!reserved.ok)return reserved;
 if(reserved.value.requestId&&reserved.value.requestId!==requestId)return {ok:false,reason:'standing_request_changed'};
 const changed=await ctx.db.query(`UPDATE social_standing_slots s SET generation_request_id=$6 WHERE s.workspace_id=$1 AND s.owner_user_id=$2 AND s.plan_id=$3 AND s.plan_revision=$4 AND s.id=$5 AND EXISTS(SELECT 1 FROM social_draft_requests r WHERE r.workspace_id=s.workspace_id AND r.owner_user_id=s.owner_user_id AND r.id=$6 AND r.source_selection->'standingPlanRef'=$7::jsonb) RETURNING id`,[ctx.scope.workspaceId,owner,ref.planId,ref.revision,ref.slotId,requestId,JSON.stringify(ref)]);
 return changed.rows.length===1?{ok:true,value:null}:{ok:false,reason:'standing_request_unavailable'};
}
export async function checkSocialStandingGenerationAuthority(ctx:RepositoryContext,owner:string,ref:SocialStandingRef):Promise<SocialResult<null>>{
 if(ctx.scope.actor.kind!=='system'||ctx.scope.actor.component!=='worker')return {ok:false,reason:'worker_required'};
 const config=await currentStandingConfiguration(ctx,owner,ref);if(!config)return {ok:false,reason:'standing_authority_changed'};
 const r=await ctx.db.query(`SELECT 1 FROM social_standing_slots s JOIN social_draft_requests r ON r.workspace_id=s.workspace_id AND r.id=s.generation_request_id AND r.owner_user_id=s.owner_user_id
 WHERE s.workspace_id=$1 AND s.owner_user_id=$2 AND s.plan_id=$3 AND s.plan_revision=$4 AND s.id=$5 AND s.state='preparing' AND s.submission_marked_at IS NULL AND s.publish_at>clock_timestamp() AND r.deadline_at>clock_timestamp()
 AND r.source_selection->'standingPlanRef'=$6::jsonb AND r.source_selection->'founderInputRefs'=s.input_refs AND COALESCE(r.source_selection->'voiceGuideRef','null'::jsonb)=$7::jsonb
 AND jsonb_array_length(s.input_refs)>0 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(s.input_refs) x LEFT JOIN social_founder_inputs i ON i.workspace_id=s.workspace_id AND i.owner_user_id=s.owner_user_id AND i.id=(x->>'inputId')::uuid
 WHERE i.id IS NULL OR NOT i.id=ANY($8::uuid[]) OR i.revision<>(x->>'revision')::integer OR NOT i.public_safe OR i.reason IS NOT NULL OR i.expires_at<=clock_timestamp())`,[ctx.scope.workspaceId,owner,ref.planId,ref.revision,ref.slotId,JSON.stringify(ref),JSON.stringify(config.guideRef),config.inputIds]);
 return r.rows.length===1?{ok:true,value:null}:{ok:false,reason:'standing_slot_unavailable'};
}
/** Persist a proven invalid key only after publication locks have been released.
 * Exact credential/account CAS prevents a delayed 401 from revoking a reconnect. */
export async function invalidateSocialPublisherCredential(ctx:RepositoryContext,binding:SocialPublisherBinding,authority?:PrivateDraftAuthority):Promise<boolean>{
 const actor=ctx.scope.actor,isOwner=actor.kind==='user'&&actor.role==='admin'&&actor.userId===binding.ownerUserId;
 if((!isOwner&&(actor.kind!=='system'||actor.component!=='worker'))||binding.adapter!=='buffer-linkedin-v1'||binding.workspaceId!==ctx.scope.workspaceId||(isOwner&&!authority))throw new Error('publisher_authority_required');
 return withTransaction(ctx.db,async()=>{
  const membership=(await ctx.db.query<{status:string;role:string}>('SELECT status,role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE',[binding.workspaceId,binding.ownerUserId])).rows[0];
  if(authority)await requirePrivateDraftAuthority(authority);
  if(isOwner&&(!membership||membership.status!=='active'||membership.role!=='admin'))return false;
  const account=await ctx.db.query("SELECT id FROM social_accounts WHERE workspace_id=$1 AND owner_user_id=$2 AND id=$3 AND revision=$4 AND adapter_version=$5 AND external_id=$6 FOR UPDATE",[binding.workspaceId,binding.ownerUserId,binding.accountId,binding.accountRevision,binding.adapter,binding.externalId]);
  if(account.rows.length!==1)return false;
  if(authority)await requirePrivateDraftAuthority(authority);
  const revoked=await ctx.db.query("UPDATE social_publisher_credentials SET encrypted_state=NULL,state='disconnected',revision=revision+1 WHERE workspace_id=$1 AND owner_user_id=$2 AND account_id=$3 AND account_revision=$4 AND id=$5 AND revision=$6 AND adapter=$7 AND organization_id=$8 AND channel_id=$9 AND external_id=$10 AND state='usable' AND encrypted_state IS NOT NULL RETURNING id",[binding.workspaceId,binding.ownerUserId,binding.accountId,binding.accountRevision,binding.credentialId,binding.credentialRevision,binding.adapter,binding.organizationId,binding.channelId,binding.externalId]);
  if(revoked.rows.length!==1)return false;
  await ctx.db.query("UPDATE social_accounts SET state='disconnected',revision=revision+1,adapter_version=NULL,verified_at=NULL,max_schedule_days=NULL WHERE workspace_id=$1 AND owner_user_id=$2 AND id=$3 AND revision=$4",[binding.workspaceId,binding.ownerUserId,binding.accountId,binding.accountRevision]);
  if(authority)await requirePrivateDraftAuthority(authority);
  return true;
 });
}
