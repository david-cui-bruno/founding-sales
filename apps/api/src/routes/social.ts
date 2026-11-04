import {SOCIAL_PUBLIC_THREAD_PATHS,routeSocialPublicThreads} from './socialPublicThreads.ts';
import {SOCIAL_PUBLISHING_READINESS_PATH,routeSocialPublishingReadiness} from './socialPublishingReadiness.ts';
import {SOCIAL_FOUNDER_PATHS,routeSocialFounderInputs} from './socialFounderInputs.ts';
import {SOCIAL_APPROVED_MEDIA_PATHS,handleSocialApprovedMediaRoute} from './socialApprovedMedia.ts';
import {SOCIAL_PUBLISHER_CONNECTION_PATH,routeSocialPublisherConnection} from './socialPublisher.ts';
import {SOCIAL_STANDING_PATHS,routeSocialStandingPlan} from './socialStandingPlan.ts';
import {linkedinPolicySaveCommandSchema,linkedinPolicyStopCommandSchema,linkedinPolicyCheckSchema} from '@fss/contracts';
import {readLinkedinPolicy,saveLinkedinPolicy,stopLinkedinPolicy,checkLinkedinPolicyCurrent} from '@fss/domain/social/linkedinPolicy.ts';
import {registerSocialManualDestination} from '@fss/domain/social/manualDestination.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {socialManualHandoffInputSchema,socialManualHandoffViewSchema,socialManualHandoffConfirmCommandSchema} from '@fss/contracts';
import {readSocialManualHandoff,confirmSocialManualHandoff} from '@fss/domain/social/manualHandoff.ts';
import {holdSocialDelivery} from '@fss/domain/social/deliveryRecovery.ts';
import {socialDeliveryHoldCommandSchema} from '@fss/contracts';
import {readSocialDeliveryQueue} from '@fss/domain/social/deliveryQueue.ts';
import {socialWeeklyCommandSchema} from '@fss/contracts';
import {readSocialWeekly,saveSocialWeekly} from '@fss/domain/social/weekly.ts';
import {readSocialDraftRoute} from './socialDraftReads.ts';
import {requestSocialDraftRoute} from './socialDraftRequest.ts';
import {socialDraftRequestReceipt} from './socialDraftRequestReceipt.ts';
import {socialConnectionCommandSchema,socialDisconnectCommandSchema} from '@fss/contracts';
import {saveSocialConnection,disconnectSocialAccount} from '@fss/domain/social/accounts.ts';
import {socialPostSaveCommandSchema,socialPostActionCommandSchema,socialBeginCommandSchema,socialObservationCommandSchema} from '@fss/contracts';
import {saveSocialPost,approveSocialPost,requestSocialCancellation,readSocialWorkspace} from '@fss/domain/social/posts.ts';
import {claimSocialDelivery,beginSocialSubmission,recordSocialObservation} from '@fss/domain/social/delivery.ts';
import {SOCIAL_VOICE_PATHS,routeSocialVoicePreferences} from './socialVoicePreferences.ts';
import {SOCIAL_PRIVATE_PATHS,routeSocialPrivateDrafts} from './socialPrivateDrafts.ts';
import {z} from 'zod';
import {uuid,socialAssetRegisterCommandSchema,socialAssetDeleteCommandSchema} from '@fss/contracts';
import {readSocialAsset,registerSocialAsset,deleteSocialAsset,listSocialAssets} from '@fss/domain/social/assets.ts';
import {routeSocialAssetUrl} from './socialAssetUrls.ts';
import {contextForPrincipal,requirePrincipal} from './routeSupport.ts';
import {guardedSocialCommand as runRouteCommand} from './socialCommand.ts';
import type {ApiRequest,RouteResult,RoutingOptions} from './types.ts';
export const SOCIAL_PATHS=[...SOCIAL_PUBLIC_THREAD_PATHS,SOCIAL_PUBLISHING_READINESS_PATH,...SOCIAL_VOICE_PATHS,...SOCIAL_PRIVATE_PATHS,...SOCIAL_FOUNDER_PATHS,...SOCIAL_APPROVED_MEDIA_PATHS,SOCIAL_PUBLISHER_CONNECTION_PATH,...SOCIAL_STANDING_PATHS,'/social/linkedin-policy/read','/social/linkedin-policy/save','/social/linkedin-policy/disable','/social/linkedin-policy/revoke','/social/linkedin-policy/check-current','/social/accounts/manual','/social/manual-handoff/read','/social/manual-handoff/confirm','/social/delivery/hold','/social/delivery/queue','/social/weekly','/social/weekly/save','/social/drafts','/social/drafts/request/receipt','/social/drafts/request','/social/drafts/read','/social','/social/accounts/connect','/social/accounts/disconnect','/social/posts/save','/social/posts/approve','/social/posts/cancel','/social/delivery/claim','/social/delivery/begin','/social/delivery/observe','/social/assets','/social/assets/read','/social/assets/register','/social/assets/delete','/social/assets/upload-url','/social/assets/download-url'];
export async function routeSocial(request:ApiRequest,options:RoutingOptions):Promise<RouteResult|null>{
 if(!SOCIAL_PATHS.includes(request.path))return null;if(request.method!=='POST')return {status:405,body:{error:'method_not_allowed'}};
 const auth=options.auth;if(!auth)return {status:404,body:{error:'not_found'}};
 const principal=await requirePrincipal(auth,request);if(!principal.ok)return principal.result;const scoped=contextForPrincipal(auth,principal.principal);if(!scoped.ok)return scoped.result;
 const ctx=scoped.context,deps={auth,request,principal:principal.principal};
 if((SOCIAL_PUBLIC_THREAD_PATHS as readonly string[]).includes(request.path))return routeSocialPublicThreads(deps);
 if(request.path===SOCIAL_PUBLISHING_READINESS_PATH)return routeSocialPublishingReadiness(deps,options.socialPublisher);
 if((SOCIAL_VOICE_PATHS as readonly string[]).includes(request.path))return routeSocialVoicePreferences(deps);
 if((SOCIAL_PRIVATE_PATHS as readonly string[]).includes(request.path))return routeSocialPrivateDrafts(deps);
 if((SOCIAL_FOUNDER_PATHS as readonly string[]).includes(request.path))return routeSocialFounderInputs(deps);
 if((SOCIAL_APPROVED_MEDIA_PATHS as readonly string[]).includes(request.path))return handleSocialApprovedMediaRoute(deps,options.socialMedia??null);
 if(request.path===SOCIAL_PUBLISHER_CONNECTION_PATH)return routeSocialPublisherConnection(deps,options.socialPublisher);
 if((SOCIAL_STANDING_PATHS as readonly string[]).includes(request.path))return routeSocialStandingPlan(deps);
 if(request.path==='/social/linkedin-policy/read'){
  if(!z.strictObject({}).safeParse(request.body).success)return {status:400,body:{error:'invalid_input'}};
  return {status:200,body:await withTransaction(auth.db,()=>readLinkedinPolicy(ctx))};
 }
 if(request.path==='/social/linkedin-policy/save')return runRouteCommand(deps,linkedinPolicySaveCommandSchema,'linkedin_policy_save',(c,body)=>{const {commandId:_id,clientVersion:_client,...input}=body;return saveLinkedinPolicy(c,input);});
 if(request.path==='/social/linkedin-policy/disable')return runRouteCommand(deps,linkedinPolicyStopCommandSchema,'linkedin_policy_disable',(c,input)=>stopLinkedinPolicy(c,input,'disabled'));
 if(request.path==='/social/linkedin-policy/revoke')return runRouteCommand(deps,linkedinPolicyStopCommandSchema,'linkedin_policy_revoke',(c,input)=>stopLinkedinPolicy(c,input,'revoked'));
 if(request.path==='/social/linkedin-policy/check-current'){
  const parsed=linkedinPolicyCheckSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'invalid_input'}};
  return {status:200,body:await withTransaction(auth.db,()=>checkLinkedinPolicyCurrent(ctx,parsed.data))};
 }
 if(request.path==='/social/manual-handoff/read'){
  const parsed=socialManualHandoffInputSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'invalid_input'}};
  const answer=await withTransaction(auth.db,()=>readSocialManualHandoff(ctx,parsed.data));return answer.ok?{status:200,body:{view:socialManualHandoffViewSchema.parse(answer.value)}}:{status:409,body:{error:answer.reason}};
 }
 if(request.path==='/social/manual-handoff/confirm')return runRouteCommand(deps,socialManualHandoffConfirmCommandSchema,'social_manual_handoff_confirm',(c,input)=>confirmSocialManualHandoff(c,input));
 if(request.path==='/social/weekly'){if(!z.strictObject({}).safeParse(request.body).success)return {status:400,body:{error:'invalid_input'}};return {status:200,body:await readSocialWeekly(ctx)};}
 if(request.path==='/social/weekly/save')return runRouteCommand(deps,socialWeeklyCommandSchema,'social_weekly_save',(c,input)=>saveSocialWeekly(c,{enabled:input.enabled,expectedRevision:input.expectedRevision}));
 if(request.path==='/social/drafts'||request.path==='/social/drafts/read')return readSocialDraftRoute(deps);
 if(request.path==='/social/drafts/request/receipt')return socialDraftRequestReceipt(deps);
 if(request.path==='/social/drafts/request')return requestSocialDraftRoute(deps);
 if(request.path==='/social/accounts/manual')return runRouteCommand(deps,socialConnectionCommandSchema,'social_manual_destination',(c,body)=>{const {commandId:_id,clientVersion:_client,...input}=body;return registerSocialManualDestination(c,input);});
 if(request.path==='/social/accounts/connect')return runRouteCommand(deps,socialConnectionCommandSchema,'social_account_connect',(c,input)=>{const {commandId:_id,clientVersion:_client,...connection}=input;return saveSocialConnection(c,connection);});
 if(request.path==='/social/accounts/disconnect')return runRouteCommand(deps,socialDisconnectCommandSchema,'social_account_disconnect',disconnectSocialAccount);
 if(request.path==='/social'){const parsed=z.strictObject({afterId:uuid.optional()}).safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'invalid_input'}};return {status:200,body:await readSocialWorkspace(ctx,parsed.data.afterId)};}
 if(request.path==='/social/posts/save')return runRouteCommand(deps,socialPostSaveCommandSchema,'social_post_save',(c,input)=>{const {commandId:_id,clientVersion:_client,...post}=input;return saveSocialPost(c,post);});
 if(request.path==='/social/posts/approve')return runRouteCommand(deps,socialPostActionCommandSchema,'social_post_approve',approveSocialPost);
 if(request.path==='/social/posts/cancel')return runRouteCommand(deps,socialPostActionCommandSchema,'social_post_cancel',requestSocialCancellation);
 if(request.path==='/social/delivery/queue'){if(!z.strictObject({}).safeParse(request.body).success)return {status:400,body:{error:'invalid_input'}};return {status:200,body:await withTransaction(auth.db,()=>readSocialDeliveryQueue(ctx,principal.principal.deviceId))};}
 if(request.path==='/social/delivery/hold')return runRouteCommand(deps,socialDeliveryHoldCommandSchema,'social_delivery_hold',(c,input)=>holdSocialDelivery(c,{...input,deviceId:principal.principal.deviceId}));
 if(request.path==='/social/delivery/claim')return runRouteCommand(deps,socialPostActionCommandSchema,'social_delivery_claim',(c,input)=>claimSocialDelivery(c,{...input,deviceId:principal.principal.deviceId}));
 if(request.path==='/social/delivery/begin'){
  const answer=await runRouteCommand(deps,socialBeginCommandSchema,'social_delivery_begin',(c,input)=>beginSocialSubmission(c,{...input,deviceId:principal.principal.deviceId}));
  // A durable submission marker is not a reusable authorization to click again.
  if(answer.status===200&&(answer.body as {replayed?:boolean}).replayed)return {status:409,body:{error:'inspect_existing_submission'}};
  return answer;
 }
 if(request.path==='/social/delivery/observe')return runRouteCommand(deps,socialObservationCommandSchema,'social_delivery_observe',(c,input)=>recordSocialObservation(c,{...input,deviceId:principal.principal.deviceId}));
 if(request.path==='/social/assets'){const parsed=z.strictObject({afterId:uuid.optional()}).safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'invalid_input'}};return {status:200,body:{assets:await listSocialAssets(ctx,parsed.data.afterId)}};}
 if(request.path==='/social/assets/read'){const parsed=z.strictObject({assetId:uuid}).safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'invalid_input'}};const asset=await readSocialAsset(ctx,parsed.data.assetId);return asset&&asset.state!=='deleted'?{status:200,body:{asset}}:{status:404,body:{error:'not_found'}};}
 if(request.path==='/social/assets/delete')return runRouteCommand(deps,socialAssetDeleteCommandSchema,'social_asset_delete',(c,input)=>deleteSocialAsset(c,input.assetId));
 const store=options.socialMedia;if(!store)return {status:503,body:{error:'social_media_not_configured'}};
 if(request.path==='/social/assets/register')return runRouteCommand(deps,socialAssetRegisterCommandSchema,'social_asset_register',(c,input)=>{const {commandId:_id,clientVersion:_client,...asset}=input;return registerSocialAsset(c,asset);});
 return routeSocialAssetUrl(deps,store);
}
