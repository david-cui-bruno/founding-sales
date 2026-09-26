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
  /** @deprecated never answered since wave 2 (S4.2): a posture has no yearly expiry. */
  'posture_overdue',
  'scoped_pause',
  'restore_in_progress',
  'reassignment',
  'uncertain_reply',
  'ambiguous_match',
  'opportunity_manual',
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
  /** @deprecated never answered since wave 2 (S4.3): a number is attested when added. */
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
// Calling identities (specification 9.1; lane g60)
// ---------------------------------------------------------------------------

/**
 * How a calling identity came to be verified.
 *
 * Version one has no telephony provider — a call is a `tel:` handoff from the Mac — so
 * the only verification there is is a person's statement that this is the number they
 * place calls from, recorded with who made it and when, the way 12.7's sending
 * checklist records a person saying they looked. The owner's own statement and an
 * admin's on a member's behalf are recorded as different methods, because they are
 * different evidence. A later call-back code would be a third value here and a third
 * branch in the CHECK. See `docs/decisions/g60-calling-identities-are-attested-in-version-one.md`.
 */
export const CALLING_IDENTITY_VERIFICATION_METHODS = ['owner_attestation', 'admin_attestation'] as const;
export const callingIdentityVerificationMethodSchema = z.enum(CALLING_IDENTITY_VERIFICATION_METHODS);
export type CallingIdentityVerificationMethod = z.infer<typeof callingIdentityVerificationMethodSchema>;

/**
 * Why a calling-identity command was refused.
 *
 * Request refusals in the sense of `docs/decisions/g4-dial-refusal-codes.md`: none of
 * them is a hold, none has a recovery action, and none becomes an `active_holds` row.
 * Where a fact already has a word in `DIAL_REQUEST_REFUSAL_CODES` it is spelled the
 * same (`identity_shared_line_disabled`), so a refusal here and the dial refusal it
 * prevents never say one thing in two words.
 *
 * A colleague's identity is `identity_unknown` to a salesperson, not "not yours", for
 * the reason a colleague's Today card is `not_found`: the difference would tell them
 * what exists.
 */
export const CALLING_IDENTITY_REFUSAL_CODES = [
  /** Not `+`, a country code and 8 to 15 digits in all. No country is ever assumed. */
  'number_invalid',
  /** The label is empty after trimming or longer than 80 characters. */
  'label_invalid',
  /** The owner is not an active member of this workspace. */
  'owner_not_member',
  /** Registering, attesting or retiring somebody else's number is an admin's act. */
  'admin_only',
  /** The number is already registered in this workspace to somebody else. */
  'number_registered_to_another',
  'identity_unknown',
  /** A null-owner row is the deferred shared line and stays disabled (9.1). */
  'identity_shared_line_disabled',
] as const;
export const callingIdentityRefusalCodeSchema = z.enum(CALLING_IDENTITY_REFUSAL_CODES);
export type CallingIdentityRefusalCode = z.infer<typeof callingIdentityRefusalCodeSchema>;

/** One calling identity as the API hands it out: to its owner, or to an admin. */
export const callingIdentityDtoSchema = z.strictObject({
  id: uuid,
  ownerUserId: uuid.nullable(),
  e164,
  label: z.string().max(80).nullable(),
  verificationStatus: z.enum(['unverified', 'verified']),
  enabled: z.boolean(),
  verifiedAt: instant.nullable(),
  verifiedByUserId: uuid.nullable(),
  verificationMethod: callingIdentityVerificationMethodSchema.nullable(),
  disabledAt: instant.nullable(),
  /**
   * Whether this is the number the owner's Today cards dial from: the most recently
   * added or attested of their numbers that are not retired (wave 2, S4.3: a number is
   * attested when added, and one an older release left unverified is usable), chosen by
   * the server so the Mac shows the choice rather than re-deriving it.
   */
  usedForCalls: z.boolean(),
  createdAt: instant,
});
export type CallingIdentityDto = z.infer<typeof callingIdentityDtoSchema>;

/** `GET /calling-identities`: the caller's own numbers, oldest first. */
export const callingIdentityListSchema = z.strictObject({
  identities: z.array(callingIdentityDtoSchema),
});
export type CallingIdentityList = z.infer<typeof callingIdentityListSchema>;

/**
 * What a calling-number command returns inside the command envelope: the outcome and
 * the row as it now is (`apps/api/src/routes/callingIdentities.ts`; lane g78). The
 * outcomes are the four `registerCallingIdentity`, `verifyCallingIdentity` and
 * `disableCallingIdentity` in `packages/domain/dial/identities.ts` can return.
 */
