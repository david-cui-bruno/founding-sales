import type {PostRevision} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import {lockSocialPost,readSocialPost,type SocialResult} from './posts.ts';
export type SocialDeliveryHoldReason='schedule_missed'|'account_identity_changed'|'account_not_verified'|'adapter_unavailable'|'approved_image_changed'|'staging_failed'|'preparation_unavailable'|'claim_expired';
/** Only a definitely unsubmitted revision can become editable recovery work. */
export async function holdSocialDelivery(ctx:RepositoryContext,input:{deviceId:string;postId:string;expectedRevision:number;reason:SocialDeliveryHoldReason}):Promise<SocialResult<PostRevision>>{
 const user=ctx.scope.actor.kind==='user'?ctx.scope.actor.userId:null;
 if(!user||(await ctx.db.query("SELECT 1 FROM devices WHERE workspace_id=$1 AND id=$2 AND user_id=$3 AND status='active'",[ctx.scope.workspaceId,input.deviceId,user])).rows.length!==1)return {ok:false,reason:'device_invalid'};
 const revision=await lockSocialPost(ctx,input.postId);if(revision===null)return {ok:false,reason:'not_found'};if(revision!==input.expectedRevision)return {ok:false,reason:'stale_revision'};
 const delivery=(await ctx.db.query<{id:string;state:string;reason:string|null;submission_id:string|null;receipt_id:string|null}>("SELECT id,state,reason,submission_id,receipt_id FROM social_deliveries WHERE workspace_id=$1 AND post_id=$2 AND revision=$3",[ctx.scope.workspaceId,input.postId,revision])).rows[0];
 if(!delivery)return {ok:false,reason:'approval_required'};
 if(delivery.submission_id!==null||delivery.receipt_id!==null)return {ok:false,reason:'inspect_existing_submission'};
 if(delivery.state==='failed'&&delivery.reason===input.reason)return {ok:true,value:(await readSocialPost(ctx,input.postId))!};
 if(!['pending','preparing'].includes(delivery.state))return {ok:false,reason:'delivery_not_pending'};
 await ctx.db.query("UPDATE social_deliveries SET state='failed',reason=$3 WHERE workspace_id=$1 AND id=$2",[ctx.scope.workspaceId,delivery.id,input.reason]);
 await ctx.db.query("UPDATE social_post_revisions SET state='failed',reason=$4 WHERE workspace_id=$1 AND post_id=$2 AND revision=$3",[ctx.scope.workspaceId,input.postId,revision,input.reason]);
 await recordCrmAuditEvent(ctx,{action:'social.delivery_held',subjectKind:'social_post',subjectId:input.postId,detail:{revision,reason:input.reason}});
 return {ok:true,value:(await readSocialPost(ctx,input.postId))!};
}
