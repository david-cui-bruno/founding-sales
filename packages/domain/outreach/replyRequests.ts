import {createHash} from 'node:crypto';
import type {AnswerBlock} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {readMessage,readMessageBody} from '../mail/messages.ts';
import {authorizationForMailbox} from './authorization.ts';
import {lockSendGateForStopFact} from '../policy/sendGate.ts';
import {databaseNow} from '../policy/clock.ts';
import {preflightRoutineReply,ROUTINE_REPLY_PROMPT_VERSION,type RoutineReplyInput,type ReplyDecision} from './replyPolicy.ts';
export const ROUTINE_REPLY_MODEL='claude-haiku-4-5';
export interface RoutineSource {input:RoutineReplyInput;hash:string;mailboxId:string;contactId:string;firmId:string;receivedAt:string;subject:string;threadId:string;replyTo:string;references:readonly string[];planRevision:number;authorizationRevision:number}
type Result<T>={ok:true;value:T}|{ok:false;reason:string};
export interface ReplyRequestRow {[key:string]:unknown;id:string;plan_id:string;message_id:string|null;source_hash:string;model_name:string;state:string;paid_attempts:number;deadline_at:Date;revision:number;decision:ReplyDecision|null}
export const readReplyRequest=async(ctx:RepositoryContext,id:string,lock=false):Promise<ReplyRequestRow|null>=>(await ctx.db.query<ReplyRequestRow>(`SELECT * FROM outreach_reply_requests WHERE workspace_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[ctx.scope.workspaceId,id])).rows[0]??null;
/** Reassembled for preparation and dispatch. Bodies remain in the existing retention store. */
export async function readRoutineSource(ctx:RepositoryContext,input:{planId:string;messageId:string}):Promise<Result<RoutineSource>>{
 const p=(await ctx.db.query<{firm_id:string;contact_id:string;mailbox_id:string;owner_user_id:string;revision:number;state:string;assigned_user_id:string|null;status:string}>(`SELECT p.*,f.assigned_user_id,f.status FROM outreach_plans p JOIN firms f ON f.workspace_id=p.workspace_id AND f.id=p.firm_id WHERE p.workspace_id=$1 AND p.id=$2`,[ctx.scope.workspaceId,input.planId])).rows[0];
 if(!p||!['reply_pending','booked'].includes(p.state)||p.status!=='active'||p.owner_user_id!==p.assigned_user_id)return {ok:false,reason:'plan_unavailable'};
 const auth=await authorizationForMailbox(ctx,p.mailbox_id);if(!auth.allowed||auth.revision===null)return {ok:false,reason:'mailbox_not_authorized'};
 const actor=ctx.scope.actor;if(actor.kind==='user'&&actor.role!=='admin'&&actor.userId!==p.owner_user_id)return {ok:false,reason:'not_assigned'};
 const message=await readMessage(ctx,input.messageId),body=await readMessageBody(ctx,input.messageId);
 if(!message||message.mailboxId!==p.mailbox_id||message.direction!=='incoming'||!message.matched||message.metadataOnly||message.listId!==null||!message.rfcMessageId||!body||body.truncated)return {ok:false,reason:'message_unavailable'};
 const matches=(await ctx.db.query<{outreach_plan_id:string|null;contact_id:string|null;ambiguous:boolean}>('SELECT outreach_plan_id,contact_id,ambiguous FROM mail_message_matches WHERE workspace_id=$1 AND mail_message_id=$2',[ctx.scope.workspaceId,message.id])).rows;
 if(matches.length!==1||matches[0]?.outreach_plan_id!==input.planId||matches[0]?.contact_id!==p.contact_id||matches[0]?.ambiguous)return {ok:false,reason:'ambiguous_sender'};
 const route=(await ctx.db.query("SELECT id FROM email_addresses WHERE workspace_id=$1 AND contact_id=$2 AND address=$3 AND eligibility='usable' AND retired_at IS NULL",[ctx.scope.workspaceId,p.contact_id,message.headerFrom])).rows[0];
 if(!route)return {ok:false,reason:'sender_changed'};
 const thread=(await ctx.db.query<{id:string;direction:string;internal_date:Date;body_text:string|null;truncated:boolean|null}>(`SELECT m.id,m.direction,m.internal_date,b.body_text,b.truncated FROM mail_messages m LEFT JOIN mail_message_bodies b ON b.workspace_id=m.workspace_id AND b.mail_message_id=m.id WHERE m.workspace_id=$1 AND m.mailbox_id=$2 AND m.provider_thread_id=$3 ORDER BY m.internal_date,m.id LIMIT 21`,[ctx.scope.workspaceId,p.mailbox_id,message.providerThreadId])).rows;
 if(thread.length>20)return {ok:false,reason:'context_too_large'};
 if(thread.at(-1)?.id!==message.id)return {ok:false,reason:'thread_changed'};
 const prior=thread.filter(m=>m.id!==message.id);
 if(prior.some(m=>m.body_text===null||m.truncated))return {ok:false,reason:'context_incomplete'};
 const blocks=(await ctx.db.query<{block_id:string;version:number;kind:AnswerBlock['kind'];text:string;approved_at:Date}>(`SELECT v.* FROM outreach_answer_blocks b JOIN outreach_answer_block_versions v ON v.workspace_id=b.workspace_id AND v.block_id=b.id AND v.version=b.current_version WHERE b.workspace_id=$1 AND v.approved_at IS NOT NULL AND v.retired_at IS NULL ORDER BY b.id LIMIT 51`,[ctx.scope.workspaceId])).rows.map(b=>({id:b.block_id,version:b.version,kind:b.kind,text:b.text,approvedAt:b.approved_at.toISOString(),retiredAt:null}));
 if(blocks.length>50||blocks.length===0)return {ok:false,reason:'approved_facts_unavailable'};
 const prepared:RoutineReplyInput={messageText:body.text,contextText:JSON.stringify(prior.map(m=>({direction:m.direction,text:m.body_text}))),blocks,human:true,matched:true,autoSubmitted:message.autoSubmitted};
 const preflight=preflightRoutineReply(prepared);if(!preflight.ok)return {ok:false,reason:preflight.decision.kind==='answer'?'invalid_input':preflight.decision.reason};
 const hash=createHash('sha256').update(JSON.stringify({prepared,planRevision:p.revision,authorizationRevision:auth.revision,thread:thread.map(m=>m.id),from:message.headerFrom,replyTo:message.rfcMessageId})).digest('hex');
 return {ok:true,value:{input:prepared,hash,mailboxId:p.mailbox_id,firmId:p.firm_id,contactId:p.contact_id,receivedAt:message.internalDate,subject:message.subject??'Maintenance',threadId:message.providerThreadId,replyTo:message.rfcMessageId,references:[...new Set([...message.referenceMessageIds,message.rfcMessageId])],planRevision:p.revision,authorizationRevision:auth.revision}};
}
export async function requestRoutineReply(ctx:RepositoryContext,input:{planId:string;messageId:string;threadRevision:string}):Promise<Result<{requestId:string}>>{
 await lockSendGateForStopFact(ctx);
 if(!(await ctx.db.query<{routine_replies_enabled:boolean}>('SELECT routine_replies_enabled FROM outreach_settings WHERE workspace_id=$1',[ctx.scope.workspaceId])).rows[0]?.routine_replies_enabled)return {ok:false,reason:'routine_replies_disabled'};
 const source=await readRoutineSource(ctx,input);if(!source.ok)return source;
 if(source.value.hash!==input.threadRevision)return {ok:false,reason:'source_changed'};
 const at=await databaseNow(ctx);
 if(Date.parse(at)>=Date.parse(source.value.receivedAt)+48*3600000)return {ok:false,reason:'reply_expired'};
 const row=(await ctx.db.query<{id:string}>(`INSERT INTO outreach_reply_requests(workspace_id,plan_id,message_id,original_message_id,source_hash,prompt_version,model_name) VALUES($1,$2,$3,$3,$4,$5,$6) ON CONFLICT(workspace_id,original_message_id) DO NOTHING RETURNING id`,[ctx.scope.workspaceId,input.planId,input.messageId,source.value.hash,ROUTINE_REPLY_PROMPT_VERSION,ROUTINE_REPLY_MODEL])).rows[0];
 const existing=row??(await ctx.db.query<{id:string}>('SELECT id FROM outreach_reply_requests WHERE workspace_id=$1 AND original_message_id=$2',[ctx.scope.workspaceId,input.messageId])).rows[0];
 return existing?{ok:true,value:{requestId:existing.id}}:{ok:false,reason:'source_changed'};
}
