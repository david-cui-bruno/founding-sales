import {DEFAULT_INTEGRATION_SETTING_VALUES,callingProviderSettingSchema,callingSetupSchema,callingSetupReceiptSchema,telephonyBudgetSettingSchema,type CallingSetup,type CallingSetupInput,type CallingSetupSaved,type CallingSetupReceipt} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {isAdminScope} from '../db/workspaceScope.ts';
import {readSetting,settingLockName,lockSettingForRead,updateSetting} from '../settings/store.ts';
import {readTelephonyBudget} from '../settings/integrations.ts';
import {telephonySpentToday} from '../calls/sessions.ts';
import {lockSendGateForStopFact} from '../policy/sendGate.ts';
import {CallingAuthorityChanged,requireCallingAuthority,type CallingAuthority} from './followUpDraftAccess.ts';

export const CALLING_SETUP_COMMAND_KIND='calling.setup_provider';
/** The request supplies only presence of the existing injected adapter, never a credential. */
export async function readCallingSetup(ctx:RepositoryContext,configured:boolean,authority:CallingAuthority):Promise<CallingSetup>{
 await lockSettingForRead(ctx,'calling_provider');await lockSettingForRead(ctx,'telephony_budget');
 const provider=await readSetting(ctx,'calling_provider'),budget=await readSetting(ctx,'telephony_budget');
 const parsed=callingProviderSettingSchema.safeParse(provider.value);
 const telephony=telephonyBudgetSettingSchema.safeParse(budget.value);
 const body=callingSetupSchema.parse({callingProvider:{provider:parsed.success?parsed.data.provider:'tel',version:provider.version},
  telephonyBudget:{...(telephony.success?telephony.data:{...telephonyBudgetSettingSchema.parse(DEFAULT_INTEGRATION_SETTING_VALUES.telephony_budget),dailyCeilingCents:0}),version:budget.version},
  spentTodayCents:await telephonySpentToday(ctx),configured});
 await requireCallingAuthority(ctx,authority);
 return body;
}
/** Gate -> exclusive provider setting -> shared existing budget -> current principal.
 * Compare under the setting lock; an old Enable never overwrites a newer OFF. */
export async function changeCallingProvider(ctx:RepositoryContext,input:CallingSetupInput,configured:boolean,authority:CallingAuthority):Promise<
 {ok:true;value:CallingSetupSaved}|{ok:false;reason:'admin_only'|'setting_version_conflict'|'integration_unconfigured'|'telephony_budget_disabled'}>{
 if(!isAdminScope(ctx.scope)){await requireCallingAuthority(ctx,authority);return {ok:false,reason:'admin_only'};}
 await lockSendGateForStopFact(ctx);
 await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',[settingLockName(ctx.scope.workspaceId,'calling_provider')]);
 if(input.provider==='twilio')await lockSettingForRead(ctx,'telephony_budget');
 await requireCallingAuthority(ctx,authority);
 if((await readSetting(ctx,'calling_provider')).version!==input.expectedVersion)return {ok:false,reason:'setting_version_conflict'};
 if(input.provider==='twilio'){
  if(!configured)return {ok:false,reason:'integration_unconfigured'};
  const budget=await readTelephonyBudget(ctx);
  if(budget.dailyCeilingCents<=0||budget.unitPriceMicros<=0)return {ok:false,reason:'telephony_budget_disabled'};
 }
 const saved=await updateSetting(ctx,{settingKey:'calling_provider',value:{provider:input.provider},changeNote:input.provider==='twilio'?'Enabled browser calling in web Calling':'Turned off browser calling in web Calling'});
 if(!saved.ok){if(saved.reason==='admin_only'||saved.reason==='setting_version_conflict')return {ok:false,reason:saved.reason};throw Error('Calling provider setting invalid');}
 return {ok:true,value:{provider:input.provider,version:saved.value.current.version}};
}
/** Receipt acceptance is history. No provider, call or configuration write occurs here. */
export async function readCallingSetupReceipt(ctx:RepositoryContext,input:{commandId:string;payloadSHA256:string},deviceId:string,authority:CallingAuthority):Promise<CallingSetupReceipt>{
 if(!isAdminScope(ctx.scope))throw new CallingAuthorityChanged();
 const actor=ctx.scope.actor;if(actor.kind!=='user')throw new CallingAuthorityChanged();
 const row=(await ctx.db.query<{result_status:string;result:unknown}>(`SELECT r.result_status,r.result FROM command_receipts r
  JOIN devices d ON d.workspace_id=r.workspace_id AND d.id=r.device_id
  WHERE r.workspace_id=$1 AND r.command_id=$2 AND r.device_id=$3 AND d.user_id=$4 AND r.command_kind=$5 AND r.payload_hash=$6`,
 [ctx.scope.workspaceId,input.commandId,deviceId,actor.userId,CALLING_SETUP_COMMAND_KIND,input.payloadSHA256])).rows[0];
 await requireCallingAuthority(ctx,authority);
 return callingSetupReceiptSchema.parse(!row?{state:'unknown'}:row.result_status==='accepted'?{state:'accepted',result:row.result}:{state:'refused',reason:row.result});
}
