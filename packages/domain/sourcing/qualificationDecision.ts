import type {CandidateInput,QualificationFact,SourceObservation} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {decideAdminOnly} from '../crm/authorization.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import {databaseNow} from '../policy/clock.ts';
import {qualifyCandidate,NEUTRAL_MAINTENANCE_QUESTION,type SourcingIdentity} from './qualificationPolicy.ts';
import type {QualificationRunRow,SourcingResult} from './qualificationStore.ts';
export function candidateIdentity(candidate:CandidateInput,facts:readonly QualificationFact[],sources:readonly SourceObservation[]):SourcingIdentity {
 const fold=(s:string)=>s.normalize('NFKC').replace(/\s+/gu,' ').trim().toLowerCase();
 const matched=facts.some(f=>f.kind==='firm_identity'&&fold(f.value).includes(fold(candidate.firmName))&&sources.some(s=>s.id===f.observationId&&s.firstParty&&!s.truncated));
 return {status:matched?'resolved':'unknown',name:candidate.firmName,website:candidate.website,locality:candidate.locality,region:candidate.region};
}
/** Candidate-first locking matches evidence completion. Caller supplies a transaction, never model decisions. */
export async function evaluateQualification(ctx:RepositoryContext,input:{runId:string}):Promise<SourcingResult<{runId:string}>> {
 if(!decideAdminOnly(ctx).permitted)return {ok:false,reason:'admin_only'};
 const w=ctx.scope.workspaceId;
 const identity=(await ctx.db.query<{candidate_id:string}>('SELECT candidate_id FROM sourcing_qualification_runs WHERE workspace_id=$1 AND id=$2',[w,input.runId])).rows[0];
 if(!identity)return {ok:false,reason:'not_found'};
 const candidate=(await ctx.db.query<{revision:number;status:string;payload:CandidateInput}>('SELECT revision,status,payload FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,identity.candidate_id])).rows[0];
 const run=(await ctx.db.query<QualificationRunRow>('SELECT * FROM sourcing_qualification_runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[w,input.runId])).rows[0];
 if(!candidate||!run)return {ok:false,reason:'not_found'};
 if(candidate.status==='dismissed'||candidate.revision!==run.candidate_revision)return {ok:false,reason:'candidate_changed'};
 if(!['review','eligible'].includes(run.state)||run.reason!==null)return {ok:false,reason:'evidence_unavailable'};
 const verdict=qualifyCandidate({identity:candidateIdentity(candidate.payload,run.facts,run.observations),facts:run.facts,observations:run.observations,now:await databaseNow(ctx)});
 // Free-form model questions cannot be proven claim-free; a neutral question always remains useful.
 await ctx.db.query('UPDATE sourcing_qualification_runs SET state=$3,verdict=$4::jsonb,opening_question=$5 WHERE workspace_id=$1 AND id=$2',
  [w,run.id,verdict.decision==='eligible'?'eligible':'review',JSON.stringify(verdict),NEUTRAL_MAINTENANCE_QUESTION]);
 await recordCrmAuditEvent(ctx,{action:'sourcing.qualification_decided',subjectKind:'sourcing_candidate',subjectId:run.candidate_id,detail:{runId:run.id,decision:verdict.decision,policyVersion:verdict.policyVersion}});
 return {ok:true,value:{runId:run.id}};
}
