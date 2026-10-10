import {createHash,randomUUID} from 'node:crypto';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import {lockSocialPost,readSocialPost,readSocialAccount,type SocialResult} from './posts.ts';
import {socialAssetObject} from './assets.ts';
import {inspectXPostText} from './xText.ts';

import type {SocialManualHandoffView,SocialManualHandoffSnapshot} from '@fss/contracts';
export type {SocialManualHandoffView,SocialManualHandoffSnapshot} from '@fss/contracts';
export interface SocialManualHandoffInput {postId:string;expectedRevision:number}
const owner=(ctx:RepositoryContext)=>ctx.scope.actor.kind==='user'?ctx.scope.actor.userId:null;

/** Caller owns a transaction. Manual review never supplies provider authority. */
export async function previewSocialManualHandoff(ctx:RepositoryContext,input:SocialManualHandoffInput):Promise<SocialResult<SocialManualHandoffView>>{
 if(!owner(ctx))return {ok:false,reason:'user_required'};
 // Asset writers take this lock before changing any derivative or deleting it.
 await ctx.db.query('SELECT 1 FROM social_library_usage WHERE workspace_id=$1 FOR SHARE',[ctx.scope.workspaceId]);
 const revision=await lockSocialPost(ctx,input.postId);if(revision===null)return {ok:false,reason:'not_found'};
 if(revision!==input.expectedRevision)return {ok:false,reason:'stale_revision'};
 const post=(await readSocialPost(ctx,input.postId))!;
 if(!['draft','failed'].includes(post.state))return {ok:false,reason:'manual_handoff_not_draft'};
 const blocked=(await ctx.db.query(`SELECT 1 FROM social_deliveries WHERE workspace_id=$1 AND post_id=$2
  AND (state IN ('pending','preparing','submitting','scheduled','published','unknown','cancellation_pending')
   OR (submission_id IS NOT NULL AND NOT(state='cancelled' OR state='failed' AND reason='not_found_on_platform'))) LIMIT 1`,[ctx.scope.workspaceId,input.postId])).rows.length;
 if(blocked)return {ok:false,reason:'inspect_existing_submission'};
 const account=await readSocialAccount(ctx,post.accountId);if(!account)return {ok:false,reason:'account_not_found'};
 if(account.state==='disconnected')return {ok:false,reason:'destination_disconnected'};
 if(account.platform==='facebook'&&account.account_kind!=='page')return {ok:false,reason:'facebook_page_required'};
 if(account.platform!=='facebook'&&account.account_kind!=='profile')return {ok:false,reason:'profile_required'};
 const at=post.publishAt===null?NaN:Date.parse(post.publishAt);if(!Number.isFinite(at))return {ok:false,reason:'schedule_required'};
 if(at<=Date.now())return {ok:false,reason:'schedule_in_past'};
 if(!post.text.trim()||(account.platform==='x'?!inspectXPostText(post.text).valid:[...post.text].length>(account.platform==='linkedin'?3000:10000))||post.images.length>(account.platform==='x'?4:account.platform==='linkedin'?1:10))return {ok:false,reason:'content_needs_edit'};
 const images:SocialManualHandoffSnapshot['images']=[],seen=new Set<string>();
 for(const image of post.images){
  const key=`${image.assetId}:${image.version}`;if(seen.has(key))return {ok:false,reason:'duplicate_image'};seen.add(key);
  const object=await socialAssetObject(ctx,{assetId:image.assetId,version:image.version},'download');if(!object||object.kind!=='derivative')return {ok:false,reason:'image_unavailable'};
  images.push({...image,sha256:object.sha256,mime:object.mime,width:object.width,height:object.height});
 }
 const snapshot:SocialManualHandoffSnapshot={account:{id:account.id,platform:account.platform,externalId:account.external_id,displayName:account.display_name,accountKind:account.account_kind,revision:account.revision},text:post.text,images,publishAt:new Date(at).toISOString(),zone:post.zone};
 const fingerprint=createHash('sha256').update(JSON.stringify({postId:post.postId,revision,snapshot})).digest('hex');
 return {ok:true,value:{postId:post.postId,revision,fingerprint,snapshot,approvalId:null,approvedAt:null,state:'review_required',accountEvidence:'human_review_required'}};
}

export async function confirmSocialManualHandoff(ctx:RepositoryContext,input:SocialManualHandoffInput&{fingerprint:string;reviewedDestination:boolean}):Promise<SocialResult<{approvalId:string}>>{
 if(input.reviewedDestination!==true)return {ok:false,reason:'destination_review_required'};
 const current=await previewSocialManualHandoff(ctx,input);if(!current.ok)return current;
 if(current.value.fingerprint!==input.fingerprint)return {ok:false,reason:'approval_changed'};
 const previous=(await ctx.db.query<{id:string}>('SELECT id FROM social_manual_handoff_approvals WHERE workspace_id=$1 AND post_id=$2 AND revision=$3 AND fingerprint=$4 AND approved_by=$5',[ctx.scope.workspaceId,input.postId,input.expectedRevision,input.fingerprint,owner(ctx)])).rows[0];
 if(previous)return {ok:true,value:{approvalId:previous.id}};
 const id=randomUUID();await ctx.db.query('INSERT INTO social_manual_handoff_approvals(workspace_id,id,post_id,revision,fingerprint,snapshot,approved_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)',[ctx.scope.workspaceId,id,input.postId,input.expectedRevision,input.fingerprint,JSON.stringify(current.value.snapshot),owner(ctx)]);
 await recordCrmAuditEvent(ctx,{action:'social.manual_handoff_reviewed',subjectKind:'social_post',subjectId:input.postId,detail:{revision:input.expectedRevision}});
 return {ok:true,value:{approvalId:id}};
}

/** Must be refreshed immediately before a user-clicked copy/open/download. */
export async function readSocialManualHandoff(ctx:RepositoryContext,input:SocialManualHandoffInput):Promise<SocialResult<SocialManualHandoffView>>{
 const current=await previewSocialManualHandoff(ctx,input);if(!current.ok)return current;
 const approval=(await ctx.db.query<{id:string;approved_at:Date|string}>('SELECT id,approved_at FROM social_manual_handoff_approvals WHERE workspace_id=$1 AND post_id=$2 AND revision=$3 AND fingerprint=$4 AND approved_by=$5',[ctx.scope.workspaceId,input.postId,input.expectedRevision,current.value.fingerprint,owner(ctx)])).rows[0];
 return {ok:true,value:approval?{...current.value,approvalId:approval.id,approvedAt:new Date(approval.approved_at).toISOString(),state:'manual_needed'}:current.value};
}
