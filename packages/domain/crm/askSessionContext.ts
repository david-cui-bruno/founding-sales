import {readAskExecutionEvidence} from './askExecutionEvidence.ts';
import {askScopeWithin} from './askAgentScope.ts';
import {askAgentScopeSchema} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {askCopiedSourceSchema,type askAnswerRequestPayloadSchema} from '@fss/contracts';
import type {z} from 'zod';
import {readAskConversationTurn} from './askAnswers.ts';
import {askFingerprint} from './askAnswerAuthority.ts';
/** Previous turns are dated context only; every original input must remain in the new current scope. */
export async function readAskSessionContext(context:RepositoryContext,requestId:string,scope:z.infer<typeof askAnswerRequestPayloadSchema>['scope']){
 const actor=context.scope.actor;if(actor.kind!=='user')return {turns:[],fingerprint:askFingerprint([])};
 const parent=(await context.db.query<{session_id:string;ordinal:number;scope:unknown}>(`SELECT t.session_id,t.ordinal,s.scope FROM crm_ask_session_turns t JOIN crm_ask_sessions s ON s.workspace_id=t.workspace_id AND s.id=t.session_id WHERE t.workspace_id=$1 AND t.request_id=$2 AND s.owner_user_id=$3 AND s.state='active'`,[context.scope.workspaceId,requestId,actor.userId])).rows[0];
 if(parent===undefined)return {turns:[],fingerprint:askFingerprint([])};
 const prior=(await context.db.query<{request_id:string;version:number;epoch:number;scope:{sources:unknown[]};original_agent_scope:unknown}>(`SELECT t.request_id,r.version,r.epoch,r.scope,r.original_agent_scope FROM crm_ask_session_turns t JOIN crm_ask_requests r ON r.workspace_id=t.workspace_id AND r.id=t.request_id WHERE t.workspace_id=$1 AND t.session_id=$2 AND t.ordinal<$3 AND r.owner_user_id=$4 AND r.state NOT IN ('deleted','stale') ORDER BY t.ordinal DESC LIMIT 8`,[context.scope.workspaceId,parent.session_id,parent.ordinal,actor.userId])).rows.reverse();
 const key=(source:unknown)=>{const parsed=askCopiedSourceSchema.safeParse(source);return parsed.success?`${parsed.data.workspaceId}:${parsed.data.kind}:${parsed.data.sourceId}:${parsed.data.revision}:${parsed.data.contentHash}`:null;};
 const keys=new Set(scope.sources.map(key));
 const turns=[];
 const dependencies=(await context.db.query<{parent_request_id:string}>('SELECT parent_request_id FROM crm_ask_history_dependencies WHERE workspace_id=$1 AND request_id=$2',[context.scope.workspaceId,requestId])).rows;
 const inherited=new Set(dependencies.map(row=>row.parent_request_id));
 const currentScope=askAgentScopeSchema.safeParse(parent.scope);
 for(const previous of prior){
  if(!inherited.has(previous.request_id))continue;
  const previousScope=askAgentScopeSchema.safeParse(previous.original_agent_scope);
  if(!currentScope.success||!previousScope.success||!askScopeWithin(previousScope.data,currentScope.data))continue;
  const evidence=await readAskExecutionEvidence(context,{requestId:previous.request_id,version:previous.version,epoch:previous.epoch});
  if(!evidence||!evidence.scope.sources.every(source=>key(source)!==null&&keys.has(key(source))))continue;
  const readable=await readAskConversationTurn(context,previous.request_id);
  if(readable===null)continue;
  turns.push({question:readable.question,answer:readable.answer,createdAt:readable.createdAt});
 }
 return {turns,fingerprint:askFingerprint(turns)};
}
