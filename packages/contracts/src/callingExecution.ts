import {z} from 'zod';
import {commandIdSchema} from './auth.ts';
import {CALL_SESSION_STATUSES} from './callSessions.ts';
import {instant,uuid} from './foundationRows.ts';

/** Reconcile one exact create_call_session command. Never mint a session or token. */
export const callingExecutionReceiptInputSchema=z.strictObject({
 firmId:uuid,commandId:commandIdSchema,payloadSHA256:z.string().regex(/^[a-f0-9]{64}$/u),
});
/** Current server observation, not a permission to reconnect. expired_unconsumed
 * requires a locked, expired session with no consumption, never a client timer.
 * unavailable retains uncertainty. A cost settlement is not call termination. */
export const callingExecutionStatusSchema=z.enum([...CALL_SESSION_STATUSES,'expired_unconsumed','unavailable']);
export const callingExecutionReceiptSchema=z.discriminatedUnion('state',[
 z.strictObject({state:z.literal('unknown')}),
 z.strictObject({state:z.literal('refused')}),
 z.strictObject({state:z.literal('accepted'),firmId:uuid,sessionId:uuid,expiresAt:instant,
  status:callingExecutionStatusSchema,canReconnect:z.literal(false)}),
]);
export type CallingExecutionReceiptInput=z.infer<typeof callingExecutionReceiptInputSchema>;
export type CallingExecutionReceipt=z.infer<typeof callingExecutionReceiptSchema>;
