import {z} from 'zod';
import {uuid} from './foundationRows.ts';
import {commandIdSchema} from './auth.ts';
import {semanticVersionSchema} from './clientVersion.ts';
import {mailSourceReadSchema} from './crmMail.ts';
import {bookingCreatePayloadSchema,bookingCreateReceiptSchema} from './bookingCreate.ts';
const common={expectedPolicyRevision:z.number().int().positive(),meetingId:uuid,expectedBookingUid:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),attendeeRouteId:uuid,agreement:mailSourceReadSchema};
/** An explicit human decision over the selected original and appointment, never an NLP permission flag. */
export const bookingChangePayloadSchema=z.discriminatedUnion('action',[
 z.strictObject({...common,action:z.literal('cancel'),confirmation:z.literal('owner_confirmed_attendee_cancellation')}),
 z.strictObject({...common,action:z.literal('reschedule'),offeredContext:mailSourceReadSchema.optional(),agreedSlot:bookingCreatePayloadSchema.shape.agreedSlot,confirmation:z.literal('owner_confirmed_attendee_unconditional_exact_slot')}),
]);
const command={commandId:commandIdSchema,clientVersion:semanticVersionSchema};
export const bookingChangeCommandSchema=z.discriminatedUnion('action',[bookingChangePayloadSchema.options[0].extend(command),bookingChangePayloadSchema.options[1].extend(command)]);
export const bookingChangeInspectCommandSchema=z.strictObject({submissionId:uuid,...command});
export const bookingChangeReceiptSchema=bookingCreateReceiptSchema.extend({action:z.enum(['reschedule','cancel']),targetBookingUid:z.string(),reminderState:z.enum(['unverified','replaced','stopped'])});
export type BookingChangePayload=z.infer<typeof bookingChangePayloadSchema>;
export type BookingChangeReceipt=z.infer<typeof bookingChangeReceiptSchema>;
