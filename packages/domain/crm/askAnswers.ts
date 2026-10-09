import {askAnswerAcknowledgmentSchema,askAnswerRequestPayloadSchema,askAnswerReadResultSchema,askAnswerSourceResultSchema,crmClaimContextSchema,crmOriginalAccessClosureSchema,type AskAnswerRequest} from '@fss/contracts';
import {createHash} from 'node:crypto';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {activeIdentityActor} from './identityAccess.ts';
import {lockConflictSources,originalSourceAccessClosure} from './evidenceDecisions.ts';
import {readProcessingContext} from './processingContext.ts';
import {resolveCrmSource} from './sourceResolver.ts';
import {createNativeCrmMailEvidence} from './nativeMailEvidence.ts';
import {readAskCorpus} from './askCorpus.ts';
import {readAskPurpose} from './askAnswerAuthority.ts';
import {enqueueJob} from '../jobs/jobStore.ts';

const copiedMail=createNativeCrmMailEvidence();

/** Private inputs are retained only after the complete selected copy closure is locked. */
export async function requestAskAnswer(context:RepositoryContext,input:AskAnswerRequest){
 const actor=context.scope.actor;
 if(actor.kind!=='user'||!await activeIdentityActor(context)||!await lockConflictSources(context,input.scope.sources))return {ok:false as const,reason:'source_unavailable'};
 const contexts=[];
 const closures=[];
 for(const source of input.scope.sources){
  if(await resolveCrmSource(context,source,copiedMail)===null)return {ok:false as const,reason:'source_unavailable'};
  const current=await readProcessingContext(context,source,copiedMail);
  const original=await originalSourceAccessClosure(context,source);
  if(current===null||original===null)return {ok:false as const,reason:'source_unavailable'};
  contexts.push(current);
  closures.push(original);
 }
 if(!await lockConflictSources(context,input.scope.sources,contexts,closures))return {ok:false as const,reason:'source_unavailable'};
 const closure={firmIds:[...new Set([...closures.flatMap(value=>value.firmIds),...contexts.flatMap(value=>value.firmIds)])].sort(),personIds:[...new Set([...closures.flatMap(value=>value.personIds),...contexts.flatMap(value=>value.personId===null?[]:[value.personId])])].sort()};
 const purpose=await readAskPurpose(context,'answer');
 const state=purpose===null?'unavailable':'pending';
 const row=(await context.db.query<{id:string;version:number;epoch:number}>(`INSERT INTO crm_ask_requests(workspace_id,owner_user_id,question,scope,initial_contexts,initial_access_closure,state,reason,purpose_revision,evaluation_fingerprint) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10) RETURNING id,version,epoch`,[context.scope.workspaceId,actor.userId,input.question,JSON.stringify(input.scope),JSON.stringify(contexts),JSON.stringify(closure),state,purpose===null?'purpose_unavailable':null,purpose?.revision??null,purpose?.evaluationFingerprint??null])).rows[0]!;
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
 const metadata={requestId:row.id,version:row.version,createdAt:row.created_at.toISOString(),state:row.state,reason:row.reason};
 const unavailable=()=>askAnswerReadResultSchema.parse({...metadata,state:row.state==='complete'?'stale':row.state,reason:row.state==='deleted'?'deleted':'source_unavailable',question:null,fallback:null,answer:null});
 if(row.state==='deleted'||row.state==='stale')return unavailable();
 const input=askAnswerRequestPayloadSchema.safeParse({question:row.question,scope:row.scope});
 const originals=crmOriginalAccessClosureSchema.safeParse(row.initial_access_closure);
 const contexts=crmClaimContextSchema.array().max(10).safeParse(row.initial_contexts);
 if(!input.success||!originals.success||!contexts.success||contexts.data.length!==input.data.scope.sources.length)return unavailable();
 const sources=input.data.scope.sources;
 if(!await lockConflictSources(context,sources,contexts.data,[originals.data]))return unavailable();
 for(const [index,source] of sources.entries()){
  if(await resolveCrmSource(context,source,copiedMail)===null)return unavailable();
  const current=await readProcessingContext(context,source,copiedMail);
  if(JSON.stringify(current)!==JSON.stringify(contexts.data[index]))return unavailable();
 }
 const locked=(await context.db.query<PrivateRequest>('SELECT * FROM crm_ask_requests WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 FOR SHARE',[context.scope.workspaceId,requestId,actor.userId])).rows[0];
 if(locked===undefined||locked.version!==row.version||locked.epoch!==row.epoch||locked.state!==row.state||JSON.stringify(locked.scope)!==JSON.stringify(row.scope)||locked.question!==row.question)return unavailable();
 const fallback=await readAskCorpus(context,{scope:input.data.scope,query:input.data.question,limit:20});
 if(fallback===null||!await activeIdentityActor(context))return unavailable();
 return askAnswerReadResultSchema.parse({...metadata,question:input.data.question,fallback,answer:row.state==='complete'?row.result:null});
}
