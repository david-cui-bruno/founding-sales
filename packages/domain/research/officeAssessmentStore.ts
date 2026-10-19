import {unevaluatedFirmOfficeAssessment,type FirmOfficeAssessmentView,type SourceObservation,type QualificationFact} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {OFFICE_SOURCE_MILLISECONDS} from './officeAssessmentContract.ts';
import {officeNow,readOfficeAssessmentBinding} from './officeAssessmentTarget.ts';
import {currentOfficeSources,evaluateOfficeAssessment,validOfficeProof} from './officeAssessmentEvidence.ts';
interface SourceRow extends Record<string,unknown>{id:string;evidence_id:string;observation:SourceObservation;facts:QualificationFact[];expires_at:Date;source_reference:string;content_hash:string;retrieved_at:Date;terms_allow_retention:boolean;retention_expires_at:Date|null;provider:string;contact_id:string|null;firm_id:string;}
function sourceValid(row:SourceRow,source:SourceObservation,now:number):boolean {
 return row.provider==='company_page'&&row.contact_id===null&&row.source_reference===source.url&&row.content_hash===source.contentHash
 &&row.retrieved_at.getTime()<=Date.parse(source.retrievedAt)&&Date.parse(source.retrievedAt)<=now&&now<Date.parse(source.retrievedAt)+OFFICE_SOURCE_MILLISECONDS
 &&(row.terms_allow_retention||!!row.retention_expires_at&&row.retention_expires_at.getTime()>now)
 &&(!row.retention_expires_at||row.retention_expires_at.getTime()>now);
}
export async function markOfficeUnavailable(ctx:RepositoryContext,runId:string,reason:string):Promise<void>{await ctx.db.query(`UPDATE firm_office_assessments SET result='stale',reason=$3 WHERE workspace_id=$1 AND research_run_id=$2 AND result='pending'`,[ctx.scope.workspaceId,runId,reason]);}
export async function retainedOfficeSources(ctx:RepositoryContext,input:{firmId:string;observations:readonly SourceObservation[];evidenceIds:readonly string[]}):Promise<boolean>{
 if(!validOfficeProof(input.observations,[])||input.evidenceIds.length!==input.observations.length)return false;
 const rows=(await ctx.db.query<SourceRow>(`SELECT * FROM evidence_items WHERE workspace_id=$1 AND firm_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR SHARE`,[ctx.scope.workspaceId,input.firmId,input.evidenceIds])).rows;
 const now=Date.parse(await officeNow(ctx));
 return input.observations.every((source,index)=>{const evidence=rows.find(r=>r.id===input.evidenceIds[index]);return !!evidence&&sourceValid(evidence,source,now);});
}
export async function finishOfficeAssessment(ctx:RepositoryContext,input:{runId:string;observations:readonly SourceObservation[];facts:readonly QualificationFact[];evidenceIds:readonly string[]}):Promise<boolean>{
 const bound=await readOfficeAssessmentBinding(ctx,input.runId,true);
 if('reason' in bound||bound.parent.result!=='pending'||!validOfficeProof(input.observations,input.facts)||input.evidenceIds.length!==input.observations.length)return false;
 const now=await officeNow(ctx),time=Date.parse(now),expiry:number[]=[];
 if(!currentOfficeSources(bound.candidate,input.observations,now))return false;
 const rows=(await ctx.db.query<SourceRow>(`SELECT * FROM evidence_items WHERE workspace_id=$1 AND firm_id=$2 AND id=ANY($3::uuid[]) ORDER BY id FOR SHARE`,[ctx.scope.workspaceId,bound.parent.firm_id,input.evidenceIds])).rows;
 for(const [index,source] of input.observations.entries()){
  const evidence=rows.find(r=>r.id===input.evidenceIds[index]);
  if(!evidence||!sourceValid(evidence,source,time))return false;
  expiry.push(Math.min(Date.parse(source.retrievedAt)+OFFICE_SOURCE_MILLISECONDS,evidence.retention_expires_at?.getTime()??Infinity));
 }
 const result=evaluateOfficeAssessment(bound.candidate,input.observations,input.facts,bound.parent.route_endpoint_hash,now);
 for(const [index,observation] of input.observations.entries())await ctx.db.query(`INSERT INTO firm_office_assessment_sources(workspace_id,assessment_id,firm_id,observation_id,ordinal,evidence_id,expires_at,observation,facts) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)`,[ctx.scope.workspaceId,bound.parent.id,bound.parent.firm_id,observation.id,index,input.evidenceIds[index],new Date(expiry[index]!),JSON.stringify(observation),JSON.stringify(input.facts.filter(f=>f.observationId===observation.id))]);
 await ctx.db.query(`UPDATE firm_office_assessments SET result=$3,reason=$4,expected_source_count=$5,assessed_at=$6,expires_at=$7 WHERE workspace_id=$1 AND id=$2 AND result='pending'`,[ctx.scope.workspaceId,bound.parent.id,result.result,result.reason,input.observations.length,now,new Date(Math.min(...expiry))]);
 return true;
}
export async function readFirmOfficeAssessment(ctx:RepositoryContext,input:{firmId:string}):Promise<FirmOfficeAssessmentView>{
 const empty=unevaluatedFirmOfficeAssessment(),actor=ctx.scope.actor;
 const visible=(await ctx.db.query(`SELECT id FROM firms WHERE workspace_id=$1 AND id=$2 AND ($3::uuid IS NULL OR assigned_user_id=$3)`,[ctx.scope.workspaceId,input.firmId,actor.kind==='user'&&actor.role!=='admin'?actor.userId:null])).rows.length>0;
 if(!visible)return empty;
 const latest=(await ctx.db.query<{id:string|null;outcome:string;reason:string|null}>(`SELECT id,outcome,reason FROM (
 SELECT r.id,r.revision,r.outcome,r.refusal_code AS reason FROM research_runs r WHERE r.workspace_id=$1 AND r.firm_id=$2 AND r.purpose='office_evidence'
 UNION ALL SELECT NULL::uuid,(j.payload->>'revision')::bigint,j.state,CASE WHEN j.state='dead' THEN 'job_failed' ELSE 'queued' END
 FROM jobs j WHERE j.workspace_id=$1 AND j.kind='research.firm' AND j.payload->>'firmId'=$2::text AND j.payload->>'purpose'='office_evidence'
 AND j.payload->>'revision' ~ '^[1-9][0-9]{0,9}$' AND j.idempotency_key='research-firm:'||$2::text||':'||(j.payload->>'revision') AND NOT EXISTS(SELECT 1 FROM research_runs r WHERE r.workspace_id=j.workspace_id AND r.firm_id=$2 AND j.idempotency_key='research-firm:'||r.firm_id::text||':'||r.revision::text)
 ) intents ORDER BY revision DESC LIMIT 1`,[ctx.scope.workspaceId,input.firmId])).rows[0];
 if(!latest)return empty;
 const pending={...empty,status:'pending' as const,researchRunId:latest.id,reason:latest.reason??'research_pending'};
 if(!latest.id)return pending;
 if(latest.outcome==='refused'||latest.outcome==='failed')return {...pending,reason:latest.reason??'research_failed'};
 const bound=await readOfficeAssessmentBinding(ctx,latest.id);
 if('reason' in bound)return {...pending,status:'stale',reason:bound.reason};
 const {parent}=bound;
 const view:FirmOfficeAssessmentView={...pending,assessmentId:parent.id,routeId:parent.phone_route_id,routeVersion:parent.route_version,assessedAt:parent.assessed_at?.toISOString()??null,expiresAt:parent.expires_at.toISOString(),sourceCount:0,policyVersion:parent.assessment_version};
 if(latest.outcome!=='completed'||!parent.assessed_at)return {...view,reason:latest.reason??parent.reason??'research_pending'};
 const rows=(await ctx.db.query<SourceRow>(`SELECT s.observation,s.facts,s.expires_at,s.evidence_id,e.source_reference,e.content_hash,e.retrieved_at,e.terms_allow_retention,e.retention_expires_at,e.provider,e.contact_id,e.firm_id FROM firm_office_assessment_sources s JOIN evidence_items e ON e.workspace_id=s.workspace_id AND e.firm_id=s.firm_id AND e.id=s.evidence_id WHERE s.workspace_id=$1 AND s.assessment_id=$2 ORDER BY s.ordinal`,[ctx.scope.workspaceId,parent.id])).rows;
 const now=await officeNow(ctx);
 if(!rows.length||rows.length!==parent.expected_source_count)return {...view,status:'stale',reason:'source_lost'};
 if(!validOfficeProof(rows.map(r=>r.observation),rows.flatMap(r=>r.facts)))return {...view,status:'stale',reason:'invalid_evidence'};
 if(rows.some(r=>r.expires_at.getTime()<=Date.parse(now)||!sourceValid(r,r.observation,Date.parse(now))))return {...view,status:'stale',reason:'source_expired_or_terms'};
 const proof=evaluateOfficeAssessment(bound.candidate,rows.map(r=>r.observation),rows.flatMap(r=>r.facts),parent.route_endpoint_hash,now);
 if(proof.result!==parent.result||proof.reason!==parent.reason)return {...view,status:'stale',reason:'proof_changed'};
 return {...view,status:proof.result,reason:proof.reason,sourceCount:rows.length};
}
