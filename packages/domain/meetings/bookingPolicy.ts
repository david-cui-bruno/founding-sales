import {createHash} from 'node:crypto';
import {BOOKING_BUSINESS_RULES,DEFAULT_BOOKING_POLICY,bookingPolicyCommandSchema,bookingPolicySettingSchema,type BookingPolicyBindings,type BookingPolicyView} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {readSetting,updateSetting,settingLockName} from '../settings/store.ts';
import {localDate} from '../src/rules/localClock.ts';
import type {BookingPolicyRuntime,CurrentBookingPolicy,CurrentBookingPolicyQuery,BookingPolicySnapshot} from './bookingPolicyTypes.ts';

export async function readCurrentBookingPolicy(ctx:RepositoryContext,query:CurrentBookingPolicyQuery,runtime?:BookingPolicyRuntime):Promise<CurrentBookingPolicy> {
  const view=await readBookingPolicy(ctx,runtime),bindings=view.setting.bindings;
  if(view.setting.status==='revoked')return {kind:'unavailable',reason:'policy_revoked'};
  if(!view.businessPolicyValid||bindings===null)return {kind:'unavailable',reason:'policy_unavailable'};
  if(bindings.ownerUserId!==query.ownerUserId)return {kind:'unavailable',reason:'owner_changed'};
  if(query.expectedRevision!==undefined&&query.expectedRevision!==view.revision)return {kind:'unavailable',reason:'policy_revision_changed'};
  const bindingKey=bookingPolicyBindingKey(bindings);
  if(query.expectedBindingKey!==undefined&&query.expectedBindingKey!==bindingKey)return {kind:'unavailable',reason:'policy_binding_changed'};
  return {kind:'available',snapshot:{workspaceId:ctx.scope.workspaceId,ownerUserId:bindings.ownerUserId,policyRevision:view.revision,bindingKey,bindings,businessPolicyValid:true,operationalReady:view.readiness.ready,enabled:false,evidenceKind:view.readiness.evidenceKind}};
}
export async function revalidateBookingPolicy(ctx:RepositoryContext,snapshot:BookingPolicySnapshot,runtime?:BookingPolicyRuntime):Promise<CurrentBookingPolicy> {
  if(ctx.scope.workspaceId!==snapshot.workspaceId)return {kind:'unavailable',reason:'workspace_changed'};
  return readCurrentBookingPolicy(ctx,{ownerUserId:snapshot.ownerUserId,expectedRevision:snapshot.policyRevision,expectedBindingKey:snapshot.bindingKey},runtime);
}

export function bookingPolicyBindingKey(bindings:BookingPolicyBindings):string {
  return createHash('sha256').update(JSON.stringify(bindings)).digest('hex');
}
async function activeOwner(ctx:RepositoryContext,owner:string):Promise<boolean> {
  const member=(await ctx.db.query<{role:string;status:string}>('SELECT role,status FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',[ctx.scope.workspaceId,owner])).rows[0];
  return member?.role==='admin'&&member.status==='active';
}
export async function readBookingPolicy(ctx:RepositoryContext,runtime?:BookingPolicyRuntime):Promise<BookingPolicyView> {
  const stored=await readSetting(ctx,'booking_policy');
  const parsed=bookingPolicySettingSchema.safeParse(stored.value);
  const setting=parsed.success?parsed.data:DEFAULT_BOOKING_POLICY;
  const bindings=setting.bindings;
  const businessPolicyValid=setting.status==='saved'&&bindings!==null&&await activeOwner(ctx,bindings.ownerUserId);
  const at=runtime?.now()??new Date().toISOString(),date=localDate(at,'America/New_York'),month=date.slice(0,7);
  const spend=(await ctx.db.query<{today:string|null;month:string|null}>(`WITH spend AS (
    SELECT business_date,cost_cents AS cents FROM provider_ledger WHERE workspace_id=$1 AND provider_key IN ('aws_bedrock.booking','google_vertex.booking','calcom.booking')
    UNION ALL SELECT business_date,cents FROM provider_reservations WHERE workspace_id=$1 AND provider_key IN ('aws_bedrock.booking','google_vertex.booking','calcom.booking') AND state IN ('reserved','calling')
  ) SELECT sum(cents) FILTER(WHERE business_date=$2::date) AS today,sum(cents) FILTER(WHERE business_date>=$3::date AND business_date<= $2::date) AS month FROM spend`,[ctx.scope.workspaceId,date,`${month}-01`])).rows[0];
  return {revision:stored.version,setting,rules:BOOKING_BUSINESS_RULES,businessPolicyValid,enabled:false,
    readiness:{ready:false,evidenceKind:'unavailable',reasons:['account_access_unverified','calendar_freebusy_unverified','event_settings_unverified','model_consent_unverified','model_acceptance_unverified','sender_authority_unverified','source_authority_unverified','provider_adapter_unavailable','release_unverified','enable_unapproved']},
    budget:{lane:'booking',timeZone:'America/New_York',businessDate:date,calendarMonth:month,dailyCeilingCents:bindings?.budget.dailyCeilingCents??200,monthlyCeilingCents:bindings?.budget.monthlyCeilingCents??2500,observedDailyCents:Number(spend?.today??0),observedMonthlyCents:Number(spend?.month??0),allowance:'unknown',remainingDailyCents:null,remainingMonthlyCents:null},
  };
}
/** Must run in the ordinary command transaction. The settings lock orders competing revisions. */
export async function mutateBookingPolicy(ctx:RepositoryContext,input:unknown):Promise<{ok:true;value:{revision:number}}|{ok:false;reason:string}> {
  const actor=ctx.scope.actor;
  if(actor.kind!=='user'||actor.role!=='admin'||!await activeOwner(ctx,actor.userId))return {ok:false,reason:'admin_required'};
  const parsed=bookingPolicyCommandSchema.safeParse(input);if(!parsed.success)return {ok:false,reason:'invalid_input'};
  const command=parsed.data;
  if(command.action==='save'&&command.bindings.ownerUserId!==actor.userId)return {ok:false,reason:'owner_mismatch'};
  await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[settingLockName(ctx.scope.workspaceId,'booking_policy')]);
  const old=await readSetting(ctx,'booking_policy');if(old.version!==command.expectedRevision)return {ok:false,reason:'stale_revision'};
  const previous=bookingPolicySettingSchema.safeParse(old.value);
  const setting=command.action==='save'?{status:'saved',enabled:false,bindings:command.bindings}:{status:command.action==='revoke'?'revoked':'disabled',enabled:false,bindings:previous.success?previous.data.bindings:null};
  const result=await updateSetting(ctx,{settingKey:'booking_policy',value:setting,commandId:command.commandId,changeNote:`Booking policy ${command.action}`});
  return result.ok?{ok:true,value:{revision:result.value.current.version}}:result;
}
