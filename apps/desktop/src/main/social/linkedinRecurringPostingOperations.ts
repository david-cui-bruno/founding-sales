import {linkedinRecurringViewSchema} from '@fss/contracts';
import type {OperationOutput} from '../../shared/operations.ts';
import type {AuthedClient} from '../authedClient.ts';
export function linkedinRecurringPostingOperations(deps:{api:AuthedClient;generation():number}){
 return {'social.recurringPosting':async():Promise<OperationOutput<'social.recurringPosting'>>=>{
  const g=deps.generation();
  const result=await deps.api.read('/social/linkedin-recurring/read',v=>linkedinRecurringViewSchema.parse(v),{});
  if(g!==deps.generation())return {view:null,reason:'session_changed'};
  return result.ok?{view:result.value,reason:null}:{view:null,reason:result.reason};
 }};
}
