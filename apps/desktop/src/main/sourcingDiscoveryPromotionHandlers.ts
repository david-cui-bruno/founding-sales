import {discoveryPromotionSavedSchema,discoveryResearchFirmLinkSavedSchema,addFirmResultSchema} from '@fss/contracts';
import type {OperationInput,OperationOutput} from '../shared/operations.ts';
import type {AuthedClient} from './authedClient.ts';

/** No disk cache. Current owner generation fences both reads and late commands. */
export function sourcingDiscoveryPromotionHandlers(deps:{api:AuthedClient;generation():number}) {
 return {
  'sourcing.discoveryCreateResearchFirm':async(input:OperationInput<'sourcing.discoveryCreateResearchFirm'>):Promise<OperationOutput<'sourcing.discoveryCreateResearchFirm'>>=>{
   const generation=deps.generation(),{commandId,...payload}=input;
   try{
    const answer=await deps.api.command('/crm/firms/add',payload,value=>addFirmResultSchema.parse(value),{commandId,current:()=>generation===deps.generation()});
    if(generation!==deps.generation())return {result:null,reason:'session_changed'};
    return answer.ok?{result:answer.value,reason:null}:{result:null,reason:answer.reason.slice(0,80)};
   }catch{return {result:null,reason:generation===deps.generation()?'unavailable':'session_changed'};}
  },
  'sourcing.discoveryLinkResearchFirm':async(input:OperationInput<'sourcing.discoveryLinkResearchFirm'>):Promise<OperationOutput<'sourcing.discoveryLinkResearchFirm'>>=>{
   const generation=deps.generation(),{commandId,...payload}=input;
   try{
    const answer=await deps.api.command('/sourcing/candidates/discovery/link-research-firm-v1',payload,value=>discoveryResearchFirmLinkSavedSchema.parse(value),{commandId,current:()=>generation===deps.generation()});
    if(generation!==deps.generation())return {result:null,reason:'session_changed'};
    return answer.ok?{result:answer.value,reason:null}:{result:null,reason:answer.reason.slice(0,80)};
   }catch{return {result:null,reason:generation===deps.generation()?'unavailable':'session_changed'};}
  },
  'sourcing.discoveryResearchFirmRead':async(input:OperationInput<'sourcing.discoveryResearchFirmRead'>):Promise<OperationOutput<'sourcing.discoveryResearchFirmRead'>>=>{
   const generation=deps.generation();
   try{
    const answer=await deps.api.read('/sourcing/candidates/discovery/research-firm-read-v1',value=>discoveryResearchFirmLinkSavedSchema.parse(value),input);
    if(generation!==deps.generation())return {view:null,reason:'session_changed'};
    return answer.ok?{view:answer.value,reason:null}:{view:null,reason:answer.reason.slice(0,80)};
   }catch{return {view:null,reason:generation===deps.generation()?'unavailable':'session_changed'};}
  },
  'sourcing.discoveryPrepare':async(input:OperationInput<'sourcing.discoveryPrepare'>):Promise<OperationOutput<'sourcing.discoveryPrepare'>>=>{
   const generation=deps.generation(),{commandId,...payload}=input;
   try{
    const answer=await deps.api.command('/sourcing/candidates/discovery/prepare-v1',payload,value=>discoveryPromotionSavedSchema.parse(value),{commandId,current:()=>generation===deps.generation()});
    if(generation!==deps.generation())return {result:null,reason:'session_changed'};
    return answer.ok?{result:answer.value,reason:null}:{result:null,reason:answer.reason.slice(0,80)};
   }catch{return {result:null,reason:generation===deps.generation()?'unavailable':'session_changed'};}
  },
  'sourcing.discoveryPreparationRead':async(input:OperationInput<'sourcing.discoveryPreparationRead'>):Promise<OperationOutput<'sourcing.discoveryPreparationRead'>>=>{
   const generation=deps.generation();
   try{
    const answer=await deps.api.read('/sourcing/candidates/discovery/preparation-read-v1',value=>discoveryPromotionSavedSchema.parse(value),input);
    if(generation!==deps.generation())return {view:null,reason:'session_changed'};
    return answer.ok?{view:answer.value,reason:null}:{view:null,reason:answer.reason.slice(0,80)};
   }catch{return {view:null,reason:generation===deps.generation()?'unavailable':'session_changed'};}
  },
 };
}
