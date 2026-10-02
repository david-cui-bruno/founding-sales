import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
import { CALL_OUTCOMES, loggedCallResultSchema } from './dial.ts';
import { instant, uuid } from './foundationRows.ts';
import { CALL_PROPOSAL_KINDS, callProposalSchema } from './callAnalysis.ts';

/**
 * Applying a post-call analysis (slice 3a, lane B; migration 0036).
 *
 * Every effect of an analysis happens only when David clicks, for the first time, through an
 * existing domain command, for the analysis he saw:
 *
 *   * `POST /calls/proposals/apply` — the selected keys of one analysis, in one transaction.
 *     The server checks, under the analysis lock, that the analysis is still the newest
 *     completed model analysis on the current transcript (`stale_analysis`) and that the
 *     echoed hash is the stored one (`stale_proposal`); then the first-time rules
 *     (`call_already_logged`, `outcome_required`, `callback_exists`); then maps each key to
 *     its command. Atomic: a refusal of any key writes nothing, and names the key.
 *   * `POST /calls/proposals/decline` — records the decision only; a declined proposal stays
 *     applicable. Dismissing a review item is a decline of that proposal.
 *   * `POST /calls/pending/dismiss` — releases a call's pending-review hold.
 *   * `GET /review`, `POST /review/stage/resolve` — Needs review.
 *   * `GET /calls/proposals/acceptance` — the shadow measurement, per action type.
 *
 * This file is the contract lane C reads. A change to it after B1 merges is reported first.
 */

const commandEnvelope = { commandId: commandIdSchema, clientVersion: semanticVersionSchema };
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u);

/** A proposal key: the kind for every kind but a task, `task:<16 hex>` for a task. */
export const callProposalKeySchema = z.union([
  z.enum(CALL_PROPOSAL_KINDS).exclude(['task']),
  z.string().regex(/^task:[0-9a-f]{16}$/u),
]);
export type CallProposalKey = z.infer<typeof callProposalKeySchema>;

const keys = z
  .array(callProposalKeySchema)
  .min(1)
  .max(40)
  .refine(list => new Set(list).size === list.length, 'keys are unique');

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

/**
 * Why an Apply is refused. **An Apply is atomic**: if any selected key is refused, or its
 * command fails, the whole batch rolls back — nothing is applied, no task is written, nothing
 * is measured — and the 409 carries `keyReasons` (`applyKeyReasonsSchema`) naming the key.
 * David re-selects and clicks again. In the order they are checked:
 *
 *   * `stale_analysis` — the analysis is not the newest completed model analysis on the call's
 *     current transcript (a later version completed, or the transcript changed);
 *   * `stale_proposal` — the echoed `proposalHash` is not the stored one;
 *   * `proposal_unknown` — a key that is not an `apply` proposal of that analysis;
 *   * `call_already_logged` — `outcome` selected, and the call already has a log;
 *   * `outcome_required` — `callback` or `follow_up` selected with no `outcome` and no log;
 *   * `callback_exists` — `callback` selected, and the call's log already has a callback
 *     (cancelled ones included);
 *   * `follow_up_expired` — `follow_up` selected more than 7 days after the call (the
 *     call's own time — the session's start — never when it was logged);
 *   * `follow_up_not_granted` — `follow_up` selected and its single-email permission could
 *     not be granted (the template retired, say).
 *
 * A command a key maps to may refuse with its own code (e.g. `not_assigned`); that key is
 * named the same way.
 */
export const CALL_PROPOSAL_REFUSAL_CODES = [
  'stale_analysis',
  'stale_proposal',
  'proposal_unknown',
  'call_already_logged',
  'outcome_required',
  'callback_exists',
  'follow_up_expired',
  'follow_up_not_granted',
] as const;
export type CallProposalRefusalCode = (typeof CALL_PROPOSAL_REFUSAL_CODES)[number];

/**
 * A refused Apply's per-key reasons, beside the overall `reason` in the 409 body:
 * `keyReasons: { [proposalKey]: reasonCode }`. Freshness refusals (`stale_analysis`,
 * `stale_proposal`) name no key and carry none.
 */
export const applyKeyReasonsSchema = z.record(z.string().min(1).max(64), z.string().min(1).max(64));
export type ApplyKeyReasons = z.infer<typeof applyKeyReasonsSchema>;

/**
 * What one applied key became. `already_parked`: this proposal's park was already made
 * once (even if it was since resumed — a Resume sticks), or a park hold (the automatic
 * cadence park included) is open on the firm, so nothing was opened. `already_created`:
 * that promise is already a task for this call. `already_applied`: this call's buying
 * signal is already on the opportunity (one per call), so nothing moved. None of the three is
 * measured: only `applied` writes a decision record.
 */
