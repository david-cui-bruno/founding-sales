import {socialFounderInputListInputSchema,socialFounderInputReadInputSchema,socialFounderInputSaveCommandSchema,socialFounderReceiptInputSchema,socialFounderReceiptSchema,socialCalibrationReadInputSchema,socialCalibrationFinishCommandSchema} from '@fss/contracts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {listSocialFounderInputs,readSocialFounderInput,saveSocialFounderInput} from '@fss/domain/social/founderInputs.ts';
import {readSocialCalibration,finishSocialCalibration,CalibrationGuideConflict} from '@fss/domain/social/calibration.ts';
import {PrivateDraftAuthorityChanged,requirePrivateDraftAuthority} from '@fss/domain/social/privateDrafts.ts';
import {contextForPrincipal,runRouteCommand,requirePrincipal,type RouteDeps} from './routeSupport.ts';
import {retainedPrincipalAuthority} from './retainedPrincipalAuthority.ts';
import {samePrivatePrincipal} from './privateReadAuthority.ts';
import type {RouteResult} from './types.ts';
export const SOCIAL_FOUNDER_PATHS=['/social/inputs/list','/social/inputs/read','/social/inputs/save','/social/calibration/read','/social/calibration/finish','/social/founder/receipt'] as const;
export const SOCIAL_FOUNDER_COMMAND_KINDS=['social.founder_input_save','social.calibration_finish'] as const;
export async function routeSocialFounderInputs(deps:RouteDeps):Promise<RouteResult>{
 const scoped=contextForPrincipal(deps.auth,deps.principal);if(!scoped.ok)return scoped.result;
 const check=async()=>{const fresh=await requirePrincipal(deps.auth,deps.request);if(!fresh.ok||!samePrivatePrincipal(fresh.principal,deps.principal))throw new PrivateDraftAuthorityChanged();};
 try{
  let answer:RouteResult;
  if(deps.request.path===SOCIAL_FOUNDER_PATHS[2])answer=await runRouteCommand(deps,socialFounderInputSaveCommandSchema,SOCIAL_FOUNDER_COMMAND_KINDS[0],(ctx,body)=>{const {commandId:_id,clientVersion:_version,...input}=body;return saveSocialFounderInput(ctx,input,retainedPrincipalAuthority(deps,ctx));},ctx=>requirePrivateDraftAuthority(retainedPrincipalAuthority(deps,ctx)));
  else if(deps.request.path===SOCIAL_FOUNDER_PATHS[4])answer=await runRouteCommand(deps,socialCalibrationFinishCommandSchema,SOCIAL_FOUNDER_COMMAND_KINDS[1],async(ctx,body)=>{
   const {commandId:_id,clientVersion:_version,...input}=body;
   // A final wallclock failure must roll back optional guide erasure while still
   // recording an ordinary opaque refused receipt, not an unrecoverable UNKNOWN.
   await ctx.db.query('SAVEPOINT social_calibration_finish');
   try{const result=await finishSocialCalibration(ctx,input,retainedPrincipalAuthority(deps,ctx));await ctx.db.query('RELEASE SAVEPOINT social_calibration_finish');return result;}
   catch(error){if(!(error instanceof CalibrationGuideConflict))throw error;await ctx.db.query('ROLLBACK TO SAVEPOINT social_calibration_finish');await ctx.db.query('RELEASE SAVEPOINT social_calibration_finish');return {ok:false as const,reason:error.reason};}
  },ctx=>requirePrivateDraftAuthority(retainedPrincipalAuthority(deps,ctx)));
  else{
   const path=deps.request.path,schema=path===SOCIAL_FOUNDER_PATHS[0]?socialFounderInputListInputSchema:path===SOCIAL_FOUNDER_PATHS[1]?socialFounderInputReadInputSchema:path===SOCIAL_FOUNDER_PATHS[3]?socialCalibrationReadInputSchema:socialFounderReceiptInputSchema;
   const parsed=schema.safeParse(deps.request.body);if(!parsed.success)return {status:400,body:{error:'invalid_input'}};
   answer=await withTransaction(deps.auth.db,async()=>{
    const ctx=scoped.context,authority=retainedPrincipalAuthority(deps,ctx);await check();
    if(path===SOCIAL_FOUNDER_PATHS[0])return {status:200,body:await listSocialFounderInputs(ctx,socialFounderInputListInputSchema.parse(parsed.data).afterId,authority)};
    if(path===SOCIAL_FOUNDER_PATHS[1]){const input=await readSocialFounderInput(ctx,socialFounderInputReadInputSchema.parse(parsed.data).inputId,authority);return input?{status:200,body:{input}}:{status:404,body:{error:'not_found'}};}
    if(path===SOCIAL_FOUNDER_PATHS[3])return {status:200,body:await readSocialCalibration(ctx,authority)};
    const receipt=socialFounderReceiptInputSchema.parse(parsed.data),p=deps.principal,kind=SOCIAL_FOUNDER_COMMAND_KINDS[receipt.kind==='input'?0:1];
    const row=(await ctx.db.query<{result_status:string;result:unknown}>(`SELECT r.result_status,r.result FROM command_receipts r JOIN devices d ON d.workspace_id=r.workspace_id AND d.id=r.device_id WHERE r.workspace_id=$1 AND r.command_id=$2 AND r.device_id=$3 AND d.user_id=$4 AND r.command_kind=$5 AND r.payload_hash=$6`,[p.workspaceId,receipt.commandId,p.deviceId,p.userId,kind,receipt.payloadSHA256])).rows[0];await requirePrivateDraftAuthority(authority);
    return {status:200,body:socialFounderReceiptSchema.parse(!row?{state:'unknown'}:row.result_status==='accepted'?{state:'accepted',result:row.result}:{state:'refused',reason:typeof row.result==='string'?row.result:'refused'})};
   });
  }
  await check();return answer;
 }catch(error){if(error instanceof PrivateDraftAuthorityChanged)return {status:401,body:{error:'unauthenticated'}};throw error;}
}
