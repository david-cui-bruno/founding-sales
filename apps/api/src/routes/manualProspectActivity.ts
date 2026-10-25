import {manualProspectActivitySaveCommandSchema,manualProspectActivityListInputSchema,manualProspectActivityReadInputSchema,manualProspectActivityReceiptInputSchema,manualProspectActivityReceiptSchema} from '@fss/contracts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {saveManualProspectActivity,listManualProspectActivity,readManualProspectActivity} from '@fss/domain/sourcing/manualProspectActivity.ts';
import {ManualActivityAuthorityChanged,ManualActivityUnavailable,requireManualActivityAuthority,currentManualActivityAuthority} from '@fss/domain/sourcing/manualProspectActivityAccess.ts';
import {contextForPrincipal,runRouteCommand,requirePrincipal,type RouteDeps} from './routeSupport.ts';
import {retainedPrincipalAuthority} from './retainedPrincipalAuthority.ts';
import {samePrivatePrincipal} from './privateReadAuthority.ts';
import type {RouteResult} from './types.ts';
export const MANUAL_ACTIVITY_PATHS=['/sourcing/candidates/prospects/activity/list','/sourcing/candidates/prospects/activity/read','/sourcing/candidates/prospects/activity/save','/sourcing/candidates/prospects/activity/receipt'] as const;
export const MANUAL_ACTIVITY_COMMAND_KIND='sourcing.manual_activity_save';
export async function routeManualProspectActivity(deps:RouteDeps):Promise<RouteResult>{
 if(deps.principal.role!=='admin')return {status:403,body:{error:'admin_only'}};
 const scoped=contextForPrincipal(deps.auth,deps.principal);if(!scoped.ok)return scoped.result;
 const check=async():Promise<void>=>{const p=await requirePrincipal(deps.auth,deps.request);if(!p.ok||!samePrivatePrincipal(p.principal,deps.principal))throw new ManualActivityAuthorityChanged();};
 try{
  let answer:RouteResult;
  if(deps.request.path===MANUAL_ACTIVITY_PATHS[2]){
   let beforeCommit:(()=>Promise<void>)|undefined;
   answer=await runRouteCommand(deps,manualProspectActivitySaveCommandSchema,MANUAL_ACTIVITY_COMMAND_KIND,async(ctx,body)=>{
    const {commandId:_id,clientVersion:_version,...input}=body;
    const authority=retainedPrincipalAuthority(deps,ctx),result=await saveManualProspectActivity(ctx,input,authority);
    if(result.ok)beforeCommit=()=>currentManualActivityAuthority(ctx,input.candidateId,input.expectedCandidateRevision,authority);
    return result;
   },async()=>{await beforeCommit?.();});
  }else{
   const schema=deps.request.path===MANUAL_ACTIVITY_PATHS[0]?manualProspectActivityListInputSchema:deps.request.path===MANUAL_ACTIVITY_PATHS[1]?manualProspectActivityReadInputSchema:manualProspectActivityReceiptInputSchema;
   const parsed=schema.safeParse(deps.request.body);if(!parsed.success)return {status:400,body:{error:'invalid_input'}};
   answer=await withTransaction(deps.auth.db,async()=>{
    const ctx=scoped.context,authority=retainedPrincipalAuthority(deps,ctx);await check();
    if('commandId' in parsed.data){
     const p=deps.principal,row=(await ctx.db.query<{result_status:string;result:unknown}>(`SELECT r.result_status,r.result FROM command_receipts r JOIN devices d ON d.workspace_id=r.workspace_id AND d.id=r.device_id WHERE r.workspace_id=$1 AND r.command_id=$2 AND r.device_id=$3 AND d.user_id=$4 AND r.command_kind=$5 AND r.payload_hash=$6`,[p.workspaceId,parsed.data.commandId,p.deviceId,p.userId,MANUAL_ACTIVITY_COMMAND_KIND,parsed.data.payloadSHA256])).rows[0];
     await requireManualActivityAuthority(ctx,authority);
     return {status:200,body:manualProspectActivityReceiptSchema.parse(!row?{state:'unknown'}:row.result_status==='accepted'?{state:'accepted',result:row.result}:{state:'refused',reason:typeof row.result==='string'?row.result:'refused'})};
    }
    if('attemptId' in parsed.data){const activity=await readManualProspectActivity(ctx,parsed.data,authority);return activity?{status:200,body:{activity}}:{status:404,body:{error:'not_found'}};}
    return {status:200,body:await listManualProspectActivity(ctx,parsed.data,authority)};
   });
  }
  await check();return answer;
 }catch(error){
  if(error instanceof ManualActivityAuthorityChanged)return {status:401,body:{error:'unauthenticated'}};
  if(error instanceof ManualActivityUnavailable)return {status:409,body:{error:error.reason}};
  throw error;
 }
}
