import type { JobHandler } from '@fss/domain/jobs/handlerRegistry.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { workspaceScope, type RepositoryContext } from '@fss/domain/db/workspaceScope.ts';
import { unavailableBookingInterpretationAuthority, type BookingInterpretationAuthorityPort } from '@fss/domain/crm/bookingInterpretationAuthority.ts';
import { loadBookingInterpretationSources } from '@fss/domain/crm/bookingInterpretationSources.ts';
import type { BookingInterpretationRow } from '@fss/domain/crm/bookingInterpretation.ts';
import type { BookingPolicySnapshot } from '@fss/domain/meetings/bookingPolicyTypes.ts';
import { lockBookingBudget } from '@fss/domain/meetings/bookingPolicy.ts';
import { settingLockName } from '@fss/domain/settings/store.ts';
import { reserveAttempt, markCalling, readAttempt, settleAttempt } from '@fss/domain/research/reservations.ts';
import { centsOf } from '@fss/domain/research/pricing.ts';
import { BOOKING_MAX_OUTPUT_TOKENS, type BookingInterpretationModel } from '../providers/bookingInterpretationModel.ts';
import { z } from 'zod';
export interface BookingInterpretationOptions { authority?: BookingInterpretationAuthorityPort; model?: BookingInterpretationModel }
const citation = z.strictObject({sourceId:z.string().uuid(),start:z.number().int().nonnegative(),end:z.number().int().positive(),quote:z.string().min(1).max(12000)});
const candidateSchema = z.strictObject({intent:z.enum(['interest','accept_slot','clarify','conditional','refusal','opt_out','change','handoff']),agreement:citation.nullable(),slot:z.strictObject({localDate:z.string(),localTime:z.string(),timeZone:z.string(),evidence:citation}).nullable(),substantive:citation.nullable()});
async function policyLock(context:RepositoryContext) {
  await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[settingLockName(context.scope.workspaceId,'booking_policy')]);
}
/** Non-sending job. Transactions never span the model wait. Calling cannot be replayed. */
export function bookingInterpretationJobHandler(options: BookingInterpretationOptions): JobHandler {
 const authority=options.authority??unavailableBookingInterpretationAuthority;
 return {kind:'crm.booking_interpretation',protection:'outbound_fence',maxAttempts:2,leaseSeconds:120,
 async handle(input) {
  const id=input.job.payload['requestId'];if(typeof id!=='string')return;
  const prepared=await withTransaction(input.session,async()=>{
   const row=(await input.session.query<BookingInterpretationRow>('SELECT * FROM crm_booking_interpretations WHERE workspace_id=$1 AND id=$2',[input.scope.workspaceId,id])).rows[0];if(!row)return null;
   const context={db:input.session,scope:workspaceScope(input.scope.workspaceId,{kind:'user',userId:row.requested_by,role:'admin'})};
   const previous=await readAttempt(context,{subjectKind:'booking_interpretation',subjectId:id,attempt:1});
   if(previous!==null){if(previous.state==='calling'||previous.state==='reserved'){
     await lockBookingBudget(context);await settleAttempt(context,{reservationId:previous.id,at:new Date().toISOString(),outcome:previous.state==='calling'?{kind:'estimated'}:{kind:'released'}});
     await input.session.query("UPDATE crm_booking_interpretations SET state='unknown_acceptance',reason='model_call_not_replayed',outcome=NULL WHERE workspace_id=$1 AND id=$2 AND state<>'stale'",[input.scope.workspaceId,id]);}return null;}
   if(row.state!=='pending')return null;
   const loaded=await loadBookingInterpretationSources(context,row.source_refs);
   await policyLock(context);
   const snapshot=row.authority_snapshot as BookingPolicySnapshot|null;
   const current=snapshot===null?null:await authority.revalidate(context,snapshot);
   const model=options.model;
   const ready=loaded!==null&&loaded.fingerprint===row.source_fingerprint&&loaded.originals[0]!.ownerUserId===row.requested_by&&current?.kind==='available'&&current.snapshot.operationalReady&&current.snapshot.capability==='interpretation';
   if(!ready||!model||current?.kind!=='available'||model.providerKey!==current.snapshot.bindings.model.providerKey||model.route!==current.snapshot.bindings.model.route||model.modelVersion!==current.snapshot.bindings.model.modelVersion||model.accountBinding!==current.snapshot.bindings.model.accountBinding||Date.parse(model.fundingVerifiedUntil)<=Date.now()||loaded?.originals[0]!.accountBinding!==current.snapshot.bindings.sender.accountId){
    await input.session.query("UPDATE crm_booking_interpretations SET state='unavailable',reason='booking_source_model_or_authority_unavailable',outcome=NULL WHERE workspace_id=$1 AND id=$2 AND state='pending'",[input.scope.workspaceId,id]);return null;}
   const text=JSON.stringify(loaded.originals.map(source=>({sourceId:source.sourceId,direction:source.direction,occurredAt:source.occurredAt,rawSenderDate:source.rawSenderDate,text:source.passage,ranges:source.ranges})));
   const maxInput=model.inputBound(text);if(maxInput===null)return null;
   const cents=centsOf('claude-haiku-4-5',{inputTokens:maxInput,outputTokens:BOOKING_MAX_OUTPUT_TOKENS},'bedrock');
   await lockBookingBudget(context);const budget=await authority.budget(context,current.snapshot);
   if(budget?.allowance!=='available'||(budget.remainingDailyCents??0)<cents||(budget.remainingMonthlyCents??0)<cents){
    await input.session.query("UPDATE crm_booking_interpretations SET state='unavailable',reason='booking_budget_unavailable' WHERE workspace_id=$1 AND id=$2 AND state='pending'",[input.scope.workspaceId,id]);return null;}
   const reservation=await reserveAttempt(context,{providerKey:'aws_bedrock.booking',subjectKind:'booking_interpretation',subjectId:id,attempt:1,at:new Date().toISOString(),businessTimeZone:'America/New_York',cents,modelName:'claude-haiku-4-5',maxInputTokens:maxInput,maxOutputTokens:BOOKING_MAX_OUTPUT_TOKENS});
   if(!await markCalling(context,reservation.id))return null;
   await input.session.query("UPDATE crm_booking_interpretations SET state='processing',reservation_id=$3 WHERE workspace_id=$1 AND id=$2 AND state='pending'",[input.scope.workspaceId,id,reservation.id]);
   return {context,row,loaded,text,reservation,snapshot:current.snapshot,model};
  });
  if(!prepared)return;
  let result:Awaited<ReturnType<BookingInterpretationModel['run']>>;
  try{result=await prepared.model.run({text:prepared.text,signal:AbortSignal.timeout(60000)});}catch{result={acceptance:'unknown',usage:null,candidate:null};}
  await withTransaction(input.session,async()=>{
   const {context,row,reservation,snapshot}=prepared;
   const loaded=await loadBookingInterpretationSources(context,row.source_refs);
   await policyLock(context);const current=await authority.revalidate(context,snapshot);
   await lockBookingBudget(context);
   const usage=result.usage;
   const validUsage=usage!==null&&Number.isSafeInteger(usage.inputTokens)&&Number.isSafeInteger(usage.outputTokens)&&usage.inputTokens>=0&&usage.outputTokens>=0&&usage.inputTokens<=reservation.maxInputTokens&&usage.outputTokens<=reservation.maxOutputTokens;
   await settleAttempt(context,{reservationId:reservation.id,at:new Date().toISOString(),outcome:result.acceptance==='not_accepted'?{kind:'released_not_called'}:result.acceptance==='accepted'&&validUsage?{kind:'settled',cents:centsOf('claude-haiku-4-5',usage,'bedrock')}:{kind:'estimated'}});
   const valid=loaded!==null&&loaded.fingerprint===row.source_fingerprint&&current.kind==='available'&&current.snapshot.operationalReady;
   let outcome:unknown=null,reason:string|null=null,state='complete';
   if(!valid){state='stale';reason='source_or_authority_changed';}
   else if(result.acceptance==='unknown'||!validUsage){state='unknown_acceptance';reason='model_acceptance_or_usage_unknown';}
   else if(result.acceptance==='not_accepted'){state='unavailable';reason='model_not_accepted';}
   else{
    const parsed=candidateSchema.safeParse(result.candidate);
    const evidence=parsed.success?parsed.data.agreement:null;
    const original=loaded.originals[0]!;
    const ranges=z.array(z.object({kind:z.string(),start:z.number().int(),end:z.number().int()})).safeParse(original.ranges);
    const supported=evidence!==null&&evidence.sourceId===original.sourceId&&evidence.end>evidence.start&&original.passage?.slice(evidence.start,evidence.end)===evidence.quote&&ranges.success&&ranges.data.some(range=>range.kind==='authored'&&range.start<=evidence.start&&range.end>=evidence.end);
    if(parsed.success&&supported&&(parsed.data.intent==='opt_out'||parsed.data.intent==='refusal'))outcome={kind:'stop',reason:parsed.data.intent,evidence,permission:false};
    else if(parsed.success&&supported&&parsed.data.intent==='interest'&&parsed.data.slot===null&&parsed.data.substantive===null)outcome={kind:'approved_link',bookingUrl:snapshot.bindings.event.bookingUrl,permission:false};
    else outcome={kind:'clarification',reason:'booking_candidate_requires_review',permission:false};
   }
   await input.session.query("UPDATE crm_booking_interpretations SET state=$3,reason=$4,outcome=$5::jsonb WHERE workspace_id=$1 AND id=$2 AND state='processing'",[input.scope.workspaceId,id,state,reason,outcome===null?null:JSON.stringify(outcome)]);
  });
 }};
}
