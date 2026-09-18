import { z } from 'zod';
import { accountIdSchema as id, accountInstantSchema as instant } from './accountContract';
import { audienceQuerySchema, discoveryProviderSchema, researchCapabilitySchema, researchLimitsSchema, PLACES_MAX_COMPANIES } from '../../main/research/companyResearchTypes';
import { ownerResearchSourceSchema } from './ownerCommandContract';
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** Google Places API (New) Text Search, Enterprise SKU: the reviewed cost per call can never be below this ceiling, in micros of USD. */
export const PLACES_SEARCH_COST_MICROS = 35000;
/** No operator review stays valid longer than this; the worker pauses itself when a review lapses instead of retrying every tick. */
export const RESEARCH_REVIEW_MAX_DAYS = 180;
export const RESEARCH_REVIEW_MAX_MS = RESEARCH_REVIEW_MAX_DAYS * 86_400_000;
/** The provenance text is bounded here and, byte for byte, in the Terraform variable validation that carries it into the worker. */
export const RESEARCH_PROVENANCE_MAX_CHARS = 500;
export const researchReviewedCapabilitySchema = z.strictObject({ capability: researchCapabilitySchema, reviewedAt: instant, expiresAt: instant, provenance: z.string().trim().min(1).max(RESEARCH_PROVENANCE_MAX_CHARS), researchReservationMicros: researchLimitsSchema.shape.maxCostMicros, currency: z.literal('USD'),
  /** Operator-reviewed cost reserved before every Places text-search call. Required only when the provider is `places`. */
  placesSearchCostMicros: researchLimitsSchema.shape.maxCostMicros.min(PLACES_SEARCH_COST_MICROS).optional(),
  /** Bounded per-firm model extraction on the scheduled Places path only. Absent means regex facts only. Its `maxCostMicros` is the
   *  per-firm research reservation and its `model` the same reviewed model the credential names; the real usage cost is settled and the rest refunded. */
  placesExtraction: researchLimitsSchema.shape.knownCompanyExtraction })
  .refine(v => Date.parse(v.reviewedAt) < Date.parse(v.expiresAt) && v.capability.searchCostMicros + v.capability.modelCostMicros <= 20000000, 'invalid_review')
  .refine(v => Date.parse(v.expiresAt) - Date.parse(v.reviewedAt) <= RESEARCH_REVIEW_MAX_MS, 'review_window_exceeded')
  .refine(v => !v.placesExtraction || (v.placesExtraction.maxCostMicros === v.researchReservationMicros && v.placesExtraction.model === v.capability.model), 'places_extraction_mismatch');
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
/** `budget_exhausted` and `territory_exhausted` describe the stored policy's ledgers and sweep; they hold nothing the owner can do (Replace widens a ceiling or moves the territory). */
export const researchSetupBlockerSchema = z.enum(['needs_pairing','operator_descriptor_missing','operator_descriptor_invalid','operator_descriptor_expired','credential_parameter_missing','legacy_or_orphan_state','descriptor_changed','budget_corrupt','state_corrupt','unavailable','local_pending','local_journal_unavailable','places_credential_parameter_missing','places_cost_missing','budget_exhausted','territory_exhausted']);
export type ResearchSetupBlocker = z.infer<typeof researchSetupBlockerSchema>;
export const RESEARCH_INFORMATIONAL_BLOCKERS: readonly ResearchSetupBlocker[] = ['budget_exhausted', 'territory_exhausted'];
export const researchSetupLedgerSchema = z.strictObject({ limitMicros: integer.positive(), reservedOrSpentMicros: integer, remainingMicros: integer });
/** Why the worker paused the selector itself. Set only by the scheduled research phase; a manual pause carries no reason. */
export const researchPausedReasonSchema = z.enum(['descriptor_expired']);
export type ResearchPausedReason = z.infer<typeof researchPausedReasonSchema>;

