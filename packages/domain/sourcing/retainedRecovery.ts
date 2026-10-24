import {createHash,randomUUID} from 'node:crypto';
import {retainedIdentityDecisionInputSchema,retainedInterpretationInputSchema,qualificationEvidenceSchema,type RetainedIdentityDecisionInput,type RetainedInterpretationInput,type QualificationFact} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import {replaceCandidateIdentity} from './candidateCorrection.ts';
import {qualificationCitationRoles} from './qualificationCitationRoles.ts';
import {evaluateQualification} from './qualificationDecision.ts';
import {finishQualification,type SourcingResult} from './qualificationStore.ts';
import {retainedCandidateOnly,retainedWallNow} from './retainedAcquisition.ts';
import {fail,literalName,lockRecovery,recoverySavepoint,resolveRetainedCitation,type RetainedDecision,type RetainedAuthority} from './retainedRecoveryEvidence.ts';

export async function decideRetainedIdentity(ctx:RepositoryContext,input:RetainedIdentityDecisionInput,authority?:RetainedAuthority):Promise<SourcingResult<{decisionId:string;candidateId:string;revision:number;qualificationRunId:string}>>{
 const parsed=retainedIdentityDecisionInputSchema.safeParse(input);if(!parsed.success)return fail('invalid_input');
 const v=parsed.data;
 return recoverySavepoint(ctx,async()=>{
  const locked=await lockRecovery(ctx,v);if(!locked.ok)return locked;
  if(authority&&!await authority())return fail('session_changed');
  const {candidate,run}=locked.value,now=await retainedWallNow(ctx);
  if(await retainedCandidateOnly(ctx,v.candidateId))return fail('recovery_already_recorded');
  const citation=resolveRetainedCitation(run.observations,v,candidate.payload.website,now);
  const name=citation?literalName(citation.text,v.nameStart,v.nameEnd):null;
  if(!citation||!name)return fail('identity_evidence_required');
  const roles=qualificationCitationRoles({...candidate.payload,firmName:name},[{kind:'firm_identity',value:citation.text,observationId:v.observationId,blockId:v.blockId}],run.observations);
  if(!roles.ok)return fail('identity_evidence_required');
  const decisionId=randomUUID(),revision=candidate.revision+(candidate.payload.firmName===name?0:1);
  await ctx.db.query(`INSERT INTO sourcing_retained_identity_decisions(workspace_id,id,candidate_id,original_run_id,original_revision,result_revision,reviewer_user_id,observation_id,block_id,content_hash,relevant_text_hash,name_start,name_end)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[ctx.scope.workspaceId,decisionId,v.candidateId,run.id,candidate.revision,revision,ctx.scope.actor.kind==='user'?ctx.scope.actor.userId:null,v.observationId,v.blockId,v.contentHash,v.relevantTextHash,v.nameStart,v.nameEnd]);
  const corrected=await replaceCandidateIdentity(ctx,v.candidateId,candidate.payload,name,candidate.revision);if(!corrected.ok)return corrected;
  await recordCrmAuditEvent(ctx,{action:'sourcing.retained_identity_decided',subjectKind:'sourcing_candidate',subjectId:v.candidateId,detail:{decisionId,originalRunId:run.id,previousRevision:candidate.revision,revision,observationId:v.observationId,blockId:v.blockId,contentHash:v.contentHash,relevantTextHash:v.relevantTextHash,nameStart:v.nameStart,nameEnd:v.nameEnd,methodVersion:'human-retained-v1'}});
  return {ok:true,value:{decisionId,candidateId:v.candidateId,revision,qualificationRunId:run.id}};
 },authority);
}
export async function interpretRetainedQualification(ctx:RepositoryContext,input:RetainedInterpretationInput,authority?:RetainedAuthority):Promise<SourcingResult<{runId:string;candidateId:string;candidateRevision:number;decisionId:string}>>{
 const parsed=retainedInterpretationInputSchema.safeParse(input);if(!parsed.success)return fail('invalid_input');
 const v=parsed.data;
 return recoverySavepoint(ctx,async()=>{
  const locked=await lockRecovery(ctx,v,true);if(!locked.ok)return locked;
  const {candidate,run}=locked.value;
  // lockRecovery already holds candidate/original-run locks, serializing interpretation and lifecycle deletion.
  // Decisions are immutable. The lineage FK and unique interpretation index protect insertion without UPDATE authority.
  const decision=(await ctx.db.query<RetainedDecision>('SELECT * FROM sourcing_retained_identity_decisions WHERE workspace_id=$1 AND candidate_id=$2 AND id=$3',[ctx.scope.workspaceId,v.candidateId,v.decisionId])).rows[0];
  if(authority&&!await authority())return fail('session_changed');
  const now=await retainedWallNow(ctx);
  if(!decision||decision.original_run_id!==run.id||decision.result_revision!==candidate.revision||decision.original_revision!==run.candidate_revision)return fail('candidate_changed');
  const identity=resolveRetainedCitation(run.observations,{observationId:decision.observation_id,blockId:decision.block_id,contentHash:decision.content_hash,relevantTextHash:decision.relevant_text_hash},candidate.payload.website,now);
  if(!identity||literalName(identity.text,decision.name_start,decision.name_end)!==candidate.payload.firmName)return fail('identity_evidence_required');
  if((await ctx.db.query('SELECT id FROM sourcing_qualification_runs WHERE workspace_id=$1 AND retained_identity_decision_id=$2',[ctx.scope.workspaceId,v.decisionId])).rows.length)return fail('interpretation_already_recorded');
  const facts:QualificationFact[]=[];
  for(const selection of v.selections){const citation=resolveRetainedCitation(run.observations,selection,candidate.payload.website,now);if(!citation)return fail('invalid_evidence');facts.push({kind:selection.kind,value:citation.text,observationId:selection.observationId,blockId:selection.blockId});}
  const roles=qualificationCitationRoles(candidate.payload,facts,run.observations);if(!roles.ok)return fail('invalid_evidence');
  if(!qualificationEvidenceSchema.safeParse({observations:run.observations,facts:roles.facts}).success)return fail('invalid_evidence');
  if(run.requested_at.getTime()>=Date.parse(now))return fail('qualification_clock_conflict');
  const canonical=[...v.selections].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const fingerprint=createHash('sha256').update(JSON.stringify(['human-retained-v1',v.decisionId,candidate.revision,run.id,canonical])).digest('hex'),runId=randomUUID();
  await ctx.db.query(`INSERT INTO sourcing_qualification_runs(workspace_id,id,candidate_id,candidate_revision,fingerprint,prompt_version,policy_version,model_name,retained_identity_decision_id,requested_at,deadline_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,'human-reviewed-retained-v1',$8,$9,$9::timestamptz+interval '30 minutes')`,[ctx.scope.workspaceId,runId,v.candidateId,candidate.revision,fingerprint,run.prompt_version,run.policy_version,v.decisionId,now]);
  const finished=await finishQualification(ctx,{runId,observations:run.observations,facts:roles.facts,reason:null});if(!finished.ok)return finished;
  const evaluated=await evaluateQualification(ctx,{runId});if(!evaluated.ok)return evaluated;
  await recordCrmAuditEvent(ctx,{action:'sourcing.retained_qualification_interpreted',subjectKind:'sourcing_candidate',subjectId:v.candidateId,detail:{decisionId:v.decisionId,originalRunId:run.id,runId,revision:candidate.revision,methodVersion:'human-retained-v1',policyVersion:run.policy_version,promptVersion:run.prompt_version,selections:v.selections}});
  return {ok:true,value:{runId,candidateId:v.candidateId,candidateRevision:candidate.revision,decisionId:v.decisionId}};
 },authority);
}
