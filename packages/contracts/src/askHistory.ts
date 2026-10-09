import {z} from 'zod';
import {askAnswerStateSchema,askAnswerReasonSchema} from './askAnswers.ts';
import {commandIdSchema} from './auth.ts';
import {semanticVersionSchema} from './clientVersion.ts';

export const askHistoryCursorSchema=z.strictObject({pinned:z.boolean(),createdAt:z.iso.datetime(),requestId:z.uuid()});
export const askHistoryListSchema=z.strictObject({cursor:askHistoryCursorSchema.optional(),limit:z.number().int().min(1).max(50).default(20)});
export const askHistoryItemSchema=z.strictObject({requestId:z.uuid(),historyRevision:z.number().int().positive(),requestVersion:z.number().int().positive(),createdAt:z.iso.datetime(),updatedAt:z.iso.datetime(),title:z.string().trim().min(1).max(100).nullable(),pinned:z.boolean(),question:z.string().max(300).nullable(),state:askAnswerStateSchema,reason:askAnswerReasonSchema.nullable()});
export const askHistoryPageSchema=z.strictObject({items:z.array(askHistoryItemSchema).max(50),nextCursor:askHistoryCursorSchema.nullable()});
export type AskHistoryList=z.infer<typeof askHistoryListSchema>;
export const askHistoryChangePayloadSchema=z.strictObject({requestId:z.uuid(),expectedRevision:z.number().int().positive(),action:z.discriminatedUnion('kind',[z.strictObject({kind:z.literal('rename'),title:z.string().trim().min(1).max(100)}),z.strictObject({kind:z.literal('pin'),pinned:z.boolean()}),z.strictObject({kind:z.literal('delete')})])});
export const askHistoryChangeSchema=askHistoryChangePayloadSchema.extend({commandId:commandIdSchema,clientVersion:semanticVersionSchema}).strict();
export const askHistoryChangedSchema=z.strictObject({requestId:z.uuid(),historyRevision:z.number().int().positive(),requestVersion:z.number().int().positive(),state:askAnswerStateSchema});
export type AskHistoryChange=z.infer<typeof askHistoryChangeSchema>;
