import {socialWeeklyRequestAllowed} from './weekly.ts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {withTransaction,type SessionQueryable} from '../db/queryable.ts';
import {databaseNow} from '../policy/clock.ts';
import {listApplicableHolds} from '../policy/holds.ts';
import {readResearchSettings} from '../research/settings.ts';
import {lockResearchBudget} from '../research/ceilings.ts';
import {readCreditSpend,workspaceBusinessZone} from '../research/ledger.ts';
import {reserveAttempt,markCalling,settleAttempt} from '../research/reservations.ts';
import {centsOf} from '../research/pricing.ts';
import type {SocialDraftRow} from './drafts.ts';
import {readSocialDraftSourcesForWorker} from './draftSources.ts';
import {SOCIAL_DRAFT_MODEL,SOCIAL_DRAFT_PROMPT_VERSION,SOCIAL_DRAFT_LIMITS,validateSocialDrafts,type SocialDraftInput} from './draftPolicy.ts';
export interface SocialDraftPort {
 readonly providerKey:'aws_bedrock.social_draft';
 countInputTokens(input:SocialDraftInput):Promise<number>;
 generate(input:SocialDraftInput):Promise<{raw:string;costCents:number;costEstimated:boolean}>;
}
/** No user impersonation, external call in a transaction, or automatic approval. */
export async function runSocialDraft(ctx:RepositoryContext,id:string,port:SocialDraftPort|null):Promise<void>{
 if(ctx.scope.actor.kind!=='system'||ctx.scope.actor.component!=='worker')throw new Error('worker_required');
 if(!port||port.providerKey!=='aws_bedrock.social_draft')return;
 const db=ctx.db as SessionQueryable;
 const read=async(lock=false)=>(await db.query<SocialDraftRow>(`SELECT * FROM social_draft_requests WHERE workspace_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[ctx.scope.workspaceId,id])).rows[0];
 const initial=await read();if(!initial||initial.state!=='queued')return;
 const review=async(reason:string)=>{await db.query("UPDATE social_draft_requests SET state='review',reason=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state IN ('queued','calling')",[ctx.scope.workspaceId,id,reason]);};
 if(!await socialWeeklyRequestAllowed(ctx,initial.owner_user_id,initial.weekly_revision)){await review('weekly_setting_changed');return;}
 const source=await readSocialDraftSourcesForWorker(ctx,initial.owner_user_id,initial.source_selection);
 if(!source.ok||source.value.hash!==initial.source_hash){await review('source_changed_or_unavailable');return;}
 let tokens:number;try{tokens=await port.countInputTokens(source.value.input);}catch{await review('token_count_unavailable');return;}
 if(!Number.isSafeInteger(tokens)||tokens<=0||tokens>100000){await review('input_over_budget');return;}
 const cents=centsOf(SOCIAL_DRAFT_MODEL,{inputTokens:tokens,outputTokens:SOCIAL_DRAFT_LIMITS.maxOutputTokens},'bedrock');
 const claim=await withTransaction(db,async()=>{
  await lockResearchBudget(ctx);
  const row=await read(true),at=await databaseNow(ctx);
  if(!row||row.state!=='queued'||row.paid_attempts>=SOCIAL_DRAFT_LIMITS.maxAttempts||row.deadline_at.getTime()<=Date.parse(at)||row.model_name!==SOCIAL_DRAFT_MODEL||row.prompt_version!==SOCIAL_DRAFT_PROMPT_VERSION)return null;
  if(!await socialWeeklyRequestAllowed(ctx,row.owner_user_id,row.weekly_revision)){await review('weekly_setting_changed');return null;}
  const settings=await readResearchSettings(ctx);
  if(!settings.enabled||(await listApplicableHolds(ctx,{actionKind:'research'})).length)return null;
  const current=await readSocialDraftSourcesForWorker(ctx,row.owner_user_id,row.source_selection);
  if(!current.ok||current.value.hash!==row.source_hash||current.value.hash!==source.value.hash){await review('source_changed_or_unavailable');return null;}
  const zone=await workspaceBusinessZone(ctx),spend=await readCreditSpend(ctx,{at,businessTimeZone:zone});
  if(spend.todayCents+cents>settings.dailyCostCeilingCents||spend.monthToDateCents+cents>settings.monthlyCostCeilingCents)return null;
  const reserved=await reserveAttempt(ctx,{subjectKind:'social_draft',subjectId:id,attempt:row.paid_attempts+1,providerKey:port.providerKey,at,businessTimeZone:zone,cents,modelName:SOCIAL_DRAFT_MODEL,maxInputTokens:tokens,maxOutputTokens:SOCIAL_DRAFT_LIMITS.maxOutputTokens});
  if(!await markCalling(ctx,reserved.id))return null;
  await db.query("UPDATE social_draft_requests SET state='calling',paid_attempts=paid_attempts+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",[ctx.scope.workspaceId,id]);
  return reserved;
 });
 if(!claim)return;
 let outcome:{raw:string;costCents:number;costEstimated:boolean};
 try{outcome=await port.generate(source.value.input);}catch{outcome={raw:'',costCents:claim.cents,costEstimated:true};}
 await withTransaction(db,async()=>{await settleAttempt(ctx,{reservationId:claim.id,at:await databaseNow(ctx),outcome:outcome.costEstimated||!Number.isSafeInteger(outcome.costCents)||outcome.costCents<0?{kind:'estimated'}:{kind:'settled',cents:outcome.costCents}});});
 await withTransaction(db,async()=>{
  const row=await read(true);if(!row||row.state!=='calling')return;
  if(!await socialWeeklyRequestAllowed(ctx,row.owner_user_id,row.weekly_revision)){await review('weekly_setting_changed');return;}
  const current=await readSocialDraftSourcesForWorker(ctx,row.owner_user_id,row.source_selection);
  if(!current.ok||current.value.hash!==row.source_hash){await review('source_changed_or_unavailable');return;}
  if(row.deadline_at.getTime()<=Date.parse(await databaseNow(ctx))){await db.query("UPDATE social_draft_requests SET state='expired',reason='deadline_expired',updated_at=now() WHERE workspace_id=$1 AND id=$2",[ctx.scope.workspaceId,id]);return;}
  const concepts=validateSocialDrafts(outcome.raw,current.value.input);
  await db.query('UPDATE social_draft_requests SET state=$3,concepts=$4::jsonb,reason=$5,updated_at=now() WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,id,concepts?'ready':row.paid_attempts<SOCIAL_DRAFT_LIMITS.maxAttempts?'queued':'review',concepts?JSON.stringify(concepts):null,concepts?null:'generation_unavailable_or_invalid']);
 });
}
