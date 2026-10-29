import {callingBudgetReceiptSchema,telephonyBudgetSettingSchema,type CallingBudgetInput,type CallingBudgetSaved,type CallingBudgetReceipt} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {isAdminScope} from '../db/workspaceScope.ts';
import {readSetting,settingLockName,updateSetting} from '../settings/store.ts';
import {lockSendGateForStopFact} from '../policy/sendGate.ts';
import {CallingAuthorityChanged,requireCallingAuthority,type CallingAuthority} from './followUpDraftAccess.ts';

export const CALLING_BUDGET_COMMAND_KIND='calling.setup_budget';
/** Changes only the daily ceiling. The stored rate, duration, provider and monthly
 * ceiling remain their existing independently owned values. */
export async function changeCallingBudget(ctx:RepositoryContext,input:CallingBudgetInput,authority:CallingAuthority):Promise<
 {ok:true;value:CallingBudgetSaved}|{ok:false;reason:'admin_only'|'setting_version_conflict'|'telephony_budget_disabled'}>{
 if(!isAdminScope(ctx.scope)){await requireCallingAuthority(ctx,authority);return {ok:false,reason:'admin_only'};}
 await lockSendGateForStopFact(ctx);
 await ctx.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[settingLockName(ctx.scope.workspaceId,'telephony_budget')]);
 await requireCallingAuthority(ctx,authority);
 const current=await readSetting(ctx,'telephony_budget');
 if(current.version!==input.expectedVersion)return {ok:false,reason:'setting_version_conflict'};
 const budget=telephonyBudgetSettingSchema.safeParse(current.value);
 if(!budget.success)return {ok:false,reason:'telephony_budget_disabled'};
 const saved=await updateSetting(ctx,{settingKey:'telephony_budget',value:{...budget.data,dailyCeilingCents:input.dailyCeilingCents},changeNote:'Changed daily calling budget in web Calling'});
 if(!saved.ok){if(saved.reason==='admin_only'||saved.reason==='setting_version_conflict')return {ok:false,reason:saved.reason};throw Error('Calling budget setting invalid');}
 return {ok:true,value:{dailyCeilingCents:input.dailyCeilingCents,version:saved.value.current.version}};
}
export async function readCallingBudgetReceipt(ctx:RepositoryContext,input:{commandId:string;payloadSHA256:string},deviceId:string,authority:CallingAuthority):Promise<CallingBudgetReceipt>{
 const actor=ctx.scope.actor;if(!isAdminScope(ctx.scope)||actor.kind!=='user')throw new CallingAuthorityChanged();
 const row=(await ctx.db.query<{result_status:string;result:unknown}>(`SELECT r.result_status,r.result FROM command_receipts r
  JOIN devices d ON d.workspace_id=r.workspace_id AND d.id=r.device_id
  WHERE r.workspace_id=$1 AND r.command_id=$2 AND r.device_id=$3 AND d.user_id=$4 AND r.command_kind=$5 AND r.payload_hash=$6`,
 [ctx.scope.workspaceId,input.commandId,deviceId,actor.userId,CALLING_BUDGET_COMMAND_KIND,input.payloadSHA256])).rows[0];
 await requireCallingAuthority(ctx,authority);
 return callingBudgetReceiptSchema.parse(!row?{state:'unknown'}:row.result_status==='accepted'?{state:'accepted',result:row.result}:{state:'refused',reason:row.result});
}