export const CALL_PROPOSAL_KEY_RESULTS = ['applied', 'already_parked', 'already_created', 'already_applied'] as const;
export type CallProposalKeyResult = (typeof CALL_PROPOSAL_KEY_RESULTS)[number];

/** How long after the call an evidence-backed `follow_up` may still be applied (David's decision 7). */
export const CAPTURED_FOLLOW_UP_WINDOW_DAYS = 7;

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

const localTime = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/u);

/**
 * What David changed before applying, per key. A key absent here is applied exactly as
 * proposed. `follow_up.templateVersionId` is not an edit but a required choice: the approved
 * e-mail the single-email permission is for.
 */
export const callProposalEditsSchema = z.strictObject({
  outcome: z
    .strictObject({
      outcome: z.enum(CALL_OUTCOMES).optional(),
      /** David's explicit "covers all contact" for a `do_not_call` (never inferred). */
      doNotCallCoversAllContact: z.boolean().optional(),
      note: z.string().trim().min(1).max(2000).optional(),
    })
    .optional(),
  callback: z
    .strictObject({
      localDate: z.iso.date(),
      localTime,
      dueAt: instant.optional(),
      sourceTimeZone: z.string().min(1).max(64),
    })
    .optional(),
  follow_up: z.strictObject({ templateVersionId: uuid }).optional(),
  tasks: z
    .record(
      z.string().regex(/^task:[0-9a-f]{16}$/u),
      z.strictObject({ text: z.string().trim().min(1).max(300).optional(), dueAt: instant.optional() }),
    )
    .optional(),
});
export type CallProposalEdits = z.infer<typeof callProposalEditsSchema>;

/** `POST /calls/proposals/apply`. */
export const applyCallProposalsCommandSchema = z.strictObject({
  ...commandEnvelope,
  analysisId: uuid,
  transcriptSha256: sha256Hex,
  proposalHash: sha256Hex,
  keys,
  edits: callProposalEditsSchema.optional(),
});
export type ApplyCallProposalsCommand = z.infer<typeof applyCallProposalsCommandSchema>;

const appliedKeySchema = z.object({
  key: callProposalKeySchema,
  kind: z.enum(CALL_PROPOSAL_KINDS),
  result: z.enum(CALL_PROPOSAL_KEY_RESULTS),
  /** Whether what was applied differs from the proposal (the measurement's `edited`). */
  edited: z.boolean(),
  /** The row the key wrote or found, when it has one: a log, callback, permission, hold or task. */
  id: uuid.nullable(),
});

/** The accepted answer. A plain object, so a later field never breaks an older Mac. */
export const applyCallProposalsResultSchema = z.object({
  analysisId: uuid,
  callSessionId: uuid,
  /** The call's log after the Apply: the one it wrote, or the one it found. */
  callLogId: uuid.nullable(),
  results: z.array(appliedKeySchema),
  /** `logCallOutcome`'s follow-ups when the Apply logged the call, and the follow-up path's. */
  followUps: loggedCallResultSchema.shape.followUps,
});
export type ApplyCallProposalsResult = z.infer<typeof applyCallProposalsResultSchema>;

// ---------------------------------------------------------------------------
// Decline and the pending hold
// ---------------------------------------------------------------------------

/** `POST /calls/proposals/decline`: the measurement only. Any proposal, `apply` or `review`. */
export const declineCallProposalsCommandSchema = z.strictObject({
  ...commandEnvelope,
  analysisId: uuid,
  proposalHash: sha256Hex,
  keys,
});
export type DeclineCallProposalsCommand = z.infer<typeof declineCallProposalsCommandSchema>;

export const declineCallProposalsResultSchema = z.object({
  analysisId: uuid,
  declined: z.array(callProposalKeySchema),
});

/** `POST /calls/pending/dismiss`: release a call's pending-review hold without logging it. */
export const dismissPendingCallCommandSchema = z.strictObject({
  ...commandEnvelope,
  callSessionId: uuid,
});
export type DismissPendingCallCommand = z.infer<typeof dismissPendingCallCommandSchema>;

export const dismissPendingCallResultSchema = z.object({
  callSessionId: uuid,
  /** The hold released, or null when none was open. */
  releasedHoldId: uuid.nullable(),
});

/** The pending hold's source kind (`active_holds.source_event_kind`); its source id is the session. */
export const CALL_ANALYSIS_PENDING_SOURCE = 'call_analysis_pending';
/** How long a pending hold stays out of Needs review. A derived read; no job. */
export const PENDING_HOLD_REVIEW_AFTER_HOURS = 3;

// ---------------------------------------------------------------------------
// Needs review
// ---------------------------------------------------------------------------

