import type {RepositoryContext} from '../db/workspaceScope.ts';
import {socialMediaApproveInputSchema,type SocialMediaApprovalInput,type ApprovedSocialMedia} from '@fss/contracts';
import {queueSocialAssetDeletion} from './assets.ts';
import {requirePrivateDraftAuthority,type PrivateDraftAuthority} from './privateDrafts.ts';
type ApprovedMediaRow={ [Key in keyof ApprovedSocialMedia]:ApprovedSocialMedia[Key] };
export async function approveSocialMedia(ctx:RepositoryContext,raw:SocialMediaApprovalInput,authority:PrivateDraftAuthority){
 const parsed=socialMediaApproveInputSchema.safeParse(raw);if(!parsed.success)return {ok:false as const,reason:'invalid_input'};
 const input=parsed.data,owner=ctx.scope.actor.kind==='user'?ctx.scope.actor.userId:null;
 await requirePrivateDraftAuthority(authority);
 const row=(await ctx.db.query<{approval_revision:number}>(`SELECT a.approval_revision FROM social_assets a JOIN social_asset_objects o ON o.workspace_id=a.workspace_id AND o.asset_id=a.id AND o.version=a.current_version JOIN workspace_memberships m ON m.workspace_id=a.workspace_id AND m.user_id=a.owner_user_id AND m.status='active' WHERE a.workspace_id=$1 AND a.id=$2 AND a.owner_user_id=$3 AND a.state='ready' AND o.state='ready' AND o.sanitized AND o.version=$4 AND o.sha256=$5 FOR UPDATE OF a FOR SHARE OF m`,[ctx.scope.workspaceId,input.assetId,owner,input.version,input.sha256])).rows[0];
 if(!row)return {ok:false as const,reason:'media_unavailable'};if(row.approval_revision!==input.expectedApprovalRevision)return {ok:false as const,reason:'stale_approval'};
 await requirePrivateDraftAuthority(authority);
 await ctx.db.query('UPDATE social_assets SET approval_revision=approval_revision+1,approved_version=$3,approved_sha256=$4,approved_caption=$5,approved_topic=$6,approved_alt_text=$7,approved_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,input.assetId,input.version,input.sha256,input.caption,input.topic,input.altText]);
 return {ok:true as const,value:{assetId:input.assetId,version:input.version,sha256:input.sha256,approvalRevision:row.approval_revision+1}};
}
export async function withdrawSocialMedia(ctx:RepositoryContext,input:{assetId:string;expectedApprovalRevision:number},authority:PrivateDraftAuthority){
 const owner=ctx.scope.actor.kind==='user'?ctx.scope.actor.userId:null;
 const row=(await ctx.db.query<{approval_revision:number}>('SELECT approval_revision FROM social_assets WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 FOR UPDATE',[ctx.scope.workspaceId,input.assetId,owner])).rows[0];
 await requirePrivateDraftAuthority(authority);
 if(!row)return {ok:false as const,reason:'not_found'};if(row.approval_revision!==input.expectedApprovalRevision)return {ok:false as const,reason:'stale_approval'};
 await queueSocialAssetDeletion(ctx,input.assetId);
 await ctx.db.query("UPDATE social_assets SET state='deleted',deleted_at=clock_timestamp(),approval_revision=approval_revision+1,approved_version=NULL,approved_sha256=NULL,approved_caption=NULL,approved_topic=NULL,approved_alt_text=NULL,approved_at=NULL WHERE workspace_id=$1 AND id=$2",[ctx.scope.workspaceId,input.assetId]);
 return {ok:true as const,value:{assetId:input.assetId,approvalRevision:row.approval_revision+1}};
}
/** Caller supplies the retained owner; system workers never impersonate a user. Locks fence egress with withdrawal/departure. */
export async function readApprovedSocialMedia(ctx:RepositoryContext,input:{ownerUserId:string;assetId:string;version:number;sha256:string;approvalRevision?:number}):Promise<ApprovedSocialMedia|null>{
 const row=(await ctx.db.query<ApprovedMediaRow>(`SELECT a.id AS "assetId",o.version,o.sha256,a.approval_revision AS "approvalRevision",a.approved_caption AS caption,a.approved_topic AS topic,a.approved_alt_text AS "altText",o.width,o.height,o.mime FROM social_assets a JOIN social_asset_objects o ON o.workspace_id=a.workspace_id AND o.asset_id=a.id AND o.version=a.approved_version AND o.sha256=a.approved_sha256 JOIN workspace_memberships m ON m.workspace_id=a.workspace_id AND m.user_id=a.owner_user_id AND m.status='active' WHERE a.workspace_id=$1 AND a.id=$2 AND a.owner_user_id=$3 AND a.state='ready' AND o.state='ready' AND o.sanitized AND o.version=$4 AND o.sha256=$5 AND ($6::integer IS NULL OR a.approval_revision=$6) FOR SHARE OF a,o,m`,[ctx.scope.workspaceId,input.assetId,input.ownerUserId,input.version,input.sha256,input.approvalRevision??null])).rows[0];return row??null;
}
export async function listSocialMedia(ctx:RepositoryContext){
 const owner=ctx.scope.actor.kind==='user'?ctx.scope.actor.userId:null;
 return (await ctx.db.query<ApprovedMediaRow&{approved:boolean}>(`SELECT a.id AS "assetId",o.version,o.sha256,a.approval_revision AS "approvalRevision",COALESCE(a.approved_caption,'') AS caption,COALESCE(a.approved_topic,'') AS topic,COALESCE(a.approved_alt_text,'') AS "altText",o.width,o.height,o.mime,COALESCE(a.approved_version=o.version AND a.approved_sha256=o.sha256,false) AS approved FROM social_assets a JOIN social_asset_objects o ON o.workspace_id=a.workspace_id AND o.asset_id=a.id AND o.version=a.current_version JOIN workspace_memberships m ON m.workspace_id=a.workspace_id AND m.user_id=a.owner_user_id AND m.status='active' WHERE a.workspace_id=$1 AND a.owner_user_id=$2 AND a.state='ready' AND o.state='ready' AND o.sanitized ORDER BY a.id LIMIT 100`,[ctx.scope.workspaceId,owner])).rows;
}
/** Internal object-key projection; never return this value from a browser route. */
export async function readApprovedSocialMediaForOwner(ctx:RepositoryContext,ownerUserId:string,input:{assetId:string;version:number;sha256:string;approvalRevision?:number}):Promise<(ApprovedSocialMedia&{objectKey:string})|null>{
 const approved=await readApprovedSocialMedia(ctx,{...input,ownerUserId});if(!approved)return null;
 const object=(await ctx.db.query<{object_key:string}>("SELECT object_key FROM social_asset_objects WHERE workspace_id=$1 AND asset_id=$2 AND version=$3 AND sha256=$4 AND state='ready' AND sanitized FOR SHARE",[ctx.scope.workspaceId,input.assetId,input.version,input.sha256])).rows[0];
 return object?{...approved,objectKey:object.object_key}:null;
}
