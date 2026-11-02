import {repositoryContext} from '@fss/domain/db/workspaceScope.ts';
import type {JobHandler} from '@fss/domain/jobs/handlerRegistry.ts';
import type {JobSpecification} from '@fss/domain/jobs/jobStore.ts';
import {jobIdempotencyKey} from '@fss/domain/jobs/jobKinds.ts';
import {refreshCallableRanks,workspacesWithStaleCallableRanks} from '@fss/domain/sourcing/callableRanks.ts';
import type {DueWorkSource} from '../scheduler/schedulerPass.ts';

/** ADR0034: keeps the advisory Callable-today order key current. Database reads only: no fetch, model or provider call.
 * One bounded batch per call in the runner's own transaction; the job is chunked, so each batch commits with its cursor and
 * a lost lease rolls the batch back. The workspace lifecycle lock is held for one batch at a time, never across the job. */
export function sourcingCallableRankHandler():JobHandler {
  return {kind:'sourcing.callable_rank',protection:'business_uniqueness',maxAttempts:2,leaseSeconds:60,chunked:true,
    handle:async input=>{
      const refreshed=await refreshCallableRanks(repositoryContext(input.scope,input.session));
      return {progress:{refreshed},done:refreshed===0};
    }};
}
export function sourcingCallableRankSource(enabled:boolean):DueWorkSource {
  return {name:'sourcing-callable-rank',find:async(session,now)=>{
    if(!enabled)return [];
    const ids=await workspacesWithStaleCallableRanks(session,now);
    const minute=new Date(now).toISOString().slice(0,16);
    return ids.map((id):JobSpecification=>({workspaceId:id,kind:'sourcing.callable_rank',idempotencyKey:jobIdempotencyKey.sourcingCallableRank(id,minute),payload:{},maxAttempts:2}));
  }};
}
