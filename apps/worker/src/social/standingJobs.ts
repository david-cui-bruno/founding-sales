import type {SocialPublisherPort,SocialPublisherAttempt} from '@fss/contracts';
import {PublisherRefusal} from '@fss/social-publisher';
import {invalidateSocialPublisherCredential} from '@fss/domain/social/standingAuthority.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import type {JobHandler} from '@fss/domain/jobs/handlerRegistry.ts';
import type {JobSpecification} from '@fss/domain/jobs/jobStore.ts';
import {admitSocialStandingSlots,prepareSocialStandingSlot,type StandingGenerationAdmission} from '@fss/domain/social/standingSlots.ts';
import {readStandingSlot,adoptStandingPost,checkStandingPublicationAuthority,markStandingSubmission,checkStandingInspectionAuthority,readStandingRecoveryBinding,recordStandingObservation} from '@fss/domain/social/standingPublication.ts';
import type {DueWorkSource} from '../scheduler/schedulerPass.ts';
export interface StandingWorkerDeps {publisher:SocialPublisherPort|null;admitGeneration:StandingGenerationAdmission}
export function socialStandingSource(enabled:boolean):DueWorkSource{return {name:'social-standing',find:async(session,at)=>{
 const workspaces=(await session.query<{workspace_id:string}>("SELECT workspace_id FROM social_standing_plans WHERE state='active' UNION SELECT workspace_id FROM social_standing_slots WHERE submission_marked_at IS NOT NULL AND state IN ('submitting','scheduled','unknown','cancellation_pending') AND inspection_deadline>clock_timestamp() ORDER BY workspace_id LIMIT 25")).rows;
 const jobs:JobSpecification[]=[];
 for(const w of workspaces){
  const ctx=repositoryContext(workspaceScope(w.workspace_id,{kind:'system',component:'scheduler'}),session);
  if(enabled){const plans=(await session.query<{id:string;owner_user_id:string;revision:number}>("SELECT id,owner_user_id,revision FROM social_standing_plans WHERE workspace_id=$1 AND state='active' ORDER BY id LIMIT 25",[w.workspace_id])).rows;for(const p of plans)await admitSocialStandingSlots(ctx,p.owner_user_id,p.id,p.revision,new Date(at));}
  // Missed unsubmitted windows are terminal: restart never creates a catch-up burst.
  await session.query("UPDATE social_standing_slots SET state='skipped',reason='missed_window',text=NULL,image=NULL,snapshot=NULL WHERE workspace_id=$1 AND submission_marked_at IS NULL AND state IN ('preparing','queued','held') AND publish_at<=clock_timestamp()+interval '5 minutes'",[w.workspace_id]);
  const rows=(await session.query<{id:string}>(`SELECT id FROM social_standing_slots WHERE workspace_id=$1 AND (($2 AND state IN ('preparing','queued') AND publish_at>clock_timestamp()+interval '5 minutes') OR (submission_marked_at IS NOT NULL AND state IN ('submitting','scheduled','unknown','cancellation_pending') AND next_inspection_at<=clock_timestamp() AND inspection_deadline>clock_timestamp())) ORDER BY submission_marked_at NULLS LAST,publish_at,id LIMIT 25`,[w.workspace_id,enabled])).rows;
  for(const s of rows)jobs.push({workspaceId:w.workspace_id,kind:'social.standing',idempotencyKey:`social-standing:${s.id}:${at.slice(0,16)}`,payload:{slotId:s.id},maxAttempts:1});
 }return jobs;
}};}
export function socialStandingHandler(deps:StandingWorkerDeps):JobHandler{return {kind:'social.standing',protection:'outbound_fence',maxAttempts:1,leaseSeconds:300,handle:async input=>{
 const id=input.job.payload['slotId'];if(typeof id!=='string')return;
 const ctx=repositoryContext(input.scope,input.session),db=input.session;
 let slot=await readStandingSlot(ctx,id);if(!slot)return;
 if(slot.state==='preparing'){await withTransaction(db,()=>prepareSocialStandingSlot(ctx,id,deps.admitGeneration));slot=await readStandingSlot(ctx,id);if(!slot||slot.state!=='queued')return;}
 if(!deps.publisher){await db.query("UPDATE social_standing_slots SET reason='publisher_unavailable' WHERE workspace_id=$1 AND id=$2",[input.scope.workspaceId,id]);return;}
 const publisher=deps.publisher;
 if(!slot.submission_marked_at){
  try{slot=await withTransaction(db,()=>adoptStandingPost(ctx,slot!));}catch{await db.query("UPDATE social_standing_slots SET state='held',reason='source_or_authority_changed',text=NULL,snapshot=NULL WHERE workspace_id=$1 AND id=$2 AND submission_marked_at IS NULL AND state='queued' AND revision=$3",[input.scope.workspaceId,id,slot.revision]);return;}
 }
 const snapshot=slot.snapshot;if(!snapshot||!slot.fingerprint||snapshot.binding.adapter!=='buffer-linkedin-v1')return;
 const image:SocialPublisherAttempt['image']=snapshot.image?{mime:snapshot.image.mime,sha256:snapshot.image.sha256,altText:slot.submission_marked_at?'':snapshot.image.altText,byteLength:snapshot.image.byteLength}:null;
 const attempt:SocialPublisherAttempt={binding:snapshot.binding,attemptId:slot.attempt_id,fingerprint:slot.fingerprint,text:slot.submission_marked_at?null:snapshot.text,textSHA256:snapshot.textSHA256,publishAt:snapshot.publishAt,submittedAt:slot.submission_marked_at?.toISOString()??null,mediaReceiptId:slot.media_receipt_id??null,image};
 if(slot.submission_marked_at){
  const retained=slot;
  const result=await withTransaction(db,async()=>{const authority=()=>checkStandingInspectionAuthority(ctx,retained);await authority();const binding=await readStandingRecoveryBinding(ctx,retained),recovery={...attempt,binding:binding??attempt.binding};const observation=retained.state==='cancellation_pending'&&retained.receipt_id?await publisher.cancel(recovery,retained.receipt_id,authority):await publisher.inspect(recovery,retained.receipt_id,authority);await recordStandingObservation(ctx,retained,recovery,observation);return {binding:recovery.binding,revoked:observation.reason==='credential_revoked'};});
  if(result.revoked)await invalidateSocialPublisherCredential(ctx,result.binding);return;
 }
 const unsubmitted=slot;
 let inTransaction=false,marked=false;
 const begin=async()=>{if(!inTransaction){await db.query('BEGIN');inTransaction=true;}};
 const authority=async()=>{await begin();await checkStandingPublicationAuthority(ctx,unsubmitted,marked);};
 try{
  await authority();await publisher.prepare(attempt,authority);
  const observation=await publisher.submit(attempt,authority,async()=>{
   const allowed=await markStandingSubmission(ctx,unsubmitted);if(!allowed)return false;
   await db.query('COMMIT');inTransaction=false;marked=true;
   // Reacquire current owner/source locks after the committed no-repeat marker.
   // Retain them through provider egress so a committed pause orders before it.
   await authority();return true;
  });
  await begin();await recordStandingObservation(ctx,unsubmitted,attempt,observation);await db.query('COMMIT');inTransaction=false;
  if(observation.reason==='credential_revoked')await invalidateSocialPublisherCredential(ctx,attempt.binding);
 }catch(error){
  if(inTransaction){await db.query('ROLLBACK');inTransaction=false;}
  await db.query("UPDATE social_standing_slots SET state=CASE WHEN submission_marked_at IS NULL THEN 'failed_known_not_submitted' ELSE 'unknown' END,reason=CASE WHEN submission_marked_at IS NULL THEN 'preparation_refused' ELSE 'inspection_required' END,next_inspection_at=clock_timestamp()+interval '5 minutes' WHERE workspace_id=$1 AND id=$2 AND revision=$3 AND ((NOT $4::boolean AND submission_marked_at IS NULL AND state='queued') OR ($4::boolean AND submission_marked_at IS NOT NULL AND state='submitting'))",[input.scope.workspaceId,id,unsubmitted.revision,marked]);
  if(error instanceof PublisherRefusal&&error.reason==='credential_revoked')await invalidateSocialPublisherCredential(ctx,attempt.binding);
 }
}};}
