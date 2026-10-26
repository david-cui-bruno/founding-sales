import {z} from 'zod';
import {commandIdSchema} from './auth.ts';
import {semanticVersionSchema} from './clientVersion.ts';
import {instant,uuid} from './foundationRows.ts';
import {manualProspectPhoneEvidenceSchema} from './manualProspects.ts';

/** Explicit bounded public-page capture, not qualification, admission or outreach. */
export const PROSPECT_PHONE_DISCOVERY_VERSION='company-public-phone-v1' as const;
export const PROSPECT_PHONE_DISCOVERY_PATHS=[
 '/sourcing/candidates/phone-discovery/request',
 '/sourcing/candidates/phone-discovery/read',
 '/sourcing/candidates/phone-discovery/receipt',
] as const;
export const prospectPhoneDiscoveryInputSchema=z.strictObject({candidateId:uuid,expectedRevision:z.number().int().positive()});
export const prospectPhoneDiscoveryCommandSchema=prospectPhoneDiscoveryInputSchema.extend({commandId:commandIdSchema,clientVersion:semanticVersionSchema});
export const prospectPhoneDiscoveryStateSchema=z.enum(['pending','running','complete','unavailable']);
export const prospectPhoneDiscoveryReasonSchema=z.enum([
 'candidate_unavailable','candidate_changed','source_unavailable','source_not_permitted','source_changed',
 'source_expired','official_site_unknown','retained_only','research_disabled','research_held','daily_firm_ceiling',
 'authority_changed','discovery_interrupted','discovery_expired','no_readable_text','bounded_capture_incomplete',
]);
export const prospectPhoneDiscoveryQueuedSchema=z.strictObject({runId:uuid});
export const prospectPhoneDiscoveryViewSchema=z.strictObject({
 runId:uuid,candidateId:uuid,candidateRevision:z.number().int().positive(),
 state:prospectPhoneDiscoveryStateSchema,reason:prospectPhoneDiscoveryReasonSchema.nullable(),
 requestedAt:instant,checkedAt:instant.nullable(),expiresAt:instant,
 method:z.literal(PROSPECT_PHONE_DISCOVERY_VERSION),
 phoneEvidence:manualProspectPhoneEvidenceSchema,
 website:z.string().max(2000).nullable(),
 channelAuthority:z.literal('not_granted'),
});
export const prospectPhoneDiscoveryReceiptInputSchema=z.strictObject({commandId:commandIdSchema,payloadHash:z.string().regex(/^[a-f0-9]{64}$/u)});
export const prospectPhoneDiscoveryReceiptSchema=z.discriminatedUnion('state',[
 z.strictObject({state:z.literal('unknown')}),
 z.strictObject({state:z.literal('accepted'),result:prospectPhoneDiscoveryQueuedSchema}),
 z.strictObject({state:z.literal('refused')}),
]);
export type ProspectPhoneDiscoveryInput=z.infer<typeof prospectPhoneDiscoveryInputSchema>;
export type ProspectPhoneDiscoveryView=z.infer<typeof prospectPhoneDiscoveryViewSchema>;
export type ProspectPhoneDiscoveryReason=z.infer<typeof prospectPhoneDiscoveryReasonSchema>;