export const CALLING_IDENTITY_CHANGE_OUTCOMES = ['created', 'existing', 'verified', 'disabled'] as const;
export const callingIdentityChangeResultSchema = z.object({
  outcome: z.enum(CALLING_IDENTITY_CHANGE_OUTCOMES),
  identity: callingIdentityDtoSchema,
});
export type CallingIdentityChangeResult = z.infer<typeof callingIdentityChangeResultSchema>;

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

export const PAUSE_CHANNELS = ['email', 'call', 'research'] as const;
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

/*
 * What the postures form reads (lane g84, audit item G04). `statePostureDtoSchema`
 * above is strict and has no `confirmedByUserId`, which `listStatePostures` has always
 * answered with; nothing parsed it until now. These are the stripping shapes the rest
 * of the Mac's reads use (g78), and the route test holds the real answers to them with
 * `wireDrift`.
 */

/** One recorded posture, as `GET /postures` lists it and `POST /postures/record` answers it. */
export const statePostureViewSchema = z.object({
  id: uuid,
  state: z.string().regex(/^[A-Z]{2}$/u),
  revision: z.number().int().min(1),
  effectiveFrom: instant,
  effectiveTo: instant.nullable(),
  reviewAt: instant,
  rulesRevision: z.number().int().min(1),
  confirmedStatements: z.array(z.string().min(1).max(80)),
  sources: z.array(z.object({ title: z.string().max(400), url: z.string().max(500) })),
  confirmedByUserId: uuid,
  revokedAt: instant.nullable(),
});
export type StatePostureView = z.infer<typeof statePostureViewSchema>;

/** `GET /postures`. */
export const statePostureListResponseSchema = z.object({ postures: z.array(statePostureViewSchema) });
export type StatePostureListResponse = z.infer<typeof statePostureListResponseSchema>;

export const postureCitationSchema = z.object({ title: z.string(), url: z.string(), quote: z.string() });
export type PostureCitationDto = z.infer<typeof postureCitationSchema>;

/**
 * `GET /postures/reference` (lane g84): the statements a posture confirms and the quoted
 * rules, verbatim from `@fss/domain`'s `statePosture.ts`, for the form to show. Invariant
 * 7 — "Software records and enforces legal posture; it does not invent it" — is why the
 * Mac reads these rather than carrying a copy: an edit to a quoted passage is a new
 * rules revision in one place, and a second copy on the Mac would be a second text.
 *
 * `states` is every state a posture can be recorded for, in the domain's order, with the
 * quoted rule where the release carries one and null where it does not.
 */
export const postureReferenceResponseSchema = z.object({
  rulesRevision: z.number().int().min(1),
  statements: z.array(z.object({ key: z.string().min(1).max(80), text: z.string() })),
  federalCitations: z.array(postureCitationSchema),
  states: z.array(
    z.object({
      state: z.string().regex(/^[A-Z]{2}$/u),
      name: z.string(),
      rule: z.object({ summary: z.string(), citations: z.array(postureCitationSchema) }).nullable(),
    }),
  ),
});
export type PostureReferenceResponse = z.infer<typeof postureReferenceResponseSchema>;

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

/**
 * Log a call (specification 9.1, Appendix A "Log call outcome"; lane g79).
 *
 * Four changes from G4's shape, all additive or relaxing, so a desktop that sends the
 * old body is still understood:
 *
 *  * `occurredAt` is optional. Absent means "just now" and the server records its own
 *    clock; a Mac whose clock ran a few seconds fast used to fail the database's
 *    `recorded_at >= occurred_at` (audit item C15). Present is an explicitly entered
 *    historical time, and the server refuses one further in the future than
 *    `CALL_OCCURRED_AT_TOLERANCE_SECONDS` and reads one inside it as now.
 *  * `itemId` names the Today task the call was placed for. The server resolves it to
 *    the step execution or the callback behind it and applies the outcome to that —
 *    the sequence step's configured successor or retry, read from the frozen step, or
 *    the callback's completion (audit items C04, C17).
 *  * `callback.dueAt` is optional. The server resolves the local date, time and zone
 *    through the one calendar clock (`callbackInstant`) and refuses to commit a
 *    callback whose supplied `dueAt` disagrees (audit item C18).
 *  * `retryBehaviour` is still accepted, so an old body parses, and is ignored: what a
 *    no-answer does comes from the sequence step the call belongs to and never from
 *    the client (audit item C04).
 */
