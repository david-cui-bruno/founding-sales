import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
import { e164, ianaTimeZone, instant, uuid } from './foundationRows.ts';

/**
 * The wire contract of the CRM (specification 7.2, 7.3, 8.1, 9.1, 14.1, Appendix F).
 *
 * Two rules shape it, the same two that shape `auth.ts`.
 *
 * **Refusals are a closed set.** `CRM_REFUSAL_CODES` is what a CRM endpoint may
 * answer, and nothing else. A caller switches on the code; the sentence is for a
 * person and is redacted.
 *
 * **A response is a typed redacted DTO, not a row.** Section 14.1: "No endpoint
 * returns a generic activity row. Responses are typed and redacted for the caller's
 * visibility class." Appendix F's two classes are two schemas here, and the narrow
 * one has no field a body, a note or an address could occupy — so a later slice that
 * adds notes adds them to `firmDetailDto` and physically cannot leak them into the
 * read every active member gets.
 */

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export const CRM_REFUSAL_CODES = [
  'firm_unknown',
  'firm_merged',
  'contact_unknown',
  'contact_merged',
  'route_unknown',
  'route_retired',
  // Lane g88: `/contacts/routes/confirm` on a number that changed since it was shown,
  // or on one whose validation failed.
  'route_version_stale',
  'route_invalid',
  'evidence_unknown',
  'not_assigned',
  'admin_only',
  'assignee_unknown',
  'stage_unknown',
  'stage_retired',
  // Stage administration (8.1: "rename, reorder, add, or retire *nonterminal*
  // stages"). `stage_terminal` is the refusal all four verbs give for Won and Lost;
  // `stage_last_active` refuses retiring the only stage a reopen could start at.
  'stage_key_exists',
  'stage_terminal',
  'stage_last_active',
  'opportunity_unknown',
  'opportunity_closed',
  'opportunity_open_exists',
  'opportunity_not_closed',
  'lost_reason_required',
  'zone_unresolved',
  'merge_same_record',
  'merge_cross_firm',
  'merge_conflicts',
  'merge_already_performed',
  'invalid_input',
] as const;
export const crmRefusalCodeSchema = z.enum(CRM_REFUSAL_CODES);
export type CrmRefusalCode = z.infer<typeof crmRefusalCodeSchema>;

// ---------------------------------------------------------------------------
// Shared field shapes
// ---------------------------------------------------------------------------

/** A US state or territory code. Shape only; `@fss/domain` knows the list. */
export const regionCodeSchema = z.string().regex(/^[A-Z]{2}$/, 'a two-letter region code');
export const postalCodeSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 -]{1,11}$/, 'a postal code');
export const websiteSchema = z.url().max(500).startsWith('http');
export const firmNameSchema = z.string().trim().min(1).max(300);
export const contactNameSchema = z.string().trim().min(1).max(200);
export const emailAddressSchema = z
  .string()
  .max(320)
  .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/u, 'an email address');
export const reasonSchema = z.string().trim().min(1).max(500);

export const routeEligibilitySchema = z.enum(['candidate', 'usable', 'invalid', 'retired']);
export type RouteEligibility = z.infer<typeof routeEligibilitySchema>;

export const routeKindSchema = z.enum(['phone', 'email']);
export type RouteKind = z.infer<typeof routeKindSchema>;

export const routeSourceSchema = z.enum(['research_provider', 'salesperson', 'import', 'website', 'reply']);
export const technicalValidationSchema = z.enum(['unknown', 'passed', 'failed']);

export const controlModeSchema = z.enum(['automated', 'manual']);
export type ControlMode = z.infer<typeof controlModeSchema>;

export const opportunityStatusSchema = z.enum(['open', 'won', 'lost']);

/** Why a firm has no established zone. `authorizeDial` refuses every one of them (9.2). */
export const zoneUnresolvedReasonSchema = z.enum([
  'no_location',
  'state_spans_zones',
  'state_unknown',
  'no_default_for_state',
]);

// ---------------------------------------------------------------------------
// Read DTOs — Appendix F
// ---------------------------------------------------------------------------

/** Appendix F row 1: what every active member may see about any firm. */
export const firmIdentityDtoSchema = z.strictObject({
  id: uuid,
  name: firmNameSchema,
  website: z.string().nullable(),
  locality: z.string().nullable(),
  regionCode: z.string().nullable(),
  status: z.enum(['active', 'merged']),
  assignedUserId: uuid.nullable(),
  stageKey: z.string().nullable(),
  opportunityStatus: opportunityStatusSchema.nullable(),
  controlMode: controlModeSchema.nullable(),
  openedAt: instant.nullable(),
  timeZone: ianaTimeZone.nullable(),
  timeZoneUnresolvedReason: zoneUnresolvedReasonSchema.nullable(),
});
export type FirmIdentityDto = z.infer<typeof firmIdentityDtoSchema>;

export const contactDtoSchema = z.strictObject({
  id: uuid,
  fullName: contactNameSchema,
  title: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  status: z.enum(['active', 'inactive', 'merged']),
  isPrimary: z.boolean(),
});
export type ContactDto = z.infer<typeof contactDtoSchema>;

