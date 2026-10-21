import {discoveryReviewSavedSchema,discoveryUsefulListSchema} from '@fss/contracts';
import type {OperationInput,OperationOutput} from '../shared/operations.ts';
import type {AuthedClient} from './authedClient.ts';
import {sourcingCandidateReadHandlers} from './sourcingCandidateReadHandlers.ts';

/** Session-local only. No disk cache, acquisition or implicit commands on reads. */
export function sourcingDiscoveryReviewHandlers(deps:{api:AuthedClient;generation():number}) {
  return {
    ...sourcingCandidateReadHandlers(deps),
    'sourcing.discoveryUsefulList':async(input:OperationInput<'sourcing.discoveryUsefulList'>):Promise<OperationOutput<'sourcing.discoveryUsefulList'>>=>{
      const generation=deps.generation();
      try{
        const answer=await deps.api.read('/sourcing/candidates/discovery/useful-list-v1',value=>discoveryUsefulListSchema.parse(value),input);
        if(generation!==deps.generation())return {view:null,reason:'session_changed'};
        return answer.ok?{view:answer.value,reason:null}:{view:null,reason:answer.reason.slice(0,80)};
      }catch{return {view:null,reason:generation===deps.generation()?'unavailable':'session_changed'};}
    },
    'sourcing.discoveryReview':async(input:OperationInput<'sourcing.discoveryReview'>):Promise<OperationOutput<'sourcing.discoveryReview'>>=>{
      const generation=deps.generation(),{commandId,...payload}=input;
      try{
        const answer=await deps.api.command('/sourcing/candidates/discovery/review-v1',payload,value=>discoveryReviewSavedSchema.parse(value),{commandId});
        if(generation!==deps.generation())return {result:null,reason:'session_changed'};
        return answer.ok?{result:answer.value,reason:null}:{result:null,reason:answer.reason.slice(0,80)};
      }catch{return {result:null,reason:generation===deps.generation()?'unavailable':'session_changed'};}
    },
  };
}
