import {z} from 'zod';
import {instant,uuid} from './foundationRows.ts';
import {senderStandingSchema} from './outbound.ts';
/** Coded safety evidence. A retry deadline authorizes another observation only. */
export const providerIncidentSchema=z.strictObject({
 id:uuid,classification:z.enum(['transient','authentication','reputation','unknown']),
 reason:z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),state:z.enum(['waiting','revalidation_due','action_required']),
 retryAt:instant.nullable(),observedAt:instant,
 sourceKind:z.enum(['sent_search','token_refresh','mail_read','provider_send','admin_report']),
 sourceId:z.string().regex(/^[a-zA-Z0-9:_-]{1,160}$/),
});
export type ProviderIncidentView=z.infer<typeof providerIncidentSchema>;
export const outreachSenderStandingV2ResponseSchema=z.strictObject({
 senders:z.array(z.strictObject({mailboxId:uuid,standing:senderStandingSchema,incidents:z.array(providerIncidentSchema)})),
});
export type OutreachSenderStandingV2Response=z.infer<typeof outreachSenderStandingV2ResponseSchema>;