/** One structured record per scheduled tick, written to the worker log and persisted as the last tick. Every field is a count, an enum or
 *  an instant: no firm name, phone number, URL, excerpt or error text can enter it. The key list is closed (strict object). */
export const SCHEDULED_RUN_EVENT = 'SCHEDULED_RUN_COMPLETED';
export const tickPhaseSchema = z.enum(['research', 'configurations', 'submittedCommands', 'publications', 'territoryBackfill']);
export type TickPhase = z.infer<typeof tickPhaseSchema>;
export const tickPhaseResultSchema = z.enum(['completed', 'held', 'aborted', 'skipped']);
export type TickPhaseResult = z.infer<typeof tickPhaseResultSchema>;
export const tickHeldReasonSchema = z.enum(['research_phase_failed', 'configurations_phase_failed', 'commands_phase_failed', 'publications_phase_failed', 'tick_failed',
  'research_not_prepared', 'research_parked', 'meeting_held', 'dispatch_held', 'requested_followup_held', 'configuration_failed', 'command_failed', 'tick_record_write_failed',
  'territory_phase_failed', 'territory_backfill_held']);
export type TickHeldReason = z.infer<typeof tickHeldReasonSchema>;
/** The exception constructor names the worker recognizes. An unrecognized class is `unknown`: a name is never carried through verbatim,
 *  so no message, payload, URL or provider detail can reach the log through it. */
export const tickErrorClassSchema = z.enum(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'AggregateError', 'DOMException',
  'ZodError', 'DynamoReadUnavailable', 'ResearchDiscoveryError', 'unknown']);
export type TickErrorClass = z.infer<typeof tickErrorClassSchema>;
/** Why a phase did not do its work, in the phase's own words instead of an anonymous failure.
 *  `descriptor_changed`: the reviewed marker's fingerprint no longer matches the deployed descriptor; the desktop's Replace configuration rebinds it.
 *  `descriptor_expired`: the operator review has lapsed. `setup_marker_missing`: guided admission evidence is gone. `pairing_inactive`: the approving
 *  pairing is no longer active. `config_mismatch`: the stored selector or its binding changed under the phase. `phase_error`: anything else, named
 *  by constructor class only. */
export const tickPhaseHoldReasonSchema = z.enum(['descriptor_changed', 'descriptor_expired', 'setup_marker_missing', 'pairing_inactive', 'config_mismatch', 'phase_error']);
export type TickPhaseHoldReason = z.infer<typeof tickPhaseHoldReasonSchema>;
export const tickPhaseHoldSchema = z.strictObject({ reason: tickPhaseHoldReasonSchema, errorClass: tickErrorClassSchema.nullable() });
export type TickPhaseHold = z.infer<typeof tickPhaseHoldSchema>;
export const placesBatchOutcomeSchema = z.enum(['completed', 'exhausted', 'uncertain', 'denied', 'held']);
export const tickPlacesSchema = z.strictObject({ outcome: placesBatchOutcomeSchema, created: integer, routes: integer, enqueued: integer, drained: integer,
  skipped: z.strictObject({ no_website: integer, website_blocked: integer, duplicate_domain: integer, duplicate_phone: integer, existing_domain: integer, existing_phone: integer, route_held: integer, enqueue_held: integer }) });
export const tickExtractionSchema = z.strictObject({ calls: integer, settledCostMicros: integer, refundedMicros: integer });
export const tickLedgerSchema = z.strictObject({ discoveryRemainingMicros: integer, researchRemainingMicros: integer });
/** What the territory backfill sweep did for firms that already existed when the policy was approved. Counts and enums only.
 *  `exhausted` means the sweep reached the end of the table under the current policy revision; `completed` means a bounded batch with more to come. */
export const territoryBackfillOutcomeSchema = z.enum(['completed', 'exhausted', 'no_policy', 'policy_paused', 'held']);
export const tickTerritorySchema = z.strictObject({ outcome: territoryBackfillOutcomeSchema, scanned: integer, enrolled: integer, replayed: integer,
  skipped: z.strictObject({ policy_paused: integer, authority_exists: integer, route_unavailable: integer, enrollment_failed: integer }) });
