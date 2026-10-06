import {prospectingAuthorizationReadSchema,prospectingAuthorizationSaveSchema} from '@fss/contracts';
import {authorizationForMailbox,setProspectingAuthorization} from '@fss/domain/outreach/authorization.ts';
import {contextForPrincipal,requirePrincipal,runRouteCommand} from './routeSupport.ts';
import type {ApiRequest,RouteResult,RoutingOptions} from './types.ts';
export const OUTREACH_PATHS=['/outreach/authorization','/outreach/authorization/save'];
export async function routeOutreach(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(!OUTREACH_PATHS.includes(request.path))return null;
 if(request.method!=='POST')return {status:405,body:{error:'method_not_allowed'}};
 const auth=options.auth;if(!auth)return {status:404,body:{error:'not_found'}};
 const principal=await requirePrincipal(auth,request);if(!principal.ok)return principal.result;
 const scoped=contextForPrincipal(auth,principal.principal);if(!scoped.ok)return scoped.result;
 const actor=scoped.context.scope.actor;
 if(actor.kind!=='user'||actor.role!=='admin')return {status:403,body:{error:'admin_required'}};
 if(request.path==='/outreach/authorization'){
  const parsed=prospectingAuthorizationReadSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'invalid_input'}};
  const exists=await scoped.context.db.query('SELECT 1 FROM mailboxes WHERE workspace_id=$1 AND id=$2',[scoped.context.scope.workspaceId,parsed.data.mailboxId]);
  if(!exists.rows.length)return {status:404,body:{error:'not_found'}};
  return {status:200,body:await authorizationForMailbox(scoped.context,parsed.data.mailboxId)};
 }
 return runRouteCommand({auth,request,principal:principal.principal},prospectingAuthorizationSaveSchema,'outreach_authorization_save',async(ctx,input)=>setProspectingAuthorization(ctx,input));
}
