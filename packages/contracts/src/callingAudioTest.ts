import {z} from 'zod';
import {commandIdSchema} from './auth.ts';
import {semanticVersionSchema} from './clientVersion.ts';
import {instant,uuid} from './foundationRows.ts';
import {callingExecutionStatusSchema} from './callingExecution.ts';

/** A manual audio test has its own recipient; it creates no business relationship. */
export const createAudioTestSessionCommandSchema=z.strictObject({
 commandId:commandIdSchema,clientVersion:semanticVersionSchema,
 e164:z.string().regex(/^\+1[2-9][0-9]{2}[2-9][0-9]{6}$/u),callingIdentityId:uuid,
});
export const audioTestExecutionReceiptInputSchema=z.strictObject({
 commandId:commandIdSchema,payloadSHA256:z.string().regex(/^[a-f0-9]{64}$/u),
});
export const audioTestExecutionReceiptSchema=z.discriminatedUnion('state',[
 z.strictObject({state:z.literal('unknown')}),
 z.strictObject({state:z.literal('refused')}),
 z.strictObject({state:z.literal('accepted'),sessionId:uuid,expiresAt:instant,
  status:callingExecutionStatusSchema,canReconnect:z.literal(false)}),
]);
export type CreateAudioTestSessionCommand=z.infer<typeof createAudioTestSessionCommandSchema>;
export type AudioTestExecutionReceiptInput=z.infer<typeof audioTestExecutionReceiptInputSchema>;
export type AudioTestExecutionReceipt=z.infer<typeof audioTestExecutionReceiptSchema>;
