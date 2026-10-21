import {discoveryIntakeSavedSchema} from '@fss/contracts';
import type {OperationInput,OperationOutput} from '../shared/operations.ts';
import type {AuthedClient} from './authedClient.ts';

/** Single explicit save, normal API envelope/session, no retry or alternate identity. */
export function sourcingDiscoverySaveHandlers(deps:{api:AuthedClient;generation():number}) {
  return {
    'sourcing.discoverySave':async(input:OperationInput<'sourcing.discoverySave'>):Promise<OperationOutput<'sourcing.discoverySave'>>=>{
      const generation=deps.generation(),current=()=>generation===deps.generation();
      const {commandId,...payload}=input;
      if(!current())return {result:null,reason:'session_changed_before_dispatch'};
      try{
        const answer=await deps.api.command('/sourcing/candidates/discovery/save-v1',payload,value=>discoveryIntakeSavedSchema.parse(value),{commandId,current});
        if(!current())return {result:null,reason:!answer.ok&&answer.reason==='session_changed_before_dispatch'?answer.reason:'session_changed_after_dispatch'};
        return answer.ok?{result:answer.value,reason:null}:{result:null,reason:answer.reason.slice(0,80)};
      }catch{return {result:null,reason:current()?'unavailable':'session_changed_after_dispatch'};}
    },
  };
}
