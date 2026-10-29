import {prospectPriorityListInputSchema,prospectPrioritySaveCommandSchema,prospectPriorityConsiderCommandSchema,prospectPriorityLearningInputSchema,prospectPriorityReceiptInputSchema,prospectPriorityReceiptSchema} from '@fss/contracts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {listProspectPriority,saveProspectPriority,considerProspectPriority,currentProspectPriorityAuthority,readProspectPriorityLearning,ProspectPriorityChanged} from '@fss/domain/sourcing/prospectPriority.ts';
import {ManualActivityAuthorityChanged,ManualActivityUnavailable,requireManualActivityAuthority} from '@fss/domain/sourcing/manualProspectActivityAccess.ts';
import {contextForPrincipal,runRouteCommand,requirePrincipal,type RouteDeps} from './routeSupport.ts';
import {retainedPrincipalAuthority} from './retainedPrincipalAuthority.ts';
import {samePrivatePrincipal} from './privateReadAuthority.ts';
import type {RouteResult} from './types.ts';

const prefix='/sourcing/candidates/prospects/priority';
export const PROSPECT_PRIORITY_PATHS=[`${prefix}/list`,`${prefix}/save`,`${prefix}/consider`,`${prefix}/learning`,`${prefix}/receipt`] as const;
export const PROSPECT_PRIORITY_KINDS={save:'sourcing.prospect_priority_save',consider:'sourcing.prospect_priority_consider'} as const;

/** Current private review only. Qualification, CRM admission and execution are independent. */
export async function routeProspectPriority(deps:RouteDeps):Promise<RouteResult>{
 if(deps.principal.role!=='admin')return {status:403,body:{error:'admin_only'}};
 const scoped=contextForPrincipal(deps.auth,deps.principal);if(!scoped.ok)return scoped.result;
 const check=async():Promise<void>=>{
  const current=await requirePrincipal(deps.auth,deps.request);
  if(!current.ok||!samePrivatePrincipal(current.principal,deps.principal))throw new ManualActivityAuthorityChanged();
 };
 try{
  let answer:RouteResult;
  if(deps.request.path===`${prefix}/save`){
   let finish:(()=>Promise<void>)|undefined;
   answer=await runRouteCommand(deps,prospectPrioritySaveCommandSchema,PROSPECT_PRIORITY_KINDS.save,async(ctx,body)=>{
    const {commandId:_command,clientVersion:_version,...input}=body,authority=retainedPrincipalAuthority(deps,ctx);
    const result=await saveProspectPriority(ctx,input,authority);
    if(result.ok)finish=()=>currentProspectPriorityAuthority(ctx,input,authority);
    return result;
   },async()=>{await finish?.();});
  }else if(deps.request.path===`${prefix}/consider`){
   let finish:(()=>Promise<void>)|undefined;
   answer=await runRouteCommand(deps,prospectPriorityConsiderCommandSchema,PROSPECT_PRIORITY_KINDS.consider,async(ctx,body)=>{
    const {commandId:_command,clientVersion:_version,...input}=body,authority=retainedPrincipalAuthority(deps,ctx);
    const result=await considerProspectPriority(ctx,input,authority);
    if(result.ok)finish=()=>currentProspectPriorityAuthority(ctx,{...input,considerationId:result.value.considerationId},authority);
    return result;
   },async()=>{await finish?.();});
  }else{
   answer=await withTransaction(deps.auth.db,async()=>{
    const ctx=scoped.context,authority=retainedPrincipalAuthority(deps,ctx);await check();
    if(deps.request.path===`${prefix}/receipt`){
     const parsed=prospectPriorityReceiptInputSchema.safeParse(deps.request.body);
     if(!parsed.success)return {status:400,body:{error:'invalid_input'}};
     const p=deps.principal,input=parsed.data;
     const row=(await ctx.db.query<{result_status:string;result:unknown}>(`SELECT r.result_status,r.result FROM command_receipts r JOIN devices d ON d.workspace_id=r.workspace_id AND d.id=r.device_id
      WHERE r.workspace_id=$1 AND r.command_id=$2 AND r.device_id=$3 AND d.user_id=$4 AND r.command_kind=$5 AND r.payload_hash=$6`,
     [p.workspaceId,input.commandId,p.deviceId,p.userId,PROSPECT_PRIORITY_KINDS[input.operation],input.payloadSHA256])).rows[0];
     await requireManualActivityAuthority(ctx,authority);
     return {status:200,body:prospectPriorityReceiptSchema.parse(!row?{state:'unknown'}:row.result_status==='accepted'?{state:'accepted',result:row.result}:{state:'refused',reason:typeof row.result==='string'?row.result:'refused'})};
    }
    if(deps.request.path===`${prefix}/learning`){
     const parsed=prospectPriorityLearningInputSchema.safeParse(deps.request.body);
     if(!parsed.success)return {status:400,body:{error:'invalid_input'}};
     const result=await readProspectPriorityLearning(ctx,parsed.data,authority);
     return result.ok?{status:200,body:result.value}:{status:409,body:{error:result.reason}};
    }
    const parsed=prospectPriorityListInputSchema.safeParse(deps.request.body);
    if(!parsed.success)return {status:400,body:{error:'invalid_input'}};
    const result=await listProspectPriority(ctx,parsed.data,authority);
    return result.ok?{status:200,body:result.value}:{status:409,body:{error:result.reason}};
   });
  }
  await check();return answer;
 }catch(error){
  if(error instanceof ManualActivityAuthorityChanged)return {status:401,body:{error:'unauthenticated'}};
  if(error instanceof ManualActivityUnavailable||error instanceof ProspectPriorityChanged)return {status:409,body:{error:error.reason}};
  throw error;
 }
}
