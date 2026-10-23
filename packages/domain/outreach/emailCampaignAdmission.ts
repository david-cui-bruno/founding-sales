import type {AutomaticResearchTarget,EmailCampaignAdmission} from '@fss/contracts';
import type {EmailCampaignSourceSelection} from './emailCampaignSource.ts';
import {automaticCampaignSourceProof,automaticCampaignTarget,type AutomaticCampaignPublication} from './emailCampaignAutomatic.ts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {lockSendGateForStopFact} from '../policy/sendGate.ts';
import {lockTodayForFirmChange} from '../today/build.ts';
import {listApplicableHolds} from '../policy/holds.ts';
import {loadFirmForUpdate} from '../crm/firms.ts';
import {firstSuppressed} from '../suppression/effective.ts';
import {readCurrentDiscoveryResearchFirm} from '../sourcing/discoveryResearchFirm.ts';
import {enrollContact} from '../sequences/enrollments.ts';
import {admitEmailCandidate} from './emailAdmission.ts';
import {createOutreachPlan} from './plans.ts';
import {assessEmailCandidate} from './selection.ts';
import {campaignDatabaseNow,campaignAuthorityCurrent,campaignCandidateProvenance,lockCurrentEmailCampaign,type CurrentCampaignAuthority,type EmailCampaignRow} from './emailCampaignAuthority.ts';
import {researchActor} from '../sourcing/qualifiedResearchProof.ts';
type Result={ok:true;value:EmailCampaignAdmission}|{ok:false;reason:string};
export function campaignCapacityAvailable(policy:{max_enrollments:number;daily_admission_limit:number},total:number,daily:number):boolean{return total<policy.max_enrollments&&daily<policy.daily_admission_limit;}
export async function lockEmailCampaignAdmission(ctx:RepositoryContext):Promise<EmailCampaignRow|null>{
 await lockSendGateForStopFact(ctx);await lockTodayForFirmChange(ctx);
 await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sourcing-identity:${ctx.scope.workspaceId}`]);
 return lockCurrentEmailCampaign(ctx);
}
/** Committed-evidence completion/recovery only. The real system scope is retained. */
export async function admitAutomaticResearchRunToCampaign(ctx:RepositoryContext,runId:string):Promise<void>{
 const actor=ctx.scope.actor;if(actor.kind!=='system'||actor.component==='migration')return;
 const rows=(await ctx.db.query<AutomaticCampaignPublication>('SELECT * FROM sourcing_automatic_research_firms WHERE workspace_id=$1 AND run_id=$2',[ctx.scope.workspaceId,runId])).rows;
 if(rows.length!==1)return;
 const target=automaticCampaignTarget(rows[0]!);
 await admitQualifiedResearchFirmToCampaign(ctx,target.firmId,async()=>!!await automaticCampaignSourceProof(ctx,target),target);
}
export async function campaignAdmissionCounts(ctx:RepositoryContext,campaign:EmailCampaignRow):Promise<{total:number;daily:number}>{
 const row=(await ctx.db.query<{total:string;daily:string}>(`SELECT count(*) FILTER(WHERE a.campaign_id=$2)::text AS total,count(*) FILTER(WHERE (a.admitted_at AT TIME ZONE 'UTC')::date=($4::timestamptz AT TIME ZONE 'UTC')::date)::text AS daily FROM outreach_email_campaign_admissions a JOIN outreach_email_campaigns c ON c.workspace_id=a.workspace_id AND c.id=a.campaign_id WHERE a.workspace_id=$1 AND c.owner_user_id=$3`,[ctx.scope.workspaceId,campaign.id,campaign.owner_user_id,await campaignDatabaseNow(ctx)])).rows[0];
 return {total:Number(row?.total??0),daily:Number(row?.daily??0)};
}
async function admissionStop(ctx:RepositoryContext,firmId:string,campaign:EmailCampaignRow,afterEnrollmentId?:string):Promise<string|null>{
 const w=ctx.scope.workspaceId;
 if((await ctx.db.query(`SELECT 1 FROM sequence_enrollments WHERE workspace_id=$1 AND firm_id=$2 AND ($3::uuid IS NULL OR id<>$3) LIMIT 1`,[w,firmId,afterEnrollmentId??null])).rows.length)return 'firm_enrollment_history';
 if((await ctx.db.query(`SELECT 1 FROM opportunities WHERE workspace_id=$1 AND firm_id=$2 AND (control_mode='manual' OR status<>'open') UNION ALL SELECT 1 FROM crm_domain_events WHERE workspace_id=$1 AND firm_id=$2 AND event_kind IN ('opportunity.terminal_stop','opportunity.manual_mode') UNION ALL SELECT 1 FROM mail_reply_confirmations WHERE workspace_id=$1 AND firm_id=$2 UNION ALL SELECT 1 FROM outbound_messages WHERE workspace_id=$1 AND firm_id=$2 AND state IN ('dispatching','reconciling','unknown_terminal') LIMIT 1`,[w,firmId])).rows.length)return 'firm_stopped_or_uncertain';
 for(const actionKind of ['enrollment_advance','email_send'] as const)if((await listApplicableHolds(ctx,{actionKind,firmId,ownerUserId:campaign.owner_user_id,mailboxId:campaign.mailbox_id,channel:'email',enrollmentId:afterEnrollmentId})).length)return 'admission_held';
 return null;
}
/** One composition for bounded backlog and future canonical creation. Confirmed
 * refusals roll back only admission. Unknown failures propagate to the parent. */
export async function admitQualifiedResearchFirmToCampaign(ctx:RepositoryContext,firmId:string,currentAuthority:CurrentCampaignAuthority=async()=>researchActor(ctx),source:EmailCampaignSourceSelection={kind:'discovery_research',firmId}):Promise<Result>{
 const automaticSource=source.kind==='automatic_research'?source:undefined;
 if(source.firmId!==firmId)return {ok:false,reason:'campaign_source_changed'};
 const campaign=await lockEmailCampaignAdmission(ctx);
 if(!campaign||!await currentAuthority()||!await campaignAuthorityCurrent(ctx,campaign,automaticSource))return {ok:false,reason:'campaign_authority_unavailable'};
 await ctx.db.query('SAVEPOINT email_campaign_admission');
 try{
  const result=await admit(ctx,firmId,campaign,currentAuthority,automaticSource);
  if(!result.ok)await ctx.db.query('ROLLBACK TO SAVEPOINT email_campaign_admission');
  await ctx.db.query('RELEASE SAVEPOINT email_campaign_admission');return result;
 }catch(error){await ctx.db.query('ROLLBACK TO SAVEPOINT email_campaign_admission');await ctx.db.query('RELEASE SAVEPOINT email_campaign_admission');throw error;}
}
async function admit(ctx:RepositoryContext,firmId:string,campaign:EmailCampaignRow,currentAuthority:CurrentCampaignAuthority,automaticSource?:AutomaticResearchTarget):Promise<Result>{
 const w=ctx.scope.workspaceId,firm=await loadFirmForUpdate(ctx,firmId);
 if(!firm||firm.status!=='active'||firm.assigned_user_id!==campaign.owner_user_id)return {ok:false,reason:'firm_changed'};
 const previous=(await ctx.db.query('SELECT 1 FROM outreach_email_campaign_admissions WHERE workspace_id=$1 AND firm_id=$2',[w,firmId])).rows[0];
 if(previous)return {ok:false,reason:'already_admitted'};
 const counts=await campaignAdmissionCounts(ctx,campaign);if(!campaignCapacityAvailable(campaign,counts.total,counts.daily))return {ok:false,reason:'campaign_limit'};
 const lineage=automaticSource?null:await readCurrentDiscoveryResearchFirm(ctx,{firmId});
 const automatic=automaticSource?await automaticCampaignSourceProof(ctx,automaticSource):null;
 if(automaticSource?!automatic:!lineage)return {ok:false,reason:'research_firm_unavailable'};
 const candidateId=automaticSource?.candidateId??lineage!.candidate.id,candidateRevision=automaticSource?.candidateRevision??lineage!.candidate.revision;
 await ctx.db.query('SELECT id FROM sourcing_candidates WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',[w,automaticSource?[candidateId]:[lineage!.discoveryCandidateId,candidateId]]);
 if(automaticSource)await ctx.db.query('SELECT id FROM sourcing_automatic_research_firms WHERE workspace_id=$1 AND id=$2 FOR SHARE',[w,automaticSource.publicationId]);
 else await ctx.db.query(`SELECT o.candidate_id FROM sourcing_candidate_discovery_origins o JOIN sourcing_discovery_promotions p ON p.workspace_id=o.workspace_id AND p.raw_candidate_id=o.candidate_id AND p.provider=o.provider AND p.release=o.release AND p.record_id=o.record_id JOIN sourcing_discovery_research_firms l ON l.workspace_id=p.workspace_id AND l.promotion_id=p.id WHERE l.workspace_id=$1 AND l.firm_id=$2 FOR SHARE OF o,p,l`,[w,firmId]);
 const run=(await ctx.db.query<{id:string}>('SELECT id FROM sourcing_qualification_runs WHERE workspace_id=$1 AND candidate_id=$2 ORDER BY requested_at DESC,id DESC LIMIT 1',[w,candidateId])).rows[0];if(!run||automaticSource&&run.id!==automaticSource.runId)return {ok:false,reason:'evidence_unavailable'};
 await ctx.db.query('SELECT id FROM sourcing_qualification_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,run.id]);
 const input={campaignId:campaign.id,candidateId,qualificationRunId:run.id};
 if(!await campaignCandidateProvenance(ctx,input,automaticSource))return {ok:false,reason:'campaign_source_changed'};
 const stop=await admissionStop(ctx,firmId,campaign);if(stop)return {ok:false,reason:stop};
 const admitted=await admitEmailCandidate(ctx,{...input,expectedRevision:candidateRevision,expectedOwnerUserId:campaign.owner_user_id,reviewed:false},automaticSource);if(!admitted.ok)return admitted;
 if(admitted.value.firmId!==firmId)return {ok:false,reason:'firm_changed'};
 const plan=await createOutreachPlan(ctx,{firmId,contactId:admitted.value.contactId,expectedOwnerUserId:campaign.owner_user_id,mailboxId:campaign.mailbox_id,lane:'email_first',qualificationRunId:run.id},campaign.id,automaticSource);if(!plan.ok)return plan;
 const assessment=await assessEmailCandidate(ctx,input,automaticSource);if(!assessment.ok||assessment.value.reviewRequired)return {ok:false,reason:'source_changed'};
 const enrolled=await enrollContact(ctx,{originKind:'prospecting',sequenceVersionId:campaign.sequence_version_id,subject:{kind:'outreach',outreachPlanId:plan.value.id},firmId,contactId:admitted.value.contactId,assignedUserId:campaign.owner_user_id});if(!enrolled.ok)return enrolled;
 const finalStop=await admissionStop(ctx,firmId,campaign,enrolled.value.enrollmentId);if(finalStop)return {ok:false,reason:finalStop};
 if(await firstSuppressed(ctx,[{scope:'firm',canonicalKey:firmId},{scope:'handle',canonicalKey:assessment.value.route.address}],'email'))return {ok:false,reason:'email_or_firm_stopped'};
 if(!await campaignCandidateProvenance(ctx,input,automaticSource)||!await currentAuthority())return {ok:false,reason:'authority_changed'};
 const row=(await ctx.db.query<{admitted_at:Date}>(`INSERT INTO outreach_email_campaign_admissions(workspace_id,campaign_id,firm_id,contact_id,route_id,plan_id,enrollment_id,candidate_id,qualification_run_id,source_kind,publication_id,publication_revision,candidate_revision,evidence_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING admitted_at`,[w,campaign.id,firmId,admitted.value.contactId,admitted.value.routeId,plan.value.id,enrolled.value.enrollmentId,candidateId,run.id,automaticSource?'automatic_research':'discovery_research',automaticSource?.publicationId??null,automaticSource?.publicationRevision??null,automaticSource?.candidateRevision??null,automaticSource?.evidenceFingerprint??null])).rows[0]!;
 if(!await currentAuthority()||!await campaignAuthorityCurrent(ctx,campaign,automaticSource))return {ok:false,reason:'authority_changed'};
 const finalProof=await campaignCandidateProvenance(ctx,input,automaticSource);
 if(!finalProof||finalProof.route.address!==assessment.value.route.address||finalProof.route.sourceObservationId!==assessment.value.route.sourceObservationId||finalProof.route.blockId!==assessment.value.route.blockId||finalProof.route.identityKind!==assessment.value.route.identityKind)return {ok:false,reason:'campaign_source_changed'};
 return {ok:true,value:{campaignId:campaign.id,firmId,contactId:admitted.value.contactId,routeId:admitted.value.routeId,planId:plan.value.id,enrollmentId:enrolled.value.enrollmentId,candidateId,qualificationRunId:run.id,admittedAt:row.admitted_at.toISOString()}};
}
