import {readAskScopedExact} from './askInvestigationRecords.ts';
import {readAskExecutionEvidence} from './askExecutionEvidence.ts';
import {askToolFirmIds} from './askAgentScope.ts';
import {askAgentScopeSchema} from '@fss/contracts';
import {askIdentityClarificationSchema,askSupportedWorkSchema,askExplicitCorpusScopeSchema,askGroundedAnswerSchema,askAnswerAcknowledgmentSchema,askAnswerRequestPayloadSchema,askAnswerReadResultSchema,askAnswerSourceResultSchema,crmClaimContextSchema,crmOriginalAccessClosureSchema,type AskAnswerRequest,type AskAnswerReadResult} from '@fss/contracts';
import {readAsk} from './ask.ts';
import {askFingerprint} from './askAnswerAuthority.ts';
import {resolveAskAgentScope} from './askAgentScope.ts';
import {createHash} from 'node:crypto';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {activeIdentityActor} from './identityAccess.ts';
import {lockConflictSources,originalSourceAccessClosure} from './evidenceDecisions.ts';
import {readProcessingContext} from './processingContext.ts';
import {resolveCrmSource} from './sourceResolver.ts';
import {createNativeCrmMailEvidence} from './nativeMailEvidence.ts';
import {readAskCorpus} from './askCorpus.ts';
import {readAskInputConflicts} from './askAnswerConflicts.ts';
import {readAskPurpose} from './askAnswerAuthority.ts';
import {enqueueJob} from '../jobs/jobStore.ts';

const copiedMail=createNativeCrmMailEvidence();

/** Private inputs are retained only after the complete selected copy closure is locked. */
export async function requestAskAnswer(context:RepositoryContext,input:AskAnswerRequest){
 const resolvedScope=input.execution==='agent_v1'&&input.agentScope?await resolveAskAgentScope(context,input.agentScope):null;
 if(input.agentScope&&resolvedScope===null)return {ok:false as const,reason:'source_unavailable'};
 if(resolvedScope)input={...input,scope:{sources:resolvedScope.sources}};
 const actor=context.scope.actor;
 if(actor.kind!=='user'||!await activeIdentityActor(context)||!await lockConflictSources(context,input.scope.sources))return {ok:false as const,reason:'source_unavailable'};
 const contexts=[];
 const closures=[];
 for(const source of input.scope.sources){
  if(await resolveCrmSource(context,source,copiedMail)===null)return {ok:false as const,reason:'source_unavailable'};
  const current=await readProcessingContext(context,source,copiedMail);
  let original=await originalSourceAccessClosure(context,source);
  if(original===null&&current!==null&&(source.kind==='call_transcript'||source.kind==='meeting_transcript')){
   const history=await context.db.query('SELECT id FROM crm_extraction_generations WHERE workspace_id=$1 AND source_kind=$2 AND source_id=$3 LIMIT 1',[context.scope.workspaceId,source.kind,source.sourceId]);
   if(history.rows.length===0&&current.firmIds.length>0)original={firmIds:[...current.firmIds],personIds:current.personId===null?[]:[current.personId]};
  }
  if(current===null||original===null)return {ok:false as const,reason:'source_unavailable'};
  contexts.push(current);
  closures.push(original);
 }
 if(!await lockConflictSources(context,input.scope.sources,contexts,closures))return {ok:false as const,reason:'source_unavailable'};
 const closure={firmIds:[...new Set([...closures.flatMap(value=>value.firmIds),...contexts.flatMap(value=>value.firmIds),...resolvedScope?.firmIds??[]])].sort(),personIds:[...new Set([...closures.flatMap(value=>value.personIds),...contexts.flatMap(value=>value.personId===null?[]:[value.personId]),...resolvedScope?.personIds??[]])].sort()};
 const purpose=await readAskPurpose(context,'answer');
 const state=purpose===null?'unavailable':'pending';
 const row=(await context.db.query<{id:string;version:number;epoch:number}>(`INSERT INTO crm_ask_requests(workspace_id,owner_user_id,question,scope,initial_contexts,initial_access_closure,state,reason,purpose_revision,evaluation_fingerprint,execution_version,original_agent_scope) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12::jsonb) RETURNING id,version,epoch`,[context.scope.workspaceId,actor.userId,input.question,JSON.stringify(input.scope),JSON.stringify(contexts),JSON.stringify(closure),state,purpose===null?'purpose_unavailable':null,purpose?.revision??null,purpose?.evaluationFingerprint??null,input.execution??'legacy_v1',input.agentScope?JSON.stringify(input.agentScope):null])).rows[0]!;
 if(state==='pending')await enqueueJob(context.db,{workspaceId:context.scope.workspaceId,kind:'crm.ask_answer',idempotencyKey:`ask-answer:${row.id}:${row.version}:${row.epoch}`,payload:{requestId:row.id,version:row.version,epoch:row.epoch},maxAttempts:3});
 return {ok:true as const,value:askAnswerAcknowledgmentSchema.parse({requestId:row.id,version:row.version,state})};
}

