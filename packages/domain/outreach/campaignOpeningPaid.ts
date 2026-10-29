import type {RepositoryContext} from '../db/workspaceScope.ts';
import {withTransaction,type SessionQueryable} from '../db/queryable.ts';
import {lockSendGateForDispatch} from '../policy/sendGate.ts';
import {databaseNow} from '../policy/clock.ts';
import {listApplicableHolds} from '../policy/holds.ts';
import {lockResearchBudget} from '../research/ceilings.ts';
import {readResearchSettings,type ResearchSettings} from '../research/settings.ts';
import {readCreditSpend,workspaceBusinessZone} from '../research/ledger.ts';
import {readAttempt,reserveAttempt,markCalling,settleAttempt,type SettleOutcome} from '../research/reservations.ts';
import {ModelBudgetRefusal} from '../research/modelBudget.ts';
import {centsOf,countedWithHeadroom} from '../research/pricing.ts';
import {localDate} from '../src/rules/localClock.ts';
import type {CampaignOpeningSelector,CampaignOpeningSnapshot} from './campaignOpening.ts';
import {CAMPAIGN_OPENING_MODEL,CAMPAIGN_OPENING_MAX_OUTPUT_TOKENS,type CampaignOpeningModelPort,type CampaignOpeningDispatchAuthority} from './campaignOpeningModelPort.ts';

const MAX_INPUT_TOKENS=10000;

/** The opening owner has already committed its exact UNKNOWN attempt. The supplied
 * context/session share one connection outside a transaction; current rechecks that
 * original attempt, source, policy, owner and execution authority after waits. */
export function budgetedCampaignOpeningSelector(
 ctx:RepositoryContext,session:SessionQueryable,port:CampaignOpeningModelPort,current:()=>Promise<boolean>,
 finalAuthority:()=>Promise<CampaignOpeningDispatchAuthority|null>,
):CampaignOpeningSelector {
 const allowedResearchSettings=async(snapshot:CampaignOpeningSnapshot):Promise<ResearchSettings|null>=>{
  const settings=await readResearchSettings(ctx);
  if(!settings.enabled||(await listApplicableHolds(ctx,{
   actionKind:'research',firmId:snapshot.binding.firmId,ownerUserId:snapshot.binding.ownerUserId,
  })).length)return null;
  return settings;
 };
 const settle=async(reservationId:string,outcome:SettleOutcome):Promise<void>=>{
  await withTransaction(session,async()=>{
   await settleAttempt(ctx,{reservationId,at:await databaseNow(ctx),outcome});
  });
 };
 return {select:async input=>{
  if(port.providerKey!=='aws_bedrock.campaign_opening'||!await current())return {kind:'refused'};
  const {attemptId,...snapshot}=input;
  const attempt={subjectKind:'campaign_opening' as const,subjectId:attemptId,attempt:1};
  if(await readAttempt(ctx,attempt)||!await current())return {kind:'refused'};
  let counted:number;
  try{counted=await port.countInputTokens(snapshot);}catch{return {kind:'refused'};}
  if(!await current()||!Number.isSafeInteger(counted)||counted<=0)return {kind:'refused'};
  const inputTokens=countedWithHeadroom(counted);
  if(inputTokens>MAX_INPUT_TOKENS)return {kind:'refused'};
  const cents=centsOf(CAMPAIGN_OPENING_MODEL,{inputTokens,outputTokens:CAMPAIGN_OPENING_MAX_OUTPUT_TOKENS},'bedrock');
  const reservation=await withTransaction(session,async()=>{
   await lockSendGateForDispatch(ctx);
   await lockResearchBudget(ctx);
   if(!await current()||await readAttempt(ctx,attempt))return null;
   const settings=await allowedResearchSettings(snapshot);
   if(!settings)return null;
   const at=await databaseNow(ctx),zone=await workspaceBusinessZone(ctx);
   const spend=await readCreditSpend(ctx,{at,businessTimeZone:zone});
   if(!settings.enabled||spend.todayCents+cents>settings.dailyCostCeilingCents
    ||spend.monthToDateCents+cents>settings.monthlyCostCeilingCents||!await current())return null;
   const row=await reserveAttempt(ctx,{...attempt,providerKey:port.providerKey,at,businessTimeZone:zone,cents,
    modelName:CAMPAIGN_OPENING_MODEL,maxInputTokens:inputTokens,maxOutputTokens:CAMPAIGN_OPENING_MAX_OUTPUT_TOKENS});
   return await markCalling(ctx,row.id)?row:null;
  }).catch((error:unknown)=>{if(error instanceof ModelBudgetRefusal)return null;throw error;});
  if(!reservation)return {kind:'refused'};
  // The calling marker is committed. Loss before dispatch releases only this
  // caller's obligation, without reopening its already-consumed attempt identity.
  if(!await current()){
   await settle(reservation.id,{kind:'released_not_called'});
   return {kind:'refused'};
  }
  const settings=await allowedResearchSettings(snapshot);
  const zone=await workspaceBusinessZone(ctx),at=await databaseNow(ctx);
  const spend=await readCreditSpend(ctx,{at,businessTimeZone:zone});
  const authorized=await current();
  // Open spend already includes this reservation: adding cents here again would
  // double-count its obligation. A date/zone change cannot re-date the same claim.
  if(!settings||!authorized||zone!==reservation.businessTimeZone||localDate(at,zone)!==reservation.businessDate
   ||spend.todayCents>settings.dailyCostCeilingCents||spend.monthToDateCents>settings.monthlyCostCeilingCents){
   await settle(reservation.id,{kind:'released_not_called'});
   return {kind:'refused'};
  }
  // One final statement supplies owner control, clock and zone together after all
  // source/budget waits. No separate authority or clock await follows this snapshot.
  const authority=await finalAuthority();
  if(!authority?.authorized||authority.businessTimeZone!==reservation.businessTimeZone
   ||localDate(authority.at,authority.businessTimeZone)!==reservation.businessDate){
   await settle(reservation.id,{kind:'released_not_called'});
   return {kind:'refused'};
  }
  let answer:Awaited<ReturnType<CampaignOpeningModelPort['select']>>;
  try{answer=await port.select(snapshot);}catch(error:unknown){
   await settle(reservation.id,{kind:'estimated'});
   throw error;
  }
  const observed=answer?.costEstimated===false&&Number.isSafeInteger(answer.costCents)&&answer.costCents>=0;
  await settle(reservation.id,observed?{kind:'settled',cents:answer.costCents}:{kind:'estimated'});
  // The existing opening owner validates the choice and current publication after
  // settlement. Neither returned choice nor paid receipt grants sending authority.
  return {kind:'selected',choice:answer?.choice};
 }};
}
