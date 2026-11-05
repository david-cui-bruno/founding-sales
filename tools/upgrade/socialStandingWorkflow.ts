import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {socialDraftViewSchema,type SocialDraftRequest,type SocialPublisherAttempt,type SocialPublisherObservation,type SocialStandingPlanSave} from '@fss/contracts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {repositoryContext,workspaceScope,type RepositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {saveSocialFounderInput} from '@fss/domain/social/founderInputs.ts';
import {requestSocialDrafts,readSocialDraftRequest} from '@fss/domain/social/drafts.ts';
import {socialDraftView} from '@fss/domain/social/draftWorkspace.ts';
import {saveSocialPrivateDraft} from '@fss/domain/social/privateDrafts.ts';
import {readSocialVoicePreferences} from '@fss/domain/social/voicePreferences.ts';
import {finishSocialCalibration,readSocialCalibration} from '@fss/domain/social/calibration.ts';
import {editSocialStandingSlot,pauseSocialStandingPlan,readSocialStandingActivity,saveSocialStandingPlan} from '@fss/domain/social/standingPlan.ts';
import {admitSocialStandingSlots,prepareSocialStandingSlot,type StandingGenerationAdmission} from '@fss/domain/social/standingSlots.ts';
import {createStandingDraftRequest} from '../../apps/worker/src/social/standingDraftRequest.ts';
import {adoptStandingPost,markStandingSubmission,readStandingSlot,recordStandingObservation,checkStandingInspectionAuthority} from '@fss/domain/social/standingPublication.ts';

/** Disposable upgrade proof only: real runtime/domain authority and lifecycle,
 * with fictional account/key verification and model/provider outputs, never I/O. */
