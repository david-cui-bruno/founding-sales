import {z} from 'zod';
import {askActionChangedSchema,askActionAcknowledgmentSchema,askActionPageSchema,askExplicitCorpusScopeSchema,crmClaimContextSchema,crmOriginalAccessClosureSchema,crmSourceLookupSchema,type AskActionChange,type AskActionCreate,type AskActionRead,type CanonicalSourceReference} from '@fss/contracts';
import {withTransaction,type SessionQueryable} from '../db/queryable.ts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {activeIdentityActor} from './identityAccess.ts';
import {lockAskLifecycle} from './askAnswerLifecycle.ts';
import {readAskAnswer,readAskAnswerSource} from './askAnswers.ts';
import {lockConflictSources} from './evidenceDecisions.ts';
import {resolveCrmSource} from './sourceResolver.ts';
import {readProcessingContext} from './processingContext.ts';
import {createNativeCrmMailEvidence} from './nativeMailEvidence.ts';
const copiedMail=createNativeCrmMailEvidence();
const supportSchema=crmSourceLookupSchema.extend({contentHash:z.string().regex(/^[a-f0-9]{64}$/u),locator:z.string().min(1).max(500)}).strict().array().min(1).max(10);
interface ActionProof extends Record<string,unknown>{id:string;version:number;kind:'task'|'note'|'preference';status:'active'|'open'|'done'|'cancelled'|'proposed'|'dismissed';private_state:'available'|'stale'|'deleted';target_firm_id:string|null;target_person_id:string|null;input_scope:unknown;initial_contexts:unknown;original_access_closure:unknown;support_refs:unknown;review_required:boolean;created_at:Date;updated_at:Date;completed_at:Date|null}
/** Independent immutable source proof; saved history is not needed to authorize an action. */
async function currentActionSupport(context:RepositoryContext,row:ActionProof){
 if(row.private_state!=='available')return {state:row.private_state,sources:[] as CanonicalSourceReference[]};
 const scope=askExplicitCorpusScopeSchema.safeParse(row.input_scope),contexts=crmClaimContextSchema.array().max(10).safeParse(row.initial_contexts),original=crmOriginalAccessClosureSchema.safeParse(row.original_access_closure),support=supportSchema.safeParse(row.support_refs);
 if(!scope.success||!contexts.success||!original.success||!support.success||contexts.data.length!==scope.data.sources.length)return {state:'unavailable' as const,sources:[] as CanonicalSourceReference[]};
 if(!await lockConflictSources(context,scope.data.sources,contexts.data,[original.data]))return {state:'unavailable' as const,sources:[] as CanonicalSourceReference[]};
 for(const [index,source] of scope.data.sources.entries()){
  if(await resolveCrmSource(context,source,copiedMail)===null)return {state:'unavailable' as const,sources:[] as CanonicalSourceReference[]};
  const current=await readProcessingContext(context,source,copiedMail);
  if(JSON.stringify(current)!==JSON.stringify(contexts.data[index]))return {state:'stale' as const,sources:[] as CanonicalSourceReference[]};
 }
 const sources:CanonicalSourceReference[]=[];
 for(const source of support.data){
  if(!scope.data.sources.some(input=>input.kind===source.kind&&input.sourceId===source.sourceId&&input.revision===source.revision&&input.contentHash===source.contentHash&&input.workspaceId===source.workspaceId))return {state:'unavailable' as const,sources:[] as CanonicalSourceReference[]};
  const resolved=await resolveCrmSource(context,source,copiedMail);
  if(resolved===null||resolved.passage===null)return {state:'unavailable' as const,sources:[] as CanonicalSourceReference[]};
  sources.push(resolved.source);
 }
 return {state:'current' as const,sources};
}
/** A human action may use a current keyword finding even when model purposes are disabled. */
export async function createAskAction(context:RepositoryContext,input:AskActionCreate){
 const actor=context.scope.actor;if(actor.kind!=='user'||!await activeIdentityActor(context))return {ok:false as const,reason:'source_unavailable'};
 await lockAskLifecycle(context);
 const current=await readAskAnswer(context,input.requestId);
 if(current===null||current.question===null||current.version!==input.expectedVersion)return {ok:false as const,reason:'source_unavailable'};
 const row=(await context.db.query<{scope:unknown;initial_contexts:unknown;initial_access_closure:unknown;version:number;epoch:number}>('SELECT scope,initial_contexts,initial_access_closure,version,epoch FROM crm_ask_requests WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 FOR SHARE',[context.scope.workspaceId,input.requestId,actor.userId])).rows[0];
 if(row===undefined||row.version!==input.expectedVersion)return {ok:false as const,reason:'source_unavailable'};
 const scope=askExplicitCorpusScopeSchema.parse(row.scope),contexts=crmClaimContextSchema.array().max(10).parse(row.initial_contexts),original=crmOriginalAccessClosureSchema.parse(row.initial_access_closure);
 const target=input.action.kind==='preference'?null:input.action.target;
 if(target!==null&&!contexts.some(value=>target.kind==='firm'?value.firmIds.includes(target.firmId):value.personId===target.personId))return {ok:false as const,reason:'source_unavailable'};
 let references:CanonicalSourceReference[];
 if(input.finding.kind==='keyword_passage')references=current.fallback?.passages[input.finding.index]?.sources??[];
 else{
  const claim=current.answer?.claims[input.finding.index];if(claim===undefined)return {ok:false as const,reason:'source_unavailable'};
  references=[];
  for(const windowId of claim.citationWindowIds){const result=await readAskAnswerSource(context,{requestId:input.requestId,expectedVersion:input.expectedVersion,windowId});if(result===null||!result.source.passage?.text.includes(claim.text))return {ok:false as const,reason:'source_unavailable'};references.push(result.source.source);}
 }
 const support=supportSchema.safeParse(references.map(({workspaceId,sourceId,kind,revision,contentHash,locator})=>({workspaceId,sourceId,kind,revision,contentHash,locator})));
 if(!support.success)return {ok:false as const,reason:'input_bound_reached'};
 const checked=await currentActionSupport(context,{id:input.requestId,version:1,kind:'note',status:'active',private_state:'available',target_firm_id:target?.kind==='firm'?target.firmId:null,target_person_id:target?.kind==='person'?target.personId:null,input_scope:scope,initial_contexts:contexts,original_access_closure:original,support_refs:support.data,review_required:false,created_at:new Date(),updated_at:new Date(),completed_at:null});
 if(checked.state!=='current')return {ok:false as const,reason:'source_unavailable'};
 const created=(await context.db.query<{id:string;version:number;kind:string}>(`INSERT INTO crm_ask_actions(workspace_id,owner_user_id,source_request_id,source_request_version,kind,status,target_firm_id,target_person_id,human_text,input_scope,initial_contexts,original_access_closure,support_refs,due) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb) RETURNING id,version,kind`,[context.scope.workspaceId,actor.userId,input.requestId,input.expectedVersion,input.action.kind,input.action.kind==='task'?'open':input.action.kind==='note'?'active':'proposed',target?.kind==='firm'?target.firmId:null,target?.kind==='person'?target.personId:null,input.action.kind==='task'?input.action.label:input.action.text,JSON.stringify(scope),JSON.stringify(contexts),JSON.stringify(original),JSON.stringify(support.data),input.action.kind==='task'?JSON.stringify(input.action.due):null])).rows[0]!;
 return {ok:true as const,value:askActionAcknowledgmentSchema.parse({actionId:created.id,version:created.version,kind:created.kind})};
}
/** Private note/task bodies are loaded only after all original input and support checks. */
export async function readAskActions(context:RepositoryContext&{db:SessionQueryable},input:AskActionRead){
 const actor=context.scope.actor;if(actor.kind!=='user'||!await activeIdentityActor(context))return null;
 const scope=input.scope;
 const rows=(await context.db.query<ActionProof>(`SELECT id,version,kind,status,private_state,target_firm_id,target_person_id,input_scope,initial_contexts,original_access_closure,support_refs,review_required,created_at,updated_at,completed_at FROM crm_ask_actions WHERE workspace_id=$1 AND owner_user_id=$2 AND ($3::uuid IS NULL OR id>$3) AND ($4='history' OR $4='person' AND target_person_id=$5::uuid OR $4='firm' AND target_firm_id=$5::uuid OR $4='today' AND kind='task' AND status='open' AND due IS NOT NULL AND CASE due->>'kind' WHEN 'date' THEN (due->>'date')::date <= (clock_timestamp() AT TIME ZONE (due->>'zone'))::date WHEN 'instant' THEN ((due->>'at')::timestamptz AT TIME ZONE (due->>'zone'))::date <= (clock_timestamp() AT TIME ZONE (due->>'zone'))::date ELSE false END) ORDER BY id LIMIT $6`,[context.scope.workspaceId,actor.userId,input.afterId??null,scope.kind,scope.kind==='person'?scope.personId:scope.kind==='firm'?scope.firmId:null,input.limit+1])).rows;
 const items=[];
 for(const row of rows.slice(0,input.limit)){
  const item=await withTransaction(context.db,async()=>{
   const support=await currentActionSupport(context,row);
   const body=support.state==='current'?(await context.db.query<{human_text:string;due:unknown}>('SELECT human_text,due FROM crm_ask_actions WHERE workspace_id=$1 AND owner_user_id=$2 AND id=$3 AND version=$4 AND private_state=\'available\' FOR SHARE',[context.scope.workspaceId,actor.userId,row.id,row.version])).rows[0]:undefined;
   const readable=support.state==='current'&&body!==undefined;
   return {actionId:row.id,version:row.version,kind:row.kind,status:row.status,provenance:'human' as const,createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString(),completedAt:row.completed_at?.toISOString()??null,target:readable?row.target_firm_id!==null?{kind:'firm',firmId:row.target_firm_id}:row.target_person_id!==null?{kind:'person',personId:row.target_person_id}:null:null,label:readable&&row.kind==='task'?body.human_text:null,text:readable&&row.kind!=='task'?body.human_text:null,due:readable?body.due:null,reviewRequired:row.review_required,supportState:readable?'current':support.state==='current'?'unavailable':support.state,sources:readable?support.sources:[]};
  });
  items.push(item);
 }
 if(!await activeIdentityActor(context))return null;
 return askActionPageSchema.parse({items,nextAfterId:rows.length>input.limit?rows[input.limit-1]!.id:null});
}

