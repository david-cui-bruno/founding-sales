import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
import { CALL_OUTCOMES, doNotCallChoiceSchema, suppressionChannelSchema } from './dial.ts';
import { instant, uuid } from './foundationRows.ts';

/**
 * Correcting a logged call outcome (slice S3X, lane X2; DESIGN-S3X Part 2). No migration.
 *
 * The outcome is updated in place under the call log's row lock; every correction appends one
 * `audit_events` row (`call.outcome_corrected`), so the original and every correction stay
 * visible with who and when. The effects the old outcome had — a callback, call tasks, a stop,
 * an agreement and its permissions, an automatic cadence park, a retired number — are found
 * from the links that already exist, recomputed under the locks, and each one that conflicts
 * with the new outcome needs David's explicit keep or undo, with nothing preselected (P3).
 *
 *   * `POST /calls/logs/correction-preview` — a read (a POST for its body, no receipt): what
 *     the correction would meet.
 *   * `POST /calls/logs/correct` — the command. Atomic: a refusal writes nothing.
 *   * `GET /calls?firmId=` — every call log of the firm, from the database alone, with
 *     `direction`, `durationSeconds` and `callSessionId`; `include=corrections` adds each
 *     log's corrections.
 *
 * **A correction never lifts a stop** (RESET A). A conflicting stop is "Keep stop" or "Lift
 * stop…"; the second lifts nothing here. The answer lists it in `liftNext`, and the desktop
 * then opens the existing single-stop lift (`POST /suppressions/supersede`, admin only) as its
 * own confirmed step.
 */

const commandEnvelope = { commandId: commandIdSchema, clientVersion: semanticVersionSchema };
const callOutcomeSchema = z.enum(CALL_OUTCOMES);

/** The audit action of one correction, subject `call_log` / the log id. */
export const CALL_OUTCOME_CORRECTED_ACTION = 'call.outcome_corrected';

/**
 * The audit action a correction writes for each applied suggestion it contradicts (§3.8),
 * subject `call_analysis` / the analysis id. The `call.proposal_decided` row it corrects is
 * never rewritten, so `/calls/proposals/acceptance` is unchanged. One row per distinct
 * `(analysisId, key)` within a correction; S3T aggregates every row of a pair once.
 */
export const CALL_PROPOSAL_CORRECTED_ACTION = 'call.proposal_corrected';

/** Why David corrected an outcome that came from an applied suggestion (P4). */
export const CALL_CORRECTION_REASONS = ['original_error', 'new_information'] as const;
export const callCorrectionReasonSchema = z.enum(CALL_CORRECTION_REASONS);
export type CallCorrectionReason = z.infer<typeof callCorrectionReasonSchema>;

/**
 * What a correction can meet (§3.2):
 *
 *   * `callback` — a callback created for this log (`callbacks.call_log_id`);
 *   * `task` — a call task of the log's session (`call_tasks.call_session_id`);
 *   * `stop` — a stop this log wrote (`<command>:handle | :firm`) or an earlier correction of
 *     it wrote (`applied.suppressionEventIds`), not directly superseded;
 *   * `permission` — a follow-up permission granted from this log;
 *   * `agreement` — the agreement recorded on the log when no permission is there to undo
 *     (id `agreement:<logId>`);
 *   * `park` — an automatic cadence park open at the firm;
 *   * `analysis_park` — the "pause calling" an analysis applied (never conflicts);
 *   * `route` — the number a `wrong_number` retired (keep only: nothing un-retires it);
 *   * `deal` — a deal opened from this call's buying signal (never changed);
 *   * `history` — manual mode, ended enrollments and the applied step (never changed).
 */
export const CALL_CORRECTION_EFFECT_KINDS = [
  'callback',
  'task',
  'stop',
  'permission',
  'agreement',
  'park',
  'analysis_park',
  'route',
  'deal',
  'history',
] as const;
export const callCorrectionEffectKindSchema = z.enum(CALL_CORRECTION_EFFECT_KINDS);
export type CallCorrectionEffectKind = z.infer<typeof callCorrectionEffectKindSchema>;

export const CALL_CORRECTION_EFFECT_STATES = [
  'open',
  'completed',
  'cancelled',
  'done',
  'effective',
  'live',
  'consumed',
  'revoked',
  'expired',
  'retired',
  'parked',
] as const;
export const callCorrectionEffectStateSchema = z.enum(CALL_CORRECTION_EFFECT_STATES);
export type CallCorrectionEffectState = z.infer<typeof callCorrectionEffectStateSchema>;

