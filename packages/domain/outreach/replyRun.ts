import type {RepositoryContext} from '../db/workspaceScope.ts';
import {withTransaction,type SessionQueryable} from '../db/queryable.ts';
import {databaseNow} from '../policy/clock.ts';
import {lockSendGateForDispatch,sendGateLockName} from '../policy/sendGate.ts';
import {listApplicableHolds} from '../policy/holds.ts';
import {readResearchSettings} from '../research/settings.ts';
import {lockResearchBudget,tryLockResearchBudget} from '../research/ceilings.ts';
import {readCreditSpend,workspaceBusinessZone} from '../research/ledger.ts';
import {reserveAttempt,markCalling,settleAttempt} from '../research/reservations.ts';
import {centsOf} from '../research/pricing.ts';
import {readReplyRequest,readRoutineSource,ROUTINE_REPLY_MODEL} from './replyRequests.ts';
import {validateReplyDecision,type RoutineReplyInput} from './replyPolicy.ts';
export interface RoutineReplyPort {
 readonly providerKey:'aws_bedrock.outreach_reply';
 countInputTokens(input:RoutineReplyInput):Promise<number>;
 interpret(input:RoutineReplyInput):Promise<{raw:string;costCents:number;costEstimated:boolean}>;
}
/** Committed claim precedes network; the scheduler independently expires stranded claims. */
export async function runRoutineReply(ctx:RepositoryContext,input:{requestId:string},port:RoutineReplyPort|null):Promise<void>{
 if(!port||port.providerKey!=='aws_bedrock.outreach_reply')return;
 const db=ctx.db as SessionQueryable;
 const initial=await readReplyRequest(ctx,input.requestId);if(!initial||initial.state!=='queued'||!initial.message_id)return;
 const source=await readRoutineSource(ctx,{planId:initial.plan_id,messageId:initial.message_id});
 const review=async(reason:string)=>{await db.query("UPDATE outreach_reply_requests SET state='review',reason=$3,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state IN ('queued','calling')",[ctx.scope.workspaceId,input.requestId,reason]);};
 if(!source.ok||source.value.hash!==initial.source_hash){await review(source.ok?'source_changed':source.reason);return;}
 let tokens:number;try{tokens=await port.countInputTokens(source.value.input);}catch{await review('token_count_unavailable');return;}
 if(!Number.isSafeInteger(tokens)||tokens<=0||tokens>100000){await review('input_over_budget');return;}
 const cents=centsOf(ROUTINE_REPLY_MODEL,{inputTokens:tokens,outputTokens:1024},'bedrock');
 const claim=await withTransaction(db,async()=>{
  await lockSendGateForDispatch(ctx);await lockResearchBudget(ctx);
  const row=await readReplyRequest(ctx,input.requestId,true),at=await databaseNow(ctx);
  if(!row||row.state!=='queued'||row.paid_attempts>=2||row.deadline_at.getTime()<=Date.parse(at)||row.model_name!==ROUTINE_REPLY_MODEL||!row.message_id)return null;
  const enabled=(await db.query<{routine_replies_enabled:boolean}>('SELECT routine_replies_enabled FROM outreach_settings WHERE workspace_id=$1 FOR SHARE',[ctx.scope.workspaceId])).rows[0]?.routine_replies_enabled;
  const settings=await readResearchSettings(ctx);
  if(!enabled||!settings.enabled||(await listApplicableHolds(ctx,{actionKind:'research'})).length)return null;
  const current=await readRoutineSource(ctx,{planId:row.plan_id,messageId:row.message_id});if(!current.ok||current.value.hash!==row.source_hash){await review('source_changed');return null;}
  const zone=await workspaceBusinessZone(ctx),spend=await readCreditSpend(ctx,{at,businessTimeZone:zone});
  if(spend.todayCents+cents>settings.dailyCostCeilingCents||spend.monthToDateCents+cents>settings.monthlyCostCeilingCents)return null;
  const reserved=await reserveAttempt(ctx,{subjectKind:'outreach_reply',subjectId:row.id,attempt:row.paid_attempts+1,providerKey:port.providerKey,at,businessTimeZone:zone,cents,modelName:ROUTINE_REPLY_MODEL,maxInputTokens:tokens,maxOutputTokens:1024});
  if(!await markCalling(ctx,reserved.id))return null;
  await db.query("UPDATE outreach_reply_requests SET state='calling',paid_attempts=paid_attempts+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",[ctx.scope.workspaceId,row.id]);
  return reserved;
 });
 if(!claim)return;
 let outcome:{raw:string;costCents:number;costEstimated:boolean};
 try{outcome=await port.interpret(source.value.input);}catch{outcome={raw:'',costCents:claim.cents,costEstimated:true};}
 await withTransaction(db,()=>settleAttempt(ctx,{reservationId:claim.id,at:new Date().toISOString(),outcome:outcome.costEstimated||!Number.isSafeInteger(outcome.costCents)||outcome.costCents<0?{kind:'estimated'}:{kind:'settled',cents:outcome.costCents}}));
 await withTransaction(db,async()=>{
  await lockSendGateForDispatch(ctx);
  const row=await readReplyRequest(ctx,input.requestId,true);if(!row||row.state!=='calling'||!row.message_id)return;
  const current=await readRoutineSource(ctx,{planId:row.plan_id,messageId:row.message_id});
  if(!current.ok||current.value.hash!==row.source_hash||row.deadline_at.getTime()<=Date.parse(await databaseNow(ctx))){await review('source_changed_or_expired');return;}
  const decision=validateReplyDecision(outcome.raw,current.value.input.blocks);
  await db.query('UPDATE outreach_reply_requests SET state=$3,decision=$4::jsonb,reason=$5,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,row.id,decision.kind==='answer'?'ready':decision.kind,JSON.stringify(decision),decision.kind==='answer'?null:'unsupported_or_uncertain']);
 });
}
export async function expireRoutineReplies(ctx:RepositoryContext,at:string):Promise<void>{
 if(!await tryLockRoutineWorkspace(ctx))return;
 const pending=(await ctx.db.query<{id:string;state:string}>(`SELECT p.id,p.state FROM provider_reservations p JOIN outreach_reply_requests r ON r.workspace_id=p.workspace_id AND r.id=p.subject_id WHERE p.workspace_id=$1 AND p.subject_kind='outreach_reply' AND p.state IN ('reserved','calling') AND r.deadline_at<=$2 ORDER BY r.deadline_at,r.id LIMIT 100`,[ctx.scope.workspaceId,at])).rows;
 for(const p of pending)await settleAttempt(ctx,{reservationId:p.id,at,outcome:{kind:p.state==='calling'?'estimated':'released'}});
 await ctx.db.query("UPDATE outreach_reply_requests SET state='expired',reason='deadline_exceeded',revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND state IN ('queued','calling') AND deadline_at<=$2",[ctx.scope.workspaceId,at]);
}

export async function tryLockRoutineWorkspace(ctx:RepositoryContext):Promise<boolean>{
 const gate=(await ctx.db.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',[sendGateLockName(ctx.scope.workspaceId)])).rows[0]?.locked;
 return gate===true&&await tryLockResearchBudget(ctx);
}
