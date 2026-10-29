import {z} from 'zod';
import {instant,uuid} from './foundationRows.ts';

export const socialPublishingReadinessInputSchema=z.strictObject({});
export const socialPublishingReadinessHoldSchema=z.enum([
 'adapter_unavailable','current_account_unverified','current_publication_policy_unavailable','unsupported_route',
]);
export type SocialPublishingReadinessHold=z.infer<typeof socialPublishingReadinessHoldSchema>;
const holds=z.array(socialPublishingReadinessHoldSchema).min(1).max(4)
 .refine(value=>new Set(value).size===value.length,'Duplicate readiness hold');
const account=z.strictObject({
 accountId:uuid,revision:z.number().int().positive(),platform:z.enum(['linkedin','facebook','x']),
 accountKind:z.enum(['profile','page']),displayName:z.string().min(1).max(200),
 historicalState:z.enum(['connected','reconnect','unsupported','disconnected']),
 currentAccountVerified:z.literal(false),holds,
});
/** Metadata observation only. Historical account stamps cannot activate a runner. */
export const socialPublishingReadinessSchema=z.strictObject({
 observedAt:instant,runnerAvailable:z.literal(false),publishingActivated:z.literal(false),holds,
 accounts:z.array(account).max(30),
});
export type SocialPublishingReadiness=z.infer<typeof socialPublishingReadinessSchema>;
