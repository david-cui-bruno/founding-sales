import {createHash} from 'node:crypto';
import {z} from 'zod';
import {replyDraftGenerateInputSchema,replyFactRefSchema,type ReplyDraftContext,type ReplyDraftGenerateInput,type ReplyGeneratedDraft,type ReplyComposerResult} from '../../contracts/src/replyComposer.ts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {withTransaction,type SessionQueryable} from '../db/queryable.ts';
import {lockSendGateForDispatch} from '../policy/sendGate.ts';
import {databaseNow} from '../policy/clock.ts';
import {listApplicableHolds} from '../policy/holds.ts';
import {lockResearchBudget} from '../research/ceilings.ts';
import {readResearchSettings} from '../research/settings.ts';
import {readCreditSpend,workspaceBusinessZone} from '../research/ledger.ts';
import {readAttempt,reserveAttempt,markCalling,settleAttempt} from '../research/reservations.ts';
import {centsOf} from '../research/pricing.ts';
import {readReplyDraftContext} from './composer.ts';

export const HUMAN_REPLY_DRAFT_MODEL='claude-haiku-4-5';
export const HUMAN_REPLY_DRAFT_MAX_OUTPUT_TOKENS=1024;
export interface HumanReplyDraftPort {
 readonly providerKey:'aws_bedrock.outreach_reply';
 countInputTokens(context:ReplyDraftContext):Promise<number>;
 compose(context:ReplyDraftContext):Promise<{raw:string;costCents:number;costEstimated:boolean}>;
}
const outputSchema=z.strictObject({text:z.string().trim().min(1).max(12000),factRefs:z.array(replyFactRefSchema).max(20),unsupportedClaims:z.array(z.string().trim().min(1).max(500)).max(9)});

