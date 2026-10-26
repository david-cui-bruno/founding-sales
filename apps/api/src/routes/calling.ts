import {callingWrapCommandSchema,callingFollowUpSaveCommandSchema,callingFollowUpListInputSchema,callingFollowUpReadInputSchema,callingReceiptInputSchema,callingReceiptSchema,type CallingFollowUpSource} from '@fss/contracts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {wrapCalling,callingWrapSource} from '@fss/domain/calling/wrap.ts';
import {listCallingDrafts,readCallingDraft,saveCallingDraft,findCallingDraft,callingDraftSource} from '@fss/domain/calling/followUpDrafts.ts';
import {CallingAuthorityChanged,CallingUnavailable,requireCallingAuthority,currentCallingSource} from '@fss/domain/calling/followUpDraftAccess.ts';
import {ManualActivityAuthorityChanged,ManualActivityUnavailable} from '@fss/domain/sourcing/manualProspectActivityAccess.ts';
import {SuppressionJournalError} from '@fss/domain/suppression/journal.ts';
import {policyRouteDeps} from './dialSupport.ts';
import {contextForPrincipal,runRouteCommand} from './routeSupport.ts';
import {retainedPrincipalAuthority} from './retainedPrincipalAuthority.ts';
import {privatePrincipalIsCurrent} from './privateReadAuthority.ts';
import type {ApiRequest,RouteResult,RoutingOptions} from './types.ts';
export const CALLING_PATHS=['/calling/wrap','/calling/follow-ups/list','/calling/follow-ups/read','/calling/follow-ups/save','/calling/follow-ups/receipt'] as const;
export const CALLING_COMMAND_KINDS={wrap:'calling.wrap',save:'calling.follow_up_save'} as const;
/** Five closed routes, existing session/command runner and per-request transaction only. */
export async function routeCalling(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(!(CALLING_PATHS as readonly string[]).includes(request.path))return null;
 const prepared=await policyRouteDeps(request,options);if(!prepared.ok)return prepared.result;
 if(request.method!=='POST')return {status:405,body:{error:'method_not_allowed'}};
 const deps=prepared.deps,scoped=contextForPrincipal(deps.auth,deps.principal);if(!scoped.ok)return scoped.result;
 try{
  let answer:RouteResult;
  if(request.path===CALLING_PATHS[0]||request.path===CALLING_PATHS[3]){
   let beforeCommit:(()=>Promise<void>)|undefined;
   const finish=async()=>{await beforeCommit?.();};
   answer=request.path===CALLING_PATHS[0]?await runRouteCommand(deps,callingWrapCommandSchema,CALLING_COMMAND_KINDS.wrap,async(ctx,input)=>{
    const authority=retainedPrincipalAuthority(deps,ctx),result=await wrapCalling(ctx,input,authority,deps.journal);
    const source=result.ok?callingWrapSource(result.value):null;
    beforeCommit=()=>source?currentCallingSource(ctx,source,authority):requireCallingAuthority(ctx,authority);
    return result;
   },finish):await runRouteCommand(deps,callingFollowUpSaveCommandSchema,CALLING_COMMAND_KINDS.save,async(ctx,input)=>{
    const authority=retainedPrincipalAuthority(deps,ctx),before=await findCallingDraft(ctx,input.draftId);
    const source:CallingFollowUpSource|null=before?callingDraftSource(before):null;
    const {commandId:_command,clientVersion:_version,...payload}=input;
    const result=await saveCallingDraft(ctx,payload,authority);
    beforeCommit=()=>result.ok&&source?currentCallingSource(ctx,source,authority):requireCallingAuthority(ctx,authority);
    return result;
   },finish);
  }else{
   answer=await withTransaction(deps.auth.db,async()=>{
    const ctx=scoped.context,authority=retainedPrincipalAuthority(deps,ctx);
    if(request.path===CALLING_PATHS[1]){
     const parsed=callingFollowUpListInputSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'invalid_input'}};
     return {status:200,body:await listCallingDrafts(ctx,parsed.data,authority)};
    }
    if(request.path===CALLING_PATHS[2]){
     const parsed=callingFollowUpReadInputSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'invalid_input'}};
     const draft=await readCallingDraft(ctx,parsed.data,authority);
     return draft?{status:200,body:{draft}}:{status:404,body:{error:'draft_unavailable'}};
    }
    const parsed=callingReceiptInputSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'invalid_input'}};
    const p=deps.principal,input=parsed.data;
    const receipt=(await ctx.db.query<{result_status:string;result:unknown}>(`SELECT r.result_status,r.result FROM command_receipts r
     JOIN devices d ON d.workspace_id=r.workspace_id AND d.id=r.device_id
     WHERE r.workspace_id=$1 AND r.command_id=$2 AND r.device_id=$3 AND d.user_id=$4 AND r.command_kind=$5 AND r.payload_hash=$6`,[p.workspaceId,input.commandId,p.deviceId,p.userId,CALLING_COMMAND_KINDS[input.operation],input.payloadSHA256])).rows[0];
    await requireCallingAuthority(ctx,authority);
    const body=!receipt?{state:'unknown'}:receipt.result_status==='accepted'?{state:'accepted',acceptance:{operation:input.operation,result:receipt.result}}:{state:'refused',reason:typeof receipt.result==='string'?receipt.result:'refused'};
    return {status:200,body:callingReceiptSchema.parse(body)};
   });
  }
  if(!await privatePrincipalIsCurrent(deps))return {status:401,body:{error:'session_changed'}};
  return answer;
 }catch(error){
  if(error instanceof CallingAuthorityChanged||error instanceof ManualActivityAuthorityChanged)return {status:401,body:{error:'session_changed'}};
  if(error instanceof CallingUnavailable||error instanceof ManualActivityUnavailable)return {status:409,body:{error:error.reason}};
  if(error instanceof SuppressionJournalError)return {status:503,body:{error:'journal_unavailable'}};
  throw error;
 }
}
