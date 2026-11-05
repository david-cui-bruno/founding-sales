import {socialStandingCommandSchema,socialStandingReceiptInputSchema} from '@fss/contracts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {readSocialStandingPlan,readSocialStandingPublisherOptions,saveSocialStandingPlan,pauseSocialStandingPlan,readSocialStandingActivity,editSocialStandingSlot} from '@fss/domain/social/standingPlan.ts';
import {PrivateDraftAuthorityChanged,requirePrivateDraftAuthority} from '@fss/domain/social/privateDrafts.ts';
import {contextForPrincipal,runRouteCommand,type RouteDeps} from './routeSupport.ts';
import {retainedPrincipalAuthority} from './retainedPrincipalAuthority.ts';
import {privatePrincipalIsCurrent,privateAuthorityRefusal} from './privateReadAuthority.ts';
import type {RouteResult} from './types.ts';
export const SOCIAL_STANDING_PATHS=['/social/standing-plan/read','/social/standing-plan/options','/social/standing-plan/activity','/social/standing-plan/command','/social/standing-plan/receipt'];
export async function routeSocialStandingPlan(deps:RouteDeps):Promise<RouteResult>{
 if(deps.request.method!=='POST')return {status:405,body:{error:'method_not_allowed'}};
 const scoped=contextForPrincipal(deps.auth,deps.principal);if(!scoped.ok)return scoped.result;
 const ctx=scoped.context,authority=retainedPrincipalAuthority(deps,ctx);
 try{
  let answer:RouteResult;
  if(deps.request.path==='/social/standing-plan/command'){
   answer=await runRouteCommand(deps,socialStandingCommandSchema,'social_standing_plan_command',async(c,input)=>{
    await requirePrivateDraftAuthority(authority);
    if(input.operation==='save'){const result=await saveSocialStandingPlan(c,input.plan);return result.ok?{ok:true,value:{planId:result.value.planId,revision:result.value.revision}}:result;}
    if(input.operation==='pause')return pauseSocialStandingPlan(c,input);
    return editSocialStandingSlot(c,input.operation==='skip'?{slotId:input.slotId,expectedRevision:input.expectedRevision}:input);
   },()=>requirePrivateDraftAuthority(authority));
  }else answer=await withTransaction(deps.auth.db,async()=>{
   await requirePrivateDraftAuthority(authority);let body:unknown;
   if(deps.request.path==='/social/standing-plan/read')body={plan:await readSocialStandingPlan(ctx)};
   else if(deps.request.path==='/social/standing-plan/activity')body=await readSocialStandingActivity(ctx);
   else if(deps.request.path==='/social/standing-plan/options'){
    const p=deps.principal;
    const publisherOptions=await readSocialStandingPublisherOptions(ctx);
    const calibration=(await ctx.db.query<{id:string}>('SELECT id FROM social_founder_calibrations WHERE workspace_id=$1 AND owner_user_id=$2 AND completed_at IS NOT NULL',[p.workspaceId,p.userId])).rows[0];
    const guide=(await ctx.db.query<{guideId:string;revision:number}>('SELECT id AS "guideId",revision FROM social_voice_preferences WHERE workspace_id=$1 AND owner_user_id=$2 AND entries IS NOT NULL',[p.workspaceId,p.userId])).rows[0]??null;
    const inputs=(await ctx.db.query<{id:string}>("SELECT id FROM social_founder_inputs WHERE workspace_id=$1 AND owner_user_id=$2 AND public_safe AND reason IS NULL AND expires_at>clock_timestamp() ORDER BY created_at,id LIMIT 30",[p.workspaceId,p.userId])).rows;
    body={...publisherOptions,calibrationId:calibration?.id??null,guideRef:guide,inputIds:inputs.map(i=>i.id)};
   }else if(deps.request.path==='/social/standing-plan/receipt'){
    const parsed=socialStandingReceiptInputSchema.safeParse(deps.request.body);if(!parsed.success)return {status:400,body:{error:'invalid_input'}};
    const p=deps.principal,row=(await ctx.db.query<{result_status:string;result:unknown}>(`SELECT r.result_status,r.result FROM command_receipts r JOIN devices d ON d.workspace_id=r.workspace_id AND d.id=r.device_id WHERE r.workspace_id=$1 AND r.command_id=$2 AND r.device_id=$3 AND d.user_id=$4 AND r.command_kind='social_standing_plan_command' AND r.payload_hash=$5`,[p.workspaceId,parsed.data.commandId,p.deviceId,p.userId,parsed.data.payloadSHA256])).rows[0];
    body=!row?{state:'unknown'}:row.result_status==='accepted'?{state:'accepted',result:row.result}:{state:'refused',reason:typeof row.result==='string'?row.result:'refused'};
   }else return {status:404,body:{error:'not_found'}};
   await requirePrivateDraftAuthority(authority);return {status:200,body};
  });
  if(!await privatePrincipalIsCurrent(deps))return privateAuthorityRefusal();return answer;
 }catch(error){if(error instanceof PrivateDraftAuthorityChanged)return privateAuthorityRefusal();if(error instanceof Error&&['standing_plan_scope_unavailable','standing_plan_source_unavailable'].includes(error.message))return {status:409,body:{error:error.message}};throw error;}
}