/** Caller supplies one session, outside any transaction. Paid markers contain no body. */
export async function generateReplyDraft(ctx:RepositoryContext,input:ReplyDraftGenerateInput,port:HumanReplyDraftPort|null):Promise<ReplyComposerResult<ReplyGeneratedDraft>>{
 if(!replyDraftGenerateInputSchema.safeParse(input).success)return {ok:false,reason:'invalid_input'};
 const selection={messageId:input.messageId,factRefs:input.factRefs,envelope:input.envelope};
 const source=await readReplyDraftContext(ctx,selection);if(!source.ok)return source;
 if(source.value.sourceRevision!==input.sourceRevision)return {ok:false,reason:'source_changed'};
 const attempt={subjectKind:'outreach_reply' as const,subjectId:input.commandId,attempt:1};
 if(await readAttempt(ctx,attempt))return {ok:false,reason:'generation_already_attempted'};
 if(!port||port.providerKey!=='aws_bedrock.outreach_reply')return {ok:false,reason:'generation_unavailable'};
 let tokens:number;try{tokens=await port.countInputTokens(source.value);}catch{return {ok:false,reason:'token_count_unavailable'};}
 if(!Number.isSafeInteger(tokens)||tokens<=0||tokens>100000)return {ok:false,reason:'input_over_budget'};
 const cents=centsOf(HUMAN_REPLY_DRAFT_MODEL,{inputTokens:tokens,outputTokens:HUMAN_REPLY_DRAFT_MAX_OUTPUT_TOKENS},'bedrock');
 const db=ctx.db as SessionQueryable;
 const claim=await withTransaction(db,async()=>{
  await lockSendGateForDispatch(ctx);await lockResearchBudget(ctx);
  if(await readAttempt(ctx,attempt))return {ok:false as const,reason:'generation_already_attempted'};
  const current=await readReplyDraftContext(ctx,selection);if(!current.ok)return current;
  if(current.value.sourceRevision!==input.sourceRevision)return {ok:false as const,reason:'source_changed'};
  const settings=await readResearchSettings(ctx);
  if(!settings.enabled||(await listApplicableHolds(ctx,{actionKind:'research',firmId:current.value.firmId,ownerUserId:current.value.mailboxOwnerUserId,mailboxId:current.value.mailboxId})).length)return {ok:false as const,reason:'generation_held'};
  const at=await databaseNow(ctx),zone=await workspaceBusinessZone(ctx),spend=await readCreditSpend(ctx,{at,businessTimeZone:zone});
  if(spend.todayCents+cents>settings.dailyCostCeilingCents||spend.monthToDateCents+cents>settings.monthlyCostCeilingCents)return {ok:false as const,reason:'generation_over_budget'};
  const reservation=await reserveAttempt(ctx,{...attempt,providerKey:port.providerKey,at,businessTimeZone:zone,cents,modelName:HUMAN_REPLY_DRAFT_MODEL,maxInputTokens:tokens,maxOutputTokens:HUMAN_REPLY_DRAFT_MAX_OUTPUT_TOKENS});
  if(!await markCalling(ctx,reservation.id))return {ok:false as const,reason:'generation_already_attempted'};
  return {ok:true as const,value:reservation};
 });
 if(!claim.ok)return claim;
 let answer:{raw:string;costCents:number;costEstimated:boolean};
 try{answer=await port.compose(source.value);}catch{
  await withTransaction(db,()=>settleAttempt(ctx,{reservationId:claim.value.id,at:new Date().toISOString(),outcome:{kind:'estimated'}}));
  return {ok:false,reason:'generation_outcome_unknown'};
 }
 await withTransaction(db,()=>settleAttempt(ctx,{reservationId:claim.value.id,at:new Date().toISOString(),outcome:answer.costEstimated||!Number.isSafeInteger(answer.costCents)||answer.costCents<0?{kind:'estimated'}:{kind:'settled',cents:answer.costCents}}));
 const current=await withTransaction(db,async()=>{await lockSendGateForDispatch(ctx);return readReplyDraftContext(ctx,selection);});
 if(!current.ok)return current;
 if(current.value.sourceRevision!==input.sourceRevision)return {ok:false,reason:'source_changed'};
 let parsed:unknown;try{parsed=JSON.parse(answer.raw);}catch{return {ok:false,reason:'generation_invalid'};}
 const output=outputSchema.safeParse(parsed);if(!output.success)return {ok:false,reason:'generation_invalid'};
 if(new Set(output.data.factRefs.map(r=>r.id)).size!==output.data.factRefs.length||output.data.factRefs.some(ref=>!current.value.facts.some(f=>f.id===ref.id&&f.version===ref.version)))return {ok:false,reason:'generation_invalid_facts'};
 // A bounded backstop, not a semantic proof: every draft still needs human review.
 // Explicit offer/capability/promise bytes must come from the exact selected facts.
 const cited=current.value.facts.filter(f=>output.data.factRefs.some(ref=>ref.id===f.id&&ref.version===f.version));
 let uncited=output.data.text;
 for(const fact of [...cited].sort((a,b)=>b.text.length-a.text.length))uncited=uncited.replaceAll(fact.text,'');
 if(/[$€£]\s*\d|\b(?:\d+\s*(?:usd|dollars|per month)|free trial|no cost|discount|guarantee(?:d)?|integrates? with|we will|i will|we'll|i'll|cancel your|reschedule your)\b/iu.test(uncited))return {ok:false,reason:'generation_unsupported_claim'};
 const urls=output.data.text.match(/https?:\/\/[^\s<>]+/gu)??[];
 if(urls.some(url=>!cited.some(f=>f.text.includes(url))))return {ok:false,reason:'generation_unsupported_claim'};
 const reviewNotes=['Review every claim and commitment against this conversation and the approved facts. Pricing is undefined unless separately approved.',...output.data.unsupportedClaims];
 const draft={sourceRevision:input.sourceRevision,text:output.data.text,factRefs:output.data.factRefs,reviewRequired:true as const,reviewNotes};
 return {ok:true,value:{...draft,draftRevision:createHash('sha256').update(JSON.stringify({draft,envelope:current.value.envelope,authorUserId:current.value.authorUserId})).digest('hex')}};
}
