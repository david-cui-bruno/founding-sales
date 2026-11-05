import {createHash,randomUUID} from 'node:crypto';
import type {PostRevision,SocialPublisherAttempt,SocialPublisherBinding,SocialPublisherObservation} from '@fss/contracts';
import {repositoryContext,workspaceScope,type RepositoryContext} from '../db/workspaceScope.ts';
import type {SessionQueryable} from '../db/queryable.ts';
import {socialApprovalSnapshotForWorker} from './posts.ts';
import {currentStandingConfiguration} from './standingAuthority.ts';
import {readSocialDraftSourcesForWorker} from './draftSources.ts';
import {readApprovedSocialMediaForOwner} from './approvedMedia.ts';
import type {SocialDraftRow} from './drafts.ts';
export interface StandingSlot extends Record<string,unknown> {id:string;owner_user_id:string;plan_id:string;plan_revision:number;revision:number;state:string;publish_at:Date;text:string|null;image:null|{assetId:string;version:number;sha256:string;approvalRevision:number;altText:string;mime:'image/jpeg'|'image/png';byteLength:number};post_id:string|null;attempt_id:string;fingerprint:string|null;submission_marked_at:Date|null;receipt_id:string|null;media_receipt_id:string|null;observed_at:Date|null;generation_request_id:string|null;snapshot:null|{binding:SocialPublisherBinding;text:string|null;textSHA256:string;publishAt:string;image:StandingSlot['image']};inspection_deadline:Date|null}
export async function readStandingSlot(ctx:RepositoryContext,id:string):Promise<StandingSlot|null>{return (await ctx.db.query<StandingSlot>('SELECT * FROM social_standing_slots WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,id])).rows[0]??null;}
/** Separate publication authority: never extends the model dispatch deadline. */
export async function checkStandingPublicationAuthority(ctx:RepositoryContext,slot:StandingSlot,ownMarkedAttempt=false):Promise<void>{
 if(ctx.scope.actor.kind!=='system'||ctx.scope.actor.component!=='worker')throw new Error('worker_required');
 const c=await currentStandingConfiguration(ctx,slot.owner_user_id,{planId:slot.plan_id,revision:slot.plan_revision});if(!c)throw new Error('standing_authority_changed');
 if(slot.snapshot&&Object.entries(c.binding).some(([key,value])=>slot.snapshot!.binding[key as keyof SocialPublisherBinding]!==value))throw new Error('standing_authority_changed');
 const locked=(await ctx.db.query<StandingSlot>('SELECT * FROM social_standing_slots WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.scope.workspaceId,slot.id])).rows[0];if(!locked||locked.revision!==slot.revision||locked.attempt_id!==slot.attempt_id||(ownMarkedAttempt?locked.state!=='submitting'||!locked.submission_marked_at:locked.state!=='queued'||locked.submission_marked_at!==null)||locked.publish_at.getTime()<=Date.now()+300000)throw new Error('standing_slot_unavailable');
 const request=(await ctx.db.query<SocialDraftRow>('SELECT * FROM social_draft_requests WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3',[ctx.scope.workspaceId,slot.generation_request_id,slot.owner_user_id])).rows[0];if(!request||request.state!=='ready'||request.source_selection.standingPlanRef?.slotId!==slot.id||request.source_selection.standingPlanRef.planId!==slot.plan_id||request.source_selection.standingPlanRef.revision!==slot.plan_revision)throw new Error('source_changed_or_unavailable');
 const {standingPlanRef:_ref,...selection}=request.source_selection;const source=await readSocialDraftSourcesForWorker(ctx,slot.owner_user_id,selection);if(!source.ok||source.value.hash!==request.source_hash)throw new Error('source_changed_or_unavailable');
 if(slot.image){if(c.mediaScope!=='approved_pool')throw new Error('image_unavailable');const media=await readApprovedSocialMediaForOwner(ctx,slot.owner_user_id,slot.image);if(!media||media.altText!==slot.image.altText||media.byteLength!==slot.image.byteLength||media.mime!==slot.image.mime)throw new Error('image_unavailable');}
}
export async function adoptStandingPost(ctx:RepositoryContext,slot:StandingSlot):Promise<StandingSlot>{
 await checkStandingPublicationAuthority(ctx,slot);const c=await currentStandingConfiguration(ctx,slot.owner_user_id,{planId:slot.plan_id,revision:slot.plan_revision});if(!c||!slot.text)throw new Error('standing_authority_changed');
 const postId=slot.post_id??randomUUID();const image=slot.image;
 const post:PostRevision={postId,revision:slot.revision,accountId:c.binding.accountId,text:slot.text,images:image?[{assetId:image.assetId,version:image.version,altText:image.altText}]:[],publishAt:slot.publish_at.toISOString(),zone:c.timezone,state:'draft',reason:null};
 if(!slot.post_id)await ctx.db.query('INSERT INTO social_posts(workspace_id,id,owner_user_id,current_revision) VALUES($1,$2,$3,$4)',[ctx.scope.workspaceId,postId,slot.owner_user_id,slot.revision]);
 else await ctx.db.query('UPDATE social_posts SET current_revision=$3 WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,postId,slot.revision]);
 await ctx.db.query('INSERT INTO social_post_revisions(workspace_id,post_id,revision,account_id,text,images,publish_at,zone) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT DO NOTHING',[ctx.scope.workspaceId,postId,slot.revision,post.accountId,post.text,JSON.stringify(post.images),post.publishAt,post.zone]);
 const snap=await socialApprovalSnapshotForWorker(ctx,post,slot.owner_user_id);if(!snap.ok)throw new Error(snap.reason);
 await ctx.db.query(`INSERT INTO social_post_approvals(workspace_id,id,post_id,revision,account_revision,fingerprint,snapshot,approved_by,approval_kind,delegated_slot_id) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,NULL,'founder_standing_v1',$8) ON CONFLICT(workspace_id,post_id,revision) DO NOTHING`,[ctx.scope.workspaceId,randomUUID(),postId,slot.revision,c.binding.accountRevision,snap.value.fingerprint,JSON.stringify(snap.value.snapshot),slot.id]);
 await ctx.db.query("UPDATE social_post_revisions SET state='approved' WHERE workspace_id=$1 AND post_id=$2 AND revision=$3",[ctx.scope.workspaceId,postId,slot.revision]);
 const snapshot={binding:c.binding,text:slot.text,textSHA256:createHash('sha256').update(slot.text.replace(/\r\n?/gu,'\n').trim()).digest('hex'),publishAt:post.publishAt!,image};
 await ctx.db.query('UPDATE social_standing_slots SET post_id=$3,fingerprint=$4,snapshot=$5::jsonb WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,slot.id,postId,snap.value.fingerprint,JSON.stringify(snapshot)]);
 return {...slot,post_id:postId,fingerprint:snap.value.fingerprint,snapshot};
}
/** MUST run in its own committed transaction before provider click. */
export async function markStandingSubmission(ctx:RepositoryContext,slot:StandingSlot):Promise<boolean>{
 await checkStandingPublicationAuthority(ctx,slot);
 const result=await ctx.db.query("UPDATE social_standing_slots SET submission_marked_at=clock_timestamp(),state='submitting',inspection_deadline=publish_at+interval '24 hours',next_inspection_at=clock_timestamp()+interval '5 minutes' WHERE workspace_id=$1 AND id=$2 AND revision=$3 AND state='queued' AND submission_marked_at IS NULL AND fingerprint=$4 RETURNING id",[ctx.scope.workspaceId,slot.id,slot.revision,slot.fingerprint]);
 if(result.rows.length)await ctx.db.query("UPDATE social_post_revisions SET state='submitting' WHERE workspace_id=$1 AND post_id=$2 AND revision=$3",[ctx.scope.workspaceId,slot.post_id,slot.revision]);return result.rows.length===1;
}
export async function checkStandingInspectionAuthority(ctx:RepositoryContext,slot:StandingSlot):Promise<void>{
 if(ctx.scope.actor.kind!=='system'||ctx.scope.actor.component!=='worker'||!slot.submission_marked_at||!slot.snapshot||slot.snapshot.binding.adapter!=='buffer-linkedin-v1'||!slot.inspection_deadline||slot.inspection_deadline.getTime()<=Date.now())throw new Error('inspection_authority_expired');
 // Same lock order as lifecycle/pause, including retained inactive membership.
 await ctx.db.query('SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE',[ctx.scope.workspaceId,slot.owner_user_id]);
 // Stopped/departed owners do not turn previous writes into permission to recreate.
 // Only this immutable attempt can be inspected/cancelled, for at most 24h past target.
 const current=await ctx.db.query("SELECT id FROM social_standing_slots WHERE workspace_id=$1 AND id=$2 AND attempt_id=$3 AND submission_marked_at IS NOT NULL AND inspection_deadline>clock_timestamp() AND state IN ('submitting','scheduled','unknown','cancellation_pending') FOR UPDATE",[ctx.scope.workspaceId,slot.id,slot.attempt_id]);if(current.rows.length!==1)throw new Error('inspection_authority_expired');
}
/** Same-account reconnect supplies credentials only, never replacement create authority. */
export async function readStandingRecoveryBinding(ctx:RepositoryContext,slot:StandingSlot):Promise<SocialPublisherBinding|null>{
 await checkStandingInspectionAuthority(ctx,slot);const original=slot.snapshot!.binding;
 return (await ctx.db.query<SocialPublisherBinding&Record<string,unknown>>(`SELECT s.adapter,s.workspace_id AS "workspaceId",s.owner_user_id AS "ownerUserId",s.account_id AS "accountId",s.account_revision AS "accountRevision",s.id AS "credentialId",s.revision AS "credentialRevision",s.organization_id AS "organizationId",s.channel_id AS "channelId",s.external_id AS "externalId"
 FROM social_publisher_credentials s JOIN social_accounts a ON a.workspace_id=s.workspace_id AND a.id=s.account_id AND a.revision=s.account_revision JOIN workspace_memberships m ON m.workspace_id=s.workspace_id AND m.user_id=s.owner_user_id
 WHERE s.workspace_id=$1 AND s.owner_user_id=$2 AND s.account_id=$3 AND s.external_id=$4 AND s.organization_id=$5 AND s.channel_id=$6 AND s.adapter='buffer-linkedin-v1' AND a.adapter_version=s.adapter AND a.owner_user_id=s.owner_user_id AND a.external_id=s.external_id AND a.state='connected' AND s.state='usable' AND s.encrypted_state IS NOT NULL AND m.status='active' AND m.role='admin' FOR SHARE OF a,s`,[original.workspaceId,original.ownerUserId,original.accountId,original.externalId,original.organizationId,original.channelId])).rows[0]??null;
}
/** Exact remote identity/media matching is independent of lifecycle certainty. */
export function standingObservationMatches(attempt:SocialPublisherAttempt,o:SocialPublisherObservation):boolean{return attempt.binding.adapter==='buffer-linkedin-v1'&&o.accountExternalId===attempt.binding.externalId&&o.fingerprint===attempt.fingerprint&&o.imageCount===(attempt.image?1:0)&&o.mediaMatched&&(attempt.image?!!o.mediaReceiptId:o.mediaReceiptId===null)&&(!attempt.mediaReceiptId||attempt.mediaReceiptId===o.mediaReceiptId);}
export async function recordStandingObservation(ctx:RepositoryContext,slot:StandingSlot,attempt:SocialPublisherAttempt,o:SocialPublisherObservation):Promise<void>{
 const current=(await ctx.db.query<StandingSlot>('SELECT * FROM social_standing_slots WHERE workspace_id=$1 AND id=$2 AND attempt_id=$3 FOR UPDATE',[ctx.scope.workspaceId,slot.id,attempt.attemptId])).rows[0];if(!current?.submission_marked_at||current.snapshot?.binding.adapter!=='buffer-linkedin-v1')return;
 const original=current.snapshot.binding;
 if(attempt.fingerprint!==current.fingerprint||attempt.publishAt!==current.snapshot.publishAt||attempt.binding.adapter!==original.adapter||attempt.binding.workspaceId!==original.workspaceId||attempt.binding.ownerUserId!==original.ownerUserId||attempt.binding.accountId!==original.accountId||attempt.binding.organizationId!==original.organizationId||attempt.binding.channelId!==original.channelId||attempt.binding.externalId!==original.externalId||!!attempt.image!==!!current.snapshot.image)return;
 if(attempt.image&&current.snapshot.image&&(attempt.image.sha256!==current.snapshot.image.sha256||attempt.image.mime!==current.snapshot.image.mime||attempt.image.byteLength!==current.snapshot.image.byteLength))return;
 const at=Date.parse(o.observedAt);if(!Number.isFinite(at)||at>Date.now()+300000||at<current.submission_marked_at.getTime()-300000||(current.observed_at&&at<new Date(current.observed_at).getTime()))return;
 if(['published','cancelled','failed_known_not_submitted'].includes(current.state))return;
 if((current.receipt_id&&o.receiptId&&current.receipt_id!==o.receiptId)||(current.media_receipt_id&&o.mediaReceiptId&&current.media_receipt_id!==o.mediaReceiptId))return;
 const rejected=current.state==='submitting'&&o.state==='rejected'&&['provider_rejected','credential_revoked'].includes(o.reason)&&o.accountExternalId===attempt.binding.externalId&&o.fingerprint===attempt.fingerprint&&!o.receiptId&&!o.mediaReceiptId&&!current.receipt_id&&!current.media_receipt_id;
 const matched=standingObservationMatches(attempt,o)&&o.state!=='rejected'&&!!o.receiptId,state=rejected?'failed_known_not_submitted':matched?o.state:'unknown',reason=matched?(o.reason==='matched'?null:o.reason):o.reason==='matched'?'readback_incomplete':o.reason;
 let permalink:string|null=null;if(matched&&state==='published'&&o.permalink){try{const url=new URL(o.permalink);if(url.protocol==='https:'&&!url.username&&!url.password&&['linkedin.com','www.linkedin.com'].includes(url.hostname))permalink=url.toString();}catch{/* Unverified links are not shown. */}}
 await ctx.db.query(`UPDATE social_standing_slots SET state=CASE WHEN state='cancellation_pending' AND $3 IN ('scheduled','unknown') THEN state ELSE $3 END,reason=$4,receipt_id=COALESCE(receipt_id,$5),media_receipt_id=COALESCE(media_receipt_id,$6),permalink=COALESCE($7,permalink),observed_at=$8,next_inspection_at=CASE WHEN $3 IN ('published','cancelled','failed_known_not_submitted') THEN NULL WHEN state='cancellation_pending' THEN clock_timestamp()+interval '5 minutes' WHEN $3='scheduled' THEN GREATEST(publish_at,clock_timestamp()+interval '5 minutes') ELSE clock_timestamp()+interval '5 minutes' END WHERE workspace_id=$1 AND id=$2`,[ctx.scope.workspaceId,slot.id,state,reason,matched?o.receiptId:null,matched?o.mediaReceiptId:null,permalink,o.observedAt]);
 await ctx.db.query("UPDATE social_post_revisions SET state=CASE WHEN state='cancellation_pending' AND $4 IN ('scheduled','unknown') THEN state ELSE $4 END,reason=$5 WHERE workspace_id=$1 AND post_id=$2 AND revision=$3 AND state<>'published'",[ctx.scope.workspaceId,slot.post_id,slot.revision,rejected?'failed':state,reason]);
}
export interface StandingPublicationMedia {ownerUserId:string;objectKey:string;mimeType:'image/jpeg'|'image/png';sha256:string;byteLength:number}
/** Public only for an explicitly admitted Buffer attempt. Caller retains this
 * transaction through S3 read and repeats this projection before releasing bytes.
 * Workspace/attempt/hash locate authority; none is itself a credential. */
export async function readStandingPublicationMedia(db:SessionQueryable,workspaceId:string,attemptId:string,sha256:string,now=new Date()):Promise<StandingPublicationMedia|null>{
 if(!/^[a-f0-9]{64}$/u.test(sha256)||!Number.isFinite(now.getTime()))return null;
 const ctx=repositoryContext(workspaceScope(workspaceId,{kind:'system',component:'worker'}),db);
 const candidate=(await db.query<StandingSlot>('SELECT * FROM social_standing_slots WHERE workspace_id=$1 AND attempt_id=$2',[workspaceId,attemptId])).rows[0];if(!candidate)return null;
 const configuration=await currentStandingConfiguration(ctx,candidate.owner_user_id,{planId:candidate.plan_id,revision:candidate.plan_revision});if(!configuration||configuration.mediaScope!=='approved_pool')return null;
 const slot=(await db.query<StandingSlot>('SELECT * FROM social_standing_slots WHERE workspace_id=$1 AND id=$2 AND attempt_id=$3',[workspaceId,candidate.id,attemptId])).rows[0];
 if(!slot||!slot.submission_marked_at||!slot.inspection_deadline||slot.inspection_deadline.getTime()<=now.getTime()||slot.submission_marked_at.getTime()>now.getTime()||!['submitting','scheduled','published','unknown'].includes(slot.state)||!slot.image||!slot.snapshot?.image||slot.snapshot.binding.adapter!=='buffer-linkedin-v1'||slot.snapshot.binding.workspaceId!==workspaceId||slot.snapshot.binding.ownerUserId!==slot.owner_user_id||slot.image.sha256!==sha256)return null;
 const image=slot.image,snapshot=slot.snapshot.image;
 if(image.assetId!==snapshot.assetId||image.version!==snapshot.version||image.sha256!==snapshot.sha256||image.approvalRevision!==snapshot.approvalRevision||image.mime!==snapshot.mime||image.byteLength!==snapshot.byteLength||image.altText!==snapshot.altText||Object.entries(configuration.binding).some(([key,value])=>slot.snapshot!.binding[key as keyof SocialPublisherBinding]!==value))return null;
 const request=(await db.query<SocialDraftRow>("SELECT * FROM social_draft_requests WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 AND source_selection->'founderInputRefs'=$4::jsonb AND COALESCE(source_selection->'voiceGuideRef','null'::jsonb)=$5::jsonb FOR SHARE",[workspaceId,slot.generation_request_id,slot.owner_user_id,JSON.stringify(slot['input_refs']),JSON.stringify(configuration.guideRef)])).rows[0];
 if(!request||request.state!=='ready'||!request.source_selection.founderInputRefs?.length||request.source_selection.founderInputRefs.some(ref=>!configuration.inputIds.includes(ref.inputId))||request.source_selection.standingPlanRef?.slotId!==slot.id||request.source_selection.standingPlanRef.planId!==slot.plan_id||request.source_selection.standingPlanRef.revision!==slot.plan_revision)return null;
 const {standingPlanRef:_ref,...selection}=request.source_selection,source=await readSocialDraftSourcesForWorker(ctx,slot.owner_user_id,selection);
 if(!source.ok||source.value.hash!==request.source_hash)return null;
 const media=await readApprovedSocialMediaForOwner(ctx,slot.owner_user_id,image);
 if(!media||media.altText!==image.altText||media.mime!==image.mime||media.byteLength!==image.byteLength||!Number.isSafeInteger(media.byteLength)||media.byteLength<1||media.byteLength>5242880||(media.mime!=='image/jpeg'&&media.mime!=='image/png'))return null;
 return {ownerUserId:slot.owner_user_id,objectKey:media.objectKey,mimeType:media.mime,sha256:media.sha256,byteLength:media.byteLength};
}
