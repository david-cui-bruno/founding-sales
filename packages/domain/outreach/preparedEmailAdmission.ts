import type {EmailCampaignAdmission} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {firstSuppressed} from '../suppression/effective.ts';
import {lockDiscoveryReviewSources} from '../sourcing/discoveryReviewVisibility.ts';
import {listPreparedEmailCandidates} from '../sourcing/preparedEmailRead.ts';
import {enrollContact} from '../sequences/enrollments.ts';
import {admitEmailCandidate} from './emailAdmission.ts';
import {createOutreachPlan} from './plans.ts';
import {assessEmailCandidate} from './selection.ts';
import type {PreparedEmailTarget} from './emailCampaignSource.ts';
import {admissionStop,campaignAdmissionCounts,campaignCapacityAvailable,lockEmailCampaignAdmissionGates} from './emailCampaignAdmission.ts';
import {campaignAuthorityCurrent,campaignCandidateProvenance,campaignDatabaseNow,type EmailCampaignRow} from './emailCampaignAuthority.ts';
import {emailVerificationDecides,emailVerificationOutcome,latestEmailVerification,recordEmailVerification,type EmailVerifier} from './emailVerification.ts';
type Result={ok:true;value:EmailCampaignAdmission}|{ok:false;reason:string};

/** ADR0035. One own-site prepared company into one approved campaign, composed from the same owners as a research Firm: campaign,
 * email assessment/contact/route, outreach plan, enrollment and the cap history row. The Firm is created here and is always new.
 * Lock order: source lifecycle, send gate, Today, sourcing identity, campaign, then candidate and run. A confirmed refusal rolls back
 * only this admission; an unknown failure propagates. */