export const routeDtoSchema = z.strictObject({
  id: uuid,
  contactId: uuid.nullable(),
  value: z.string().max(320),
  eligibility: routeEligibilitySchema,
  /** The version the card shows; `authorize_dial` compares against it (9.1). */
  version: z.number().int().min(1),
});
export type RouteDto = z.infer<typeof routeDtoSchema>;

/** Appendix F row 2: the assigned salesperson's and the admins' view. */
export const firmDetailDtoSchema = firmIdentityDtoSchema.extend({
  addressLine: z.string().nullable(),
  postalCode: z.string().nullable(),
  countryCode: z.string(),
  timeZoneConfidence: z.enum(['high', 'medium']).nullable(),
  timeZoneSource: z.enum(['recorded', 'postal', 'coordinates', 'state_default']).nullable(),
  contacts: z.array(contactDtoSchema),
  phoneRoutes: z.array(routeDtoSchema),
  emailRoutes: z.array(routeDtoSchema),
  aliases: z.array(z.strictObject({ aliasKind: z.string(), aliasValue: z.string() })),
});
export type FirmDetailDto = z.infer<typeof firmDetailDtoSchema>;

export const firmReadDtoSchema = z.discriminatedUnion('visibility', [
  z.strictObject({ visibility: z.literal('any_active_member'), firm: firmIdentityDtoSchema }),
  z.strictObject({ visibility: z.literal('assigned_or_admin'), firm: firmDetailDtoSchema }),
]);
export type FirmReadDto = z.infer<typeof firmReadDtoSchema>;

export const pipelineStageDtoSchema = z.strictObject({
  id: uuid,
  key: z.string(),
  displayName: z.string(),
  position: z.number().int().min(1),
  terminalKind: z.enum(['won', 'lost']).nullable(),
  retired: z.boolean(),
});
export type PipelineStageDto = z.infer<typeof pipelineStageDtoSchema>;

// ---------------------------------------------------------------------------
// Command bodies
//
// Every mutating body carries `commandId` and `clientVersion`, because every
// mutation goes through `runCommand` (5.3) and neither is optional there.
// ---------------------------------------------------------------------------

const commandEnvelope = { commandId: commandIdSchema, clientVersion: semanticVersionSchema };

export const createFirmCommandSchema = z.strictObject({
  ...commandEnvelope,
  name: firmNameSchema,
  website: websiteSchema.optional(),
  addressLine: z.string().trim().min(1).max(300).optional(),
  locality: z.string().trim().min(1).max(120).optional(),
  regionCode: regionCodeSchema.optional(),
  postalCode: postalCodeSchema.optional(),
  countryCode: regionCodeSchema.optional(),
  assignedUserId: uuid.optional(),
  externalId: z.string().trim().min(1).max(320).optional(),
});

export const updateFirmCommandSchema = z.strictObject({
  ...commandEnvelope,
  firmId: uuid,
  patch: z.strictObject({
    name: firmNameSchema.optional(),
    website: websiteSchema.nullable().optional(),
    addressLine: z.string().trim().min(1).max(300).nullable().optional(),
    locality: z.string().trim().min(1).max(120).nullable().optional(),
    regionCode: regionCodeSchema.nullable().optional(),
    postalCode: postalCodeSchema.nullable().optional(),
    countryCode: regionCodeSchema.optional(),
  }),
});

export const reassignFirmCommandSchema = z.strictObject({
  ...commandEnvelope,
  firmId: uuid,
  toUserId: uuid,
  reason: reasonSchema.optional(),
});

export const resolveFirmZoneCommandSchema = z.strictObject({
  ...commandEnvelope,
  firmId: uuid,
  recordedZone: ianaTimeZone.optional(),
});

export const createContactCommandSchema = z.strictObject({
  ...commandEnvelope,
  firmId: uuid,
  fullName: contactNameSchema,
  title: z.string().trim().min(1).max(200).optional(),
  linkedinUrl: z.url().max(400).optional(),
  isPrimary: z.boolean().optional(),
  externalId: z.string().trim().min(1).max(320).optional(),
});

export const updateContactCommandSchema = z.strictObject({
  ...commandEnvelope,
  contactId: uuid,
  patch: z.strictObject({
    fullName: contactNameSchema.optional(),
    title: z.string().trim().min(1).max(200).nullable().optional(),
    linkedinUrl: z.url().max(400).nullable().optional(),
    status: z.enum(['active', 'inactive']).optional(),
    isPrimary: z.boolean().optional(),
  }),
});

export const addRouteCommandSchema = z.strictObject({
  ...commandEnvelope,
  firmId: uuid,
  contactId: uuid.optional(),
  routeKind: routeKindSchema,
  /** E.164 for a phone route, an email address for an email route. */
  value: z.string().min(3).max(320),
  source: routeSourceSchema,
  associationConfidence: z.number().min(0).max(1).optional(),
  technicalValidation: technicalValidationSchema.optional(),
});

