import {z} from 'zod';
import {discoveryReviewInputSchema,discoveryReviewSavedSchema,discoveryUsefulListInputSchema,discoveryUsefulListSchema,uuid} from '@fss/contracts';
import type {Operation} from './operations.ts';
import {sourcingCandidateReadOperations} from './sourcingCandidateReadOperations.ts';

export const sourcingDiscoveryReviewOperations={
  'sourcing.discoveryUsefulList':{
    kind:'read',calls:[{method:'POST',path:'/sourcing/candidates/discovery/useful-list-v1'}],
    input:discoveryUsefulListInputSchema,output:z.object({view:discoveryUsefulListSchema.nullable(),reason:z.string().nullable()}),
    transform:'Read human service interpretations only, without fetching or qualification authority',
  },
  'sourcing.discoveryReview':{
    kind:'command',calls:[{method:'POST',path:'/sourcing/candidates/discovery/review-v1'}],
    input:discoveryReviewInputSchema.safeExtend({commandId:uuid}),output:z.object({result:discoveryReviewSavedSchema.nullable(),reason:z.string().nullable()}),
    transform:'Explicit bounded human review tied to the displayed candidate revision, no admission or contact',
  },
} as const satisfies Readonly<Record<string,Operation>>;

export const sourcingDiscoveryOperations={...sourcingCandidateReadOperations,...sourcingDiscoveryReviewOperations};
