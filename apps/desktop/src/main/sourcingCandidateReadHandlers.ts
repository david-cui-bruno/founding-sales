import {candidateListSchema,discoveryIntakeListSchema} from '@fss/contracts';
import type {OperationInput,OperationOutput} from '../shared/operations.ts';
import type {AuthedClient} from './authedClient.ts';

/** Reads retained observations only, with no command receipt or acquisition authority. */
export function sourcingCandidateReadHandlers(deps:{api:AuthedClient;generation():number}) {
  return {
    'sourcing.list':async(input:OperationInput<'sourcing.list'>):Promise<OperationOutput<'sourcing.list'>>=>{
      const generation=deps.generation();
      const answer=await deps.api.read('/sourcing/candidates/list',value=>candidateListSchema.parse(value),input);
      if(generation!==deps.generation())return {view:null,reason:'not_found'};
      return answer.ok?{view:answer.value,reason:null}:{view:null,reason:answer.reason.slice(0,80)};
    },
    'sourcing.discoveryList':async(input:OperationInput<'sourcing.discoveryList'>):Promise<OperationOutput<'sourcing.discoveryList'>>=>{
      const generation=deps.generation();
      try {
        const answer=await deps.api.read('/sourcing/candidates/discovery/list-v1',value=>discoveryIntakeListSchema.parse(value),input);
        if(generation!==deps.generation())return {view:null,reason:'session_changed'};
        return answer.ok?{view:answer.value,reason:null}:{view:null,reason:answer.reason.slice(0,80)};
      }catch{return {view:null,reason:generation===deps.generation()?'unavailable':'session_changed'};}
    },
  };
}
