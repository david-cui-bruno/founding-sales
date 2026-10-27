import {uuid} from '@fss/contracts';
import type {JobHandler} from '@fss/domain/jobs/handlerRegistry.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import type {PageFetchProvider} from '@fss/domain/research/providers.ts';
import {runProspectPhoneDiscovery,expireProspectPhoneDiscoveryInTransaction} from '@fss/domain/sourcing/prospectPhoneDiscovery.ts';
import type {DueWorkSource} from '../scheduler/schedulerPass.ts';
import type {Logger} from '../bootstrap/log.ts';

/** The domain owns claim, continuation fences and commits. No qualification,
 * evaluation, admission, publication or model dependency belongs on this path. */
export function prospectPhoneDiscoveryHandler(deps:{pageFetch:PageFetchProvider;log?:Logger}):JobHandler {
 return {kind:'sourcing.phone_discover',protection:'outbound_fence',maxAttempts:1,leaseSeconds:180,
  handle:async input=>{
   const runId=uuid.safeParse(input.job.payload['runId']);
   if(!runId.success)return;
   const diagnostic=await runProspectPhoneDiscovery(repositoryContext(input.scope,input.session),{runId:runId.data},{pageFetch:deps.pageFetch});
   // Emitted only after domain finalization. Logging must not turn a completed
   // one-attempt capture into a failed job, and never receives source/error text.
   if(diagnostic&&deps.log)try{
    deps.log.log('warn','phone_discovery_source_unavailable',{run_id:runId.data,branch:diagnostic.branch,stage:diagnostic.stage,page_count:diagnostic.pages,
     ...Object.fromEntries(Object.entries(diagnostic.skipped).map(([key,count])=>[`skip_${key}`,count]))});
   }catch{ /* Diagnostic sink failure cannot change capture custody. */ }
  }};
}

/** Scheduler owns the transaction. Terminalize interrupted runs without ever
 * enqueueing capture, refreshing authority, or waiting for physical retention. */
export function prospectPhoneDiscoverySource():DueWorkSource {
 return {name:'prospect-phone-discovery-expiry',find:async(session,now)=>{
  const workspaces=(await session.query<{workspace_id:string}>(`SELECT DISTINCT workspace_id FROM sourcing_prospect_phone_discoveries
   WHERE state IN ('pending','running') AND (deadline_at<=$1 OR expires_at<=$1)
   ORDER BY workspace_id LIMIT 25`,[now])).rows;
  for(const workspace of [...workspaces].sort((a,b)=>a.workspace_id.localeCompare(b.workspace_id))){
   const ctx=repositoryContext(workspaceScope(workspace.workspace_id,{kind:'system',component:'scheduler'}),session);
   await expireProspectPhoneDiscoveryInTransaction(ctx);
  }
  return [];
 }};
}
