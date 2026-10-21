import {discoveryReviewCommandSchema,discoveryReviewSavedSchema,discoveryUsefulListInputSchema} from '@fss/contracts';
import {recordDiscoveryReview,readVisibleDiscoveryReview,listUsefulDiscoveryCandidates} from '@fss/domain/sourcing/discoveryReview.ts';
import {runCommand} from '../auth/commands.ts';
import {commandReply,contextForPrincipal,type RouteDeps} from './routeSupport.ts';
import type {RouteResult} from './types.ts';

export const DISCOVERY_REVIEW_PATHS=['/sourcing/candidates/discovery/review-v1','/sourcing/candidates/discovery/useful-list-v1'] as const;

/** Authenticated by the ordinary sourcing router. Receipt stores only opaque IDs:
 * replays rehydrate under current candidate/source access, never historical text. */
export async function routeDiscoveryReview(deps:RouteDeps):Promise<RouteResult> {
  const {auth,principal,request}=deps;
  const scoped=contextForPrincipal(auth,principal);if(!scoped.ok)return scoped.result;
  if(request.path==='/sourcing/candidates/discovery/useful-list-v1'){
    const parsed=discoveryUsefulListInputSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'malformed_body'}};
    const answer=await listUsefulDiscoveryCandidates(scoped.context,parsed.data);
    return answer.ok?{status:200,body:answer.value}:{status:answer.reason==='admin_only'?403:400,body:{error:answer.reason}};
  }
  const parsed=discoveryReviewCommandSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'malformed_body'}};
  const {commandId,clientVersion,...payload}=parsed.data;
  const outcome=await runCommand(auth,principal,{commandId,clientVersion,kind:'sourcing.discovery_review',payload},async context=>{
    const answer=await recordDiscoveryReview(context,payload);
    return answer.ok?{status:'accepted',result:{reviewId:answer.value.review.id,alreadyRecorded:answer.value.alreadyRecorded}}:{status:'refused',reason:answer.reason};
  });
  if(outcome.status!=='accepted')return commandReply(outcome);
  const review=await readVisibleDiscoveryReview(scoped.context,outcome.result.reviewId);
  if(!review)return commandReply({status:'refused',reason:'review_unavailable',replayed:outcome.replayed});
  return commandReply({...outcome,result:discoveryReviewSavedSchema.parse({review,alreadyRecorded:outcome.result.alreadyRecorded})});
}
