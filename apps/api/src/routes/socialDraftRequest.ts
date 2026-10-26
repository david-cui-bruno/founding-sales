import {socialDraftRequestCommandSchema} from '@fss/contracts';
import {requestSocialDrafts} from '@fss/domain/social/drafts.ts';
import {PrivateDraftAuthorityChanged,requirePrivateDraftAuthority} from '@fss/domain/social/privateDrafts.ts';
import {runRouteCommand,type RouteDeps} from './routeSupport.ts';
import {retainedPrincipalAuthority} from './retainedPrincipalAuthority.ts';
import {privatePrincipalIsCurrent,privateAuthorityRefusal} from './privateReadAuthority.ts';
import type {RouteResult} from './types.ts';

/** Guide-bearing work retains the initiating principal, not just durable owner
 * membership. Omitted guides keep the existing command path unchanged. */
export async function requestSocialDraftRoute(deps:RouteDeps):Promise<RouteResult>{
 const parsed=socialDraftRequestCommandSchema.safeParse(deps.request.body);
 const guided=parsed.success&&parsed.data.voiceGuideRef!==undefined;
 try{
  const result=await runRouteCommand(deps,socialDraftRequestCommandSchema,'social_drafts_request',(ctx,input)=>{
   const {commandId:_id,clientVersion:_client,...selection}=input;
   return requestSocialDrafts(ctx,selection,guided?retainedPrincipalAuthority(deps,ctx):undefined);
  },guided?ctx=>requirePrivateDraftAuthority(retainedPrincipalAuthority(deps,ctx)):undefined);
  // Existing-receipt and unique-winner replay bypass command beforeCommit.
  if(guided&&!await privatePrincipalIsCurrent(deps))return privateAuthorityRefusal();
  return result;
 }catch(error){if(error instanceof PrivateDraftAuthorityChanged)return privateAuthorityRefusal();throw error;}
}