export async function admitPreparedCompanyToCampaign(ctx:RepositoryContext,campaignId:string,target:PreparedEmailTarget):Promise<Result>{
 await lockDiscoveryReviewSources(ctx);
 await lockEmailCampaignAdmissionGates(ctx);
 const campaign=(await ctx.db.query<EmailCampaignRow>('SELECT * FROM outreach_email_campaigns WHERE workspace_id=$1 AND id=$2 AND revoked_at IS NULL FOR UPDATE',[ctx.scope.workspaceId,campaignId])).rows[0];
 if(!campaign||!await campaignAuthorityCurrent(ctx,campaign,target))return {ok:false,reason:'campaign_authority_unavailable'};
 await ctx.db.query('SAVEPOINT email_campaign_prepared_admission');
 try{
  const result=await admit(ctx,campaign,target);
  if(!result.ok)await ctx.db.query('ROLLBACK TO SAVEPOINT email_campaign_prepared_admission');
  await ctx.db.query('RELEASE SAVEPOINT email_campaign_prepared_admission');return result;
 }catch(error){await ctx.db.query('ROLLBACK TO SAVEPOINT email_campaign_prepared_admission');await ctx.db.query('RELEASE SAVEPOINT email_campaign_prepared_admission');throw error;}
}
async function admit(ctx:RepositoryContext,campaign:EmailCampaignRow,target:PreparedEmailTarget):Promise<Result>{
 const w=ctx.scope.workspaceId;
 if((await ctx.db.query('SELECT 1 FROM outreach_email_campaign_admissions WHERE workspace_id=$1 AND candidate_id=$2',[w,target.candidateId])).rows.length)return {ok:false,reason:'already_admitted'};
 const counts=await campaignAdmissionCounts(ctx,campaign);if(!campaignCapacityAvailable(campaign,counts.total,counts.daily))return {ok:false,reason:'campaign_limit'};
 await ctx.db.query('SELECT id FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,target.candidateId]);
 const run=(await ctx.db.query<{id:string}>('SELECT id FROM sourcing_qualification_runs WHERE workspace_id=$1 AND candidate_id=$2 ORDER BY requested_at DESC,id DESC LIMIT 1',[w,target.candidateId])).rows[0];
 if(!run||run.id!==target.runId)return {ok:false,reason:'evidence_unavailable'};
 await ctx.db.query('SELECT id FROM sourcing_qualification_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,run.id]);
 const input={campaignId:campaign.id,candidateId:target.candidateId,qualificationRunId:run.id};
 if(!await campaignCandidateProvenance(ctx,input,target))return {ok:false,reason:'campaign_source_changed'};
 const admitted=await admitEmailCandidate(ctx,{...input,expectedRevision:target.candidateRevision,expectedOwnerUserId:campaign.owner_user_id,reviewed:false},target);if(!admitted.ok)return admitted;
 const firmId=admitted.value.firmId,stop=await admissionStop(ctx,firmId,campaign);if(stop)return {ok:false,reason:stop};
 const plan=await createOutreachPlan(ctx,{firmId,contactId:admitted.value.contactId,expectedOwnerUserId:campaign.owner_user_id,mailboxId:campaign.mailbox_id,lane:'email_first',qualificationRunId:run.id},campaign.id,target);if(!plan.ok)return plan;
 const assessment=await assessEmailCandidate(ctx,input,target);if(!assessment.ok||assessment.value.reviewRequired||assessment.value.firmId!==firmId)return {ok:false,reason:'source_changed'};
 const enrolled=await enrollContact(ctx,{originKind:'prospecting',sequenceVersionId:campaign.sequence_version_id,subject:{kind:'outreach',outreachPlanId:plan.value.id},firmId,contactId:admitted.value.contactId,assignedUserId:campaign.owner_user_id});if(!enrolled.ok)return enrolled;
 const finalStop=await admissionStop(ctx,firmId,campaign,enrolled.value.enrollmentId);if(finalStop)return {ok:false,reason:finalStop};
 if(await firstSuppressed(ctx,[{scope:'firm',canonicalKey:firmId},{scope:'handle',canonicalKey:assessment.value.route.address}],'email'))return {ok:false,reason:'email_or_firm_stopped'};
 if(!await campaignCandidateProvenance(ctx,input,target))return {ok:false,reason:'authority_changed'};
 const row=(await ctx.db.query<{admitted_at:Date}>(`INSERT INTO outreach_email_campaign_admissions(workspace_id,campaign_id,firm_id,contact_id,route_id,plan_id,enrollment_id,candidate_id,qualification_run_id,source_kind,candidate_revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'prepared_capture',$10) RETURNING admitted_at`,[w,campaign.id,firmId,admitted.value.contactId,admitted.value.routeId,plan.value.id,enrolled.value.enrollmentId,target.candidateId,run.id,target.candidateRevision])).rows[0]!;
 if(!await campaignAuthorityCurrent(ctx,campaign,target))return {ok:false,reason:'authority_changed'};
 const finalProof=await campaignCandidateProvenance(ctx,input,target);
 if(!finalProof||finalProof.route.address!==assessment.value.route.address||finalProof.route.sourceObservationId!==assessment.value.route.sourceObservationId||finalProof.route.blockId!==assessment.value.route.blockId)return {ok:false,reason:'campaign_source_changed'};
 return {ok:true,value:{campaignId:campaign.id,firmId,contactId:admitted.value.contactId,routeId:admitted.value.routeId,planId:plan.value.id,enrollmentId:enrolled.value.enrollmentId,candidateId:target.candidateId,qualificationRunId:run.id,admittedAt:row.admitted_at.toISOString()}};
}

export interface PreparedEmailPass {admitted:number;checked:number;failed:number}
/** The worker's pass for a workspace: for each unrevoked, unexpired campaign with room, take prepared companies in the prepared list's
 * order (one per host), check each published address once (syntax, real MX, no consumer/disposable domain; no SMTP, no third party)
 * and admit the valid ones. A resolver error records nothing and the address is asked again next pass. The check runs before any
 * admission lock, and a recorded answer is never asked again inside its window. */
export async function runPreparedEmailAdmission(ctx:RepositoryContext,deps:{verifier:EmailVerifier}):Promise<PreparedEmailPass>{
 const pass:PreparedEmailPass={admitted:0,checked:0,failed:0};
 const campaigns=(await ctx.db.query<EmailCampaignRow>('SELECT * FROM outreach_email_campaigns WHERE workspace_id=$1 AND revoked_at IS NULL AND expires_at>clock_timestamp() ORDER BY approved_at,id',[ctx.scope.workspaceId])).rows;
 for(const campaign of campaigns){
  const counts=await campaignAdmissionCounts(ctx,campaign),room=Math.min(campaign.max_enrollments-counts.total,campaign.daily_admission_limit-counts.daily);
  if(room<=0)continue;
  const skip=new Set((await ctx.db.query<{candidate_id:string}>('SELECT candidate_id FROM outreach_email_campaign_admissions WHERE workspace_id=$1',[ctx.scope.workspaceId])).rows.map(row=>row.candidate_id));
  let admitted=0;
  for(const company of await listPreparedEmailCandidates(ctx,{limit:room+10,regions:campaign.regions,skip})){
   if(admitted>=room)break;
   const now=Date.parse(await campaignDatabaseNow(ctx));
   let recorded=await latestEmailVerification(ctx,company.route.address);
   if(recorded&&!emailVerificationDecides(recorded,now))recorded=null;
   if(!recorded){
    const result=await deps.verifier.verify(company.route.address);
    if(!result)continue;
    await recordEmailVerification(ctx,company.route.address,result);pass.checked++;
    recorded={result,outcome:emailVerificationOutcome(result),checkedAt:new Date(now)};
   }
   if(recorded.outcome!=='ok')continue;
   try{
    const result=await admitPreparedCompanyToCampaign(ctx,campaign.id,{kind:'prepared_capture',candidateId:company.candidateId,candidateRevision:company.candidateRevision,runId:company.runId,address:company.route.address});
    if(result.ok){admitted++;pass.admitted++;}
   }catch{pass.failed++;}
  }
 }
 return pass;
}
