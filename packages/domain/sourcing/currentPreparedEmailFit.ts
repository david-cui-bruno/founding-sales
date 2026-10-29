import {qualifyEmailCandidate,type EmailEvidenceRoute} from '../outreach/selection.ts';
import {nativeFirmCitations,type NativeEvidenceInput} from './nativeFirmEligibility.ts';

export type CurrentPreparedEmailFit={eligible:false;route:null;channelAuthority:'not_granted'}
 |{eligible:true;route:EmailEvidenceRoute;channelAuthority:'not_granted'};
const unavailable=():CurrentPreparedEmailFit=>({eligible:false,route:null,channelAuthority:'not_granted'});
/** Source-fit for added US preparation only, never a modified email-fit-v2 verdict.
 * The same input must independently prove current us-v1 native evidence. All other
 * legacy email unknowns/route checks remain; suppression/admission/OFF stay with
 * their existing channel owners and are never granted or lifted here. */
export function currentUSPreparedEmailFit(input:NativeEvidenceInput,nativeProof:unknown):CurrentPreparedEmailFit {
 const current=nativeFirmCitations(input);
 if('status' in current||current.policyVersion!=='native-firm-eligibility-us-v1')return unavailable();
 try{if(JSON.stringify(current)!==JSON.stringify(nativeProof))return unavailable();}catch{return unavailable();}
 const candidate=input.candidate;
 const legacy=qualifyEmailCandidate({identity:{status:'resolved',name:candidate.firmName,website:candidate.website,
  locality:candidate.locality,region:candidate.region},facts:input.facts,observations:input.observations,now:input.now});
 if(!legacy.route||legacy.unknowns.some(reason=>reason!=='target_geography_unsupported'))return unavailable();
 return {eligible:true,route:legacy.route,channelAuthority:'not_granted'};
}
