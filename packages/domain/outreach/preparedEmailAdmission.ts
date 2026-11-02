import type {EmailCampaignAdmission} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {withTransaction} from '../db/queryable.ts';
import {firstSuppressed} from '../suppression/effective.ts';
import {lockDiscoveryReviewSources} from '../sourcing/discoveryReviewVisibility.ts';
import {enrollContact} from '../sequences/enrollments.ts';
import {admitEmailCandidate} from './emailAdmission.ts';
import {createOutreachPlan} from './plans.ts';
import {assessEmailCandidate} from './selection.ts';
import {admittedCandidateIds,listPreparedEmailChoices} from './preparedEmailSelection.ts';
import type {PreparedEmailTarget} from './emailCampaignSource.ts';
import {admissionStop,campaignAdmissionCounts,campaignCapacityAvailable,lockEmailCampaignAdmissionGates} from './emailCampaignAdmission.ts';
import {campaignAuthorityCurrent,campaignCandidateProvenance,campaignDatabaseNow,type EmailCampaignRow} from './emailCampaignAuthority.ts';
import {emailVerificationDecides,emailVerificationOutcome,latestEmailVerification,recordEmailVerification,type EmailVerificationProvider,type EmailVerifier} from './emailVerification.ts';
import {checkPublishedAddress,paidCheckTimeAvailable,type AddressVerifier} from './addressGuess.ts';
type Result={ok:true;value:EmailCampaignAdmission}|{ok:false;reason:string};

/** ADR0035/0036. One own-site prepared company, with its provider-found named decision-maker, into one approved campaign, composed from the same owners as a research Firm: campaign,
 * email assessment/contact/route, outreach plan, enrollment and the cap history row. The Firm is created here and is always new.
 * Lock order: source lifecycle, send gate, Today, sourcing identity, campaign, then candidate and run. A confirmed refusal rolls back
 * only this admission; an unknown failure propagates. The caller owns the transaction (the locks are transaction-level). */
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
 // A campaign with an opening policy (even a revoked one) holds every first email whose source is not research; refuse instead of admitting into a hold.
 if((await ctx.db.query('SELECT 1 FROM outreach_campaign_opening_policies WHERE workspace_id=$1 AND campaign_id=$2',[w,campaign.id])).rows.length)return {ok:false,reason:'opening_policy_configured'};
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
/** At most this many lists of room+10 per campaign per pass; each list skips everything already tried this pass. */
const ROUNDS=8;
/** The worker's pass for a workspace (ADR0036): for each unrevoked, unexpired campaign without an opening policy and with room, take prepared
 * companies that have a current found provider person (a named decision-maker with a verified own-domain personal address) in the prepared
 * list's order (one per host), check the person's address once (syntax, real MX, no consumer/disposable domain; no SMTP, no third party) and
 * admit the valid ones. A resolver error records nothing and the address is asked again next pass. A recorded invalid answer, an existing
 * Firm with the company's name or website host, an unresolvable time zone and a stopped address (the refusals admission would repeat on every
 * pass) are excluded before the list's limit, within the bounded 400-record scan, and what was tried this pass is skipped by the next list, so
 * refused or invalid companies never starve later valid ones. The check and reads run in autocommit before any admission lock; each
 * admission is its own transaction (the caller must not already hold one), so a check commits whatever an admission does.
 * ADR0038: with a paid verifier, a PUBLISHED address that passed the free check is also asked of it once (a custody row and a credit, under the daily cap):
 * invalid and disposable are recorded as an invalid check and dropped; ok, catch_all and unknown admit (the company published it). No verifier, no cap room or a failed
 * check leaves the free check alone deciding, and a guessed address is never asked again (the paid check already answered ok). */
export async function runPreparedEmailAdmission(ctx:RepositoryContext,deps:{verifier:EmailVerifier;paid?:AddressVerifier}):Promise<PreparedEmailPass>{
 const pass:PreparedEmailPass={admitted:0,checked:0,failed:0},w=ctx.scope.workspaceId,startedAt=Date.now();
 const campaigns=(await ctx.db.query<EmailCampaignRow>('SELECT c.* FROM outreach_email_campaigns c WHERE c.workspace_id=$1 AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp() AND NOT EXISTS(SELECT 1 FROM outreach_campaign_opening_policies p WHERE p.workspace_id=c.workspace_id AND p.campaign_id=c.id) ORDER BY c.approved_at,c.id',[w])).rows;
 for(const campaign of campaigns){
  const counts=await campaignAdmissionCounts(ctx,campaign),room=Math.min(campaign.max_enrollments-counts.total,campaign.daily_admission_limit-counts.daily);
  if(room<=0)continue;
  const tried=await admittedCandidateIds(ctx);
  let admitted=0;
  for(let round=0;round<ROUNDS&&admitted<room;round++){
   const batch=await listPreparedEmailChoices(ctx,{limit:room+10,regions:campaign.regions,skip:tried,campaignId:campaign.id});
   if(!batch.length)break;
   for(const {read:company,person} of batch){
    if(admitted>=room)break;
    tried.add(company.candidateId);
    const now=Date.parse(await campaignDatabaseNow(ctx));
    let recorded=await latestEmailVerification(ctx,person.email);
    if(recorded&&!emailVerificationDecides(recorded,now))recorded=null;
    if(!recorded){
     let result=await deps.verifier.verify(person.email),provider:EmailVerificationProvider='dns_mx',wrote=false;const address=person.email;
     if(!result)continue;
     if(result==='valid'&&deps.paid&&person.emailStatus==='published'&&paidCheckTimeAvailable(startedAt)){
      const verdict=await checkPublishedAddress(ctx,deps.paid,company,address,async()=>{await recordEmailVerification(ctx,address,'invalid','millionverifier');wrote=true;});
      if(verdict!==null){provider='millionverifier';if(wrote)result='invalid';}
     }
     if(!wrote)await recordEmailVerification(ctx,address,result,provider);pass.checked++;
     recorded={result,outcome:emailVerificationOutcome(result),checkedAt:new Date(now)};
    }
    if(recorded.outcome!=='ok')continue;
    try{
     const result=await withTransaction(ctx.db,()=>admitPreparedCompanyToCampaign(ctx,campaign.id,{kind:'prepared_capture',candidateId:company.candidateId,candidateRevision:company.candidateRevision,runId:company.runId,address:person.email}));
     if(result.ok){admitted++;pass.admitted++;}
    }catch{pass.failed++;}
   }
  }
 }
 return pass;
}