/** Navigation only resolves server-frozen canonical windows under the live request closure. */
export async function readAskAnswerSource(context:RepositoryContext,input:{requestId:string;expectedVersion:number;windowId:string}){
 const request=await readAskAnswer(context,input.requestId);
 if(request===null||request.version!==input.expectedVersion||request.state!=='complete'||request.answer===null)return null;
 const row=(await context.db.query<{source_kind:'selected_note'|'mail'|'call_transcript'|'meeting_transcript';source_id:string;source_revision:number;source_hash:string;locator:string;text_hash:string}>(`SELECT w.* FROM crm_ask_request_windows w JOIN crm_ask_requests r ON r.workspace_id=w.workspace_id AND r.id=w.request_id AND r.version=w.request_version AND r.epoch=w.request_epoch WHERE w.workspace_id=$1 AND w.request_id=$2 AND w.id=$3 AND w.request_version=$4`,[context.scope.workspaceId,input.requestId,input.windowId,input.expectedVersion])).rows[0];
 if(row===undefined)return null;
 const resolved=await resolveCrmSource(context,{workspaceId:context.scope.workspaceId,kind:row.source_kind,sourceId:row.source_id,revision:row.source_revision,contentHash:row.source_hash,locator:row.locator},copiedMail);
 if(resolved===null||resolved.passage===null||createHash('sha256').update(resolved.passage.text).digest('hex')!==row.text_hash)return null;
 return askAnswerSourceResultSchema.parse({requestId:input.requestId,version:input.expectedVersion,windowId:input.windowId,source:{state:resolved.state,source:resolved.source,extent:resolved.extent,passage:resolved.passage}});
}

