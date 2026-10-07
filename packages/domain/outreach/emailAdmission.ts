import {existingEmailRoute} from './existingEmail.ts';
import type {CandidateInput} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {lockSendGateForStopFact} from '../policy/sendGate.ts';
import {lockTodayForFirmChange,refreshTodayForFirm} from '../today/build.ts';
import {createFirm,loadFirmForUpdate,resolveZoneForFirm} from '../crm/firms.ts';
import {createContact} from '../crm/contacts.ts';
import {addEmailRoute} from '../crm/routes.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import {sourcingTimeZone} from '../sourcing/admission.ts';
import {attachSourcingAttribution} from '../sourcing/attribution.ts';
import {assessEmailCandidate} from './selection.ts';
type Input={candidateId:string;qualificationRunId:string;expectedRevision:number;expectedOwnerUserId:string;reviewed:boolean};
type Value={firmId:string;contactId:string;routeId:string;identityKind:'named'|'role';alreadyAdmitted:boolean};
type Result={ok:true;value:Value}|{ok:false;reason:string};
export async function admitEmailCandidate(ctx:RepositoryContext,input:Input):Promise<Result>{
 const actor=ctx.scope.actor;if(actor.kind!=='user'||actor.role!=='admin')return {ok:false,reason:'admin_required'};
 if(actor.userId!==input.expectedOwnerUserId)return {ok:false,reason:'owner_changed'};
 await ctx.db.query('SAVEPOINT outreach_email_admission');
 try{const result=await admit(ctx,input);if(!result.ok)await ctx.db.query('ROLLBACK TO SAVEPOINT outreach_email_admission');await ctx.db.query('RELEASE SAVEPOINT outreach_email_admission');return result;}
 catch(e){await ctx.db.query('ROLLBACK TO SAVEPOINT outreach_email_admission');await ctx.db.query('RELEASE SAVEPOINT outreach_email_admission');throw e;}
}
async function admit(ctx:RepositoryContext,input:Input):Promise<Result>{
 const w=ctx.scope.workspaceId;
 await lockSendGateForStopFact(ctx);await lockTodayForFirmChange(ctx);
 await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sourcing-identity:${w}`]);
 // Lock firms before candidate/run, matching phone admission and merge ordering.
 const preliminary=await assessEmailCandidate(ctx,input);if(!preliminary.ok)return preliminary;
 let firm=preliminary.value.firmId?await loadFirmForUpdate(ctx,preliminary.value.firmId):null;
 const candidate=(await ctx.db.query<{payload:CandidateInput;revision:number}>('SELECT payload,revision FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,input.candidateId])).rows[0];
 await ctx.db.query('SELECT id FROM sourcing_qualification_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,input.qualificationRunId]);
 if(!candidate||candidate.revision!==input.expectedRevision)return {ok:false,reason:'candidate_changed'};
 const assessment=await assessEmailCandidate(ctx,input);if(!assessment.ok)return assessment;
 if(assessment.value.firmId!==(firm?.id??null))return {ok:false,reason:'firm_changed'};
 if(assessment.value.reviewRequired&&!input.reviewed)return {ok:false,reason:'qualification_requires_review'};
 const existing=(await ctx.db.query<{firm_id:string;contact_id:string;route_id:string;identity_kind:'named'|'role';association_review_required:boolean}>(`SELECT firm_id,contact_id,route_id,identity_kind,association_review_required FROM outreach_email_sources WHERE workspace_id=$1 AND candidate_id=$2`,[w,input.candidateId])).rows[0];
 if(existing){if(existing.association_review_required)return {ok:false,reason:'identity_review_required'};return {ok:true,value:{firmId:existing.firm_id,contactId:existing.contact_id,routeId:existing.route_id,identityKind:existing.identity_kind,alreadyAdmitted:true}};}
 if(!(await ctx.db.query("SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' FOR SHARE",[w,input.expectedOwnerUserId])).rows.length)return {ok:false,reason:'owner_inactive'};
 const zone=sourcingTimeZone(candidate.payload.region,candidate.payload.locality);if(!zone)return {ok:false,reason:'zone_unresolved'};
 if(!firm){const made=await createFirm(ctx,{name:candidate.payload.firmName,website:candidate.payload.website,locality:candidate.payload.locality,regionCode:candidate.payload.region,assignedUserId:input.expectedOwnerUserId});if(!made.ok)return made;firm=made.value;}
 if(firm.assigned_user_id!==input.expectedOwnerUserId||firm.status==='merged')return {ok:false,reason:'firm_changed'};
 const route=assessment.value.route;
 const prior=await existingEmailRoute(ctx,firm.id,route.address);if(!prior.ok)return prior;
 let contactId:string,routeId:string;
 if(prior.value){
  if(!input.reviewed)return {ok:false,reason:'qualification_requires_review'};
  contactId=prior.value.contactId;routeId=prior.value.id;
 }else{
  const contact=await createContact(ctx,{firmId:firm.id,fullName:route.displayName,title:route.identityKind==='role'?'Office mailbox':'Source-listed contact'});if(!contact.ok)return contact;
  const email=await addEmailRoute(ctx,{firmId:firm.id,contactId:contact.value.id,address:route.address,source:'website',retrievedAt:new Date(),associationConfidence:1});if(!email.ok)return email;
  contactId=contact.value.id;routeId=email.value.id;
 }
 // No invented technical validation: the existing email validation gate still applies.
 if(firm.time_zone===null){const resolved=await resolveZoneForFirm(ctx,{firmId:firm.id,recordedZone:zone});if(!resolved.ok)return resolved;}
 await ctx.db.query(`INSERT INTO outreach_email_sources(workspace_id,candidate_id,run_id,firm_id,contact_id,route_id,observation_id,block_id,identity_kind,reviewed) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[w,input.candidateId,input.qualificationRunId,firm.id,contactId,routeId,route.sourceObservationId,route.blockId,route.identityKind,input.reviewed]);
 const policy=(await ctx.db.query<{policy_version:string}>('SELECT policy_version FROM sourcing_qualification_runs WHERE workspace_id=$1 AND id=$2',[w,input.qualificationRunId])).rows[0]!;
 const query=(await ctx.db.query<{query_id:string}>(`SELECT a.query_id FROM sourcing_discovery_hits h JOIN sourcing_discovery_attempts a ON a.workspace_id=h.workspace_id AND a.id=h.attempt_id WHERE h.workspace_id=$1 AND h.candidate_id=$2 ORDER BY a.created_at,a.id LIMIT 1`,[w,input.candidateId])).rows[0];
 const attribution=await attachSourcingAttribution(ctx,{firmId:firm.id,candidateId:input.candidateId,qualificationRunId:input.qualificationRunId,queryId:query?.query_id??null,hypothesis:assessment.value.rank,policyVersion:policy.policy_version,acquisition:'cold_sourced'});if(!attribution.ok)throw new Error(`email_admission_${attribution.reason}`);
 await recordCrmAuditEvent(ctx,{action:'outreach.email_admitted',subjectKind:'firm',subjectId:firm.id,detail:{candidateId:input.candidateId,runId:input.qualificationRunId,contactId:contactId,identityKind:route.identityKind,reviewed:input.reviewed,reusedRoute:prior.value!==null}});
 await refreshTodayForFirm(ctx,{firmId:firm.id});
 return {ok:true,value:{firmId:firm.id,contactId:contactId,routeId:routeId,identityKind:route.identityKind,alreadyAdmitted:false}};
}