export const logCallOutcomeCommandSchema = z.strictObject({
  ...commandEnvelope,
  firmId: uuid,
  contactId: uuid.optional(),
  routeId: uuid.optional(),
  ticketId: uuid.optional(),
  callingIdentityId: uuid.optional(),
  /** The Today task this call was placed for, when it was placed from one. */
  itemId: uuid.optional(),
  outcome: callOutcomeSchema,
  /** Omit for "just now": the server's clock is used. Present only for an entered past time. */
  occurredAt: instant.optional(),
  note: z.string().trim().min(1).max(2000).optional(),
  /** Accepted for old clients and ignored. The step's frozen configuration decides (9.1). */
  retryBehaviour: callRetryBehaviourSchema.optional(),
  /**
   * For `callback_requested`: the wall clock the salesperson confirmed. Without it the
   * call is still recorded and a callback that needs a time goes on Today (C13).
   */
  callback: z
    .strictObject({
      localDate: z.iso.date(),
      localTime: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/u).optional(),
      /** What the client resolved and showed. Checked against the server's own resolution. */
      dueAt: instant.optional(),
      sourceTimeZone: z.string().min(1).max(64),
    })
    .optional(),
  /** `do_not_call` suppresses the firm only when the request covered all Callie contact (9.1). */
  doNotCallCoversAllContact: z.boolean().optional(),
});

/**
 * How far ahead of the server's clock an entered `occurredAt` may be and still be read
 * as now. Two minutes covers an ordinary unsynchronised Mac; a time beyond it is a
 * time that has not happened and is refused rather than silently moved.
 */
export const CALL_OCCURRED_AT_TOLERANCE_SECONDS = 120;

/**
 * What a recorded call still needs from a person (lane g79, audit items C13, C14).
 *
 * "Call logging always records what occurred ... it never refuses history." So an
 * outcome whose consequence cannot be applied is recorded anyway, and what could not
 * be done is said explicitly here rather than by refusing the call:
 *
 *  * `callback_time_needed` — a callback was asked for without a confirmed instant, or
 *    with one the server resolved differently. A task "Callback — needs a time" is on
 *    Today until a time is set or the callback is made.
 *  * `route_not_named` — the outcome acts on the number (wrong number, do not call)
 *    and no number was named, so nothing was retired or suppressed by number.
 *  * `effects_not_applied` — applying the outcome was refused part-way. Every effect
 *    was rolled back to a savepoint; the call itself is recorded.
 */
export const CALL_FOLLOW_UP_KINDS = ['callback_time_needed', 'route_not_named', 'effects_not_applied'] as const;
export type CallFollowUpKind = (typeof CALL_FOLLOW_UP_KINDS)[number];

export const callFollowUpSchema = z.object({
  kind: z.enum(CALL_FOLLOW_UP_KINDS),
  /** A stable code: `no_instant`, `instant_mismatch`, `instant_invalid`, or the refusal. */
  reason: z.string().max(80),
});
export type CallFollowUp = z.infer<typeof callFollowUpSchema>;

/**
 * What the sequence step behind the call became (9.1).
 *
 *  * `completed` — the step is done and its configured successor exists (or the plan
 *    ran out).
 *  * `completed_and_stopped` — an engaged outcome: the step is done and every live
 *    enrollment at the firm stopped, so no successor exists (Appendix G 26).
 *  * `retry_scheduled` — the step's frozen `retry_call`: the same execution, due again.
 *  * `not_completed` — wrong number or a failure to place the call: the task stays.
 *  * `not_open` — the step had already finished; the call is history only.
 */
export const CALL_STEP_APPLICATIONS = [
  'completed',
  'completed_and_stopped',
  'retry_scheduled',
  'not_completed',
  'not_open',
] as const;
export type CallStepApplication = (typeof CALL_STEP_APPLICATIONS)[number];

/**
 * The accepted answer to `POST /calls/log`. A plain object rather than a strict one, so
 * a later field does not make an older Mac call a recorded call unreadable.
 */
export const loggedCallResultSchema = z.object({
  callLogId: uuid,
  outcome: callOutcomeSchema,
  stepEffect: callStepEffectSchema,
  occurredAt: instant,
  /** Whether the call switched the opportunity to manual control (7.3). */
  setManual: z.boolean(),
  /** A close the salesperson must confirm, never applied by the call itself (9.1). */
  suggestedStageKey: z.literal('lost').nullable(),
  suppressionEventIds: z.array(uuid),
  /** The number a wrong-number outcome retired. */
  retiredRouteId: uuid.nullable(),
  /** The callback this call created. */
  callbackId: uuid.nullable(),
  stepExecutionId: uuid.nullable(),
  stepApplication: z.enum(CALL_STEP_APPLICATIONS).nullable(),
  /** The step the application created: the successor, or null for a retry or none. */
  successorExecutionId: uuid.nullable(),
  /** The callback this call fulfilled (Appendix A "Callback confirm/complete"). */
  completedCallbackId: uuid.nullable(),
  followUps: z.array(callFollowUpSchema),
});
export type LoggedCallResult = z.infer<typeof loggedCallResultSchema>;

