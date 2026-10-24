import {createHash} from 'node:crypto';
import {qualificationEvidenceSchema,type CandidateInput,type SourceObservation} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {lockSendGateForStopFact} from '../policy/sendGate.ts';
import {isLegacyCandidatePayload} from './discoveryIntake.ts';
import type {QualificationRunRow,SourcingResult} from './qualificationStore.ts';
import {QUALIFICATION_POLICY_VERSION,QUALIFICATION_PROMPT_VERSION} from './qualificationVersions.ts';
import {candidateAcquisitionOutstanding,lockRetainedAdmin,retainedWallNow} from './retainedAcquisition.ts';
export interface RecoveryCandidate {payload:CandidateInput;revision:number;status:string;qualification_blocked:boolean;[key:string]:unknown}
export interface RetainedDecision {id:string;candidate_id:string;original_run_id:string;original_revision:number;result_revision:number;observation_id:string;block_id:string;content_hash:string;relevant_text_hash:string;name_start:number;name_end:number;[key:string]:unknown}
export type RetainedAuthority=()=>Promise<boolean>;
export const fail=(reason:string):{ok:false;reason:string}=>({ok:false,reason});
export async function recoverySavepoint<T>(ctx:RepositoryContext,work:()=>Promise<SourcingResult<T>>,authority?:RetainedAuthority):Promise<SourcingResult<T>>{
 await ctx.db.query('SAVEPOINT retained_recovery');
 try{let result=await work();if(result.ok&&authority&&!await authority())result=fail('session_changed');if(!result.ok)await ctx.db.query('ROLLBACK TO SAVEPOINT retained_recovery');await ctx.db.query('RELEASE SAVEPOINT retained_recovery');return result;}
 catch(error){await ctx.db.query('ROLLBACK TO SAVEPOINT retained_recovery');await ctx.db.query('RELEASE SAVEPOINT retained_recovery');throw error;}
}
export async function lockRecovery(ctx:RepositoryContext,input:{candidateId:string;expectedRevision:number;qualificationRunId:string},revisionChanged=false):Promise<SourcingResult<{candidate:RecoveryCandidate;run:QualificationRunRow;now:string}>>{
 if(ctx.scope.actor.kind!=='user'||ctx.scope.actor.role!=='admin')return fail('admin_only');
 await lockSendGateForStopFact(ctx);
 await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sourcing-identity:${ctx.scope.workspaceId}`]);
 const candidate=(await ctx.db.query<RecoveryCandidate>('SELECT payload,revision,status,qualification_blocked FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.scope.workspaceId,input.candidateId])).rows[0];
 if(!candidate)return fail('not_found');
 const run=(await ctx.db.query<QualificationRunRow>('SELECT * FROM sourcing_qualification_runs WHERE workspace_id=$1 AND candidate_id=$2 AND id=$3 FOR UPDATE',[ctx.scope.workspaceId,input.candidateId,input.qualificationRunId])).rows[0];
 if(!await lockRetainedAdmin(ctx))return fail('admin_only');
 if(!isLegacyCandidatePayload(candidate.payload))return fail('candidate_format_not_supported');
 if(candidate.revision!==input.expectedRevision||(!revisionChanged&&run?.candidate_revision!==candidate.revision))return fail('candidate_changed');
 if(candidate.status==='dismissed'||candidate.qualification_blocked)return fail('identity_review_required');
 if(!run)return fail('not_found');
 const latest=(await ctx.db.query<{id:string}>('SELECT id FROM sourcing_qualification_runs WHERE workspace_id=$1 AND candidate_id=$2 ORDER BY requested_at DESC,id DESC LIMIT 1',[ctx.scope.workspaceId,input.candidateId])).rows[0];
 if(latest?.id!==run.id)return fail('candidate_changed');
 if((await ctx.db.query(`SELECT candidate_id FROM sourcing_admissions WHERE workspace_id=$1 AND candidate_id=$2 UNION ALL SELECT candidate_id FROM outreach_email_sources WHERE workspace_id=$1 AND candidate_id=$2 UNION ALL SELECT candidate_id FROM outreach_plans WHERE workspace_id=$1 AND candidate_id=$2`,[ctx.scope.workspaceId,input.candidateId])).rows.length)return fail('candidate_already_admitted');
 if(await candidateAcquisitionOutstanding(ctx,input.candidateId))return fail('acquisition_in_progress');
 if(run.state!=='unavailable'||run.reason!=='invalid_evidence'||run.prompt_version!==QUALIFICATION_PROMPT_VERSION||run.policy_version!==QUALIFICATION_POLICY_VERSION)return fail('evidence_unavailable');
 const audits=(await ctx.db.query<{detail:{diagnostic?:{phase?:string;extraction?:{stage?:string;code?:string}}}}>("SELECT detail FROM audit_events WHERE workspace_id=$1 AND subject_id=$2 AND action='sourcing.qualification_recorded' AND detail->>'runId'=$3",[ctx.scope.workspaceId,input.candidateId,run.id])).rows;
 if(audits.length!==1||audits[0]?.detail.diagnostic?.phase!=='extraction_rejected'||audits[0]?.detail.diagnostic?.extraction?.stage!=='citation_roles'||audits[0]?.detail.diagnostic?.extraction?.code!=='identity_not_literal')return fail('rejection_provenance_required');
 if(!qualificationEvidenceSchema.safeParse({observations:run.observations,facts:run.facts}).success||Buffer.byteLength(JSON.stringify(run.observations))>100000)return fail('invalid_evidence');
 return {ok:true,value:{candidate,run,now:await retainedWallNow(ctx)}};
}
const host=(url:string)=>new URL(url).hostname.toLowerCase().replace(/^www\./u,'');
export function resolveRetainedCitation(observations:readonly SourceObservation[],citation:{observationId:string;blockId:string;contentHash:string;relevantTextHash:string},website:string,now:string):{source:SourceObservation;text:string}|null{
 const source=observations.find(s=>s.id===citation.observationId),block=source?.blocks.find(b=>b.id===citation.blockId);
 if(!source||!block||block.text.length>2000||!source.firstParty||source.truncated||source.contentHash!==citation.contentHash||source.relevantTextHash!==citation.relevantTextHash)return null;
 if(createHash('sha256').update(JSON.stringify(source.blocks)).digest('hex')!==source.relevantTextHash)return null;
 const age=Date.parse(now)-Date.parse(source.retrievedAt);
 try{if(host(source.url)!==host(website)||age<0||age>7*86400000)return null;}catch{return null;}
 return {source,text:block.text};
}
export function literalName(text:string,start:number,end:number):string|null{
 const splits=(at:number)=>at>0&&at<text.length&&/[\uD800-\uDBFF]/u.test(text[at-1]!)&&/[\uDC00-\uDFFF]/u.test(text[at]!);
 if(start<0||end>text.length||start>=end||splits(start)||splits(end))return null;
 const name=text.slice(start,end);
 return name===name.trim()&&name.length>=2&&name.length<=300&&/[\p{L}\p{N}]/u.test(name)?name:null;
}
