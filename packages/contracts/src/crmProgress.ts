import {z} from 'zod';
import {canonicalSourceReferenceSchema} from './people.ts';
export const crmProgressReadSchema=z.strictObject({firmId:z.uuid().optional(),personId:z.uuid().optional(),limit:z.number().int().min(1).max(50).default(50)}).refine(value=>value.firmId!==undefined||value.personId!==undefined);
export const crmProgressEventSchema=z.strictObject({id:z.uuid(),kind:z.enum(['contacted','replied','booked','attended','opted_out']),occurredAt:z.iso.datetime(),firmIds:z.array(z.uuid()).max(100),personIds:z.array(z.uuid()).max(100),source:canonicalSourceReferenceSchema.nullable(),evidence:z.strictObject({kind:z.enum(['mail_source','meeting_booking','meeting_attendance','reply_opt_out']),id:z.uuid()})});
export const crmProgressResponseSchema=z.strictObject({version:z.literal(1),events:z.array(crmProgressEventSchema).max(50),truncated:z.boolean(),coverage:z.literal('partial')});
export type CrmProgressResponse=z.infer<typeof crmProgressResponseSchema>;
