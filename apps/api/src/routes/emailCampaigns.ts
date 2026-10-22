import {isDeepStrictEqual} from 'node:util';
import {emailCampaignApproveCommandSchema,emailCampaignRevokeCommandSchema,emailCampaignControlRequestSchema,emailCampaignControlSchema,emailCampaignCommandResultSchema} from '@fss/contracts';
import {approveEmailCampaign,revokeEmailCampaign,readEmailCampaignControl} from '@fss/domain/outreach/emailCampaign.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {runCommand} from '../auth/commands.ts';
import {commandReply,contextForPrincipal,requirePrincipal} from './routeSupport.ts';
import type {ApiRequest,RouteResult,RoutingOptions} from './types.ts';
export const EMAIL_CAMPAIGN_PATHS=['/outreach/email-campaigns/control','/outreach/email-campaigns/approve','/outreach/email-campaigns/revoke'] as const;
export async function routeEmailCampaigns(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(!(EMAIL_CAMPAIGN_PATHS as readonly string[]).includes(request.path))return null;
 if(request.method!=='POST')return {status:405,body:{error:'method_not_allowed'}};
 const auth=options.auth;if(!auth)return {status:404,body:{error:'not_found'}};
 const initial=await requirePrincipal(auth,request);if(!initial.ok)return initial.result;
 const principal=initial.principal,scoped=contextForPrincipal(auth,principal);if(!scoped.ok)return scoped.result;
 if(principal.role!=='admin')return {status:403,body:{error:'admin_required'}};
 const currentAuthority=async()=>{const current=await requirePrincipal(auth,request);return current.ok&&isDeepStrictEqual(current.principal,principal);};
 if(request.path==='/outreach/email-campaigns/control'){
  if(!emailCampaignControlRequestSchema.safeParse(request.body).success)return {status:400,body:{error:'malformed_body'}};
  const control=await withTransaction(auth.db,()=>readEmailCampaignControl(scoped.context));
  if(!await currentAuthority())return {status:401,body:{error:'unauthenticated'}};
  return control?{status:200,body:emailCampaignControlSchema.parse(control)}:{status:404,body:{error:'campaign_control_unavailable'}};
 }
 const schema=request.path.endsWith('/approve')?emailCampaignApproveCommandSchema:emailCampaignRevokeCommandSchema;
 const parsed=schema.safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'malformed_body'}};
 const {commandId,clientVersion,...payload}=parsed.data;
 const outcome=await runCommand(auth,principal,{commandId,clientVersion,kind:request.path.endsWith('/approve')?'outreach.email_campaign_approve':'outreach.email_campaign_revoke',payload},async ctx=>{
  const result='mailboxId' in payload?await approveEmailCampaign(ctx,payload,currentAuthority):await revokeEmailCampaign(ctx,payload,currentAuthority);
  return result.ok?{status:'accepted',result:emailCampaignCommandResultSchema.parse(result.value)}:{status:'refused',reason:result.reason};
 });
 if(!await currentAuthority())return {status:401,body:{error:'unauthenticated'}};
 // An IDs-only receipt is historical custody, not current campaign/content proof.
 return commandReply(outcome);
}
