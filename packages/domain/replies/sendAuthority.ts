import type {HumanReplySendInput} from '../../contracts/src/replyComposer.ts';
import {repositoryContext,workspaceScope,type RepositoryContext} from '../db/workspaceScope.ts';
import type {OutboundFenceRow} from '../outbound/fence.ts';
import {refuseSend,acceptSend,type SendResult} from '../outbound/types.ts';
import {coverageRefusal,readMailboxCoverage} from '../mail/coverage.ts';
import {listApplicableHolds} from '../policy/holds.ts';
import {humanReplyIdentityLive,previewHumanReply} from './dispatch.ts';

type Intent={message_id:string;user_id:string;role:'admin'|'salesperson';session_id:string;device_id:string;authorized:boolean;live:boolean;revision:number;source_revision:string;draft_revision:string;fact_refs:HumanReplySendInput['factRefs'];envelope:HumanReplySendInput['envelope'];provider_thread_id:string;in_reply_to:string;reference_ids:string[]};
async function intentFor(ctx:RepositoryContext,id:string):Promise<Intent|null>{return (await ctx.db.query<Intent>(`SELECT *,expires_at>clock_timestamp() AS live FROM human_reply_send_intents WHERE workspace_id=$1 AND outbound_message_id=$2 FOR UPDATE`,[ctx.scope.workspaceId,id])).rows[0]??null;}

/** Human permission is independent of routine automation; common send gates remain mandatory. */
export async function decideHumanReplyPermission(ctx:RepositoryContext,fence:OutboundFenceRow,expectedRevision?:number):Promise<SendResult<null>>{
 const intent=await intentFor(ctx,fence.id);
 if(!intent?.authorized||!intent.live||expectedRevision!==undefined&&intent.revision!==expectedRevision)return refuseSend('step_ineligible','human_reply:fresh_approval_required');
 const human=repositoryContext(workspaceScope(ctx.scope.workspaceId,{kind:'user',userId:intent.user_id,role:intent.role}),ctx.db);
 if(!await humanReplyIdentityLive(human,{sessionId:intent.session_id,deviceId:intent.device_id},intent.user_id,intent.role))return refuseSend('step_ineligible','human_reply:session_changed');
 const coverage=coverageRefusal(await readMailboxCoverage(ctx,{mailboxId:fence.mailboxId}));
 if(coverage)return refuseSend(coverage.reason==='coverage_incomplete'?'coverage_incomplete':'grant_revoked',coverage.detail);
 // The final claim owns gate → fence → intent/session before taking this firm lock.
 // Keep its authority fixed from preview through claim commit; timezone corrections
 // take the firm's write lock without needing a workspace-wide send gate.
 await ctx.db.query('SELECT id FROM firms WHERE workspace_id=$1 AND id=$2 FOR SHARE',[ctx.scope.workspaceId,fence.firmId]);
 const preview=await previewHumanReply(human,{messageId:intent.message_id,text:fence.body,factRefs:intent.fact_refs,envelope:intent.envelope});
 if(!preview.ok)return refuseSend('step_ineligible',`human_reply:${preview.reason}`);
 if(preview.value.sourceRevision!==intent.source_revision||preview.value.draftRevision!==intent.draft_revision||preview.value.body!==fence.body||preview.value.subject!==fence.subject)return refuseSend('step_ineligible','human_reply:draft_changed');
 const owner=(await ctx.db.query<{owner_user_id:string}>('SELECT owner_user_id FROM mailboxes WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,fence.mailboxId])).rows[0]?.owner_user_id;
 const holds=await listApplicableHolds(ctx,{actionKind:'email_send',firmId:fence.firmId,opportunityId:fence.opportunityId??undefined,ownerUserId:owner,mailboxId:fence.mailboxId,channel:'email'});
 if(holds.some(h=>!(h.sourceEventKind==='mail_message'&&h.sourceEventId===intent.message_id&&h.reasonCode==='uncertain_reply')))return refuseSend('step_ineligible','human_reply:sending_held');
 return acceptSend(null);
}

export async function consumeHumanReplyApproval(ctx:RepositoryContext,id:string):Promise<boolean>{
 return (await ctx.db.query(`UPDATE human_reply_send_intents SET authorized=false WHERE workspace_id=$1 AND outbound_message_id=$2 AND authorized AND expires_at>clock_timestamp() RETURNING message_id`,[ctx.scope.workspaceId,id])).rows.length===1;
}

export async function humanReplyEnvelope(ctx:RepositoryContext,id:string):Promise<{to:string;cc:readonly string[];threadId:string;inReplyTo:string;references:readonly string[]}|null>{
 const row=await intentFor(ctx,id),header=(value:string)=>`<${value.replace(/^<|>$/gu,'')}>`;
 return row?{to:row.envelope.to.join(', '),cc:row.envelope.cc,threadId:row.provider_thread_id,inReplyTo:header(row.in_reply_to),references:row.reference_ids.map(header)}:null;
}

export async function refuseHumanReplyApproval(ctx:RepositoryContext,id:string,reason:string,expectedRevision?:number):Promise<void>{
 await ctx.db.query(`UPDATE human_reply_send_intents SET authorized=false,refusal=$3 WHERE workspace_id=$1 AND outbound_message_id=$2 AND authorized AND ($4::integer IS NULL OR revision=$4)`,[ctx.scope.workspaceId,id,/^[a-z0-9_:,-]{1,200}$/u.test(reason)?reason:'send_refused',expectedRevision??null]);
}

export async function humanReplyApprovalIsLive(ctx:RepositoryContext,id:string,expectedRevision?:number):Promise<boolean>{
 return (await ctx.db.query(`SELECT 1 FROM human_reply_send_intents WHERE workspace_id=$1 AND outbound_message_id=$2 AND authorized AND expires_at>clock_timestamp() AND ($3::integer IS NULL OR revision=$3)`,[ctx.scope.workspaceId,id,expectedRevision??null])).rows.length===1;
}
