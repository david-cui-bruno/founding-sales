import {socialWeeklyRequestAllowed} from './weekly.ts';
import {retiredPostingDraftReason} from './retiredPosting.ts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {withTransaction,type SessionQueryable} from '../db/queryable.ts';
import {databaseNow} from '../policy/clock.ts';
import {listApplicableHolds} from '../policy/holds.ts';
import {readResearchSettings} from '../research/settings.ts';
import {lockResearchBudget} from '../research/ceilings.ts';
import {readCreditSpend,workspaceBusinessZone} from '../research/ledger.ts';
import {reserveAttempt,markCalling,settleAttempt} from '../research/reservations.ts';
import {centsOf} from '../research/pricing.ts';
/** All social drafting is conservatively charged to this lane, never shifted to research. */
export async function postingSpend(ctx:RepositoryContext,at:string):Promise<{today:number;month:number}>{
 const row=(await ctx.db.query<{today:string;month:string}>(`WITH spend AS (SELECT (created_at AT TIME ZONE 'America/New_York')::date AS day,CASE WHEN state IN ('reserved','calling') THEN cents ELSE settled_cents END AS cost FROM provider_reservations WHERE workspace_id=$1 AND subject_kind='social_draft' AND state<>'released') SELECT COALESCE(sum(cost) FILTER(WHERE day=($2::timestamptz AT TIME ZONE 'America/New_York')::date),0)::text AS today,COALESCE(sum(cost) FILTER(WHERE day>=date_trunc('month',$2::timestamptz AT TIME ZONE 'America/New_York')::date AND day<=($2::timestamptz AT TIME ZONE 'America/New_York')::date),0)::text AS month FROM spend`,[ctx.scope.workspaceId,at])).rows[0]!;
 return {today:Number(row.today),month:Number(row.month)};
}
import type {SocialDraftRow} from './drafts.ts';
import {readSocialDraftSourcesForWorker} from './draftSources.ts';
import {SOCIAL_DRAFT_MODEL,socialDraftPromptVersion,SOCIAL_DRAFT_LIMITS,validateSocialDrafts,type SocialDraftInput} from './draftPolicy.ts';
import {socialVoicePortAllowed,readPrivateVoiceGuide,PRIVATE_VOICE_GUIDE_VERSION} from './voiceGeneration.ts';
export interface SocialDraftPort {
 readonly providerKey:'aws_bedrock.social_draft';
 readonly privateVoiceGuideVersion?:typeof PRIVATE_VOICE_GUIDE_VERSION;
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
 const review=async(reason:string)=>{await db.query("UPDATE social_draft_requests SET state='review',concepts=NULL,reason=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state IN ('queued','calling')",[ctx.scope.workspaceId,id,reason]);};
 if(!socialVoicePortAllowed(initial.source_selection,port)){await review('voice_guide_port_unavailable');return;}
 const standing=async()=>{const reason=await retiredPostingDraftReason(ctx,id);if(reason)await review(reason);return reason===null;};
 if(!await withTransaction(db,standing))return;
 if(!await socialWeeklyRequestAllowed(ctx,initial.owner_user_id,initial.weekly_revision)){await review('weekly_setting_changed');return;}
 const source=await withTransaction(db,()=>readSocialDraftSourcesForWorker(ctx,initial.owner_user_id,initial.source_selection));
 if(!source.ok||source.value.hash!==initial.source_hash){await review('source_changed_or_unavailable');return;}
 let tokens:number;try{tokens=await port.countInputTokens(source.value.input);}catch{await review('token_count_unavailable');return;}
 if(!await withTransaction(db,standing))return;
 if(!Number.isSafeInteger(tokens)||tokens<=0||tokens>100000){await review('input_over_budget');return;}
 let cents:number;try{cents=centsOf(SOCIAL_DRAFT_MODEL,{inputTokens:tokens,outputTokens:SOCIAL_DRAFT_LIMITS.maxOutputTokens},'bedrock');}catch{await review('cost_bound_unavailable');return;}
 if(!Number.isSafeInteger(cents)||cents<=0){await review('cost_bound_unavailable');return;}
 const claim=await withTransaction(db,async()=>{
  // Guide lifecycle writers own membership/guide before request rows. Acquire
  // those same locks first, never a guide lock from beneath a request lock.
  const guide=await readPrivateVoiceGuide(ctx,initial.owner_user_id,initial.source_selection);
  if(!guide.ok){await review('source_changed_or_unavailable');return null;}
  if(!await standing())return null;
  await lockResearchBudget(ctx);
  const row=await read(true),at=await databaseNow(ctx);
  if(!await standing())return null;
  if(!row||row.state!=='queued'||row.paid_attempts>=SOCIAL_DRAFT_LIMITS.maxAttempts||row.deadline_at.getTime()<=Date.parse(at)||row.model_name!==SOCIAL_DRAFT_MODEL||row.prompt_version!==socialDraftPromptVersion(row.source_selection.mode))return null;
  if(!await socialWeeklyRequestAllowed(ctx,row.owner_user_id,row.weekly_revision)){await review('weekly_setting_changed');return null;}
  const settings=await readResearchSettings(ctx);
  if(!settings.enabled||(await listApplicableHolds(ctx,{actionKind:'research'})).length){if(row.source_selection.mode)await review('drafting_held');return null;}
  const current=await readSocialDraftSourcesForWorker(ctx,row.owner_user_id,row.source_selection);
  if(!current.ok||current.value.hash!==row.source_hash||current.value.hash!==source.value.hash){await review('source_changed_or_unavailable');return null;}
  const zone=await workspaceBusinessZone(ctx),spend=await readCreditSpend(ctx,{at,businessTimeZone:zone});
  if(spend.todayCents+cents>settings.dailyCostCeilingCents||spend.monthToDateCents+cents>settings.monthlyCostCeilingCents){if(row.source_selection.mode)await review('shared_budget_exhausted');return null;}
  if(row.source_selection.mode){const lane=await postingSpend(ctx,at);if(lane.today+cents>100||lane.month+cents>1000){await review('posting_budget_exhausted');return null;}}
  const reserved=await reserveAttempt(ctx,{subjectKind:'social_draft',subjectId:id,attempt:row.paid_attempts+1,providerKey:port.providerKey,at,businessTimeZone:zone,cents,modelName:SOCIAL_DRAFT_MODEL,maxInputTokens:tokens,maxOutputTokens:SOCIAL_DRAFT_LIMITS.maxOutputTokens});
  if(!await markCalling(ctx,reserved.id))return null;
  await db.query("UPDATE social_draft_requests SET state='calling',paid_attempts=paid_attempts+1,updated_at=now() WHERE workspace_id=$1 AND id=$2",[ctx.scope.workspaceId,id]);
  // Historical standing work must not spend through the manual draft worker,
  // including after a reservation/row wait. Preserve any incurred spend.
  const retired=await retiredPostingDraftReason(ctx,id);
  if(retired){
   await settleAttempt(ctx,{reservationId:reserved.id,at:await databaseNow(ctx),outcome:{kind:'released_not_called'}});
   await review(retired);return null;
  }
  return reserved;
 });
 if(!claim)return;
 // Reservation/standing/budget waits above cannot authorize stale style. This
 // claim alone knows no generation call has happened, so it can release here.
 const handoff=await withTransaction(db,async()=>{
  const current=await readSocialDraftSourcesForWorker(ctx,initial.owner_user_id,initial.source_selection);
  const row=await read(true);
  const valid=current.ok&&current.value.hash===source.value.hash&&row?.state==='calling'&&row.source_hash===current.value.hash&&row.deadline_at.getTime()>Date.parse(await databaseNow(ctx));
  if(!valid){await review('source_changed_or_unavailable');return null;}
  return current.value.input;
 });
 if(!handoff){await withTransaction(db,()=>settleAttempt(ctx,{reservationId:claim.id,at:new Date().toISOString(),outcome:{kind:'released_not_called'}}));return;}
 let outcome:{raw:string;costCents:number;costEstimated:boolean};
 try{outcome=await port.generate(handoff);}catch{outcome={raw:'',costCents:claim.cents,costEstimated:true};}
 await withTransaction(db,async()=>{await settleAttempt(ctx,{reservationId:claim.id,at:await databaseNow(ctx),outcome:outcome.costEstimated||!Number.isSafeInteger(outcome.costCents)||outcome.costCents<0?{kind:'estimated'}:{kind:'settled',cents:outcome.costCents}});});
 await withTransaction(db,async()=>{
  const guide=await readPrivateVoiceGuide(ctx,initial.owner_user_id,initial.source_selection);
  if(!guide.ok){await review('source_changed_or_unavailable');return;}
  if(!await standing())return;
  await lockResearchBudget(ctx);
  const row=await read(true);if(!row||row.state!=='calling')return;
  if(row.source_selection.mode){
   const settings=await readResearchSettings(ctx),at=await databaseNow(ctx),zone=await workspaceBusinessZone(ctx),shared=await readCreditSpend(ctx,{at,businessTimeZone:zone}),lane=await postingSpend(ctx,at);
   if(!settings.enabled||(await listApplicableHolds(ctx,{actionKind:'research'})).length){await review('drafting_held');return;}
   if(outcome.costCents>claim.cents||shared.todayCents>settings.dailyCostCeilingCents||shared.monthToDateCents>settings.monthlyCostCeilingCents||lane.today>100||lane.month>1000){await review('cost_bound_or_budget_changed');return;}
  }
  if(!await socialWeeklyRequestAllowed(ctx,row.owner_user_id,row.weekly_revision)){await review('weekly_setting_changed');return;}
  const current=await readSocialDraftSourcesForWorker(ctx,row.owner_user_id,row.source_selection);
  if(!current.ok||current.value.hash!==row.source_hash){await review('source_changed_or_unavailable');return;}
  if(row.deadline_at.getTime()<=Date.parse(await databaseNow(ctx))){await db.query("UPDATE social_draft_requests SET state='expired',reason='deadline_expired',updated_at=now() WHERE workspace_id=$1 AND id=$2",[ctx.scope.workspaceId,id]);return;}
  const concepts=validateSocialDrafts(outcome.raw,current.value.input);
  await db.query('UPDATE social_draft_requests SET state=$3,concepts=$4::jsonb,reason=$5,updated_at=now() WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,id,concepts?'ready':!row.source_selection.mode&&row.paid_attempts<SOCIAL_DRAFT_LIMITS.maxAttempts?'queued':'review',concepts?JSON.stringify(concepts):null,concepts?null:'generation_unavailable_or_invalid']);
 });
}
