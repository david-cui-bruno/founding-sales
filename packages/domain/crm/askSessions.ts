import {readAskExecutionEvidence,admitAskSources,admitAskRecord} from './askExecutionEvidence.ts';
import type {z} from 'zod';
import {askRecordMatchSchema,askAgentScopeSchema,askSessionViewSchema,askSessionPageSchema,type askSessionCreateSchema,type askSessionChangeSchema,type askSessionTurnSchema} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {activeIdentityActor} from './identityAccess.ts';
import {lockAskLifecycle} from './askAnswerLifecycle.ts';
import {resolveAskAgentScope,askScopeWithin} from './askAgentScope.ts';
import {requestAskAnswer,readAskAnswer} from './askAnswers.ts';
import {changeAskHistory} from './askHistory.ts';
interface SessionRow extends Record<string,unknown>{id:string;version:number;scope:unknown;title:string|null;pinned:boolean;state:'active'|'deleted';created_at:Date}
async function owned(context:RepositoryContext,id:string){
 const actor=context.scope.actor;if(actor.kind!=='user'||!await activeIdentityActor(context))return null;
 await lockAskLifecycle(context);
 return (await context.db.query<SessionRow>('SELECT * FROM crm_ask_sessions WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 FOR UPDATE',[context.scope.workspaceId,id,actor.userId])).rows[0]??null;
}
export async function createAskSession(context:RepositoryContext,input:z.infer<typeof askSessionCreateSchema>){
 const actor=context.scope.actor;if(actor.kind!=='user'||!await activeIdentityActor(context))return {ok:false as const,reason:'source_unavailable'};
 await lockAskLifecycle(context);
 if(await resolveAskAgentScope(context,input.scope)===null)return {ok:false as const,reason:'source_unavailable'};
 const row=(await context.db.query<{id:string;version:number}>('INSERT INTO crm_ask_sessions(workspace_id,owner_user_id,scope) VALUES($1,$2,$3::jsonb) RETURNING id,version',[context.scope.workspaceId,actor.userId,JSON.stringify(input.scope)])).rows[0]!;
 return {ok:true as const,value:{sessionId:row.id,version:row.version}};
}
export async function changeAskSession(context:RepositoryContext,input:z.infer<typeof askSessionChangeSchema>){
 const row=await owned(context,input.sessionId);if(row===null||row.state!=='active')return {ok:false as const,reason:'source_unavailable'};
 if(row.version!==input.version)return {ok:false as const,reason:'history_changed'};
 const action=input.action;
 if(action.kind==='scope'){
  const previous=askAgentScopeSchema.safeParse(row.scope);if(!previous.success)return {ok:false as const,reason:'source_unavailable'};
  if(!askScopeWithin(action.scope,previous.data)&&!action.confirmExpansion)return {ok:false as const,reason:'scope_expansion_requires_confirmation'};
  if(await resolveAskAgentScope(context,action.scope)===null)return {ok:false as const,reason:'source_unavailable'};
  await context.db.query('UPDATE crm_ask_sessions SET scope=$3::jsonb,title=NULL,pinned=false,version=version+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,row.id,JSON.stringify(action.scope)]);
 }else if(action.kind==='delete'){
  const actor=context.scope.actor;if(actor.kind!=='user')return {ok:false as const,reason:'source_unavailable'};
  const turns=(await context.db.query<{request_id:string;history_revision:number}>('SELECT r.id AS request_id,r.history_revision FROM crm_ask_session_turns t JOIN crm_ask_requests r ON r.workspace_id=t.workspace_id AND r.id=t.request_id WHERE t.workspace_id=$1 AND t.session_id=$2 ORDER BY t.ordinal',[context.scope.workspaceId,row.id])).rows;
  for(const turn of turns){const current=(await context.db.query<{history_revision:number;state:string}>('SELECT history_revision,state FROM crm_ask_requests WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[context.scope.workspaceId,turn.request_id])).rows[0];if(!current)return {ok:false as const,reason:'source_unavailable'};if(current.state==='deleted')continue;const erased=await changeAskHistory(context,{commandId:input.commandId,clientVersion:input.clientVersion,requestId:turn.request_id,expectedRevision:current.history_revision,action:{kind:'delete'}});if(!erased.ok)return erased;}
  await context.db.query("UPDATE crm_ask_sessions SET scope=NULL,title=NULL,pinned=false,state='deleted',version=version+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[context.scope.workspaceId,row.id]);
 }else{
  if(await resolveAskAgentScope(context,askAgentScopeSchema.parse(row.scope))===null)return {ok:false as const,reason:'source_unavailable'};
  await context.db.query('UPDATE crm_ask_sessions SET title=$3,pinned=$4,version=version+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,row.id,action.kind==='rename'?action.title:row.title,action.kind==='pin'?action.pinned:row.pinned]);
 }
 const changed=(await context.db.query<{version:number}>('SELECT version FROM crm_ask_sessions WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,row.id])).rows[0]!;
 return {ok:true as const,value:{sessionId:row.id,version:changed.version}};
}
export async function requestAskSessionTurn(context:RepositoryContext,input:z.infer<typeof askSessionTurnSchema>){
 const row=await owned(context,input.sessionId);if(row===null||row.state!=='active')return {ok:false as const,reason:'source_unavailable'};
 if(row.version!==input.version)return {ok:false as const,reason:'history_changed'};
 const scope=askAgentScopeSchema.safeParse(row.scope);if(!scope.success)return {ok:false as const,reason:'source_unavailable'};
 const resolved=await resolveAskAgentScope(context,scope.data);if(resolved===null)return {ok:false as const,reason:'source_unavailable'};
 const count=(await context.db.query<{count:number}>('SELECT count(*)::int AS count FROM crm_ask_session_turns WHERE workspace_id=$1 AND session_id=$2',[context.scope.workspaceId,row.id])).rows[0]!.count;
 if(count>=50)return {ok:false as const,reason:'input_bound_reached'};
 const created=await requestAskAnswer(context,{commandId:input.commandId,clientVersion:input.clientVersion,question:input.question,scope:{sources:resolved.sources},execution:'agent_v1',agentScope:scope.data});
 if(!created.ok)return created;
 if(created.value.state==='pending'){
  const previous=(await context.db.query<{id:string;version:number;epoch:number;original_agent_scope:unknown}>('SELECT r.id,r.version,r.epoch,r.original_agent_scope FROM crm_ask_session_turns t JOIN crm_ask_requests r ON r.workspace_id=t.workspace_id AND r.id=t.request_id WHERE t.workspace_id=$1 AND t.session_id=$2 AND r.state=\'complete\' ORDER BY t.ordinal DESC LIMIT 8',[context.scope.workspaceId,row.id])).rows;
  for(const prior of previous){const intent=askAgentScopeSchema.safeParse(prior.original_agent_scope);if(!intent.success||!askScopeWithin(intent.data,scope.data))continue;const evidence=await readAskExecutionEvidence(context,{requestId:prior.id,version:prior.version,epoch:prior.epoch});if(!evidence)continue;const key={requestId:created.value.requestId,version:created.value.version,epoch:1};if(!await admitAskSources(context,key,evidence.scope.sources))continue;let admitted=true;for(const value of evidence.records){const record=askRecordMatchSchema.parse(value);if(!await admitAskRecord(context,key,{kind:record.kind,recordId:record.recordId},record)){admitted=false;break;}}if(!admitted)continue;await context.db.query('INSERT INTO crm_ask_history_dependencies(workspace_id,request_id,parent_request_id,parent_version,parent_epoch) VALUES($1,$2,$3,$4,$5)',[context.scope.workspaceId,key.requestId,prior.id,prior.version,prior.epoch]);}
 }
 await context.db.query('INSERT INTO crm_ask_session_turns(workspace_id,session_id,request_id,ordinal) VALUES($1,$2,$3,$4)',[context.scope.workspaceId,row.id,created.value.requestId,count+1]);
 await context.db.query('UPDATE crm_ask_sessions SET version=version+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,row.id]);
 return {ok:true as const,value:{sessionId:row.id,version:row.version+1,requestId:created.value.requestId,requestVersion:created.value.version,state:created.value.state}};
}
export async function readAskSession(context:RepositoryContext,sessionId:string){
 const row=await owned(context,sessionId);if(row===null)return null;
 const scope=askAgentScopeSchema.safeParse(row.scope);
 if(row.state==='deleted')return askSessionViewSchema.parse({sessionId:row.id,version:row.version,scope:null,title:null,pinned:false,state:'deleted',createdAt:row.created_at.toISOString(),turns:[],coverage:'changed'});
 const permitted=scope.success?await resolveAskAgentScope(context,scope.data):null;
 const turns=[];let changed=permitted===null;
 if(permitted!==null){
  const ids=(await context.db.query<{request_id:string;scope:{sources:{workspaceId:string;kind:string;sourceId:string;revision:number;contentHash:string}[]};original_agent_scope:unknown}>('SELECT t.request_id,r.scope,r.original_agent_scope FROM crm_ask_session_turns t JOIN crm_ask_requests r ON r.workspace_id=t.workspace_id AND r.id=t.request_id WHERE t.workspace_id=$1 AND t.session_id=$2 ORDER BY ordinal',[context.scope.workspaceId,row.id])).rows;
  for(const id of ids){
   const prior=askAgentScopeSchema.safeParse(id.original_agent_scope);
   if(!prior.success||!scope.success||!askScopeWithin(prior.data,scope.data)){changed=true;continue;}
   if(id.scope?.sources?.length===0&&(!prior.success||!scope.success||!askScopeWithin(prior.data,scope.data))){changed=true;continue;}
   if(scope.success&&scope.data.kind==='selected'&&id.scope?.sources?.some(source=>!permitted.sources.some(current=>current.workspaceId===source.workspaceId&&current.kind===source.kind&&current.sourceId===source.sourceId&&current.revision===source.revision&&current.contentHash===source.contentHash))){changed=true;continue;}
   const turn=await readAskAnswer(context,id.request_id);if(turn===null){changed=true;continue;}turns.push(turn);if(turn.question===null)changed=true;}
 }
 const refreshed=(await context.db.query<SessionRow>('SELECT * FROM crm_ask_sessions WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,row.id])).rows[0]!;
 return askSessionViewSchema.parse({sessionId:row.id,version:refreshed.version,scope:permitted!==null?scope.data:null,title:changed?null:refreshed.title,pinned:!changed&&refreshed.pinned,state:row.state,createdAt:row.created_at.toISOString(),turns,coverage:changed?'changed':permitted?.partial?'partial':'current'});
}
export async function listAskSessions(context:RepositoryContext,input:{limit:number}){
 const actor=context.scope.actor;if(actor.kind!=='user'||!await activeIdentityActor(context))return null;
 await lockAskLifecycle(context);
 const rows=(await context.db.query<{id:string}>('SELECT id FROM crm_ask_sessions WHERE workspace_id=$1 AND owner_user_id=$2 AND state=\'active\' ORDER BY pinned DESC,updated_at DESC,id DESC LIMIT $3',[context.scope.workspaceId,actor.userId,input.limit+1])).rows;
 const sessions=[];for(const row of rows.slice(0,input.limit)){const session=await readAskSession(context,row.id);if(session===null)return null;sessions.push(session);}
 return askSessionPageSchema.parse({sessions,truncated:rows.length>input.limit});
}
