import {clientCompatibility} from '@fss/contracts';
import {replyDraftContextInputSchema,replyDraftGenerateInputSchema} from '../../../../packages/contracts/src/replyComposer.ts';
import {readReplyDraftContext} from '@fss/domain/replies/composer.ts';
import {generateReplyDraft,type HumanReplyDraftPort} from '@fss/domain/replies/composerGeneration.ts';
import {requirePrincipal,contextForPrincipal} from './routeSupport.ts';
import type {ApiRequest,RoutingOptions,RouteResult} from './types.ts';

export const REPLY_COMPOSER_PATHS=['/replies/composer/context','/replies/composer/generate'];
/** Paid attempt metadata supplies replay safety; source/generated prose is never a receipt. */
export async function routeReplyComposer(request:ApiRequest,options:RoutingOptions,port:HumanReplyDraftPort|null=null):Promise<RouteResult|null>{
 if(!REPLY_COMPOSER_PATHS.includes(request.path))return null;
 if(request.method!=='POST')return {status:405,body:{error:'method_not_allowed'}};
 if(!options.auth)return {status:404,body:{error:'not_found'}};
 const principal=await requirePrincipal(options.auth,request);if(!principal.ok)return principal.result;
 const scoped=contextForPrincipal(options.auth,principal.principal);if(!scoped.ok)return scoped.result;
 if(request.path==='/replies/composer/context'){
  const input=replyDraftContextInputSchema.safeParse(request.body);if(!input.success)return {status:400,body:{error:'invalid_input'}};
  return {status:200,body:await readReplyDraftContext(scoped.context,input.data)};
 }
 const input=replyDraftGenerateInputSchema.safeParse(request.body);if(!input.success)return {status:400,body:{error:'invalid_input'}};
 if(clientCompatibility(options.auth.config.supportedClientVersions,input.data.clientVersion).kind!=='supported')return {status:426,body:{status:'refused',replayed:false,reason:'client_upgrade_required'}};
 const generated=await generateReplyDraft(scoped.context,input.data,port);
 return generated.ok?{status:200,body:{status:'accepted',replayed:false,result:generated}}:{status:409,body:{status:'refused',replayed:generated.reason==='generation_already_attempted',reason:generated.reason}};
}
