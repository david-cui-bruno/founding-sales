import {clientCompatibility} from '@fss/contracts';
import {replyDraftContextInputSchema,replyDraftGenerateInputSchema} from '../../../../packages/contracts/src/replyComposer.ts';
import {humanReplyPreviewInputSchema,humanReplySendInputSchema,humanReplySendReadInputSchema} from '../../../../packages/contracts/src/replyComposer.ts';
import {previewHumanReply,requestHumanReplySend,readHumanReplySend} from '@fss/domain/replies/dispatch.ts';
import {readReplyDraftContext} from '@fss/domain/replies/composer.ts';
import {generateReplyDraft,type HumanReplyDraftPort} from '@fss/domain/replies/composerGeneration.ts';
import {requirePrincipal,contextForPrincipal,runRouteCommand} from './routeSupport.ts';
import type {ApiRequest,RoutingOptions,RouteResult} from './types.ts';

export const REPLY_COMPOSER_PATHS=['/replies/composer/context','/replies/composer/generate','/replies/composer/preview','/replies/composer/send-status','/replies/composer/send'];
/** Paid attempt metadata supplies replay safety; source/generated prose is never a receipt. */
export async function routeReplyComposer(request:ApiRequest,options:RoutingOptions,port:HumanReplyDraftPort|null=null):Promise<RouteResult|null>{
 if(!REPLY_COMPOSER_PATHS.includes(request.path))return null;
 if(request.method!=='POST')return {status:405,body:{error:'method_not_allowed'}};
 if(!options.auth)return {status:404,body:{error:'not_found'}};
 const principal=await requirePrincipal(options.auth,request);if(!principal.ok)return principal.result;
 const scoped=contextForPrincipal(options.auth,principal.principal);if(!scoped.ok)return scoped.result;
 if(request.path==='/replies/composer/preview'){
  const input=humanReplyPreviewInputSchema.safeParse(request.body);if(!input.success)return {status:400,body:{error:'invalid_input'}};
  return {status:200,body:await previewHumanReply(scoped.context,input.data)};
 }
 if(request.path==='/replies/composer/send-status'){
  const input=humanReplySendReadInputSchema.safeParse(request.body);if(!input.success)return {status:400,body:{error:'invalid_input'}};
  return {status:200,body:await readHumanReplySend(scoped.context,input.data)};
 }
 if(request.path==='/replies/composer/send')return runRouteCommand({auth:options.auth,principal:principal.principal,request},humanReplySendInputSchema,'reply.human_send',async(ctx,input)=>{
  const result=await requestHumanReplySend(ctx,input,{sessionId:principal.principal.sessionId,deviceId:principal.principal.deviceId});
  return result.ok?{ok:true,value:result}:result;
 });
 if(request.path==='/replies/composer/context'){
  const input=replyDraftContextInputSchema.safeParse(request.body);if(!input.success)return {status:400,body:{error:'invalid_input'}};
  return {status:200,body:await readReplyDraftContext(scoped.context,input.data)};
 }
 const input=replyDraftGenerateInputSchema.safeParse(request.body);if(!input.success)return {status:400,body:{error:'invalid_input'}};
 if(clientCompatibility(options.auth.config.supportedClientVersions,input.data.clientVersion).kind!=='supported')return {status:426,body:{status:'refused',replayed:false,reason:'client_upgrade_required'}};
 const generated=await generateReplyDraft(scoped.context,input.data,port,async()=>{
  const current=await requirePrincipal(options.auth!,request);if(!current.ok)return false;
  const before=principal.principal,after=current.principal;
  return before.workspaceId===after.workspaceId&&before.userId===after.userId&&before.sessionId===after.sessionId&&before.deviceId===after.deviceId&&before.role===after.role;
 });
 return generated.ok?{status:200,body:{status:'accepted',replayed:false,result:generated}}:{status:409,body:{status:'refused',replayed:generated.reason==='generation_already_attempted',reason:generated.reason}};
}
