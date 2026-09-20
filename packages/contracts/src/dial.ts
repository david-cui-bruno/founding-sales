import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
import { e164, instant, uuid } from './foundationRows.ts';

/**
 * The wire contract of policy, suppression and dialing
 * (specification 9.1, 9.2, 10.1, 10.2, 14.1, 15).
 *
 * It lives in `@fss/contracts` rather than in `@fss/domain` for one reason: the
 * Electron client needs the call outcomes, the refusal codes and the ticket shape,
 * and it may not depend on the domain package — section 14.2, "it contains no
 * authoritative sequence, suppression, policy, eligibility, or send logic". A
 * vocabulary it cannot import is a vocabulary it would re-type, and a re-typed
 * enum drifts.
 */

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * Section 15's closed reason codes, as far as they reach a dial decision. Every one
 * of these is also a `hold_reason_codes` row, spelled identically, so a refusal and
 * the hold that caused it never say the same thing in two words.
 */
export const DIAL_HOLD_REFUSAL_CODES = [
  'firm_suppressed',
  'handle_suppressed',
  'manual_suppression_review',
  'route_missing',
  'route_candidate',
  'route_invalid',
  'route_retired',
  'outside_calling_window',
  'posture_missing',
  'posture_overlapping',
  'posture_overdue',
  'scoped_pause',
  'restore_in_progress',
  'reassignment',
  'uncertain_reply',
  'ambiguous_match',
  'opportunity_manual',
  'dead_job',
  'long_hold_review',
  'provider_refusal',
] as const;

/**
 * The refusals section 15 has no word for, because they are facts about the request
 * rather than reversible blockers on the work. None of them is a hold: there is no
 * control that clears "this calling identity is not yours". See
 * `docs/decisions/g4-dial-refusal-codes.md`.
 */
export const DIAL_REQUEST_REFUSAL_CODES = [
  'firm_unknown',
  'not_assigned',
  'zone_unresolved',
  'route_version_stale',
  'identity_missing',
  'identity_not_owned',
  'identity_unverified',
  'identity_disabled',
  'identity_shared_line_disabled',
  'ticket_unknown',
  'ticket_expired',
  'ticket_wrong_device',
  'already_consumed',
] as const;

export const DIAL_REFUSAL_CODES = [...DIAL_HOLD_REFUSAL_CODES, ...DIAL_REQUEST_REFUSAL_CODES] as const;
export const dialRefusalCodeSchema = z.enum(DIAL_REFUSAL_CODES);
export type DialRefusalCode = z.infer<typeof dialRefusalCodeSchema>;

// ---------------------------------------------------------------------------
// Call outcomes (specification 9.1)
// ---------------------------------------------------------------------------

/**
 * The outcome table of 9.1, one value per row, with "No answer or busy" split into
 * the two words a person would press. The effects are in `@fss/domain`; this is the
 * vocabulary the button and the column share.
 */
export const CALL_OUTCOMES = [
  'interested',
  'referral_or_wrong_person',
  'callback_requested',
  'not_interested',
  'do_not_call',
  'wrong_number',
  'voicemail_left',
  'no_answer',
  'busy',
  'policy_or_technical_failure',
] as const;
export const callOutcomeSchema = z.enum(CALL_OUTCOMES);
export type CallOutcome = z.infer<typeof callOutcomeSchema>;

/** What the outcome does to the sequence step. The sequences lane reads the recorded value. */
export const CALL_STEP_EFFECTS = ['complete_and_advance', 'advance', 'retry_call', 'none'] as const;
export const callStepEffectSchema = z.enum(CALL_STEP_EFFECTS);
export type CallStepEffect = z.infer<typeof callStepEffectSchema>;

/** What a step configured for a no-answer does next, when the sequence says (9.1). */
export const CALL_RETRY_BEHAVIOURS = ['advance', 'retry_call'] as const;
export const callRetryBehaviourSchema = z.enum(CALL_RETRY_BEHAVIOURS);

// ---------------------------------------------------------------------------
// Suppression (specification 10.2)
// ---------------------------------------------------------------------------

export const SUPPRESSION_SCOPES = ['firm', 'handle'] as const;
export const suppressionScopeSchema = z.enum(SUPPRESSION_SCOPES);
export type SuppressionScope = z.infer<typeof suppressionScopeSchema>;

