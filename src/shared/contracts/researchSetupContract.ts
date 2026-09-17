import { z } from 'zod';
import { accountIdSchema as id, accountInstantSchema as instant } from './accountContract';
import { audienceQuerySchema, discoveryProviderSchema, researchCapabilitySchema, researchLimitsSchema, PLACES_MAX_COMPANIES } from '../../main/research/companyResearchTypes';
import { ownerResearchSourceSchema } from './ownerCommandContract';
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** Google Places API (New) Text Search, Enterprise SKU: the reviewed cost per call can never be below this ceiling, in micros of USD. */
export const PLACES_SEARCH_COST_MICROS = 35000;
export const researchReviewedCapabilitySchema = z.strictObject({ capability: researchCapabilitySchema, reviewedAt: instant, expiresAt: instant, provenance: z.string().trim().min(1).max(500), researchReservationMicros: researchLimitsSchema.shape.maxCostMicros, currency: z.literal('USD'),
  /** Operator-reviewed cost reserved before every Places text-search call. Required only when the provider is `places`. */
  placesSearchCostMicros: researchLimitsSchema.shape.maxCostMicros.min(PLACES_SEARCH_COST_MICROS).optional() }).refine(v => Date.parse(v.reviewedAt) < Date.parse(v.expiresAt) && v.capability.searchCostMicros + v.capability.modelCostMicros <= 20000000, 'invalid_review');
export type ResearchReviewedCapability = z.infer<typeof researchReviewedCapabilitySchema>;
/** `discoveryProvider` absent means the cited web search exactly as before: sources required, up to 50 companies. Places needs no hand-typed sources and takes one page (<=20) per batch.
 *  `expectedRevision` 0 approves a first-use policy on an empty workspace; a positive value replaces the stored configuration at exactly that revision,
 *  keeping spent budget and the admission fence and changing only what the worker discovers next. */
export const researchSetupApproveInputSchema = z.strictObject({ expectedRevision: integer, descriptorFingerprint: hash, audience: audienceQuerySchema, permittedSources: z.array(z.url().max(2048)).max(500), maxCompanies: researchLimitsSchema.shape.maxCompanies, maxPages: researchLimitsSchema.shape.maxPages, maxBytes: researchLimitsSchema.shape.maxBytes, discoveryCeilingMicros: integer.positive(), researchCeilingMicros: integer.positive(), disclosureAcknowledged: z.literal(true), discoveryProvider: discoveryProviderSchema.optional() })
  .refine(v => Number.isSafeInteger(v.discoveryCeilingMicros + v.researchCeilingMicros), 'ceiling_sum_invalid')
  .refine(v => v.discoveryProvider === 'places' || v.permittedSources.length >= 1, 'permitted_sources_required')
  .refine(v => v.discoveryProvider !== 'places' || v.maxCompanies <= PLACES_MAX_COMPANIES, 'places_batch_size');
export type ResearchSetupApproveInput = z.infer<typeof researchSetupApproveInputSchema>;
export const researchSetupSetStateInputSchema = z.strictObject({ state: z.enum(['paused','active']), expectedRevision: integer.positive(), disclosureAcknowledged: z.literal(true) });
export type ResearchSetupSetStateInput = z.infer<typeof researchSetupSetStateInputSchema>;
const identity = { workspaceId: id, pairingId: z.uuid() };
export const researchSetupStatusRequestSchema = z.strictObject({ ...identity, requestId: z.uuid().optional() });
export type ResearchSetupStatusRequest = z.infer<typeof researchSetupStatusRequestSchema>;
export const researchSetupRequestSchema = z.discriminatedUnion('kind', [z.strictObject({ ...identity, version: z.literal(1), requestId: z.uuid(), kind: z.literal('approve'), input: researchSetupApproveInputSchema }), z.strictObject({ ...identity, version: z.literal(1), requestId: z.uuid(), kind: z.literal('set-state'), input: researchSetupSetStateInputSchema })]);
export type ResearchSetupRequest = z.infer<typeof researchSetupRequestSchema>;
export const researchSetupCancelRequestSchema = z.strictObject({ version: z.literal(1), kind: z.literal('cancel'), originalRequest: researchSetupRequestSchema });
export type ResearchSetupCancelRequest = z.infer<typeof researchSetupCancelRequestSchema>;
export const researchSetupWriteRequestSchema = z.union([researchSetupRequestSchema, researchSetupCancelRequestSchema]);
const receiptIdentity = { ...identity, requestId: z.uuid(), kind: z.enum(['approve','set-state']), fingerprint: hash };
export const researchSetupReceiptSchema = z.discriminatedUnion('status', [z.strictObject({ ...receiptIdentity, status: z.literal('applied'), revision: integer.positive(), state: z.enum(['paused','active']) }), z.strictObject({ ...receiptIdentity, status: z.literal('cancelled'), revision: z.null(), state: z.null() })]);
export type ResearchSetupReceipt = z.infer<typeof researchSetupReceiptSchema>;
export const researchSetupBlockerSchema = z.enum(['needs_pairing','operator_descriptor_missing','operator_descriptor_invalid','operator_descriptor_expired','credential_parameter_missing','legacy_or_orphan_state','descriptor_changed','budget_corrupt','state_corrupt','unavailable','local_pending','local_journal_unavailable','places_credential_parameter_missing','places_cost_missing']);
export type ResearchSetupBlocker = z.infer<typeof researchSetupBlockerSchema>;
export const researchSetupLedgerSchema = z.strictObject({ limitMicros: integer.positive(), reservedOrSpentMicros: integer, remainingMicros: integer });
/** `placesCredentialParameterDeclared` and `placesBlockers` describe Places readiness only; a worker predating them reports neither, which the desktop treats as not ready for Places. */
export const researchSetupRemoteStatusSchema = z.strictObject({ ...identity, selector: ownerResearchSourceSchema.nullable(), discoveryLedger: researchSetupLedgerSchema.nullable(), researchLedger: researchSetupLedgerSchema.nullable(), descriptor: researchReviewedCapabilitySchema.nullable(), descriptorFingerprint: hash.nullable(), credentialParameterDeclared: z.boolean(), blockers: z.array(researchSetupBlockerSchema), checkedAt: instant, receipt: researchSetupReceiptSchema.nullable(),
  placesCredentialParameterDeclared: z.boolean().optional(), placesBlockers: z.array(researchSetupBlockerSchema).optional() });
export type ResearchSetupRemoteStatus = z.infer<typeof researchSetupRemoteStatusSchema>;
/** Metadata only. Exact request stays in encrypted main-process journal. */
export const researchSetupPendingSchema = z.strictObject({ requestId: z.uuid(), kind: z.enum(['approve','set-state']), createdAt: instant, state: z.literal('unknown') });
export type ResearchSetupPending = z.infer<typeof researchSetupPendingSchema>;
export const researchSetupStatusSchema = z.strictObject({ remote: researchSetupRemoteStatusSchema.nullable(), pending: researchSetupPendingSchema.nullable(), blockers: z.array(researchSetupBlockerSchema) });
export type ResearchSetupStatus = z.infer<typeof researchSetupStatusSchema>;
export interface ResearchSetupApi { status(): Promise<ResearchSetupStatus>; approve(input: ResearchSetupApproveInput): Promise<ResearchSetupReceipt>; setState(input: ResearchSetupSetStateInput): Promise<ResearchSetupReceipt>; retry(): Promise<ResearchSetupReceipt>; cancelPending(): Promise<ResearchSetupReceipt>; }