export const verifyRouteCommandSchema = z.strictObject({
  ...commandEnvelope,
  routeKind: routeKindSchema,
  routeId: uuid,
  technicalValidation: technicalValidationSchema,
  associationConfidence: z.number().min(0).max(1).optional(),
});

/**
 * A person confirms a phone number reaches the firm (lane g88). Phone only: the literal
 * is the whole of that rule on the wire, and `docs/decisions/g88-founder-authoring-and-review.md`
 * says why an email address is not confirmed by hand. `routeVersion` is the version the
 * person was looking at; a route that has moved since is refused `route_version_stale`.
 */
export const confirmRouteCommandSchema = z.strictObject({
  ...commandEnvelope,
  routeKind: z.literal('phone'),
  routeId: uuid,
  routeVersion: z.number().int().min(1),
});

export const retireRouteCommandSchema = z.strictObject({
  ...commandEnvelope,
  routeKind: routeKindSchema,
  routeId: uuid,
  reason: reasonSchema,
});

export const openOpportunityCommandSchema = z.strictObject({
  ...commandEnvelope,
  firmId: uuid,
  stageKey: z.string().max(40).optional(),
});

export const changeStageCommandSchema = z.strictObject({
  ...commandEnvelope,
  opportunityId: uuid,
  toStageKey: z.string().max(40),
  /** Required when the target stage is Lost (8.1). */
  reason: reasonSchema.optional(),
});

export const reopenOpportunityCommandSchema = z.strictObject({
  ...commandEnvelope,
  firmId: uuid,
  reason: reasonSchema,
});

export const setManualCommandSchema = z.strictObject({
  ...commandEnvelope,
  opportunityId: uuid,
  reason: reasonSchema,
});

export const mergeFirmsCommandSchema = z.strictObject({
  ...commandEnvelope,
  sourceFirmId: uuid,
  targetFirmId: uuid,
  /** Conflicting fields the person has resolved, by column name. */
  resolutions: z.record(z.string(), z.string()).optional(),
});

export const mergeContactsCommandSchema = z.strictObject({
  ...commandEnvelope,
  sourceContactId: uuid,
  targetContactId: uuid,
  resolutions: z.record(z.string(), z.string()).optional(),
});

export const recordEvidenceCommandSchema = z.strictObject({
  ...commandEnvelope,
  firmId: uuid,
  contactId: uuid.optional(),
  provider: z.string().regex(/^[a-z][a-z0-9_.-]{1,63}$/u),
  sourceReference: z.string().trim().min(1).max(500),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
  confidence: z.number().min(0).max(1).optional(),
});

/** A merge conflict shown for resolution rather than decided (7.2). */
export const mergeConflictSchema = z.strictObject({
  field: z.string(),
  source: z.string().nullable(),
  target: z.string().nullable(),
});
export type MergeConflict = z.infer<typeof mergeConflictSchema>;

// ---------------------------------------------------------------------------
// What the Mac parses back (lane g78)
//
// The wrappers around the DTOs above. The CRM window and Administration each declared
// their own copy of the first three; the board's id map was a record of any strings.
// Stripping objects, held to the routes by `wireDrift` (`./wire.ts`).
// ---------------------------------------------------------------------------

/** `GET /pipeline/stages`. */
export const pipelineStagesResponseSchema = z.object({ stages: z.array(pipelineStageDtoSchema) });
export type PipelineStagesResponse = z.infer<typeof pipelineStagesResponseSchema>;

/** `GET /firms`: Appendix F row 1 for every firm the caller may list. */
export const firmListResponseSchema = z.object({ firms: z.array(firmIdentityDtoSchema) });
export type FirmListResponse = z.infer<typeof firmListResponseSchema>;

/** `POST /pipeline/board`: `PipelineBoardDto` in `packages/domain/crm/board.ts`. */
export const pipelineBoardResponseSchema = z.object({
  columns: z.array(z.object({ stage: pipelineStageDtoSchema, firms: z.array(firmIdentityDtoSchema) })),
  /** Firm id to its open opportunity id, only for the firms this caller may change. */
  opportunityIdByFirmId: z.record(uuid, uuid),
  unplacedFirms: z.array(firmIdentityDtoSchema),
});
export type PipelineBoardResponse = z.infer<typeof pipelineBoardResponseSchema>;

/**
 * A refused `POST /merges/firms` or `/merges/contacts` (audit item D05).
 *
 * `conflicts` is present when the refusal is `merge_conflicts`, on the first answer and,
 * since lane g78, on a replay too: the receipt keeps the conflicts beside the reason, so
 * a Mac that retries the same command id still reaches the conflict screen.
 */
export const mergeRefusalSchema = z.object({
  status: z.literal('refused'),
  replayed: z.boolean(),
  reason: z.string().min(1).max(80),
  conflicts: z.array(mergeConflictSchema).optional(),
});
export type MergeRefusal = z.infer<typeof mergeRefusalSchema>;

/** Kept exported so a caller can assert a value is really an E.164 route. */
export { e164 as phoneRouteValueSchema };
