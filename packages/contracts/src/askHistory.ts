import {z} from 'zod';
import {askAnswerStateSchema,askAnswerReasonSchema} from './askAnswers.ts';

export const askHistoryCursorSchema=z.strictObject({pinned:z.boolean(),createdAt:z.iso.datetime(),requestId:z.uuid()});
export const askHistoryListSchema=z.strictObject({cursor:askHistoryCursorSchema.optional(),limit:z.number().int().min(1).max(50).default(20)});
export const askHistoryItemSchema=z.strictObject({requestId:z.uuid(),historyRevision:z.number().int().positive(),requestVersion:z.number().int().positive(),createdAt:z.iso.datetime(),updatedAt:z.iso.datetime(),title:z.string().trim().min(1).max(100).nullable(),pinned:z.boolean(),question:z.string().max(300).nullable(),state:askAnswerStateSchema,reason:askAnswerReasonSchema.nullable()});
export const askHistoryPageSchema=z.strictObject({items:z.array(askHistoryItemSchema).max(50),nextCursor:askHistoryCursorSchema.nullable()});
export type AskHistoryList=z.infer<typeof askHistoryListSchema>;
