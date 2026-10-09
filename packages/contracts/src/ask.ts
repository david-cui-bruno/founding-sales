import {z} from 'zod';
export const askScopeSchema=z.strictObject({firmId:z.uuid(),from:z.iso.datetime().optional(),to:z.iso.datetime().optional()}).refine(value=>value.from===undefined||value.to===undefined||Date.parse(value.from)<Date.parse(value.to));
const askOpportunitiesReadSchema=z.strictObject({operation:z.literal('opportunities'),scope:askScopeSchema,status:z.enum(['open','all']).default('open'),limit:z.number().int().min(1).max(50).default(20)});
export const askCoverageSchema=z.strictObject({scope:z.literal('current_permitted_crm_state'),acquisition:z.literal('unverified'),semantic:z.literal('not_requested')});
const askOpportunitiesResponseSchema=z.strictObject({operation:z.literal('opportunities'),scope:askScopeSchema,dateBasis:z.literal('opportunity_opened_at'),count:z.string().regex(/^(0|[1-9]\d*)$/u),records:z.array(z.strictObject({opportunityId:z.uuid(),firmId:z.uuid(),name:z.string().nullable(),status:z.enum(['open','won','lost']),stageKey:z.string(),openedAt:z.iso.datetime()})).max(50),truncated:z.boolean(),coverage:askCoverageSchema});

const askRecordsReadSchema=z.strictObject({operation:z.literal('records'),query:z.string().trim().min(1).max(160),kind:z.literal('people'),afterId:z.uuid().optional(),limit:z.number().int().min(1).max(50).default(20)});
export const askReadSchema=z.discriminatedUnion('operation',[askOpportunitiesReadSchema,askRecordsReadSchema]);
const askRecordsResponseSchema=z.strictObject({operation:z.literal('records'),selection:z.enum(['none','single','ambiguous']),records:z.array(z.strictObject({recordId:z.uuid(),kind:z.literal('person'),name:z.string(),firmId:z.uuid().nullable()})).max(50),nextAfterId:z.uuid().nullable(),scanComplete:z.boolean(),coverage:askCoverageSchema});
export const askResponseSchema=z.discriminatedUnion('operation',[askOpportunitiesResponseSchema,askRecordsResponseSchema]);
