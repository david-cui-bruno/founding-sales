import {z} from 'zod';
import {uuid} from './foundationRows.ts';
import {commandIdSchema} from './auth.ts';
import {semanticVersionSchema} from './clientVersion.ts';
import {mailSourceReadSchema} from './crmMail.ts';
const zone=z.string().min(1).max(100).refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}},'an IANA timezone');
/** Human confirmation is an explicit decision about a supported original, not an interpreter result or permission flag. */
export const bookingCreatePayloadSchema=z.strictObject({
 expectedPolicyRevision:z.number().int().positive(),
 attendeeRouteId:uuid,
 agreement:mailSourceReadSchema,
 offeredContext:mailSourceReadSchema.optional(),
 agreedSlot:z.strictObject({startsAt:z.iso.datetime({offset:true}),timeZone:zone}),
 confirmation:z.literal('owner_confirmed_unconditional_exact_slot'),
});
export const bookingCreateCommandSchema=bookingCreatePayloadSchema.extend({commandId:commandIdSchema,clientVersion:semanticVersionSchema});
export const bookingCreateInspectCommandSchema=z.strictObject({submissionId:uuid,commandId:commandIdSchema,clientVersion:semanticVersionSchema});
export const bookingCreateReceiptSchema=z.strictObject({submissionId:uuid,state:z.enum(['pending','accepted','failed','unknown']),providerBookingUid:z.string().nullable(),meetingId:uuid.nullable(),sourceState:z.enum(['current','redacted']),reason:z.string().nullable(),dispatchStartedAt:z.string().nullable()});
export type BookingCreatePayload=z.infer<typeof bookingCreatePayloadSchema>;
export type BookingCreateReceipt=z.infer<typeof bookingCreateReceiptSchema>;