/**
 * Give a recorded "call me back" its time, later (lane g79, audit item C13).
 *
 * The call that asked for the callback is already history; this commits the instant
 * the salesperson now confirms, beside that call, exactly as the outcome would have.
 * `dueAt` is optional and checked against the server's resolution like the outcome's.
 */
export const scheduleCallbackCommandSchema = z.strictObject({
  ...commandEnvelope,
  callLogId: uuid,
  localDate: z.iso.date(),
  localTime: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/u).optional(),
  sourceTimeZone: z.string().min(1).max(64),
  dueAt: instant.optional(),
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

/**
 * Record one state's posture with its statements ticked one by one.
 * @deprecated (remove after desktop 1.0.12) — `allowCallingStatesCommandSchema` puts
 * several states on the "OK to call" list with one confirmation (wave 2, S4.2 and D5).
 * Still accepted for desktops up to 1.0.11; `reviewAt` is stored and never enforced.
 */
export const recordStatePostureCommandSchema = z.strictObject({
  ...commandEnvelope,
  state: z.string().regex(/^[A-Z]{2}$/u),
  effectiveFrom: instant,
  effectiveTo: instant.optional(),
  reviewAt: instant.optional(),
  confirmedStatements: z.array(z.string().min(1).max(80)).min(1),
  note: z.string().trim().min(1).max(1000).optional(),
});

/**
 * `POST /postures/allow` (wave 2, S4.2 and D5's API half): put several states on the
 * "OK to call" list at once. `confirmed` is a literal `true`, the one confirmation the
 * founder gives for every state named, so no client records a posture without sending
 * the statement; the server records every statement of `GET /postures/reference` as
 * confirmed, the domain's citations and database time. A state already on the list is
 * left alone. There is no review date and no expiry; revoking is `/postures/revoke`.
 */
export const allowCallingStatesCommandSchema = z.strictObject({
  ...commandEnvelope,
  states: z.array(z.string().regex(/^[A-Za-z]{2}$/u)).min(1).max(60),
  confirmed: z.literal(true),
  note: z.string().trim().max(1000).optional(),
});

/** What `POST /postures/allow` answers inside the command envelope. */
export const allowCallingStatesResultSchema = z.object({
  postures: z.array(statePostureViewSchema),
  added: z.array(z.string().regex(/^[A-Z]{2}$/u)),
  alreadyAllowed: z.array(z.string().regex(/^[A-Z]{2}$/u)),
});
export type AllowCallingStatesResult = z.infer<typeof allowCallingStatesResultSchema>;

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

/**
 * Register a calling number (lane g60). Since wave 2 (S4.3) the number is attested as it
 * is added: verified and enabled, with who and when, and usable for calls at once.
 *
 * The number travels as typed — trimmed, and at most 32 characters — and is
 * normalized by the domain, which strips spaces, dots, hyphens and parentheses after a
 * leading `+` and refuses anything else as `number_invalid`. `ownerUserId` is absent
 * for "my own number"; naming another member is an admin's act.
 */
export const registerCallingIdentityCommandSchema = z.strictObject({
  ...commandEnvelope,
  e164: z.string().trim().min(1).max(32),
  label: z.string().max(200).optional(),
  ownerUserId: uuid.optional(),
});

/**
 * The attestation: "this is the number I place calls from". `attested` is a literal
 * `true` so that no client can verify a number without sending the statement; the
 * method recorded is decided by who sends it, never by the body.
 *
 * @deprecated (remove after desktop 1.0.12) — `POST /calling-identities/register` attests
 * the number it adds (wave 2, S4.3), and no dial asks for an attestation. Still accepted
 * for desktops up to 1.0.11: it attests a number an older release left unverified, and
 * answers `existing` for any other.
 */
export const attestCallingIdentityCommandSchema = z.strictObject({
  ...commandEnvelope,
  identityId: uuid,
  attested: z.literal(true),
});

/** Stop using a number. The row stays: call logs and tickets reference it. */
export const disableCallingIdentityCommandSchema = z.strictObject({
  ...commandEnvelope,
  identityId: uuid,
});
