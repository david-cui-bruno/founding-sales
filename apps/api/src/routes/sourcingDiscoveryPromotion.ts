import {discoveryResearchFirmLinkCommandSchema} from '@fss/contracts';
import {linkDiscoveryResearchFirm,readDiscoveryResearchFirm,readDiscoveryResearchFirmForCandidate} from '@fss/domain/sourcing/discoveryResearchFirm.ts';
import {discoveryPromotionCommandSchema,qualificationReadSchema} from '@fss/contracts';
import {prepareDiscoveryCandidate,readDiscoveryPreparation,readDiscoveryPreparationForCandidate} from '@fss/domain/sourcing/discoveryPromotion.ts';
import {runCommand} from '../auth/commands.ts';
import {commandReply,contextForPrincipal,type RouteDeps} from './routeSupport.ts';
import type {RouteResult} from './types.ts';

export const DISCOVERY_PROMOTION_PATHS=['/sourcing/candidates/discovery/link-research-firm-v1','/sourcing/candidates/discovery/research-firm-read-v1','/sourcing/candidates/discovery/prepare-v1','/sourcing/candidates/discovery/preparation-read-v1'] as const;

/** Ordinary authenticated sourcing router owns authentication and POST fencing.
 * Command receipts contain only the opaque link identity, never seed text. */
export async function routeDiscoveryPromotion(deps:RouteDeps):Promise<RouteResult> {
 const {auth,principal,request}=deps;
 const scoped=contextForPrincipal(auth,principal);if(!scoped.ok)return scoped.result;
 if(request.path==='/sourcing/candidates/discovery/research-firm-read-v1'){
  const parsed=qualificationReadSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'malformed_body'}};
  const view=await readDiscoveryResearchFirmForCandidate(scoped.context,parsed.data.candidateId);
  return view?{status:200,body:view}:{status:404,body:{error:'research_firm_unavailable'}};
 }
 if(request.path==='/sourcing/candidates/discovery/link-research-firm-v1'){
  const parsed=discoveryResearchFirmLinkCommandSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'malformed_body'}};
  const {commandId,clientVersion,...payload}=parsed.data;
  const outcome=await runCommand(auth,principal,{commandId,clientVersion,kind:'sourcing.discovery_research_firm_link',payload},async context=>{
   const answer=await linkDiscoveryResearchFirm(context,payload);
   return answer.ok?{status:'accepted',result:answer.value}:{status:'refused',reason:answer.reason};
  });
  if(outcome.status!=='accepted')return commandReply(outcome);
  const view=await readDiscoveryResearchFirm(scoped.context,outcome.result.promotionId,outcome.result.alreadyLinked);
  return view?commandReply({...outcome,result:view}):commandReply({status:'refused',reason:'research_firm_unavailable',replayed:outcome.replayed});
 }
 if(request.path==='/sourcing/candidates/discovery/preparation-read-v1'){
  const parsed=qualificationReadSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'malformed_body'}};
  const view=await readDiscoveryPreparationForCandidate(scoped.context,parsed.data.candidateId);
  return view?{status:200,body:view}:{status:404,body:{error:'preparation_unavailable'}};
 }
 const parsed=discoveryPromotionCommandSchema.safeParse(request.body);if(!parsed.success)return {status:400,body:{error:'malformed_body'}};
 const {commandId,clientVersion,...payload}=parsed.data;
 const outcome=await runCommand(auth,principal,{commandId,clientVersion,kind:'sourcing.discovery_prepare',payload},async context=>{
  const answer=await prepareDiscoveryCandidate(context,payload);
  return answer.ok?{status:'accepted',result:answer.value}:{status:'refused',reason:answer.reason};
 });
 if(outcome.status!=='accepted')return commandReply(outcome);
 const view=await readDiscoveryPreparation(scoped.context,outcome.result.promotionId,outcome.result.alreadyPrepared);
 if(!view)return commandReply({status:'refused',reason:'preparation_unavailable',replayed:outcome.replayed});
 return commandReply({...outcome,result:view});
}
