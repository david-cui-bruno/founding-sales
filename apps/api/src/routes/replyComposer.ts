import {clientCompatibility} from '@fss/contracts';
import {replyDraftContextInputSchema,replyDraftGenerateInputSchema} from '../../../../packages/contracts/src/replyComposer.ts';
import {humanReplyPreviewInputSchema,humanReplySendInputSchema,humanReplySendReadInputSchema} from '../../../../packages/contracts/src/replyComposer.ts';
import {previewHumanReply,requestHumanReplySend,readHumanReplySend} from '@fss/domain/replies/dispatch.ts';
import {readReplyDraftContext} from '@fss/domain/replies/composer.ts';
import {generateReplyDraft,type HumanReplyDraftPort} from '@fss/domain/replies/composerGeneration.ts';
import {requirePrincipal,contextForPrincipal,runRouteCommand} from './routeSupport.ts';
import {privateAuthorityRefusal,privateFirmIsCurrent,privatePrincipalIsCurrent,unchangedPrivateProjection} from './privateReadAuthority.ts';
import type {ApiRequest,RoutingOptions,RouteResult} from './types.ts';

export const REPLY_COMPOSER_PATHS=['/replies/composer/context','/replies/composer/generate','/replies/composer/preview','/replies/composer/send-status','/replies/composer/send'];
/** Paid attempt metadata supplies replay safety; source/generated prose is never a receipt. */
export async function routeReplyComposer(request:ApiRequest,options:RoutingOptions,port:HumanReplyDraftPort|null=null):Promise<RouteResult|null>{
 if(!REPLY_COMPOSER_PATHS.includes(request.path))return null;
 if(request.method!=='POST')return {status:405,body:{error:'method_not_allowed'}};
 if(!options.auth)return {status:404,body:{error:'not_found'}};
 const principal=await requirePrincipal(options.auth,request);if(!principal.ok)return principal.result;
 const scoped=contextForPrincipal(options.auth,principal.principal);if(!scoped.ok)return scoped.result;
 const deps={auth:options.auth,request,principal:principal.principal};
 const currentAuthorization=()=>privatePrincipalIsCurrent(deps);
 if(request.path==='/replies/composer/preview'){
  const input=humanReplyPreviewInputSchema.safeParse(request.body);if(!input.success)return {status:400,body:{error:'invalid_input'}};
  const read=()=>previewHumanReply(scoped.context,input.data);
  const preview=await read();
  const stable=!preview.ok||await unchangedPrivateProjection(preview,read);
  const context=preview.ok?await readReplyDraftContext(scoped.context,{messageId:input.data.messageId,factRefs:input.data.factRefs,envelope:input.data.envelope}):null;
  const accessible=context?.ok!==true||await privateFirmIsCurrent(scoped.context,context.value.firmId);
  if(!await currentAuthorization())return privateAuthorityRefusal();
  if(!accessible||!preview.ok&&['not_assigned','owner_changed'].includes(preview.reason)||context?.ok===false&&['not_assigned','owner_changed'].includes(context.reason))return privateAuthorityRefusal();
  return {status:200,body:stable&&(!preview.ok||context?.ok===true&&context.value.sourceRevision===preview.value.sourceRevision)?preview:{ok:false,reason:'source_changed'}};
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
  const read=()=>readReplyDraftContext(scoped.context,input.data);
  const context=await read();
  const current=context.ok?await read():context;
  const stable=JSON.stringify(context)===JSON.stringify(current);
  const accessible=!context.ok||await privateFirmIsCurrent(scoped.context,context.value.firmId);
  if(!await currentAuthorization()||!accessible||!current.ok&&['not_assigned','owner_changed'].includes(current.reason))return privateAuthorityRefusal();
  return {status:200,body:stable?context:{ok:false,reason:'source_changed'}};
 }
 const input=replyDraftGenerateInputSchema.safeParse(request.body);if(!input.success)return {status:400,body:{error:'invalid_input'}};
 if(clientCompatibility(options.auth.config.supportedClientVersions,input.data.clientVersion).kind!=='supported')return {status:426,body:{status:'refused',replayed:false,reason:'client_upgrade_required'}};
 let generated=await generateReplyDraft(scoped.context,input.data,port,currentAuthorization);
 if(generated.ok){
  const current=await readReplyDraftContext(scoped.context,{messageId:input.data.messageId,factRefs:input.data.factRefs,envelope:input.data.envelope});
  if(!current.ok)generated=current;
  else if(current.value.sourceRevision!==input.data.sourceRevision)generated={ok:false,reason:'source_changed'};
 }
 // Keep the shipped desktop command envelope. The closed browser adapter distinguishes
 // this authority refusal from authenticated content/paid-attempt refusals.
 if(!await currentAuthorization())return {status:409,body:{status:'refused',replayed:false,reason:'session_changed'}};
 return generated.ok?{status:200,body:{status:'accepted',replayed:false,result:generated}}:{status:409,body:{status:'refused',replayed:generated.reason==='generation_already_attempted',reason:generated.reason}};
}
