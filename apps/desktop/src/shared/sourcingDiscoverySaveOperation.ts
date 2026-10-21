import {z} from 'zod';
import {commandIdSchema,discoveryIntakeSaveInputSchema,discoveryIntakeSavedSchema} from '@fss/contracts';
import type {Operation} from './operations.ts';

/** One explicit raw-observation save through the existing authenticated API. */
export const sourcingDiscoverySaveOperation={
  'sourcing.discoverySave':{
    kind:'command',calls:[{method:'POST',path:'/sourcing/candidates/discovery/save-v1'}],
    input:discoveryIntakeSaveInputSchema.safeExtend({commandId:commandIdSchema}),
    output:z.object({result:discoveryIntakeSavedSchema.nullable(),reason:z.string().nullable()}),
    transform:'Explicitly retain unverified discovery provenance, without fetching, qualification, admission or contact',
  },
} as const satisfies Readonly<Record<string,Operation>>;
