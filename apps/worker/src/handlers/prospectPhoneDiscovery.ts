import {uuid} from '@fss/contracts';
import type {JobHandler} from '@fss/domain/jobs/handlerRegistry.ts';
import {repositoryContext} from '@fss/domain/db/workspaceScope.ts';
import type {PageFetchProvider} from '@fss/domain/research/providers.ts';
import {runProspectPhoneDiscovery} from '@fss/domain/sourcing/prospectPhoneDiscovery.ts';

/** The domain owns claim, continuation fences and commits. No qualification,
 * evaluation, admission, publication or model dependency belongs on this path. */
export function prospectPhoneDiscoveryHandler(deps:{pageFetch:PageFetchProvider}):JobHandler {
 return {kind:'sourcing.phone_discover',protection:'outbound_fence',maxAttempts:1,leaseSeconds:180,
  handle:async input=>{
   const runId=uuid.safeParse(input.job.payload['runId']);
   if(!runId.success)return;
   await runProspectPhoneDiscovery(repositoryContext(input.scope,input.session),{runId:runId.data},{pageFetch:deps.pageFetch});
  }};
}