export async function runSocialStandingUpgradeWorkflow(owner:RepositoryContext):Promise<string>{
 const db=owner.db,w=owner.scope.workspaceId,actor=owner.scope.actor;
 assert(actor.kind==='user');assert.equal((await db.query<{role:string}>('SELECT current_user AS role')).rows[0]?.role,'app_runtime');
 assert((await db.query<{name:string}>('SELECT current_database() AS name')).rows[0]?.name.startsWith('fss_upgrade_'));
 const worker=repositoryContext(workspaceScope(w,{kind:'system',component:'worker'}),db),u=actor.userId;
 const text='I built a small local upgrade fixture today. Keeping its inputs explicit made the lifecycle easier to explain.';
 const concepts=JSON.stringify([{theme:'build',factRefs:[],variants:[{platform:'linkedin',text}]}]);
 const inputIds:string[]=[];
 for(let i=0;i<3;i++){
  const saved=await withTransaction(db,()=>saveSocialFounderInput(owner,{operation:'create',bullets:`${text} Fixture material ${i+1}.`,context:'Fictional owned upgrade material; no customer or shipped-product claims.',experienceDate:null,publicSafe:true},async()=>true));
  assert(saved.ok);inputIds.push(saved.value.inputId);
 }
 // Do not replace an accepted calibration or manufacture acceptance from legacy
 // settings. If absent, complete the actual three-format private review lifecycle.
 const accepted=await withTransaction(db,()=>readSocialCalibration(owner,async()=>true));
 const guide=await withTransaction(db,()=>readSocialVoicePreferences(owner,async()=>true));
 const guideRef=guide?.state==='available'?{guideId:guide.guideId,revision:guide.revision}:null;
 let calibration=accepted.completion;
 if(!calibration){
  const examples:{draftId:string;revision:number}[]=[];
  for(const founderFormat of ['story','opinion','technical'] as const){
   const selection:SocialDraftRequest={mode:'linkedin_founder',sourceRefs:[],factBlocks:[],founderInputRefs:[{inputId:inputIds[0]!,revision:1}],founderFormat,founderInputProcessingScope:'bedrock_haiku_founder_inputs_v1',...(guideRef?{voiceGuideRef:guideRef,voiceGuideProcessingScope:'bedrock_haiku_private_draft_v1' as const}:{})};
   const requested=await withTransaction(db,()=>requestSocialDrafts(owner,selection,async()=>true));assert(requested.ok);
   await db.query("UPDATE social_draft_requests SET state='ready',concepts=$3::jsonb WHERE workspace_id=$1 AND id=$2",[w,requested.value.requestId,concepts]);
   const saved=await withTransaction(db,async()=>{
    const row=await readSocialDraftRequest(owner,requested.value.requestId);assert(row);
    const request=socialDraftViewSchema.parse(socialDraftView(row));
    const selectionSHA256=createHash('sha256').update(JSON.stringify({request,conceptIndex:0,variantIndex:0})).digest('hex');
    return saveSocialPrivateDraft(owner,{operation:'create',kind:'post',text,origin:{kind:'suggestion',requestId:row.id,conceptIndex:0,variantIndex:0,selectionSHA256}},async()=>true);
   });assert(saved.ok);examples.push(saved.value);
  }
  const finished=await withTransaction(db,()=>finishSocialCalibration(owner,{examples,expectedGuide:guideRef},async()=>true));assert(finished.ok);calibration=finished.value;
 }
 const accountId=randomUUID(),credentialId=randomUUID(),externalId=`upgrade-fictional-${randomUUID()}`;
 // Verification and encrypted credential bytes are controlled local authority
 // fixtures, not a Buffer connection, a usable key, or production acceptance.
 await withTransaction(db,async()=>{
  await db.query("INSERT INTO social_accounts(workspace_id,id,owner_user_id,platform,external_id,display_name,account_kind,state,adapter_version,verified_at,max_schedule_days) VALUES($1,$2,$3,'linkedin',$4,'Fictional upgrade profile','profile','connected','buffer-linkedin-v1',clock_timestamp(),30)",[w,accountId,u,externalId]);
  await db.query("INSERT INTO social_publisher_credentials(workspace_id,id,owner_user_id,account_id,account_revision,adapter,organization_id,channel_id,external_id,encrypted_state,state,verified_at) VALUES($1,$2,$3,$4,1,'buffer-linkedin-v1','111111111111111111111111','222222222222222222222222',$5,$6,'usable',clock_timestamp())",[w,credentialId,u,accountId,externalId,Buffer.alloc(29)]);
 });
 const target=new Date();target.setUTCDate(target.getUTCDate()+1);target.setUTCHours(12,0,0,0);
 const at=new Date(target.getTime()-7200000);
 const configuration:SocialStandingPlanSave={expectedRevision:0,binding:{adapter:'buffer-linkedin-v1',workspaceId:w,ownerUserId:u,accountId,accountRevision:1,credentialId,credentialRevision:1,organizationId:'111111111111111111111111',channelId:'222222222222222222222222',externalId},guideRef,calibrationId:calibration.calibrationId,inputIds,mediaScope:'none',timezone:'UTC',cadence:[12,13,14].map(hour=>({weekday:target.getUTCDay()||7,time:`${hour}:00`})),scheduledGenerationGrant:'bedrock_haiku_founder_scheduled_v1',publicationGrant:'linkedin_personal_standing_v1',cancelRemoteOnPause:true};
 const saved=await withTransaction(db,()=>saveSocialStandingPlan(owner,configuration));assert(saved.ok);const plan=saved.value;
 await withTransaction(db,()=>admitSocialStandingSlots(worker,u,plan.planId,plan.revision,at));
 const admitted=(await db.query<{id:string}>('SELECT id FROM social_standing_slots WHERE workspace_id=$1 AND owner_user_id=$2 AND plan_id=$3 ORDER BY ordinal',[w,u,plan.planId])).rows;assert.equal(admitted.length,3);const slotId=admitted[0]!.id;
 // Use production preparation and generation reservation/binding. Only paid
 // output is supplied locally; selection, hash, lineage and readiness stay real.
 const admitGeneration:StandingGenerationAdmission=async(ctx,ownerId,ref,selection,deadline)=>{
  // created_at defaults to transaction time, not wall time. Keep the injected
  // admission deadline within that same schema-bound 30-minute request window.
  const boundary=(await db.query<{deadline:Date}>("SELECT now()+interval '30 minutes' AS deadline")).rows[0]!.deadline;
  const requested=await createStandingDraftRequest(ctx,ownerId,ref,selection,new Date(Math.min(deadline.getTime(),boundary.getTime())));
  if(!requested.ok)return requested;
  await db.query("UPDATE social_draft_requests SET state='ready',concepts=$3::jsonb WHERE workspace_id=$1 AND id=$2",[w,requested.value.requestId,concepts]);
  return requested;
 };
 await withTransaction(db,()=>prepareSocialStandingSlot(worker,slotId,admitGeneration));
 await withTransaction(db,()=>prepareSocialStandingSlot(worker,slotId,admitGeneration));
 const queued=await readStandingSlot(worker,slotId);assert(queued);assert.equal(queued.state,'queued');
 const originalLineage=(await db.query<{input_id:string;slot_id:string}>('SELECT input_id,slot_id FROM social_standing_lineage WHERE workspace_id=$1 AND owner_user_id=$2 AND slot_id=ANY($3::uuid[]) ORDER BY input_id',[w,u,admitted.map(slot=>slot.id)])).rows;
 assert.equal(originalLineage.length,3);assert.deepEqual(new Set(originalLineage.map(row=>row.input_id)),new Set(inputIds));
 const adopted=await withTransaction(db,()=>adoptStandingPost(worker,queued));
 assert.equal(await withTransaction(db,()=>markStandingSubmission(worker,adopted)),true);
 // A fresh read after COMMIT proves durable custody before any simulated result.
 const marked=await readStandingSlot(worker,slotId);assert(marked?.submission_marked_at);assert(marked.snapshot);assert(marked.fingerprint);assert(marked.post_id);assert.equal(marked.state,'submitting');
 const attempt:SocialPublisherAttempt={binding:marked.snapshot.binding,attemptId:marked.attempt_id,fingerprint:marked.fingerprint,text:marked.text,textSHA256:marked.snapshot.textSHA256,publishAt:marked.snapshot.publishAt,submittedAt:marked.submission_marked_at.toISOString(),mediaReceiptId:null,image:null};
 const observation:SocialPublisherObservation={state:'scheduled',receiptId:'333333333333333333333333',mediaReceiptId:null,permalink:null,observedAt:new Date().toISOString(),accountExternalId:attempt.binding.externalId,fingerprint:attempt.fingerprint,imageCount:0,mediaMatched:true,reason:'matched'};
 const record=(change:Partial<SocialPublisherObservation>)=>withTransaction(db,()=>recordStandingObservation(worker,marked,attempt,{...observation,...change}));
 await record({});
 const scheduled=await readStandingSlot(worker,slotId);assert(scheduled);assert.equal(scheduled.state,'scheduled');assert.equal(scheduled.receipt_id,observation.receiptId);
 await record({receiptId:'444444444444444444444444',state:'published'});
 assert.deepEqual(await readStandingSlot(worker,slotId),scheduled,'a conflicting receipt cannot rewrite custody or declare publication');
 assert.deepEqual(await withTransaction(db,()=>editSocialStandingSlot(owner,{slotId,expectedRevision:marked.revision,text:'Replacement create is forbidden.'})),{ok:false,reason:'cancel_before_edit'});
 await assert.rejects(withTransaction(db,()=>markStandingSubmission(worker,marked)),/standing_slot_unavailable/u,'the committed attempt cannot be submitted again');
 await withTransaction(db,()=>admitSocialStandingSlots(worker,u,plan.planId,plan.revision,at));
 assert.deepEqual((await db.query<{id:string}>('SELECT id FROM social_standing_slots WHERE workspace_id=$1 AND owner_user_id=$2 AND plan_id=$3 ORDER BY ordinal',[w,u,plan.planId])).rows,admitted,'readmission cannot mint replacement slots');
 assert.deepEqual((await db.query<{input_id:string;slot_id:string}>('SELECT input_id,slot_id FROM social_standing_lineage WHERE workspace_id=$1 AND owner_user_id=$2 AND slot_id=ANY($3::uuid[]) ORDER BY input_id',[w,u,admitted.map(slot=>slot.id)])).rows,originalLineage,'consumed source lineage is retained, not rebound on readmission');
 const paused=await withTransaction(db,()=>pauseSocialStandingPlan(owner,{planId:plan.planId,expectedRevision:plan.revision}));assert(paused.ok);
 assert.equal((await readStandingSlot(worker,slotId))?.state,'cancellation_pending','pause requests cancellation, never claims remote success');
 await withTransaction(db,()=>checkStandingInspectionAuthority(worker,marked));
 await record({observedAt:new Date().toISOString()});assert.equal((await readStandingSlot(worker,slotId))?.state,'cancellation_pending','scheduled readback cannot erase pending cancellation');
 await record({state:'cancelled',observedAt:new Date().toISOString()});
 const cancelled=await readStandingSlot(worker,slotId);assert(cancelled);assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.receipt_id,observation.receiptId);assert.equal(cancelled.attempt_id,marked.attempt_id);assert.deepEqual(cancelled.submission_marked_at,marked.submission_marked_at);assert.deepEqual(cancelled.snapshot,marked.snapshot);
 assert.equal((await withTransaction(db,()=>readSocialStandingActivity(owner))).items.find(item=>item.slotId===slotId)?.state,'cancelled');
 if(accepted.completion)assert.deepEqual((await withTransaction(db,()=>readSocialCalibration(owner,async()=>true))).completion,accepted.completion,'existing accepted calibration is never replaced');
 return 'explicit fictional Buffer plan admitted three lineage-bound slots; real preparation/adoption committed one immutable attempt before controlled scheduled receipt, rejected conflicting receipt/edit/repeat submission and replacement admission, pause retained cancellation-pending until exact observed cancellation with original receipt/mark/snapshot; zero external calls';
}
