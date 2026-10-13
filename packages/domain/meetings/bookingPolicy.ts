import {createHash} from 'node:crypto';
import {BOOKING_BUSINESS_RULES,DEFAULT_BOOKING_POLICY,bookingPolicyCommandSchema,bookingPolicySettingSchema,type BookingPolicyBindings,type BookingPolicyView} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {readSetting,updateSetting,settingLockName} from '../settings/store.ts';
import {localDate} from '../src/rules/localClock.ts';
import type {BookingPolicyRuntime,BookingPolicyRuntimeEvidence,CurrentBookingPolicy,CurrentBookingPolicyQuery,BookingPolicySnapshot} from './bookingPolicyTypes.ts';
import {lockMonthlySpend,readSpend,workspaceBusinessZone} from '../research/ledger.ts';
import {readMonthlyCashCeiling} from '../settings/cashCeiling.ts';
import {providerFunding} from '../settings/funding.ts';
import {bookingPolicyBindingsSchema,type BookingPolicySettingsView} from '@fss/contracts';

export async function readBookingPolicySettings(ctx:RepositoryContext,runtime?:BookingPolicyRuntime):Promise<BookingPolicySettingsView> {
  return (await readObservedBookingPolicySettings(ctx,runtime)).view;
}
async function readObservedBookingPolicySettings(ctx:RepositoryContext,runtime?:BookingPolicyRuntime):Promise<{view:BookingPolicySettingsView;authorityVerifiedAt:string|null;authorityValidUntil:string|null}> {
  const actor=ctx.scope.actor;
  if(actor.kind!=='user'||actor.role!=='admin'||!await activeOwner(ctx,actor.userId))throw new Error('owner_authority_changed');
  let configured:readonly BookingPolicyBindings[]=[];
  try{configured=await runtime?.readConfiguration?.(ctx,actor.userId)??[];}catch{configured=[];}
  if(!await activeOwner(ctx,actor.userId))throw new Error('owner_authority_changed');
  const choices:BookingPolicySettingsView['configuration']['choices']=[];
  if(configured.length<=20)for(const candidate of configured){
    const parsed=bookingPolicyBindingsSchema.safeParse(candidate);
    if(!parsed.success||parsed.data.ownerUserId!==actor.userId)continue;
    const bindings=parsed.data,id=bookingPolicyBindingKey(bindings);
    if(!choices.some(choice=>choice.id===id))choices.push({id,label:`Cal.com ${bindings.account.email} · Event ${bindings.event.eventTypeId} · ${bindings.model.modelVersion}`.slice(0,500),bindings});
  }
  const observed=await readObservedBookingPolicy(ctx,runtime);
  if(!await activeOwner(ctx,actor.userId))throw new Error('owner_authority_changed');
  return {view:{policy:observed.view,configuration:{choices,reasons:choices.length===0?['setup_unavailable']:[]}},authorityVerifiedAt:observed.authorityVerifiedAt,authorityValidUntil:observed.authorityValidUntil};
}

/** Server-only response observation. Its metadata is never serialized onto the public success wire. */
export async function readBookingPolicyResponseObservation(ctx:RepositoryContext,view:'settings'|null,runtime?:BookingPolicyRuntime):Promise<{readonly body:BookingPolicyView|BookingPolicySettingsView;readonly authorityVerifiedAt:string|null;readonly authorityValidUntil:string|null;readonly observedBusinessDate:string}> {
  const observed=view==='settings'?await readObservedBookingPolicySettings(ctx,runtime):await readObservedBookingPolicy(ctx,runtime);
  const policy='policy' in observed.view?observed.view.policy:observed.view;
  return {body:observed.view,authorityVerifiedAt:observed.authorityVerifiedAt,authorityValidUntil:observed.authorityValidUntil,observedBusinessDate:policy.budget.businessDate};
}
/** Pure terminal response freshness. It performs no reads and grants no operational authority. */
export function bookingPolicyResponseObservationCurrentAt(observed:Awaited<ReturnType<typeof readBookingPolicyResponseObservation>>,now:string):boolean {
  if(!Number.isFinite(Date.parse(now))||localDate(now,'America/New_York')!==observed.observedBusinessDate)return false;
  if(observed.authorityVerifiedAt===null&&observed.authorityValidUntil===null)return true;
  if(typeof observed.authorityVerifiedAt!=='string'||typeof observed.authorityValidUntil!=='string')return false;
  return !expiredRuntimeEvidence({verifiedAt:observed.authorityVerifiedAt,validUntil:observed.authorityValidUntil},now);
}

