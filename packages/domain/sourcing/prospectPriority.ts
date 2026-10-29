import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {prospectPriorityListInputSchema,prospectPriorityListSchema,prospectPrioritySaveInputSchema,prospectPriorityConsiderInputSchema,prospectPriorityReviewSchema,type ProspectPriorityReview,type ProspectPrioritySaveInput,type ProspectPriorityConsiderInput} from '@fss/contracts';
import type {z} from 'zod';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {listManualProspectSelection} from './manualProspects.ts';
import {readManualProspectSubject} from './manualProspectRows.ts';
import {lockDiscoveryReviewSources} from './discoveryReviewVisibility.ts';
import {requireManualActivityAuthority,currentManualActivityAuthority,lockManualActivityCandidate,type ManualActivityAuthority} from './manualProspectActivityAccess.ts';
import {priorityOrder,priorityAssessment,type PriorityOrderRow} from './prospectPriorityStore.ts';
import {currentPriorityRoles,priorityRoleCandidates} from './prospectPriorityRoles.ts';
import {currentProspectPriorityAuthority,prioritySourceKey,ProspectPriorityChanged} from './prospectPriorityAccess.ts';
export {currentProspectPriorityAuthority,ProspectPriorityChanged};
export {readProspectPriorityLearning} from './prospectPriorityLearning.ts';
type Result<T>={ok:true;value:T}|{ok:false;reason:string};
const no=(reason:string):{ok:false;reason:string}=>({ok:false,reason});
const iso=(value:string|null):string|null=>value===null?null:new Date(value).toISOString();
async function review(ctx:RepositoryContext,row:PriorityOrderRow,phone:boolean):Promise<ProspectPriorityReview>{
 const roles=await currentPriorityRoles(ctx,row.id,row.roles),choices=await priorityRoleCandidates(ctx,row.id);
 const reasons:ProspectPriorityReview['reasons']=[];
 if(row.source_url&&row.decided_at){
  const source={sourceUrl:row.source_url,decidedAt:new Date(row.decided_at).toISOString()};
  if(row.fit==='positive')reasons.push({...source,code:'human_fit'});if(row.fit==='negative')reasons.push({...source,code:'human_wrong_fit'});
  if(row.value==='positive')reasons.push({...source,code:'human_value'});if(row.timing==='positive')reasons.push({...source,code:'human_timing'});
 }
 return prospectPriorityReviewSchema.parse({policyVersion:'prospect-priority-v1',band:row.fit==='negative'?'wrong_fit':row.fit==='positive'||row.value==='positive'||row.timing==='positive'?'evidence_supported':'ordinary',
 fit:row.fit,value:row.value,timing:row.timing,roles,roleState:roles.some(role=>role.basis!=='hypothesis')?'supported':roles.length?'hypothesis':'unknown',roleCandidates:choices.candidates,roleCandidatesHasMore:choices.hasMore,
 nextAction:row.fit==='negative'?'review_wrong_fit':row.fit==='unknown'?'review_fit':!roles.some(role=>role.basis!=='hypothesis')?'research_person':!phone?'research_route':'review_contact_readiness',
 assessmentRevision:row.assessment_revision,lastConsideredAt:iso(row.last_considered_at),consideredCount:row.considered_count,reasons});
}
/** Current opt-in interface only. Old strict manual-list behavior remains unchanged. */
export async function listProspectPriority(ctx:RepositoryContext,input:z.infer<typeof prospectPriorityListInputSchema>,authority:ManualActivityAuthority=async()=>true):Promise<Result<z.infer<typeof prospectPriorityListSchema>>>{
 if(!prospectPriorityListInputSchema.safeParse(input).success)return no('invalid_input');
 await lockDiscoveryReviewSources(ctx);await requireManualActivityAuthority(ctx,authority);
 const initial=await priorityOrder(ctx,input.state,input.offset);
 if(input.viewRevision&&input.viewRevision!==initial.viewRevision)return no('view_changed');
 const metadata:ProspectPriorityReview[]=[];
 for(const row of initial.rows.slice(0,50))metadata.push(await review(ctx,row,false));
 for(let i=0;i<metadata.length;i++)if(!isDeepStrictEqual(metadata[i],await review(ctx,initial.rows[i]!,false)))return no('view_changed');
 // Final batched projection revalidates every optional phone at a shared final clock.
 // Its authority callback also revalidates role/name detail after all possible waits.
 const finalAuthority=async():Promise<boolean>=>{
  if(!await authority())return false;
  for(let i=0;i<metadata.length;i++)if(!isDeepStrictEqual(metadata[i],await review(ctx,initial.rows[i]!,false)))return false;
  if(!await authority())return false;
  return isDeepStrictEqual(initial,await priorityOrder(ctx,input.state,input.offset));
 };
 const page=await listManualProspectSelection(ctx,{state:input.state,offset:0,...(input.includeManualPhone?{includeManualPhone:true}:{})},initial.rows.slice(0,50),finalAuthority,now=>{
  if(initial.rows.slice(0,50).some(row=>row.expires_at!==null&&Date.parse(row.expires_at)<=now))throw new ProspectPriorityChanged('view_changed');
 });
 if(!page.ok)return page;if(page.value.prospects.length!==metadata.length)return no('view_changed');
 // No external/identity waits after the batch's final phone/source clock.
 const prospects=page.value.prospects.map((prospect,index)=>{
  const priority=metadata[index]!;
  const nextAction=priority.nextAction==='research_route'&&prospect.phoneEvidence?.state==='observed'?'review_contact_readiness':priority.nextAction;
  return {prospect,priority:{...priority,nextAction}};
 });
 return {ok:true,value:prospectPriorityListSchema.parse({prospects,hasMore:initial.rows.length>50,viewRevision:initial.viewRevision})};
}
export async function saveProspectPriority(ctx:RepositoryContext,input:ProspectPrioritySaveInput,authority:ManualActivityAuthority=async()=>true){
 if(!prospectPrioritySaveInputSchema.safeParse(input).success)return no('invalid_input');
 await lockManualActivityCandidate(ctx,input.candidateId,input.expectedCandidateRevision);
 await currentManualActivityAuthority(ctx,input.candidateId,input.expectedCandidateRevision,authority);
 const subject=await readManualProspectSubject(ctx,{candidateId:input.candidateId,expectedRevision:input.expectedCandidateRevision});
 if(!subject?.source_urls.includes(input.sourceUrl.replace(/\/$/u,'')))return no('source_unavailable');
 const old=await priorityAssessment(ctx,input.candidateId);
 if((old?.revision??0)!==input.expectedAssessmentRevision)return no('assessment_changed');
 const roles=await currentPriorityRoles(ctx,input.candidateId,input.roles);
 if(!isDeepStrictEqual(roles,input.roles)||new Set(roles.map(r=>`${r.relationshipId}:${r.role}`)).size!==roles.length)return no('role_unavailable');
 await currentManualActivityAuthority(ctx,input.candidateId,input.expectedCandidateRevision,authority);
 const key=await prioritySourceKey(ctx,input.candidateId,input.expectedCandidateRevision);if(!key)return no('source_unavailable');
 await ctx.db.query(`INSERT INTO sourcing_prospect_priorities(workspace_id,candidate_id,candidate_revision,revision,owner_user_id,fit,value,timing,source_url,source_key,roles,decided_at,expires_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,statement_timestamp(),statement_timestamp()+interval '30 days')
 ON CONFLICT(workspace_id,candidate_id) DO UPDATE SET candidate_revision=EXCLUDED.candidate_revision,revision=EXCLUDED.revision,owner_user_id=EXCLUDED.owner_user_id,fit=EXCLUDED.fit,value=EXCLUDED.value,timing=EXCLUDED.timing,source_url=EXCLUDED.source_url,source_key=EXCLUDED.source_key,roles=EXCLUDED.roles,decided_at=EXCLUDED.decided_at,expires_at=EXCLUDED.expires_at`,
 [ctx.scope.workspaceId,input.candidateId,input.expectedCandidateRevision,input.expectedAssessmentRevision+1,ctx.scope.actor.kind==='user'?ctx.scope.actor.userId:null,input.fit,input.value,input.timing,input.sourceUrl,key,JSON.stringify(roles)]);
 await currentProspectPriorityAuthority(ctx,input,authority);
 return {ok:true as const,value:{candidateId:input.candidateId,candidateRevision:input.expectedCandidateRevision,assessmentRevision:input.expectedAssessmentRevision+1}};
}
export async function considerProspectPriority(ctx:RepositoryContext,input:ProspectPriorityConsiderInput,authority:ManualActivityAuthority=async()=>true){
 if(!prospectPriorityConsiderInputSchema.safeParse(input).success)return no('invalid_input');
 await lockManualActivityCandidate(ctx,input.candidateId,input.expectedCandidateRevision);
 await currentManualActivityAuthority(ctx,input.candidateId,input.expectedCandidateRevision,authority);
 const assessment=await priorityAssessment(ctx,input.candidateId);
 if((assessment?.revision??0)!==input.expectedAssessmentRevision)return no('assessment_changed');
 const clock=(await ctx.db.query<{at:Date}>('SELECT clock_timestamp() at')).rows[0]!.at;
 const current=assessment&&assessment.expires_at>clock&&assessment.source_key===await prioritySourceKey(ctx,input.candidateId,input.expectedCandidateRevision)?assessment:null;
 const roles=current?await currentPriorityRoles(ctx,input.candidateId,current.roles):[];
 if(current&&!isDeepStrictEqual(roles,current.roles))return no('role_unavailable');
 const sourceIds=(await ctx.db.query<{source_id:string}>('SELECT DISTINCT source_id FROM crm_relationships WHERE workspace_id=$1 AND id=ANY($2::uuid[])',[ctx.scope.workspaceId,roles.map(role=>role.relationshipId)])).rows.map(row=>row.source_id);
 const selectedSourceKey=await prioritySourceKey(ctx,input.candidateId,input.expectedCandidateRevision);if(!selectedSourceKey)return no('source_unavailable');
 const afterRoles=(await ctx.db.query<{at:Date}>('SELECT clock_timestamp() at')).rows[0]!.at;
 if(current&&current.expires_at<=afterRoles)throw new ProspectPriorityChanged('source_expired');
 const id=randomUUID();
 const inserted=await ctx.db.query(`INSERT INTO sourcing_prospect_considerations(workspace_id,candidate_id,candidate_revision,id,owner_user_id,assessment_revision,disposition,policy_version,fit,value,timing,roles,source_key,source_url,decided_at,role_kinds,role_source_ids,occurred_at,expires_at)
 SELECT $1,$2,$3,$4,$5,$6,$7,'prospect-priority-v1',$8,$9,$10,$11::jsonb,$13,$14,$15,$16::text[],$17::uuid[],statement_timestamp(),LEAST(statement_timestamp()+interval '30 days',COALESCE($12::timestamptz,statement_timestamp()+interval '30 days')) WHERE $12::timestamptz IS NULL OR $12::timestamptz>statement_timestamp()` ,
 [ctx.scope.workspaceId,input.candidateId,input.expectedCandidateRevision,id,ctx.scope.actor.kind==='user'?ctx.scope.actor.userId:null,input.expectedAssessmentRevision,input.disposition,current?.fit??'unknown',current?.value??'unknown',current?.timing??'unknown',JSON.stringify(roles),current?.expires_at??null,selectedSourceKey,current?.source_url??null,current?.decided_at??null,[...new Set(roles.map(r=>r.role))].sort(),sourceIds]);
 if(inserted.rowCount!==1)throw new ProspectPriorityChanged('source_expired');
 if(current)await currentProspectPriorityAuthority(ctx,input,authority);else await currentManualActivityAuthority(ctx,input.candidateId,input.expectedCandidateRevision,authority);
 return {ok:true as const,value:{candidateId:input.candidateId,candidateRevision:input.expectedCandidateRevision,assessmentRevision:input.expectedAssessmentRevision,considerationId:id}};
}