export const SUPPRESSION_SOURCES = [
  'prospect_opt_out',
  'prospect_do_not_call',
  'salesperson_manual',
  'import',
  // 10.3's deletion tombstone. Terminal on commit and never salesperson-reversible,
  // exactly like the two prospect-originated sources, but with its own name so the
  // audit trail does not claim a prospect opted out when an admin ran a deletion.
  // Deliberately absent from `recordSuppressionCommandSchema` below: only
  // `commitDeletion` writes one, and no client may mint one through the ordinary
  // suppression endpoint.
  'deletion_tombstone',
  'mistaken_entry_correction',
  'admin_supersession',
] as const;
export const suppressionSourceSchema = z.enum(SUPPRESSION_SOURCES);
export type SuppressionSource = z.infer<typeof suppressionSourceSchema>;

/** The two reasons an admin may supersede after the ten minutes (10.2). */
export const ADMIN_SUPERSESSION_REASONS = ['correction', 'documented_reconsent'] as const;
export const adminSupersessionReasonSchema = z.enum(ADMIN_SUPERSESSION_REASONS);

export const SUPPRESSION_REFUSAL_CODES = [
  'suppression_unknown',
  'not_your_event',
  'not_salesperson_originated',
  'window_expired',
  'already_finalized',
  'already_superseded',
  'canonicalizer_unsupported',
  'handle_uncanonical',
  'firm_unknown',
  'not_assigned',
  'admin_only',
  'journal_unavailable',
  'invalid_input',
] as const;
export const suppressionRefusalCodeSchema = z.enum(SUPPRESSION_REFUSAL_CODES);
export type SuppressionRefusalCode = z.infer<typeof suppressionRefusalCodeSchema>;

/** Ten minutes of database time (10.2). The client shows it; the server enforces it. */
export const MANUAL_SUPPRESSION_CORRECTION_SECONDS = 600;

// ---------------------------------------------------------------------------
// Pauses (specification 10.1)
// ---------------------------------------------------------------------------

export const PAUSE_SCOPE_KINDS = ['workspace', 'owner', 'mailbox', 'opportunity', 'channel', 'all_automation'] as const;
export const pauseScopeKindSchema = z.enum(PAUSE_SCOPE_KINDS);
export type PauseScopeKind = z.infer<typeof pauseScopeKindSchema>;

export const PAUSE_CHANNELS = ['email', 'call', 'linkedin', 'research'] as const;
export const pauseChannelSchema = z.enum(PAUSE_CHANNELS);
export type PauseChannel = z.infer<typeof pauseChannelSchema>;

// ---------------------------------------------------------------------------
// Read DTOs
// ---------------------------------------------------------------------------

/**
 * What the client gets back from `authorize_dial`.
 *
 * It carries the number and the ticket and nothing that would let a client decide
 * anything: no posture text, no window arithmetic, no suppression list. Section 14.2
 * again — the decision is the server's, and this is its receipt.
 */
export const dialTicketDtoSchema = z.strictObject({
  ticketId: uuid,
  e164,
  firmId: uuid,
  contactId: uuid.nullable(),
  routeId: uuid,
  routeVersion: z.number().int().min(1),
  callingIdentityId: uuid,
  issuedAt: instant,
  expiresAt: instant,
  /** The firm's local clock at the moment of the decision, for the card to show. */
  firmLocalTime: z.string().max(5),
  firmTimeZone: z.string().max(64),
});
export type DialTicketDto = z.infer<typeof dialTicketDtoSchema>;

export const consumedTicketDtoSchema = z.strictObject({
  ticketId: uuid,
  e164,
  consumedAt: instant,
  /** The URI the main process opens. Built by the server so the client never composes one. */
  telUri: z.string().regex(/^tel:\+[1-9][0-9]{7,14}$/u, 'a tel: URI for an E.164 number'),
});
export type ConsumedTicketDto = z.infer<typeof consumedTicketDtoSchema>;

export const statePostureDtoSchema = z.strictObject({
  id: uuid,
  state: z.string().regex(/^[A-Z]{2}$/u),
  revision: z.number().int().min(1),
  effectiveFrom: instant,
  effectiveTo: instant.nullable(),
  reviewAt: instant,
  rulesRevision: z.number().int().min(1),
  confirmedStatements: z.array(z.string().min(1).max(80)),
  sources: z.array(z.strictObject({ title: z.string().max(400), url: z.url().max(500) })),
  revokedAt: instant.nullable(),
});
export type StatePostureDto = z.infer<typeof statePostureDtoSchema>;

