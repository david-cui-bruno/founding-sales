import {socialVoiceSaveCommandSchema,socialVoiceReadInputSchema,socialVoiceReceiptInputSchema,socialVoiceReceiptSchema} from '@fss/contracts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {saveSocialVoicePreferences,readSocialVoicePreferences} from '@fss/domain/social/voicePreferences.ts';
import {PrivateDraftAuthorityChanged,requirePrivateDraftAuthority} from '@fss/domain/social/privateDrafts.ts';
import {contextForPrincipal,runRouteCommand,requirePrincipal,type RouteDeps} from './routeSupport.ts';
import {retainedPrincipalAuthority} from './retainedPrincipalAuthority.ts';
import {samePrivatePrincipal} from './privateReadAuthority.ts';
import type {RouteResult} from './types.ts';
export const SOCIAL_VOICE_PATHS=['/social/voice-preferences/read','/social/voice-preferences/receipt','/social/voice-preferences/save'] as const;
export const SOCIAL_VOICE_COMMAND_KIND='social.voice_preferences_save';
export async function routeSocialVoicePreferences(deps:RouteDeps):Promise<RouteResult>{
 const scoped=contextForPrincipal(deps.auth,deps.principal);if(!scoped.ok)return scoped.result;
 const check=async()=>{const fresh=await requirePrincipal(deps.auth,deps.request);if(!fresh.ok||!samePrivatePrincipal(fresh.principal,deps.principal))throw new PrivateDraftAuthorityChanged();};
 try{
  let answer:RouteResult;
  if(deps.request.path===SOCIAL_VOICE_PATHS[2])answer=await runRouteCommand(deps,socialVoiceSaveCommandSchema,SOCIAL_VOICE_COMMAND_KIND,(ctx,body)=>{const {commandId:_id,clientVersion:_version,...input}=body;return saveSocialVoicePreferences(ctx,input,retainedPrincipalAuthority(deps,ctx));},ctx=>requirePrivateDraftAuthority(retainedPrincipalAuthority(deps,ctx)));
  else{
   const parsed=(deps.request.path===SOCIAL_VOICE_PATHS[0]?socialVoiceReadInputSchema:socialVoiceReceiptInputSchema).safeParse(deps.request.body);
   if(!parsed.success)return {status:400,body:{error:'invalid_input'}};
   answer=await withTransaction(deps.auth.db,async()=>{
    const ctx=scoped.context,authority=retainedPrincipalAuthority(deps,ctx);await check();
    if('commandId' in parsed.data){
     const receipt=socialVoiceReceiptInputSchema.parse(parsed.data),p=deps.principal;
     const row=(await ctx.db.query<{result_status:string;result:unknown}>(`SELECT r.result_status,r.result FROM command_receipts r JOIN devices d ON d.workspace_id=r.workspace_id AND d.id=r.device_id WHERE r.workspace_id=$1 AND r.command_id=$2 AND r.device_id=$3 AND d.user_id=$4 AND r.command_kind=$5 AND r.payload_hash=$6`,[p.workspaceId,receipt.commandId,p.deviceId,p.userId,SOCIAL_VOICE_COMMAND_KIND,receipt.payloadSHA256])).rows[0];
     await requirePrivateDraftAuthority(authority);
     return {status:200,body:socialVoiceReceiptSchema.parse(!row?{state:'unknown'}:row.result_status==='accepted'?{state:'accepted',result:row.result}:{state:'refused',reason:typeof row.result==='string'?row.result:'refused'})};
    }
    const guide=await readSocialVoicePreferences(ctx,authority);return guide?{status:200,body:{guide}}:{status:403,body:{error:'owner_unavailable'}};
   });
  }
  await check();return answer;
 }catch(error){if(error instanceof PrivateDraftAuthorityChanged)return {status:401,body:{error:'unauthenticated'}};throw error;}
}