interface PrivateRequest extends Record<string,unknown>{id:string;owner_user_id:string;version:number;epoch:number;created_at:Date;question:string|null;scope:unknown;initial_contexts:unknown;initial_access_closure:unknown;state:string;reason:string|null;result:unknown}
/** Saved input is not authority: every read checks its initial and current copy closure. */
export async function readAskAnswer(context:RepositoryContext,requestId:string){
 const actor=context.scope.actor;
 if(actor.kind!=='user'||!await activeIdentityActor(context))return null;
 const row=(await context.db.query<PrivateRequest>('SELECT * FROM crm_ask_requests WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3',[context.scope.workspaceId,requestId,actor.userId])).rows[0];
 if(row===undefined)return null;
 const metadata={requestId:row.id,version:row.version,createdAt:row.created_at.toISOString(),state:row.state,reason:row.reason,...row['execution_version']==='agent_v1'?{execution:'agent_v1',progress:{completedSteps:Number(row['completed_steps']),stage:row['progress_stage'],cancelledAt:row['cancelled_at'] instanceof Date?row['cancelled_at'].toISOString():null}}:{}};
 const unavailable=()=>askAnswerReadResultSchema.parse({...metadata,state:row.state==='complete'?'stale':row.state,reason:row.state==='deleted'?'deleted':row.state==='stale'?(row.reason??'source_changed'):'source_unavailable',question:null,fallback:null,answer:null});
 if(row.state==='deleted'||row.state==='stale'||row.reason==='source_unavailable')return unavailable();
 const input=askAnswerRequestPayloadSchema.safeParse({question:row.question,scope:row.scope,execution:row['execution_version']});
 const originals=crmOriginalAccessClosureSchema.safeParse(row.initial_access_closure);
 const contexts=crmClaimContextSchema.array().max(10).safeParse(row.initial_contexts);
 if(!input.success||!originals.success||!contexts.success||contexts.data.length!==input.data.scope.sources.length)return unavailable();
 const intent=askAgentScopeSchema.safeParse(row['original_agent_scope']);
 if(row['original_agent_scope']!==null&&row['original_agent_scope']!==undefined&&!intent.success)return unavailable();
 const evidence=await readAskExecutionEvidence(context,{requestId,version:row.version,epoch:row.epoch});if(!evidence)return unavailable();
 input.data.scope=evidence.scope;contexts.data=evidence.contexts;originals.data=evidence.closure;
 const sources=input.data.scope.sources;
 if(!await lockConflictSources(context,sources,contexts.data,[originals.data]))return unavailable();
 for(const [index,source] of sources.entries()){
  if(await resolveCrmSource(context,source,copiedMail)===null)return unavailable();
  const current=await readProcessingContext(context,source,copiedMail);
  if(JSON.stringify(current)!==JSON.stringify(contexts.data[index]))return unavailable();
 }
 const locked=(await context.db.query<PrivateRequest>('SELECT * FROM crm_ask_requests WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 FOR SHARE',[context.scope.workspaceId,requestId,actor.userId])).rows[0];
 if(locked===undefined||locked.version!==row.version||locked.epoch!==row.epoch||locked.state!==row.state||JSON.stringify(locked.scope)!==JSON.stringify(row.scope)||locked.question!==row.question)return unavailable();
 if(row.state==='complete'){
  const conflicts=await readAskInputConflicts(context,input.data.scope,originals.data);
  if(conflicts===null)return askAnswerReadResultSchema.parse({...metadata,state:'unavailable',reason:'input_bound_reached',question:null,fallback:null,answer:null});
  const result=askGroundedAnswerSchema.safeParse(row.result);
  if(!result.success||JSON.stringify(conflicts.map(value=>[value.conflictId,value.revision,value.state,value.resolution]))!==JSON.stringify(result.data.conflicts.map(value=>[value.conflictId,value.revision,value.state,value.resolution])))return askAnswerReadResultSchema.parse({...metadata,state:'stale',reason:'source_changed',question:null,fallback:null,answer:null});
 }
 const fallback=input.data.scope.sources.length===0?null:await readAskCorpus(context,{scope:askExplicitCorpusScopeSchema.parse(input.data.scope),query:input.data.question,limit:20});
 if((fallback===null&&input.data.scope.sources.length>0)||!await activeIdentityActor(context))return unavailable();
 const finalAnswer=row.state==='complete'?askGroundedAnswerSchema.parse(row.result):null;
 const mixedReferences=finalAnswer?.claims.flatMap(claim=>claim.exactResultToolCallIds??[])??[];
 const storedExact=finalAnswer?.exactResults??[];
 const storedExactIds=new Set(storedExact.map(exact=>exact.toolCallId));
 if(mixedReferences.length>0&&(finalAnswer?.resultVersion!=='agent_v1'||storedExactIds.size!==storedExact.length||finalAnswer.claims.some(claim=>new Set(claim.exactResultToolCallIds??[]).size!==(claim.exactResultToolCallIds??[]).length)||mixedReferences.some(id=>!storedExactIds.has(id))))return unavailable();
 const completed=askSupportedWorkSchema.safeParse(finalAnswer?.exactResults?{exactResults:finalAnswer.exactResults}:row['validated_progress']);
 const intentFirmIds=askToolFirmIds(intent.success?intent.data:null,originals.data.firmIds);
 const exactResults=[];
 if(completed.success)for(const exact of completed.data.exactResults){
  const value=exact.value as {scope?:{firmId?:string}};
  const firmId=value?.scope?.firmId;
  if(firmId&&!intent.success&&!intentFirmIds.includes(firmId))continue;
  if(!firmId&&(!intent.success||!['business','person'].includes(intent.data.kind)))continue;
  const refreshed=intent.success?await readAskScopedExact(context,intent.data,{operation:exact.operation,...firmId?{firmId}:{},limit:20,status:'all'}):firmId?await readAsk(context,exact.operation==='opportunities'?{operation:'opportunities',scope:{firmId},limit:20,status:'all'}:exact.operation==='tasks'?{operation:'tasks',scope:{firmId},limit:20}:{operation:'reply_status',scope:{firmId}}):null;
  if(refreshed!==null&&askFingerprint(refreshed)===exact.valueHash)exactResults.push(exact);
 }
 const currentExactIds=new Set(exactResults.map(exact=>exact.toolCallId));
 if(mixedReferences.some(id=>!currentExactIds.has(id)))return askAnswerReadResultSchema.parse({...metadata,state:'stale',reason:'source_changed',question:null,fallback:null,answer:null});
 const clarification=askIdentityClarificationSchema.safeParse(row['clarification']);
 return askAnswerReadResultSchema.parse({...metadata,question:input.data.question,fallback,...clarification.success?{clarification:clarification.data}:{},...exactResults.length?{supportedWork:{exactResults}}:{},answer:finalAnswer===null?null:{...finalAnswer,...finalAnswer.exactResults?{exactResults,missingEvidence:exactResults.length===finalAnswer.exactResults.length?finalAnswer.missingEvidence:[...new Set([...finalAnswer.missingEvidence,'exact_state_changed'])]}:{}}});
}

/** Older strict readers cannot express mixed proof. Never downgrade SQL-derived
 * narrative to an original-only claim or shift its stored action index. */
export function projectAskAnswerForClient(value:AskAnswerReadResult,includeExactResultCitations:boolean):AskAnswerReadResult{
 if(includeExactResultCitations)return value;
 if(value.answer?.claims.some(claim=>(claim.exactResultToolCallIds?.length??0)>0))return askAnswerReadResultSchema.parse({requestId:value.requestId,version:value.version,createdAt:value.createdAt,state:'unavailable',reason:'unsupported_answer',question:value.question,fallback:value.fallback,answer:null});
 if(value.answer===null)return value;
 return {...value,answer:{...value.answer,claims:value.answer.claims.map(claim=>{const legacy={...claim};delete legacy.exactResultToolCallIds;return legacy;})}};
}
