import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
import { crmInputTokenPriceMicrosSchema, crmTokenPriceMicrosSchema } from './crmPricing.ts';
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const name = z.string().trim().min(1).max(200);
const revision = z.number().int().positive().max(2147483647);
export const askAgentLimitsSchema=z.strictObject({maxSteps:z.number().int().min(1).max(32),maxInputBytes:z.number().int().min(1).max(1000000),maxOutputTokens:z.number().int().min(1).max(4096),deadlineMs:z.number().int().min(1).max(60000)});
export const crmCapabilitySchema = z.enum(['metadata_review','mail_capture','mail_backfill','crm_extraction','ask_answer']);
const common = { workspaceId:z.uuid(), ownerUserId:z.uuid(), revision };
const mailbox = { mailboxId:z.uuid(), providerAccountId:name, generation:revision, accountBinding:hash };
const prices = { dailyCeilingCents:z.number().int().min(1).max(100000), monthlyCeilingCents:z.number().int().min(1).max(1000000),inputTokenPriceMicros:crmInputTokenPriceMicrosSchema,outputTokenPriceMicros:crmTokenPriceMicrosSchema };
const route = { endpointId:z.string().min(1).max(100),modelVersion:name,accessGrantVersion:name,dataHandlingVersion:name };
export const crmCapabilityConfigurationSchema = z.discriminatedUnion('capability',[
 z.strictObject({...common,...mailbox,capability:z.literal('metadata_review'),disclosureVersion:name,disclosureSha256:hash,scopeDays:z.literal(90)}),
 z.strictObject({...common,...mailbox,capability:z.literal('mail_capture'),policyRevision:revision,disclosureVersion:name,disclosureSha256:hash,grantReceipt:name.nullable(),providerPolicyReceipt:name.nullable(),evaluationReceipt:name.nullable(),releaseReceipt:name.nullable(),captureVersion:name}),
 z.strictObject({...common,...mailbox,capability:z.literal('mail_backfill'),scopeFingerprint:hash,allocationFingerprint:hash}),
 z.strictObject({...common,...route,...prices,capability:z.literal('crm_extraction'),processorVersion:name}),
 z.strictObject({...common,...route,...prices,capability:z.literal('ask_answer'),purpose:z.enum(['answer','embedding']),agentLimits:askAgentLimitsSchema.optional(),embeddingDimensions:z.union([z.literal(256),z.literal(512),z.literal(1024)]).optional(),evaluationFingerprint:hash,processorVersion:name,retrievalVersion:name,answerVersion:name,supportVersion:name,chunkerVersion:name}),
]);
export type CrmCapabilityConfiguration=z.infer<typeof crmCapabilityConfigurationSchema>;
export const crmCapabilityAuthorityReceiptSchema=z.strictObject({
 id:z.uuid(),configuration:crmCapabilityConfigurationSchema,configurationFingerprint:hash,
 reviewedBy:z.uuid(),reviewReference:name,verifiedAt:z.iso.datetime(),validUntil:z.iso.datetime(),
 proof:z.strictObject({evaluationKind:z.enum(['actual_acceptance','actual_representative','diagnostic','controlled_fixture']),evaluationFingerprint:hash,evaluationConfigurationFingerprint:hash,evaluationReference:name,accessGrantReference:name,dataHandlingReference:name,providerAcceptanceReference:name,deletionAcceptanceReference:name,fundingReference:name.nullable(),oauthGrantObservationId:z.uuid().nullable(),
 release:z.strictObject({reference:name,implementationCommit:z.string().regex(/^[a-f0-9]{40}$/u),apiImageDigest:z.string().regex(/^sha256:[a-f0-9]{64}$/u),workerImageDigest:z.string().regex(/^sha256:[a-f0-9]{64}$/u),schemaVersion:revision,nativeAcceptanceReference:name}),
 }),
}).refine(value=>Date.parse(value.validUntil)>Date.parse(value.verifiedAt),{message:'Receipt expiry must follow verification'});
export type CrmCapabilityAuthorityReceipt=z.infer<typeof crmCapabilityAuthorityReceiptSchema>;
const command={commandId:commandIdSchema,clientVersion:semanticVersionSchema};
const target={capability:crmCapabilitySchema,purpose:z.enum(['answer','embedding']).optional(),mailboxId:z.uuid().optional(),expectedRevision:z.number().int().nonnegative()};
export const crmOwnerApprovalSchema=z.strictObject({consentAcknowledged:z.literal(true),qualityTier:z.enum(['acquisition','provisional_owner','representative']),criticalControlsPassed:z.literal(true).optional(),modelIntegrationVerified:z.literal(true).optional(),reviewedEvaluationReference:name.optional(),limitations:z.array(z.enum(['representative_quality_unverified','limited_business_examples','vector_quality_unverified'])).max(3).default([])});
export type CrmOwnerApproval=z.infer<typeof crmOwnerApprovalSchema>;
export const crmCapabilityActivateSchema=z.strictObject({...command,...target,approval:crmOwnerApprovalSchema});
export const crmCapabilityDisableSchema=z.strictObject({...command,...target});
export const crmCapabilityReadSchema=z.strictObject({capability:crmCapabilitySchema,purpose:z.enum(['answer','embedding']).optional(),mailboxId:z.uuid().optional()});
export const crmCapabilityReadResponseSchema=z.strictObject({capability:crmCapabilitySchema,mailboxId:z.uuid().nullable(),configured:z.boolean(),revision:z.number().int().nonnegative(),enabled:z.boolean(),ready:z.boolean(),reason:z.string().max(100),authorityReceiptId:z.uuid().nullable(),ownerApprovalId:z.uuid().nullable(),qualityTier:z.enum(['acquisition','provisional_owner','representative']).nullable(),limitations:z.array(z.string().max(100)),proposedRevision:revision,proposedConfigurationFingerprint:hash.nullable(),configuration:crmCapabilityConfigurationSchema.nullable()});
export const crmMailCaptureControlsSaveSchema=z.strictObject({...command,mailboxId:z.uuid(),expectedRevision:z.number().int().nonnegative(),expectedGeneration:revision,expectedAccountBinding:hash,policyRevision:revision,disclosureVersion:name,disclosureSha256:hash,grantReceipt:name.nullable().optional(),providerPolicyReceipt:name.nullable().optional(),evaluationReceipt:name.nullable().optional(),releaseReceipt:name.nullable().optional()});
export const crmAskPurposeSaveSchema=z.strictObject({...command,expectedRevision:z.number().int().nonnegative(),purpose:z.enum(['answer','embedding','support']),agentLimits:askAgentLimitsSchema.optional(),embeddingDimensions:z.union([z.literal(256),z.literal(512),z.literal(1024)]).optional(),enabled:z.boolean(),...route,...prices,evaluationFingerprint:hash,processorVersion:name,retrievalVersion:name,answerVersion:name,supportVersion:name,chunkerVersion:name});

export const CRM_MAIL_CAPTURE_CONSENT=Object.freeze({version:'crm-mail-body-acquisition-v1',sha256:'b013f8734b3dd70852d65271c5ac01cd1f8934d62e90417ea1e7c5652d46c3a6',text:'Callie may retain approved business email bodies, including incoming messages and original Sent replies, under the selected owner/account policy. Personal and excluded mail is not automatically copied. Disconnect stops acquisition but preserves approved copies; explicit deletion erases copied content and dependent evidence without deleting Gmail originals. Historical import is bounded and reports incomplete coverage. Hosted AI requires separate purpose, data handling, evaluation and budget approval. This consent does not authorize sending.'});
