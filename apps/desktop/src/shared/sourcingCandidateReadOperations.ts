import {z} from 'zod';
import {candidateListInputSchema,candidateListSchema,discoveryIntakeListInputSchema,discoveryIntakeListSchema} from '@fss/contracts';
import type {Operation} from './operations.ts';

/** Candidate reads stay separate from research, admission and contact commands. */
export const sourcingCandidateReadOperations={
  'sourcing.list': {
    kind:'read',calls:[{method:'POST',path:'/sourcing/candidates/list'}],
    input:candidateListInputSchema,output:z.object({view:candidateListSchema.nullable(),reason:z.string().nullable()}),
    transform:'workspace-scoped candidate drafts; source evidence remains unverified',
  },
  'sourcing.discoveryList': {
    kind:'read',calls:[{method:'POST',path:'/sourcing/candidates/discovery/list-v1'}],
    input:discoveryIntakeListInputSchema,output:z.object({view:discoveryIntakeListSchema.nullable(),reason:z.string().nullable()}),
    transform:'Read retained raw discovery observations without research, admission or contact authority',
  },
} as const satisfies Readonly<Record<string,Operation>>;