export const callbackDtoSchema = z.strictObject({
  id: uuid,
  firmId: uuid,
  contactId: uuid.nullable(),
  assignedUserId: uuid,
  requestedLocalDate: z.iso.date(),
  requestedLocalTime: z.string().max(8).nullable(),
  sourceTimeZone: z.string().max(64),
  dueAt: instant,
  status: z.enum(['open', 'completed', 'cancelled']),
});
export type CallbackDto = z.infer<typeof callbackDtoSchema>;

/** Appendix F row 1: a call outcome without its note is visible to any active member. */
export const callLogDtoSchema = z.strictObject({
  id: uuid,
  firmId: uuid,
  contactId: uuid.nullable(),
  outcome: callOutcomeSchema,
  stepEffect: callStepEffectSchema,
  occurredAt: instant,
  actorUserId: uuid,
});
export type CallLogDto = z.infer<typeof callLogDtoSchema>;

// ---------------------------------------------------------------------------
// Command bodies
// ---------------------------------------------------------------------------

const commandEnvelope = { commandId: commandIdSchema, clientVersion: semanticVersionSchema };

export const authorizeDialCommandSchema = z.strictObject({
  ...commandEnvelope,
  firmId: uuid,
  contactId: uuid.optional(),
  routeId: uuid,
  /** The version the card displayed. A stale one is refused rather than upgraded (9.1). */
  routeVersion: z.number().int().min(1),
  callingIdentityId: uuid,
});

export const consumeDialTicketCommandSchema = z.strictObject({
  ...commandEnvelope,
  ticketId: uuid,
});

export const logCallOutcomeCommandSchema = z.strictObject({
  ...commandEnvelope,
  firmId: uuid,
  contactId: uuid.optional(),
  routeId: uuid.optional(),
  ticketId: uuid.optional(),
  callingIdentityId: uuid.optional(),
  outcome: callOutcomeSchema,
  occurredAt: instant,
  note: z.string().trim().min(1).max(2000).optional(),
  /** `no_answer` and `busy` follow the step's configured behaviour (9.1). */
  retryBehaviour: callRetryBehaviourSchema.optional(),
  /** Required for `callback_requested`: the instant the salesperson confirmed. */
  callback: z
    .strictObject({
      localDate: z.iso.date(),
      localTime: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/u).optional(),
      dueAt: instant,
      sourceTimeZone: z.string().min(1).max(64),
    })
    .optional(),
  /** `do_not_call` suppresses the firm only when the request covered all Callie contact (9.1). */
  doNotCallCoversAllContact: z.boolean().optional(),
});

export const recordSuppressionCommandSchema = z.strictObject({
  ...commandEnvelope,
  scope: suppressionScopeSchema,
  /** Required for a firm suppression; context for a handle one. */
  firmId: uuid.optional(),
  /** Required for a handle suppression: the raw number or address, canonicalized server-side. */
  value: z.string().trim().min(3).max(320).optional(),
  source: z.enum(['prospect_opt_out', 'prospect_do_not_call', 'salesperson_manual', 'import']),
  reason: z.string().trim().min(1).max(500).optional(),
});

export const correctSuppressionCommandSchema = z.strictObject({
  ...commandEnvelope,
  eventId: z.string().min(1).max(200),
});

export const supersedeSuppressionCommandSchema = z.strictObject({
  ...commandEnvelope,
  eventId: z.string().min(1).max(200),
  reason: adminSupersessionReasonSchema,
});

export const recordStatePostureCommandSchema = z.strictObject({
  ...commandEnvelope,
  state: z.string().regex(/^[A-Z]{2}$/u),
  effectiveFrom: instant,
  effectiveTo: instant.optional(),
  reviewAt: instant.optional(),
  confirmedStatements: z.array(z.string().min(1).max(80)).min(1),
  note: z.string().trim().min(1).max(1000).optional(),
});

export const revokeStatePostureCommandSchema = z.strictObject({
  ...commandEnvelope,
  postureId: uuid,
});

export const setCallingWindowCommandSchema = z.strictObject({
  ...commandEnvelope,
  startMinute: z.number().int().min(0).max(1439),
  endMinute: z.number().int().min(1).max(1440),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).optional(),
});

export const openPauseCommandSchema = z.strictObject({
  ...commandEnvelope,
  scopeKind: pauseScopeKindSchema,
  scopeKey: z.string().min(1).max(200).optional(),
  channel: pauseChannelSchema.optional(),
  reasonNote: z.string().trim().min(1).max(500).optional(),
});

export const releasePauseCommandSchema = z.strictObject({
  ...commandEnvelope,
  pauseId: uuid,
});

export const completeCallbackCommandSchema = z.strictObject({
  ...commandEnvelope,
  callbackId: uuid,
});