export async function readCurrentBookingPolicy(ctx:RepositoryContext,query:CurrentBookingPolicyQuery,runtime?:BookingPolicyRuntime):Promise<CurrentBookingPolicy> {
  const actor=ctx.scope.actor;
  if(actor.kind==='user'&&(actor.role!=='admin'||actor.userId!==query.ownerUserId||!await activeOwner(ctx,actor.userId)))return {kind:'unavailable',reason:'owner_authority_changed'};
  const observed=await readObservedBookingPolicy(ctx,runtime),view=observed.view,bindings=view.setting.bindings;
  if(view.setting.status==='revoked')return {kind:'unavailable',reason:'policy_revoked'};
  if(!view.businessPolicyValid||bindings===null)return {kind:'unavailable',reason:'policy_unavailable'};
  if(bindings.ownerUserId!==query.ownerUserId)return {kind:'unavailable',reason:'owner_changed'};
  if(query.expectedRevision!==undefined&&query.expectedRevision!==view.revision)return {kind:'unavailable',reason:'policy_revision_changed'};
  const bindingKey=bookingPolicyBindingKey(bindings);
  if(query.expectedBindingKey!==undefined&&query.expectedBindingKey!==bindingKey)return {kind:'unavailable',reason:'policy_binding_changed'};
  const capability=query.capability??'booking';
  const unrelatedToInterpretation=new Set(['account_access_unverified','calendar_freebusy_unverified','event_settings_unverified','sender_authority_unverified','provider_adapter_unavailable','release_unverified']);
  const operationalReady=capability==='booking'?view.readiness.ready:view.readiness.evidenceKind!=='unavailable'&&view.readiness.reasons.every(reason=>unrelatedToInterpretation.has(reason));
  return {kind:'available',snapshot:{capability,workspaceId:ctx.scope.workspaceId,ownerUserId:bindings.ownerUserId,policyRevision:view.revision,bindingKey,bindings,businessPolicyValid:true,operationalReady,enabled:false,evidenceKind:view.readiness.evidenceKind,authorityVerifiedAt:observed.authorityVerifiedAt,authorityValidUntil:observed.authorityValidUntil}};
}
/** Technical terminal freshness only. Never an Enable, sending or booking permission grant. */
export function bookingPolicySnapshotReadyAt(snapshot:BookingPolicySnapshot,now:string):boolean {
  if(!snapshot.businessPolicyValid||!snapshot.operationalReady||typeof snapshot.authorityVerifiedAt!=='string'||typeof snapshot.authorityValidUntil!=='string')return false;
  const at=Date.parse(now),verified=Date.parse(snapshot.authorityVerifiedAt),until=Date.parse(snapshot.authorityValidUntil);
  return Number.isFinite(at)&&Number.isFinite(verified)&&Number.isFinite(until)&&verified<=at&&at<until;
}
export async function revalidateBookingPolicy(ctx:RepositoryContext,snapshot:BookingPolicySnapshot,runtime?:BookingPolicyRuntime):Promise<CurrentBookingPolicy> {
  if(ctx.scope.workspaceId!==snapshot.workspaceId)return {kind:'unavailable',reason:'workspace_changed'};
  return readCurrentBookingPolicy(ctx,{ownerUserId:snapshot.ownerUserId,expectedRevision:snapshot.policyRevision,expectedBindingKey:snapshot.bindingKey,capability:snapshot.capability},runtime);
}

