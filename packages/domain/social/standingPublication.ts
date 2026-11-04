import {createHash,randomUUID} from 'node:crypto';
import type {PostRevision,SocialPublisherAttempt,SocialPublisherBinding,SocialPublisherObservation} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {socialApprovalSnapshotForWorker} from './posts.ts';
import {currentStandingConfiguration} from './standingAuthority.ts';
import {readSocialDraftSourcesForWorker} from './draftSources.ts';
import {readApprovedSocialMediaForOwner} from './approvedMedia.ts';
import type {SocialDraftRow} from './drafts.ts';
export interface StandingSlot extends Record<string,unknown> {id:string;owner_user_id:string;plan_id:string;plan_revision:number;revision:number;state:string;publish_at:Date;text:string|null;image:null|{assetId:string;version:number;sha256:string;approvalRevision:number;altText:string;mime:'image/jpeg'|'image/png'};post_id:string|null;attempt_id:string;fingerprint:string|null;submission_marked_at:Date|null;receipt_id:string|null;generation_request_id:string|null;snapshot:null|{binding:SocialPublisherBinding;text:string|null;textSHA256:string;publishAt:string;image:StandingSlot['image']};inspection_deadline:Date|null}
export async function readStandingSlot(ctx:RepositoryContext,id:string):Promise<StandingSlot|null>{return (await ctx.db.query<StandingSlot>('SELECT * FROM social_standing_slots WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,id])).rows[0]??null;}
/** Separate publication authority: never extends the model dispatch deadline. */
export async function checkStandingPublicationAuthority(ctx:RepositoryContext,slot:StandingSlot,ownMarkedAttempt=false):Promise<void>{
 if(ctx.scope.actor.kind!=='system'||ctx.scope.actor.component!=='worker')throw new Error('worker_required');
 const c=await currentStandingConfiguration(ctx,slot.owner_user_id,{planId:slot.plan_id,revision:slot.plan_revision});if(!c)throw new Error('standing_authority_changed');
 const locked=(await ctx.db.query<StandingSlot>('SELECT * FROM social_standing_slots WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.scope.workspaceId,slot.id])).rows[0];if(!locked||locked.revision!==slot.revision||locked.attempt_id!==slot.attempt_id||(ownMarkedAttempt?locked.state!=='submitting'||!locked.submission_marked_at:locked.state!=='queued'||locked.submission_marked_at!==null)||locked.publish_at.getTime()<=Date.now()+300000)throw new Error('standing_slot_unavailable');
 const request=(await ctx.db.query<SocialDraftRow>('SELECT * FROM social_draft_requests WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3',[ctx.scope.workspaceId,slot.generation_request_id,slot.owner_user_id])).rows[0];if(!request||request.state!=='ready'||request.source_selection.standingPlanRef?.slotId!==slot.id||request.source_selection.standingPlanRef.planId!==slot.plan_id||request.source_selection.standingPlanRef.revision!==slot.plan_revision)throw new Error('source_changed_or_unavailable');
 const {standingPlanRef:_ref,...selection}=request.source_selection;const source=await readSocialDraftSourcesForWorker(ctx,slot.owner_user_id,selection);if(!source.ok||source.value.hash!==request.source_hash)throw new Error('source_changed_or_unavailable');
 if(slot.image){const media=await readApprovedSocialMediaForOwner(ctx,slot.owner_user_id,slot.image);if(!media||media.altText!==slot.image.altText)throw new Error('image_unavailable');}
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
 if(ctx.scope.actor.kind!=='system'||ctx.scope.actor.component!=='worker'||!slot.submission_marked_at||!slot.snapshot||!slot.inspection_deadline||slot.inspection_deadline.getTime()<=Date.now())throw new Error('inspection_authority_expired');
 // Same lock order as lifecycle/pause, including retained inactive membership.
 await ctx.db.query('SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE',[ctx.scope.workspaceId,slot.owner_user_id]);
 // Stopped/departed owners do not turn previous writes into permission to recreate.
 // Only this immutable attempt can be inspected/cancelled, for at most 24h past target.
 const current=await ctx.db.query("SELECT id FROM social_standing_slots WHERE workspace_id=$1 AND id=$2 AND attempt_id=$3 AND submission_marked_at IS NOT NULL AND inspection_deadline>clock_timestamp() AND state IN ('submitting','scheduled','unknown','cancellation_pending') FOR UPDATE",[ctx.scope.workspaceId,slot.id,slot.attempt_id]);if(current.rows.length!==1)throw new Error('inspection_authority_expired');
}
/** Same-account reconnect supplies credentials only, never replacement create authority. */
export async function readStandingRecoveryBinding(ctx:RepositoryContext,slot:StandingSlot):Promise<SocialPublisherBinding|null>{
 await checkStandingInspectionAuthority(ctx,slot);const original=slot.snapshot!.binding;
 return (await ctx.db.query<SocialPublisherBinding&Record<string,unknown>>(`SELECT s.workspace_id AS "workspaceId",s.owner_user_id AS "ownerUserId",s.account_id AS "accountId",s.account_revision AS "accountRevision",s.id AS "sessionId",s.revision AS "sessionRevision",s.external_id AS "externalId"
 FROM social_publisher_sessions s JOIN social_accounts a ON a.workspace_id=s.workspace_id AND a.id=s.account_id AND a.revision=s.account_revision JOIN workspace_memberships m ON m.workspace_id=s.workspace_id AND m.user_id=s.owner_user_id
 WHERE s.workspace_id=$1 AND s.owner_user_id=$2 AND s.account_id=$3 AND s.external_id=$4 AND a.owner_user_id=s.owner_user_id AND a.external_id=s.external_id AND a.state='connected' AND s.state='usable' AND s.expires_at>clock_timestamp() AND m.status='active' AND m.role='admin' FOR SHARE OF a,s`,[original.workspaceId,original.ownerUserId,original.accountId,original.externalId])).rows[0]??null;
}
export function standingObservationMatches(attempt:SocialPublisherAttempt,o:SocialPublisherObservation):boolean{return o.accountExternalId===attempt.binding.externalId&&o.fingerprint===attempt.fingerprint&&o.imageCount===(attempt.image?1:0)&&o.loadedPreview&&o.reason==='matched';}
export async function recordStandingObservation(ctx:RepositoryContext,slot:StandingSlot,attempt:SocialPublisherAttempt,o:SocialPublisherObservation):Promise<void>{
 const matched=standingObservationMatches(attempt,o),state=matched?o.state:'unknown';
 await ctx.db.query(`UPDATE social_standing_slots SET state=CASE WHEN state='published' THEN state WHEN state='cancellation_pending' AND $3 IN ('scheduled','unknown') THEN state ELSE $3 END,reason=$4,receipt_id=COALESCE($5,receipt_id),permalink=CASE WHEN $3='published' THEN $6 ELSE permalink END,next_inspection_at=CASE WHEN state='cancellation_pending' THEN clock_timestamp()+interval '5 minutes' WHEN $3='scheduled' THEN GREATEST(publish_at,clock_timestamp()+interval '5 minutes') ELSE clock_timestamp()+interval '5 minutes' END WHERE workspace_id=$1 AND id=$2 AND submission_marked_at IS NOT NULL`,[ctx.scope.workspaceId,slot.id,state,matched?null:o.reason,o.receiptId,matched?o.permalink:null]);
 await ctx.db.query("UPDATE social_post_revisions SET state=CASE WHEN state='cancellation_pending' AND $4 IN ('scheduled','unknown') THEN state ELSE $4 END,reason=$5 WHERE workspace_id=$1 AND post_id=$2 AND revision=$3 AND state<>'published'",[ctx.scope.workspaceId,slot.post_id,slot.revision,state,matched?null:o.reason]);
}
