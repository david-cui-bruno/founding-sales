import {z} from 'zod';
import type {JobHandler} from '@fss/domain/jobs/handlerRegistry.ts';
import {repositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {runSourceCheck} from '@fss/domain/sourcing/sourceCheck.ts';
import type {PageFetchProvider} from '@fss/domain/research/providers.ts';
const payloadSchema=z.object({candidateId:z.uuid(),checkId:z.uuid(),scheduled:z.boolean().optional()});
export function sourcingCheckHandler(pageFetch:PageFetchProvider):JobHandler {
 return {kind:'sourcing.check',protection:'business_uniqueness',maxAttempts:1,leaseSeconds:60,
  handle:async input=>{
   const parsed=payloadSchema.safeParse(input.job.payload);
   if(!parsed.success)throw new Error('Invalid source check identifiers');
   await runSourceCheck(repositoryContext(input.scope,input.session),parsed.data,pageFetch);
  }};
}
