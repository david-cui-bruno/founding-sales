import {z} from 'zod';
import {commandIdSchema} from './auth.ts';
import {semanticVersionSchema} from './clientVersion.ts';
import {crmCommitmentDueSchema} from './crmCommitments.ts';
import {canonicalSourceReferenceSchema} from './people.ts';

export const askActionTargetSchema=z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('firm'),firmId:z.uuid()}),z.strictObject({kind:z.literal('person'),personId:z.uuid()})]);
export const askActionFindingSchema=z.strictObject({kind:z.enum(['keyword_passage','answer_claim']),index:z.number().int().min(0).max(19)});
export const askManualActionSchema=z.discriminatedUnion('kind',[
 z.strictObject({kind:z.literal('task'),label:z.string().trim().min(1).max(300),due:crmCommitmentDueSchema,target:askActionTargetSchema}),
 z.strictObject({kind:z.literal('note'),text:z.string().trim().min(1).max(2000),target:askActionTargetSchema}),
 z.strictObject({kind:z.literal('preference'),text:z.string().trim().min(1).max(2000)}),
]);
export const askActionCreatePayloadSchema=z.strictObject({requestId:z.uuid(),expectedVersion:z.number().int().positive(),finding:askActionFindingSchema,action:askManualActionSchema});
export const askActionCreateSchema=askActionCreatePayloadSchema.extend({commandId:commandIdSchema,clientVersion:semanticVersionSchema}).strict();
export const askActionAcknowledgmentSchema=z.strictObject({actionId:z.uuid(),version:z.number().int().positive(),kind:z.enum(['task','note','preference'])});
export const askActionReadSchema=z.strictObject({scope:z.discriminatedUnion('kind',[askActionTargetSchema.options[0],askActionTargetSchema.options[1],z.strictObject({kind:z.literal('today')}),z.strictObject({kind:z.literal('history')})]),afterId:z.uuid().optional(),limit:z.number().int().min(1).max(50).default(20)});
export const askActionItemSchema=z.strictObject({actionId:z.uuid(),version:z.number().int().positive(),kind:z.enum(['task','note','preference']),status:z.enum(['active','open','done','cancelled','proposed','dismissed']),provenance:z.literal('human'),createdAt:z.iso.datetime(),updatedAt:z.iso.datetime(),completedAt:z.iso.datetime().nullable(),target:askActionTargetSchema.nullable(),label:z.string().max(300).nullable(),text:z.string().max(2000).nullable(),due:crmCommitmentDueSchema,reviewRequired:z.boolean(),supportState:z.enum(['current','stale','unavailable','deleted']),sources:z.array(canonicalSourceReferenceSchema).max(10)}).refine(value=>value.supportState==='current'||(value.label===null&&value.text===null&&value.due===null&&value.target===null&&value.sources.length===0),'Unavailable manual actions expose only source-free facts');
export const askActionPageSchema=z.strictObject({items:z.array(askActionItemSchema).max(50),nextAfterId:z.uuid().nullable()});
export const askActionChangePayloadSchema=z.strictObject({actionId:z.uuid(),expectedVersion:z.number().int().positive(),action:z.enum(['complete_task','cancel_task','dismiss_preference'])});
export const askActionChangeSchema=askActionChangePayloadSchema.extend({commandId:commandIdSchema,clientVersion:semanticVersionSchema}).strict();
export const askActionChangedSchema=z.strictObject({actionId:z.uuid(),version:z.number().int().positive(),status:z.enum(['done','cancelled','dismissed']),completedAt:z.iso.datetime().nullable()});
export type AskActionCreate=z.infer<typeof askActionCreateSchema>;
export type AskActionRead=z.infer<typeof askActionReadSchema>;
export type AskActionChange=z.infer<typeof askActionChangeSchema>;