/** `lift` only for a stop, and it lifts nothing inside the correction (§3.4a). */
export const CALL_CORRECTION_DECISIONS = ['keep', 'undo', 'lift'] as const;
export const callCorrectionDecisionSchema = z.enum(CALL_CORRECTION_DECISIONS);
export type CallCorrectionDecision = z.infer<typeof callCorrectionDecisionSchema>;

/** The applied suggestion an outcome or an effect came from, by exact recorded id (§3.7). */
export const appliedKeySchema = z.object({ analysisId: uuid, key: z.string().min(1).max(64) });
export type AppliedKey = z.infer<typeof appliedKeySchema>;

/** Codes the review shows as "Also happens": what the new outcome itself means. */
export const CALL_CORRECTION_ALSO_HAPPENS = [
  /** An engaged outcome: the open deal goes manual and live enrollments at the firm end. */
  'manual_mode',
  /** `do_not_call`: the stop the four-way choice names. */
  'stop_recorded',
  /** `wrong_number`: the dialled number is retired. */
  'route_retired',
  /** An unanswered outcome: the firm is parked if this spends the cadence. */
  'cadence_checked',
  /** `callback_requested` with a time: the callback is created. */
  'callback_scheduled',
  /** `callback_requested` without a time: "Callback — needs a time" goes on Today. */
  'callback_needs_time',
  /** `not_interested`: Lost is suggested, never closed. */
  'suggest_lost',
] as const;
export type CallCorrectionAlsoHappens = (typeof CALL_CORRECTION_ALSO_HAPPENS)[number];

/** Facts the review row shows: codes, instants and ids only. */
export const callCorrectionEffectFactsSchema = z.object({
  dueAt: instant.optional(),
  text: z.string().max(300).optional(),
  scope: z.enum(['firm', 'handle']).optional(),
  channel: suppressionChannelSchema.optional(),
  /** A stop's number or address as it is stored (the canonical key). */
  canonicalKey: z.string().max(320).optional(),
  permissionScope: z.string().max(64).optional(),
  consumedAt: instant.optional(),
  enrollmentLive: z.boolean().optional(),
  opportunityId: uuid.optional(),
  /** For `history`: the opportunity went manual or enrollments ended at log time. */
  manualOrEnded: z.boolean().optional(),
  stepExecutionId: uuid.optional(),
});

export const callCorrectionEffectSchema = z.object({
  kind: callCorrectionEffectKindSchema,
  id: z.string().min(1).max(200),
  state: callCorrectionEffectStateSchema,
  /** True when David must choose (P3); false is a collapsed line. */
  conflicts: z.boolean(),
  /** The choices offered, in order; empty when it does not conflict. Nothing is preselected. */
  decisions: z.array(callCorrectionDecisionSchema).max(3),
  appliedKey: appliedKeySchema.nullable(),
  facts: callCorrectionEffectFactsSchema,
});
export type CallCorrectionEffect = z.infer<typeof callCorrectionEffectSchema>;

/** One correction as history shows it. */
export const callLogCorrectionSchema = z.object({
  from: callOutcomeSchema,
  to: callOutcomeSchema,
  at: instant,
  byUserId: uuid.nullable(),
  reason: callCorrectionReasonSchema.nullable(),
});
export type CallLogCorrection = z.infer<typeof callLogCorrectionSchema>;

export const correctionPreviewRequestSchema = z.strictObject({
  callLogId: uuid,
  outcome: callOutcomeSchema,
});

export const correctionPreviewResponseSchema = z.object({
  callLogId: uuid,
  currentOutcome: callOutcomeSchema,
  originalOutcome: callOutcomeSchema,
  corrections: z.array(callLogCorrectionSchema).max(200),
  outcomeAppliedKey: appliedKeySchema.nullable(),
  effects: z.array(callCorrectionEffectSchema).max(200),
  /** `callback_requested` must carry a time: a callback or a fulfilled needs-a-time item exists. */
  callbackTimeRequired: z.boolean(),
  alsoHappens: z.array(z.enum(CALL_CORRECTION_ALSO_HAPPENS)).max(10),
});
export type CorrectionPreviewResponse = z.infer<typeof correctionPreviewResponseSchema>;

export const correctionEffectDecisionSchema = z.strictObject({
  kind: callCorrectionEffectKindSchema,
  id: z.string().min(1).max(200),
  state: callCorrectionEffectStateSchema,
  decision: callCorrectionDecisionSchema,
});
export type CorrectionEffectDecision = z.infer<typeof correctionEffectDecisionSchema>;