export function bookingPolicyBindingKey(bindings:BookingPolicyBindings):string {
  return createHash('sha256').update(JSON.stringify(bindings)).digest('hex');
}
async function activeOwner(ctx:RepositoryContext,owner:string):Promise<boolean> {
  const member=(await ctx.db.query<{role:string;status:string}>('SELECT role,status FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',[ctx.scope.workspaceId,owner])).rows[0];
  return member?.role==='admin'&&member.status==='active';
}
export async function lockBookingBudget(ctx:RepositoryContext):Promise<void> {
  await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${ctx.scope.workspaceId}:booking_budget`]);
  await lockMonthlySpend(ctx);
}
/** Read-only observer, not a reservation. Callers reserve under lockBookingBudget in their transaction. */
export async function readBookingBudget(ctx:RepositoryContext,input:{at:string;bindings:BookingPolicyBindings|null;funding?:BookingPolicyRuntimeEvidence['funding']}):Promise<BookingPolicyView['budget']> {
  const date=localDate(input.at,'America/New_York'),month=date.slice(0,7),bindings=input.bindings;
  const spend=(await ctx.db.query<{today:string|null;month:string|null}>(`WITH spend AS (
    SELECT business_date,cost_cents AS cents FROM provider_ledger WHERE workspace_id=$1 AND provider_key IN ('aws_bedrock.booking','google_vertex.booking','calcom.booking')
    UNION ALL SELECT business_date,cents FROM provider_reservations WHERE workspace_id=$1 AND provider_key IN ('aws_bedrock.booking','google_vertex.booking','calcom.booking') AND state IN ('reserved','calling')
  ) SELECT sum(cents) FILTER(WHERE business_date=$2::date) AS today,sum(cents) FILTER(WHERE business_date>=$3::date AND business_date<= $2::date) AS month FROM spend`,[ctx.scope.workspaceId,date,`${month}-01`])).rows[0];
  const dailyCeilingCents=bindings?.budget.dailyCeilingCents??200,monthlyCeilingCents=bindings?.budget.monthlyCeilingCents??2500,observedDailyCents=Number(spend?.today??0),observedMonthlyCents=Number(spend?.month??0);
  const funding=input.funding;
  let allowance:BookingPolicyView['budget']['allowance']='unknown',remainingDailyCents:number|null=null,remainingMonthlyCents:number|null=null;
  if(funding?.status==='held'||observedDailyCents>=dailyCeilingCents||observedMonthlyCents>=monthlyCeilingCents)allowance='blocked';
  else if(bindings!==null&&funding?.status==='verified'&&Number.isSafeInteger(funding.sharedRemainingDailyCents)&&Number.isSafeInteger(funding.sharedRemainingMonthlyCents)&&funding.sharedRemainingDailyCents!==null&&funding.sharedRemainingMonthlyCents!==null){
    let cashRemaining=Number.MAX_SAFE_INTEGER;
    if(providerFunding(`${bindings.model.providerKey}.booking`)==='cash'){
      const shared=await readSpend(ctx,{at:input.at,businessTimeZone:await workspaceBusinessZone(ctx)});
      cashRemaining=Math.max(0,await readMonthlyCashCeiling(ctx)-shared.monthToDateCents);
    }
    remainingDailyCents=Math.max(0,Math.min(dailyCeilingCents-observedDailyCents,funding.sharedRemainingDailyCents));
    remainingMonthlyCents=Math.max(0,Math.min(monthlyCeilingCents-observedMonthlyCents,funding.sharedRemainingMonthlyCents,cashRemaining));
    allowance=remainingDailyCents===0||remainingMonthlyCents===0?'blocked':'available';
  }
  return {lane:'booking',timeZone:'America/New_York',businessDate:date,calendarMonth:month,dailyCeilingCents,monthlyCeilingCents,observedDailyCents,observedMonthlyCents,allowance,remainingDailyCents,remainingMonthlyCents};
}
function expiredRuntimeEvidence(evidence:Pick<BookingPolicyRuntimeEvidence,'verifiedAt'|'validUntil'>,at:string):boolean {
  return !Number.isFinite(Date.parse(evidence.verifiedAt))||!Number.isFinite(Date.parse(evidence.validUntil))||Date.parse(evidence.verifiedAt)>Date.parse(at)||Date.parse(evidence.validUntil)<=Date.parse(at);
}
export async function readBookingPolicy(ctx:RepositoryContext,runtime?:BookingPolicyRuntime):Promise<BookingPolicyView> {
  return (await readObservedBookingPolicy(ctx,runtime)).view;
}
async function readObservedBookingPolicy(ctx:RepositoryContext,runtime?:BookingPolicyRuntime):Promise<{view:BookingPolicyView;authorityVerifiedAt:string|null;authorityValidUntil:string|null}> {
  const stored=await readSetting(ctx,'booking_policy');
  const parsed=bookingPolicySettingSchema.safeParse(stored.value);
  const setting=parsed.success?parsed.data:DEFAULT_BOOKING_POLICY,bindings=setting.bindings;
  const audit=(await ctx.db.query<{changed_by_user_id:string|null}>('SELECT changed_by_user_id FROM workspace_settings WHERE workspace_id=$1 AND setting_key=$2 AND superseded_at IS NULL',[ctx.scope.workspaceId,'booking_policy'])).rows[0];
  const businessPolicyValid=setting.status==='saved'&&bindings!==null&&audit?.changed_by_user_id===bindings.ownerUserId&&await activeOwner(ctx,bindings.ownerUserId);
  let at=runtime?.now()??new Date().toISOString();
  let evidence:BookingPolicyRuntimeEvidence|null=null;
  if(businessPolicyValid&&bindings!==null&&runtime!==undefined){try{evidence=await runtime.readEvidence(ctx,structuredClone(bindings));}catch{evidence=null;}}
  // The trusted evidence read may have waited. Saved revisions and membership are checked again, not cached.
  if((await readSetting(ctx,'booking_policy')).version!==stored.version||(businessPolicyValid&&bindings!==null&&!await activeOwner(ctx,bindings.ownerUserId)))return readObservedBookingPolicy(ctx);
  at=runtime?.now()??new Date().toISOString();
  const requirements={accountAccess:'account_access_unverified',calendarFreeBusy:'calendar_freebusy_unverified',eventSettings:'event_settings_unverified',modelConsent:'model_consent_unverified',modelAcceptance:'model_acceptance_unverified',senderAuthority:'sender_authority_unverified',sourceAuthority:'source_authority_unverified',providerAdapter:'provider_adapter_unavailable',releaseReady:'release_unverified'} as const;
  let reasons:string[]=[];
  if(evidence!==null&&bindings!==null&&bookingPolicyBindingKey(evidence.binding)!==bookingPolicyBindingKey(bindings)){reasons=['runtime_binding_changed'];evidence=null;}
  else if(evidence!==null&&expiredRuntimeEvidence(evidence,at)){reasons=['runtime_evidence_expired'];evidence=null;}
  else reasons=Object.entries(requirements).filter(([key])=>evidence?.[key as keyof typeof requirements]!==true).map(([,reason])=>reason);
  if(bindings?.model.qualityReviewRevision===null&&evidence!==null)reasons.push('model_quality_review_missing');
  if(!businessPolicyValid)reasons.push('policy_unavailable');
  let budget:BookingPolicyView['budget'];
  for(;;){
    budget=await readBookingBudget(ctx,{at,bindings,...(evidence===null?{}:{funding:evidence.funding})});
    if((await readSetting(ctx,'booking_policy')).version!==stored.version||(businessPolicyValid&&bindings!==null&&!await activeOwner(ctx,bindings.ownerUserId)))return readObservedBookingPolicy(ctx);
    const completedAt=runtime?.now()??new Date().toISOString();
    const periodChanged=localDate(completedAt,'America/New_York')!==budget.businessDate;
    const fundingExpired=evidence!==null&&expiredRuntimeEvidence(evidence,completedAt);
    if(fundingExpired){reasons=['runtime_evidence_expired'];evidence=null;}
    if(!periodChanged&&!fundingExpired)break;
    // Only a changed NY period or expired funding needs another canonical observation.
    at=completedAt;
  }
  if(evidence!==null&&budget.allowance!=='available')reasons.push(budget.allowance==='blocked'?'booking_budget_blocked':'booking_budget_unknown');
  return {view:{revision:stored.version,setting,rules:BOOKING_BUSINESS_RULES,businessPolicyValid,enabled:false,readiness:{ready:reasons.length===0,reasons,evidenceKind:evidence?.evidenceKind??'unavailable'},budget},authorityVerifiedAt:evidence?.verifiedAt??null,authorityValidUntil:evidence?.validUntil??null};
}
/** Must run in the ordinary command transaction. The settings lock orders competing revisions. */
export async function mutateBookingPolicy(ctx:RepositoryContext,input:unknown):Promise<{ok:true;value:{revision:number}}|{ok:false;reason:string}> {
  const actor=ctx.scope.actor;
  if(actor.kind!=='user'||actor.role!=='admin'||!await activeOwner(ctx,actor.userId))return {ok:false,reason:'admin_required'};
  const parsed=bookingPolicyCommandSchema.safeParse(input);if(!parsed.success)return {ok:false,reason:'invalid_input'};
  const command=parsed.data;
  if(command.action==='save'&&command.bindings.ownerUserId!==actor.userId)return {ok:false,reason:'owner_mismatch'};
  await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[settingLockName(ctx.scope.workspaceId,'booking_policy')]);
  if(!await activeOwner(ctx,actor.userId))return {ok:false,reason:'admin_required'};
  const old=await readSetting(ctx,'booking_policy');if(old.version!==command.expectedRevision)return {ok:false,reason:'stale_revision'};
  const previous=bookingPolicySettingSchema.safeParse(old.value);
  const setting=command.action==='save'?{status:'saved',enabled:false,bindings:command.bindings}:{status:command.action==='revoke'?'revoked':'disabled',enabled:false,bindings:previous.success?previous.data.bindings:null};
  const result=await updateSetting(ctx,{settingKey:'booking_policy',value:setting,commandId:command.commandId,changeNote:`Booking policy ${command.action}`});
  return result.ok?{ok:true,value:{revision:result.value.current.version}}:result;
}
