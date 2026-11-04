import {socialDraftRequestCommandSchema} from '@fss/contracts';
import {requestSocialDrafts} from '@fss/domain/social/drafts.ts';
import {PrivateDraftAuthorityChanged,requirePrivateDraftAuthority} from '@fss/domain/social/privateDrafts.ts';
import {runRouteCommand,type RouteDeps} from './routeSupport.ts';
import {retainedPrincipalAuthority} from './retainedPrincipalAuthority.ts';
import {privatePrincipalIsCurrent,privateAuthorityRefusal} from './privateReadAuthority.ts';
import type {RouteResult} from './types.ts';

/** Private guide or founder-input processing retains the initiating principal,
 * independently of whether a private guide was selected. Legacy source-only
 * commands keep their established path. */
export async function requestSocialDraftRoute(deps:RouteDeps):Promise<RouteResult>{
 const parsed=socialDraftRequestCommandSchema.safeParse(deps.request.body);
 const privateProcessing=parsed.success&&(parsed.data.voiceGuideRef!==undefined||parsed.data.mode==='linkedin_founder');
 try{
  const result=await runRouteCommand(deps,socialDraftRequestCommandSchema,'social_drafts_request',(ctx,input)=>{
   const {commandId:_id,clientVersion:_client,...selection}=input;
   return requestSocialDrafts(ctx,selection,privateProcessing?retainedPrincipalAuthority(deps,ctx):undefined);
  },privateProcessing?ctx=>requirePrivateDraftAuthority(retainedPrincipalAuthority(deps,ctx)):undefined);
  // Existing-receipt and unique-winner replay bypass command beforeCommit.
  if(privateProcessing&&!await privatePrincipalIsCurrent(deps))return privateAuthorityRefusal();
  return result;
 }catch(error){if(error instanceof PrivateDraftAuthorityChanged)return privateAuthorityRefusal();throw error;}
}