/** Completing a human task requires current evidence and an exact version. */
export async function changeAskAction(context:RepositoryContext,input:AskActionChange){
 const actor=context.scope.actor;if(actor.kind!=='user'||!await activeIdentityActor(context))return {ok:false as const,reason:'source_unavailable'};
 await lockAskLifecycle(context);
 if(input.action==='dismiss_preference'||input.action==='cancel_task'){
  const changed=(await context.db.query<{id:string;version:number;status:string}>(`UPDATE crm_ask_actions SET status=$5,version=version+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND owner_user_id=$2 AND id=$3 AND version=$4 AND kind=$6 AND status=$7 RETURNING id,version,status`,[context.scope.workspaceId,actor.userId,input.actionId,input.expectedVersion,input.action==='cancel_task'?'cancelled':'dismissed',input.action==='cancel_task'?'task':'preference',input.action==='cancel_task'?'open':'proposed'])).rows[0];
  return changed===undefined?{ok:false as const,reason:'source_unavailable'}:{ok:true as const,value:askActionChangedSchema.parse({actionId:changed.id,version:changed.version,status:changed.status,completedAt:null})};
 }
 const row=(await context.db.query<ActionProof>(`SELECT id,version,kind,status,private_state,target_firm_id,target_person_id,input_scope,initial_contexts,original_access_closure,support_refs,review_required,created_at,updated_at,completed_at FROM crm_ask_actions WHERE workspace_id=$1 AND owner_user_id=$2 AND id=$3`,[context.scope.workspaceId,actor.userId,input.actionId])).rows[0];
 if(row===undefined||row.version!==input.expectedVersion||row.kind!=='task'||row.status!=='open')return {ok:false as const,reason:'source_unavailable'};
 if((await currentActionSupport(context,row)).state!=='current'||row.review_required)return {ok:false as const,reason:'source_unavailable'};
 const changed=(await context.db.query<{id:string;version:number;status:string;completed_at:Date}>(`UPDATE crm_ask_actions SET status='done',version=version+1,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE workspace_id=$1 AND owner_user_id=$2 AND id=$3 AND version=$4 AND status='open' AND private_state='available' RETURNING id,version,status,completed_at`,[context.scope.workspaceId,actor.userId,input.actionId,input.expectedVersion])).rows[0];
 if(changed===undefined)return {ok:false as const,reason:'source_unavailable'};
 return {ok:true as const,value:askActionChangedSchema.parse({actionId:changed.id,version:changed.version,status:changed.status,completedAt:changed.completed_at.toISOString()})};
}
