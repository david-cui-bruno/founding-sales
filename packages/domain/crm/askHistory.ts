import {askHistoryPageSchema,askHistoryChangedSchema,type AskHistoryList,type AskHistoryChange} from '@fss/contracts';
import type {SessionQueryable} from '../db/queryable.ts';
import {withTransaction} from '../db/queryable.ts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {activeIdentityActor} from './identityAccess.ts';
import {lockAskLifecycle} from './askAnswerLifecycle.ts';
import {readAskAnswer} from './askAnswers.ts';
interface HistoryRow extends Record<string,unknown>{id:string;version:number;history_revision:number;created_at:Date;cursor_at:string;history_updated_at:Date;history_title:string|null;history_pinned:boolean}
/** Caller supplies one authenticated session. Current observations are serial per item, not an atomic page. */
export async function listAskHistory(context:RepositoryContext&{db:SessionQueryable},input:AskHistoryList){
 const actor=context.scope.actor;if(actor.kind!=='user'||!await activeIdentityActor(context))return null;
 let cursorAt:string|null=null;
 if(input.cursor!==undefined){
  const cursor=(await context.db.query<HistoryRow>('SELECT id,created_at,created_at::text AS cursor_at,history_pinned FROM crm_ask_requests WHERE workspace_id=$1 AND owner_user_id=$2 AND id=$3',[context.scope.workspaceId,actor.userId,input.cursor.requestId])).rows[0];
  if(cursor===undefined||cursor.history_pinned!==input.cursor.pinned||cursor.created_at.toISOString()!==input.cursor.createdAt)return null;
  cursorAt=cursor.cursor_at;
 }
 const rows=(await context.db.query<HistoryRow>(`SELECT id,version,history_revision,created_at,created_at::text AS cursor_at,history_updated_at,history_title,history_pinned FROM crm_ask_requests WHERE workspace_id=$1 AND owner_user_id=$2 AND state<>'deleted' AND ($3::timestamptz IS NULL OR (history_pinned,created_at,id)<($4::boolean,$3::timestamptz,$5::uuid)) ORDER BY history_pinned DESC,created_at DESC,id DESC LIMIT $6`,[context.scope.workspaceId,actor.userId,cursorAt,input.cursor?.pinned??false,input.cursor?.requestId??null,input.limit+1])).rows;
 const items=[];
 for(const row of rows.slice(0,input.limit)){
  const current=await withTransaction(context.db,()=>readAskAnswer(context,row.id));
  if(current===null)return null;
  const readable=current.question!==null&&current.reason!=='source_unavailable'&&current.state!=='stale'&&current.state!=='deleted';
  items.push({requestId:row.id,historyRevision:row.history_revision,requestVersion:current.version,createdAt:row.created_at.toISOString(),updatedAt:row.history_updated_at.toISOString(),title:readable?row.history_title:null,pinned:row.history_pinned,question:readable?current.question:null,state:current.state,reason:current.reason});
 }
 if(!await activeIdentityActor(context))return null;
 const last=rows[input.limit-1];
 return askHistoryPageSchema.parse({items,nextCursor:rows.length>input.limit&&last!==undefined?{pinned:last.history_pinned,createdAt:last.created_at.toISOString(),requestId:last.id}:null});
}

/** Owner intent does not authorize accessing stale source text. Caller owns the command transaction. */
export async function changeAskHistory(context:RepositoryContext,input:AskHistoryChange){
 const actor=context.scope.actor;if(actor.kind!=='user'||!await activeIdentityActor(context))return {ok:false as const,reason:'source_unavailable'};
 await lockAskLifecycle(context);
 if(input.action.kind==='delete')return {ok:false as const,reason:'invalid_input'};
 const current=await readAskAnswer(context,input.requestId);
 if(current===null||current.question===null)return {ok:false as const,reason:'source_unavailable'};
 const row=(await context.db.query<HistoryRow>('SELECT id,version,history_revision FROM crm_ask_requests WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 FOR UPDATE',[context.scope.workspaceId,input.requestId,actor.userId])).rows[0];
 if(row===undefined||row.version!==current.version||row.history_revision!==input.expectedRevision)return {ok:false as const,reason:'history_changed'};
 const changed=(await context.db.query<{id:string;version:number;history_revision:number;state:string}>(input.action.kind==='rename'?'UPDATE crm_ask_requests SET history_title=$4 WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 RETURNING id,version,history_revision,state':'UPDATE crm_ask_requests SET history_pinned=$4 WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 RETURNING id,version,history_revision,state',[context.scope.workspaceId,input.requestId,actor.userId,input.action.kind==='rename'?input.action.title:input.action.pinned])).rows[0]!;
 return {ok:true as const,value:askHistoryChangedSchema.parse({requestId:changed.id,historyRevision:changed.history_revision,requestVersion:changed.version,state:changed.state})};
}
