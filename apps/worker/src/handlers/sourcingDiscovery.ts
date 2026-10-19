import {runApolloDiscovery} from '@fss/domain/sourcing/apolloDiscovery.ts';
import type {ApolloDiscoveryDependencies,ApolloBinding} from '@fss/domain/sourcing/apolloAllowance.ts';
import type {JobSpecification} from '@fss/domain/jobs/jobStore.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import type {JobHandler} from '@fss/domain/jobs/handlerRegistry.ts';
import type {DiscoverySearchProvider} from '@fss/domain/sourcing/discoveryProvider.ts';
import {runDiscovery} from '@fss/domain/sourcing/discovery.ts';
import {readResearchSettings} from '@fss/domain/research/settings.ts';
import {listApplicableHolds} from '@fss/domain/policy/holds.ts';
import type {DueWorkSource} from '../scheduler/schedulerPass.ts';
export function sourcingDiscoveryHandler(provider:DiscoverySearchProvider|undefined,apollo?:ApolloDiscoveryDependencies):JobHandler {
 return {kind:'sourcing.discover',protection:'outbound_fence',maxAttempts:1,leaseSeconds:60,
  handle:async input=>{
   const ctx=repositoryContext(input.scope,input.session);
   if(input.job.payload['provider']==='apollo_free'){if(apollo)await runApolloDiscovery(ctx,apollo);return;}
   if(provider)await runDiscovery(ctx,provider);
  }};
}
export function sourcingDiscoverySource(enabled:boolean):DueWorkSource {
 return {name:'sourcing-discovery',find:async(session,now)=>{
  if(!enabled)return [];
  const rows=(await session.query<{workspace_id:string}>(`SELECT s.workspace_id FROM sourcing_discovery_settings s LEFT JOIN research_settings r ON r.workspace_id=s.workspace_id WHERE s.enabled AND COALESCE(r.enabled,true) AND s.next_run_at<=$1::timestamptz AND NOT EXISTS (SELECT 1 FROM active_holds h WHERE h.workspace_id=s.workspace_id AND h.released_at IS NULL AND (h.scope_kind='workspace' OR (h.scope_kind='channel' AND h.scope_key='research')) AND 'research'=ANY(h.blocked_action_kinds)) ORDER BY s.next_run_at,s.workspace_id LIMIT 25`,[now])).rows;
  const jobs=[];
  for(const row of rows){
   const ctx=repositoryContext(workspaceScope(row.workspace_id,{kind:'system',component:'scheduler'}),session);
   if(!(await readResearchSettings(ctx)).enabled||(await listApplicableHolds(ctx,{actionKind:'research',channel:'research'})).length)continue;
   // Reconsider deferred work hourly. Durable daily slots and next_run_at pace dispatch;
   // the default one slot preserves the original one-search-per-day fence.
   jobs.push({workspaceId:row.workspace_id,kind:'sourcing.discover' as const,idempotencyKey:`sourcing-discover:${row.workspace_id}:${now.slice(0,13)}`,payload:{},maxAttempts:1});
  }
  return jobs;
 }};
}

/** No account/key binding means no jobs. Runtime repeats every authority/clock
 * check under locks before dispatch, independent of this advisory scheduling read.
 */
export function apolloDiscoverySource(binding?:ApolloBinding):DueWorkSource {
 return {name:'apollo-discovery',find:async(session,now)=>{
  if(!binding)return [];
  const rows=(await session.query<{workspace_id:string;id:string}>(`SELECT workspace_id,id FROM sourcing_apollo_allowances
   WHERE account_ref=$1 AND key_ref=$2 AND enabled AND NOT halted AND starting_used+reserved<75
   AND cycle_start<=clock_timestamp() AND clock_timestamp()<cycle_end AND verified_at<=clock_timestamp() AND exclusive_attested_at<=clock_timestamp()
   AND next_run_at<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM sourcing_apollo_attempts a WHERE a.allowance_id=sourcing_apollo_allowances.id AND a.region='MA' AND a.state='complete' AND a.returned_count<100) ORDER BY next_run_at,id LIMIT 25`,[binding.accountRef,binding.keyRef])).rows;
  const jobs:JobSpecification[]=[];
  for(const row of rows){
   const ctx=repositoryContext(workspaceScope(row.workspace_id,{kind:'system',component:'scheduler'}),session);
   if(!(await readResearchSettings(ctx)).enabled||(await listApplicableHolds(ctx,{actionKind:'research',channel:'research'})).length)continue;
   jobs.push({workspaceId:row.workspace_id,kind:'sourcing.discover',idempotencyKey:`apollo-discover:${row.id}:${now.slice(0,13)}`,payload:{provider:'apollo_free'},maxAttempts:1});
  }
  return jobs;
 }};
}
