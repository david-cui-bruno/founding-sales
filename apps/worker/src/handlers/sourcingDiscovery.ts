import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import type {JobHandler} from '@fss/domain/jobs/handlerRegistry.ts';
import type {DiscoverySearchProvider} from '@fss/domain/sourcing/discoveryProvider.ts';
import {runDiscovery} from '@fss/domain/sourcing/discovery.ts';
import {readResearchSettings} from '@fss/domain/research/settings.ts';
import {listApplicableHolds} from '@fss/domain/policy/holds.ts';
import type {DueWorkSource} from '../scheduler/schedulerPass.ts';
export function sourcingDiscoveryHandler(provider:DiscoverySearchProvider):JobHandler {
 return {kind:'sourcing.discover',protection:'outbound_fence',maxAttempts:1,leaseSeconds:60,
  handle:async input=>{await runDiscovery(repositoryContext(input.scope,input.session),provider);}};
}
export function sourcingDiscoverySource(enabled:boolean):DueWorkSource {
 return {name:'sourcing-discovery',find:async(session,now)=>{
  if(!enabled)return [];
  const rows=(await session.query<{workspace_id:string}>(`SELECT s.workspace_id FROM sourcing_discovery_settings s LEFT JOIN research_settings r ON r.workspace_id=s.workspace_id WHERE s.enabled AND COALESCE(r.enabled,true) AND s.next_run_at<=$1::timestamptz AND NOT EXISTS (SELECT 1 FROM active_holds h WHERE h.workspace_id=s.workspace_id AND h.released_at IS NULL AND h.scope_kind='workspace' AND 'research'=ANY(h.blocked_action_kinds)) ORDER BY s.next_run_at,s.workspace_id LIMIT 25`,[now])).rows;
  const jobs=[];
  for(const row of rows){
   const ctx=repositoryContext(workspaceScope(row.workspace_id,{kind:'system',component:'scheduler'}),session);
   if(!(await readResearchSettings(ctx)).enabled||(await listApplicableHolds(ctx,{actionKind:'research'})).length)continue;
   jobs.push({workspaceId:row.workspace_id,kind:'sourcing.discover' as const,idempotencyKey:`sourcing-discover:${row.workspace_id}:${now.slice(0,10)}`,payload:{},maxAttempts:1});
  }
  return jobs;
 }};
}
