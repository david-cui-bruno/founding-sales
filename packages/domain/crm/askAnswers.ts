import {askAnswerAcknowledgmentSchema,askAnswerRequestPayloadSchema,askAnswerReadResultSchema,crmClaimContextSchema,crmOriginalAccessClosureSchema,type AskAnswerRequest} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {activeIdentityActor} from './identityAccess.ts';
import {lockConflictSources,originalSourceAccessClosure} from './evidenceDecisions.ts';
import {readProcessingContext} from './processingContext.ts';
import {resolveCrmSource} from './sourceResolver.ts';
import {createNativeCrmMailEvidence} from './nativeMailEvidence.ts';
import {readAskCorpus} from './askCorpus.ts';

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
 const closure={firmIds:[...new Set(closures.flatMap(value=>value.firmIds))].sort(),personIds:[...new Set(closures.flatMap(value=>value.personIds))].sort()};
 const row=(await context.db.query<{id:string;version:number}>(`INSERT INTO crm_ask_requests(workspace_id,owner_user_id,question,scope,initial_contexts,initial_access_closure,state,reason) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,'unavailable','purpose_unavailable') RETURNING id,version`,[context.scope.workspaceId,actor.userId,input.question,JSON.stringify(input.scope),JSON.stringify(contexts),JSON.stringify(closure)])).rows[0]!;
 return {ok:true as const,value:askAnswerAcknowledgmentSchema.parse({requestId:row.id,version:row.version,state:'unavailable'})};
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
