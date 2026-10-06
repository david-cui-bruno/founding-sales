import {saveAnswerBlock,approveAnswerBlock,retireAnswerBlock,listAnswerBlocks} from '@fss/domain/outreach/facts.ts';
import {prospectingAuthorizationReadSchema,prospectingAuthorizationSaveSchema,saveAnswerBlockCommandSchema,answerBlockApprovalCommandSchema,answerBlocksReadSchema} from '@fss/contracts';
import {authorizationForMailbox,setProspectingAuthorization} from '@fss/domain/outreach/authorization.ts';
import {contextForPrincipal,requirePrincipal,runRouteCommand} from './routeSupport.ts';
import type {ApiRequest,RouteResult,RoutingOptions} from './types.ts';
export const OUTREACH_PATHS=['/outreach/authorization','/outreach/authorization/save','/outreach/answer-blocks','/outreach/answer-blocks/save','/outreach/answer-blocks/approve','/outreach/answer-blocks/retire'];
export async function routeOutreach(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(!OUTREACH_PATHS.includes(request.path))return null;
 if(request.method!=='POST')return {status:405,body:{error:'method_not_allowed'}};
 const auth=options.auth;if(!auth)return {status:404,body:{error:'not_found'}};
 const principal=await requirePrincipal(auth,request);if(!principal.ok)return principal.result;
 const scoped=contextForPrincipal(auth,principal.principal);if(!scoped.ok)return scoped.result;
 const actor=scoped.context.scope.actor;
 if(actor.kind!=='user'||actor.role!=='admin')return {status:403,body:{error:'admin_required'}};
 if(request.path==='/outreach/answer-blocks'){
  const input=answerBlocksReadSchema.safeParse(request.body);if(!input.success)return {status:400,body:{error:'invalid_input'}};
  return {status:200,body:{blocks:await listAnswerBlocks(scoped.context,input.data.afterId)}};
 }
 if(request.path==='/outreach/answer-blocks/save')return runRouteCommand({auth,request,principal:principal.principal},saveAnswerBlockCommandSchema,'outreach_answer_save',async(ctx,input)=>{
  const {commandId:_command,clientVersion:_client,...content}=input;
  const result=await saveAnswerBlock(ctx,content);return result.ok?{ok:true as const,value:{id:result.value.id,version:result.value.version}}:result;
 });
 if(request.path==='/outreach/answer-blocks/approve'||request.path==='/outreach/answer-blocks/retire')return runRouteCommand({auth,request,principal:principal.principal},answerBlockApprovalCommandSchema,request.path.endsWith('/approve')?'outreach_answer_approve':'outreach_answer_retire',async(ctx,input)=>{
  const result=await (request.path.endsWith('/approve')?approveAnswerBlock:retireAnswerBlock)(ctx,input);return result.ok?{ok:true as const,value:{id:result.value.id,version:result.value.version}}:result;
 });
 if(request.path==='/outreach/authorization'){
  const parsed=prospectingAuthorizationReadSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'invalid_input'}};
  const exists=await scoped.context.db.query('SELECT 1 FROM mailboxes WHERE workspace_id=$1 AND id=$2',[scoped.context.scope.workspaceId,parsed.data.mailboxId]);
  if(!exists.rows.length)return {status:404,body:{error:'not_found'}};
  return {status:200,body:await authorizationForMailbox(scoped.context,parsed.data.mailboxId)};
 }
 return runRouteCommand({auth,request,principal:principal.principal},prospectingAuthorizationSaveSchema,'outreach_authorization_save',async(ctx,input)=>setProspectingAuthorization(ctx,input));
}
