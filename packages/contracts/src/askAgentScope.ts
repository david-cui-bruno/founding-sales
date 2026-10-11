import {z} from 'zod';
import {askCopiedSourceSchema} from './ask.ts';
const dates={from:z.iso.datetime().optional(),to:z.iso.datetime().optional()};
export const askAgentScopeSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('business'),...dates}),
 z.strictObject({kind:z.literal('firm'),firmId:z.uuid(),...dates}),
 z.strictObject({kind:z.literal('person'),personId:z.uuid(),...dates}),
 z.strictObject({kind:z.literal('selected'),sources:z.array(askCopiedSourceSchema).min(1).max(10),...dates}),
]).refine(s=>s.from===undefined||s.to===undefined||Date.parse(s.from)<Date.parse(s.to));
export type AskAgentScope=z.infer<typeof askAgentScopeSchema>;