export const correctCallOutcomeCommandSchema = z.strictObject({
  ...commandEnvelope,
  callLogId: uuid,
  expectedOutcome: callOutcomeSchema,
  outcome: callOutcomeSchema,
  /** Required exactly when §3.7's rule says so; refused otherwise. */
  reason: callCorrectionReasonSchema.optional(),
  /** Only with `do_not_call`. Absent is `{ scope: 'contact', channel: 'phone' }` (P1). */
  doNotCall: doNotCallChoiceSchema.optional(),
  /** Only with `callback_requested`. */
  callback: z
    .strictObject({
      localDate: z.iso.date(),
      localTime: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/u).optional(),
      dueAt: instant.optional(),
      sourceTimeZone: z.string().min(1).max(64),
    })
    .optional(),
  /** Exactly the conflicting set the preview showed, each with David's decision. */
  effects: z.array(correctionEffectDecisionSchema).max(200),
});
export type CorrectCallOutcomeCommand = z.infer<typeof correctCallOutcomeCommandSchema>;

/**
 * The correction's own refusals (§3.3), beside the policy codes (`not_assigned`,
 * `call_log_unknown`, `not_call_actor`, `invalid_input`, `callback_instant_mismatch`) and any
 * inner command's code.
 */
export const CALL_CORRECTION_REFUSAL_CODES = [
  'stale_outcome',
  'outcome_unchanged',
  'outcome_not_correctable',
  'route_not_named',
  'effects_changed',
  'reason_required',
  'stop_needs_admin',
  'callback_time_required',
] as const;
export type CallCorrectionRefusalCode = (typeof CALL_CORRECTION_REFUSAL_CODES)[number];

export const correctCallOutcomeResultSchema = z.object({
  callLogId: uuid,
  outcome: callOutcomeSchema,
  revision: z.number().int().min(1),
  applied: z.object({
    suppressionEventIds: z.array(z.string()),
    retiredRouteId: uuid.nullable(),
    callbackId: uuid.nullable(),
    parkHoldId: uuid.nullable(),
    reopenedTodayItemId: uuid.nullable(),
  }),
  /** The stops David marked "Lift stop…": the desktop opens one lift confirm for each. */
  liftNext: z.array(z.object({ eventId: z.string(), scope: z.enum(['firm', 'handle']), channel: suppressionChannelSchema })),
  /** `not_interested`: a suggestion David confirms on the board, never a close. */
  suggestedStageKey: z.literal('lost').nullable(),
});
export type CorrectCallOutcomeResult = z.infer<typeof correctCallOutcomeResultSchema>;

// ---------------------------------------------------------------------------
// GET /calls?firmId= — every call log of the firm (RESET C)
// ---------------------------------------------------------------------------

/** `GET /calls?firmId=&include=corrections`: each row carries its corrections. */
export const CALL_LOGS_INCLUDE_CORRECTIONS = 'corrections';

export const callLogRowSchema = z.object({
  id: uuid,
  firmId: uuid,
  contactId: uuid.nullable(),
  outcome: callOutcomeSchema,
  stepEffect: z.string(),
  occurredAt: instant,
  actorUserId: uuid,
  /** Appendix F: only the assigned salesperson and admins see it. */
  note: z.string().nullable(),
  direction: z.enum(['outbound', 'inbound']),
  durationSeconds: z.number().int().min(0).nullable(),
  /** The session whose `call_log_id` is this log, consumed or not; null for none. */
  callSessionId: uuid.nullable(),
  corrections: z.array(callLogCorrectionSchema).optional(),
});
export type CallLogRowDto = z.infer<typeof callLogRowSchema>;

export const callLogsResponseSchema = z.object({ calls: z.array(callLogRowSchema).max(500) });
export type CallLogsResponse = z.infer<typeof callLogsResponseSchema>;

/** The detail of one `call.proposal_corrected` row (§3.8). Codes and ids only. */
export const callProposalCorrectedDetailSchema = z.object({
  analysisId: uuid,
  callSessionId: uuid,
  version: z.number().int(),
  proposalHash: z.string(),
  policyVersion: z.string().nullable(),
  key: z.string(),
  kind: z.string().nullable(),
  type: z.string(),
  priorResult: z.enum(['unchanged', 'edited']),
  reason: callCorrectionReasonSchema,
  correctedFrom: z.string(),
  correctedTo: z.string(),
  callLogId: uuid,
});
export type CallProposalCorrectedDetail = z.infer<typeof callProposalCorrectedDetailSchema>;

/** Negotiated recorded-deal context for independent initiatives; no inferred fallback. */
export const callLogsOpportunityContextResponseSchema = z.strictObject({
  calls: z.array(callLogRowSchema.extend({ opportunityId: uuid.nullable() }).strict()).max(500),
});