/**
 * What a proposal review item is about: the proposal's own kind (any kind whose `mode` is
 * `review` — the mode is data, and a policy may send any kind to review), or
 * `follow_up_expired`, an undecided `follow_up` more than 7 days after its call, derived on
 * read.
 */
export const REVIEW_PROPOSAL_KINDS = [...CALL_PROPOSAL_KINDS, 'follow_up_expired'] as const;
export type ReviewProposalKind = (typeof REVIEW_PROPOSAL_KINDS)[number];

/** The firm's name on a review item, so the list reads without a second request. */
const reviewFirmName = z.string().min(1).max(300);

export const reviewItemSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('pending_hold'),
    holdId: uuid,
    callSessionId: uuid,
    firmId: uuid,
    firmName: reviewFirmName,
    openedAt: instant,
  }),
  z.object({
    source: z.literal('proposal'),
    reviewKind: z.enum(REVIEW_PROPOSAL_KINDS),
    analysisId: uuid,
    version: z.number().int().min(1),
    proposalHash: sha256Hex,
    callSessionId: uuid,
    firmId: uuid,
    firmName: reviewFirmName,
    proposal: callProposalSchema,
    completedAt: instant,
  }),
  z.object({
    source: z.literal('stage'),
    itemId: uuid,
    firmId: uuid.nullable(),
    /** Null when the item names no firm. */
    firmName: reviewFirmName.nullable(),
    opportunityId: uuid.nullable(),
    evidenceKind: z.string().min(1).max(64),
    reason: z.string().min(1).max(40),
    createdAt: instant,
  }),
]);
export type ReviewItem = z.infer<typeof reviewItemSchema>;

/** `GET /review`. */
export const reviewListResponseSchema = z.object({ items: z.array(reviewItemSchema).max(500) });
export type ReviewListResponse = z.infer<typeof reviewListResponseSchema>;

/** `POST /review/stage/resolve`. */
export const resolveStageReviewCommandSchema = z.strictObject({ ...commandEnvelope, itemId: uuid });
export const resolveStageReviewResultSchema = z.object({ itemId: uuid, resolvedAt: instant });

// ---------------------------------------------------------------------------
// The measurement
// ---------------------------------------------------------------------------

/** One decided key's result, in `audit_events.detail.result` (action `call.proposal_decided`). */
export const CALL_PROPOSAL_DECISIONS = ['unchanged', 'edited', 'declined', 'bypassed'] as const;
export type CallProposalDecision = (typeof CALL_PROPOSAL_DECISIONS)[number];

/** Below this many decided suggestions a type is `insufficient` (David's decision 8). */
export const ACCEPTANCE_MINIMUM_DECIDED = 5;

const count = z.number().int().min(0);

/**
 * `GET /calls/proposals/acceptance`. `type` is `outcome:<value>` for an outcome (except
 * `do_not_call`), `callback`, `follow_up`, `buying_signal`, `park`, `task`, `stop` (the
 * `do_not_call` outcome and `stop_scope`), or a review kind.
 */
export const proposalAcceptanceResponseSchema = z.object({
  minimumDecided: z.number().int().min(1),
  types: z.array(
    z.object({
      type: z.string().min(1).max(64),
      unchanged: count,
      edited: count,
      declined: count,
      bypassed: count,
      undecided: count,
      /** unchanged / decided, or null with nothing decided. */
      acceptedUnchangedShare: z.number().min(0).max(1).nullable(),
      insufficient: z.boolean(),
    }),
  ),
  /** Every `buying_signal` or stop suggestion David declined or edited, by id. */
  incorrect: z.array(
    z.object({
      analysisId: uuid,
      callSessionId: uuid,
      key: callProposalKeySchema,
      type: z.enum(['buying_signal', 'stop']),
      result: z.enum(['declined', 'edited']),
      decidedAt: instant,
    }),
  ),
});
export type ProposalAcceptanceResponse = z.infer<typeof proposalAcceptanceResponseSchema>;

// ---------------------------------------------------------------------------
// Today's tasks
// ---------------------------------------------------------------------------

/**
 * What a Today read may additionally include. `tasks`: open `call_tasks` as Today tasks of
 * kind `task` (lane `due_work`). `GET /today?include=tasks` and `POST /today/firm` with
 * `include: ['tasks']`. Without it a task appears in no card, count or expansion.
 */
export const TODAY_INCLUDES = ['tasks'] as const;
export type TodayInclude = (typeof TODAY_INCLUDES)[number];

/** `POST /today/tasks/complete`: mark one call task done. */
export const completeCallTaskCommandSchema = z.strictObject({ ...commandEnvelope, taskId: uuid });
export const completeCallTaskResultSchema = z.object({ taskId: uuid, completedAt: instant });