export const scheduledRunRecordSchema = z.strictObject({ event: z.literal(SCHEDULED_RUN_EVENT), version: z.literal(1), at: instant, durationMs: integer,
  status: z.enum(['inactive', 'completed', 'aborted']), phases: z.partialRecord(tickPhaseSchema, tickPhaseResultSchema),
  held: integer, heldByReason: z.partialRecord(tickHeldReasonSchema, integer.positive()),
  /** The named condition each phase that did not do its work hit. Absent for a phase that ran, and for an abort (which is not a condition). */
  phaseHolds: z.partialRecord(tickPhaseSchema, tickPhaseHoldSchema),
  territory: tickTerritorySchema.nullable(),
  places: tickPlacesSchema.nullable(), firmsCreated: integer, jobsDrained: integer,
  researchPrepared: integer, researchCompleted: integer, mailPolls: integer, dispatches: integer, sendReconciliations: integer, meetings: integer,
  extraction: tickExtractionSchema, ledger: tickLedgerSchema.nullable(), descriptorExpired: z.boolean(), selfPaused: z.boolean() });
export type ScheduledRunRecord = z.infer<typeof scheduledRunRecordSchema>;
/** Settings treats a worker whose last tick is older than this as stale. Three missed five-minute ticks. */
export const WORKER_STALE_AFTER_MS = 20 * 60_000;
/** Settings warns this long before the operator review expires. */
export const RESEARCH_RENEWAL_WARNING_MS = 14 * 86_400_000;
/** `placesCredentialParameterDeclared` and `placesBlockers` describe Places readiness only; a worker predating them reports neither, which the desktop treats as not ready for Places.
 *  `lastTickAt`/`lastTick` are the worker's last persisted scheduled tick (null before the first tick or on a worker predating them); `pausedReason` is set only when the worker paused the selector itself. */
export const researchSetupRemoteStatusSchema = z.strictObject({ ...identity, selector: ownerResearchSourceSchema.nullable(), discoveryLedger: researchSetupLedgerSchema.nullable(), researchLedger: researchSetupLedgerSchema.nullable(), descriptor: researchReviewedCapabilitySchema.nullable(), descriptorFingerprint: hash.nullable(), credentialParameterDeclared: z.boolean(), blockers: z.array(researchSetupBlockerSchema), checkedAt: instant, receipt: researchSetupReceiptSchema.nullable(),
  placesCredentialParameterDeclared: z.boolean().optional(), placesBlockers: z.array(researchSetupBlockerSchema).optional(),
  lastTickAt: instant.nullable().optional(), lastTick: scheduledRunRecordSchema.nullable().optional(), pausedReason: researchPausedReasonSchema.nullable().optional() });
export type ResearchSetupRemoteStatus = z.infer<typeof researchSetupRemoteStatusSchema>;
/** Metadata only. Exact request stays in encrypted main-process journal. */
export const researchSetupPendingSchema = z.strictObject({ requestId: z.uuid(), kind: z.enum(['approve','set-state']), createdAt: instant, state: z.literal('unknown') });
export type ResearchSetupPending = z.infer<typeof researchSetupPendingSchema>;
export const researchSetupStatusSchema = z.strictObject({ remote: researchSetupRemoteStatusSchema.nullable(), pending: researchSetupPendingSchema.nullable(), blockers: z.array(researchSetupBlockerSchema) });
export type ResearchSetupStatus = z.infer<typeof researchSetupStatusSchema>;
export interface ResearchSetupApi { status(): Promise<ResearchSetupStatus>; approve(input: ResearchSetupApproveInput): Promise<ResearchSetupReceipt>; setState(input: ResearchSetupSetStateInput): Promise<ResearchSetupReceipt>; retry(): Promise<ResearchSetupReceipt>; cancelPending(): Promise<ResearchSetupReceipt>; }
