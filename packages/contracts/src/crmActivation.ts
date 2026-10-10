import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
import { crmInputTokenPriceMicrosSchema, crmTokenPriceMicrosSchema } from './crmPricing.ts';
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const name = z.string().trim().min(1).max(200);
const revision = z.number().int().positive().max(2147483647);
export const crmCapabilitySchema = z.enum(['metadata_review','mail_capture','mail_backfill','crm_extraction','ask_answer']);
const common = { workspaceId:z.uuid(), ownerUserId:z.uuid(), revision };
const mailbox = { mailboxId:z.uuid(), providerAccountId:name, generation:revision, accountBinding:hash };
const prices = { dailyCeilingCents:z.number().int().min(1).max(100000), monthlyCeilingCents:z.number().int().min(1).max(1000000),inputTokenPriceMicros:crmInputTokenPriceMicrosSchema,outputTokenPriceMicros:crmTokenPriceMicrosSchema };
const route = { endpointId:z.string().min(1).max(100),modelVersion:name,accessGrantVersion:name,dataHandlingVersion:name };
export const crmCapabilityConfigurationSchema = z.discriminatedUnion('capability',[
 z.strictObject({...common,...mailbox,capability:z.literal('metadata_review'),disclosureVersion:name,disclosureSha256:hash,scopeDays:z.literal(90)}),
 z.strictObject({...common,...mailbox,capability:z.literal('mail_capture'),policyRevision:revision,disclosureVersion:name,disclosureSha256:hash,grantReceipt:name,providerPolicyReceipt:name,evaluationReceipt:name,releaseReceipt:name,captureVersion:name}),
 z.strictObject({...common,...mailbox,capability:z.literal('mail_backfill'),scopeFingerprint:hash,allocationFingerprint:hash}),
 z.strictObject({...common,...route,...prices,capability:z.literal('crm_extraction'),processorVersion:name}),
 z.strictObject({...common,...route,...prices,capability:z.literal('ask_answer'),purpose:z.literal('answer'),evaluationFingerprint:hash,processorVersion:name,retrievalVersion:name,answerVersion:name,supportVersion:name,chunkerVersion:name}),
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
const target={capability:crmCapabilitySchema,mailboxId:z.uuid().optional(),expectedRevision:z.number().int().nonnegative()};
export const crmCapabilityActivateSchema=z.strictObject({...command,...target,authorityReceiptId:z.uuid()});
export const crmCapabilityDisableSchema=z.strictObject({...command,...target});
export const crmCapabilityReadSchema=z.strictObject({capability:crmCapabilitySchema,mailboxId:z.uuid().optional()});
export const crmCapabilityReadResponseSchema=z.strictObject({capability:crmCapabilitySchema,mailboxId:z.uuid().nullable(),configured:z.boolean(),revision:z.number().int().nonnegative(),enabled:z.boolean(),ready:z.boolean(),reason:z.string().max(100),authorityReceiptId:z.uuid().nullable(),proposedRevision:revision,proposedConfigurationFingerprint:hash.nullable(),configuration:crmCapabilityConfigurationSchema.nullable()});
export const crmMailCaptureControlsSaveSchema=z.strictObject({...command,mailboxId:z.uuid(),expectedRevision:z.number().int().nonnegative(),expectedGeneration:revision,expectedAccountBinding:hash,policyRevision:revision,disclosureVersion:name,disclosureSha256:hash,grantReceipt:name,providerPolicyReceipt:name,evaluationReceipt:name,releaseReceipt:name});
export const crmAskPurposeSaveSchema=z.strictObject({...command,expectedRevision:z.number().int().nonnegative(),purpose:z.enum(['answer','embedding','support']),enabled:z.boolean(),...route,...prices,evaluationFingerprint:hash,processorVersion:name,retrievalVersion:name,answerVersion:name,supportVersion:name,chunkerVersion:name});
