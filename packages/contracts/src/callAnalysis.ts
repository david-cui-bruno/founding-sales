import { z } from 'zod';
import { commandIdSchema } from './auth.ts';
import { semanticVersionSchema } from './clientVersion.ts';
import { CALL_OUTCOMES } from './dial.ts';
import { instant, uuid } from './foundationRows.ts';
import { CALL_SUMMARY_SIDES } from './callSummaries.ts';

/**
 * Post-call analysis (slice 3a, migration 0035).
 *
 * Once a recorded call has a channel-labelled transcript, the worker asks a model for one
 * structured reading of the call (`call_analysis.1`). The answer is checked against the
 * transcript (`readCallAnalysisAnswer`) and stored as one **version** of the call's analysis,
 * with the proposal set the pure policy computes from it (`proposeEffects`) and that set's
 * hash. Nothing in an analysis acts by itself: every proposal is applied only when David
 * clicks, through an existing domain command, after the server checks under the analysis
 * lock that the analysis is still the authoritative one and the hash is the stored one.
 *
 * This file is the contract Lanes B and C read: the stored result, the proposal shape, the
 * policy version, and the `GET /calls/analysis` DTO. A change to any of it is reported first.
 */

/** Bumped whenever a byte of the policy table (`analysisPolicy.ts`) changes what it proposes. */
export const CALL_POLICY_VERSION = 'call_policy.3';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Who answered: a person at the firm, a gatekeeper, a machine (voicemail, IVR), or nobody. */
export const CALL_ANALYSIS_REACHED = ['person', 'gatekeeper', 'machine', 'none'] as const;
export type CallAnalysisReached = (typeof CALL_ANALYSIS_REACHED)[number];

/**
 * The overall interest reading. `buying_signal` survives the reader only with a verified
 * qualifying signal (`CALL_ANALYSIS_QUALIFYING_SIGNALS`); otherwise it becomes `unclear`.
 */
export const CALL_ANALYSIS_INTEREST_LEVELS = ['buying_signal', 'curious', 'neutral', 'not_interested', 'unclear'] as const;
export type CallAnalysisInterestLevel = (typeof CALL_ANALYSIS_INTEREST_LEVELS)[number];

export const CALL_ANALYSIS_SIGNAL_KINDS = [
  'demo_request',
  'evaluation',
  'adoption_question',
  'pricing_question',
  'information_request',
  'other',
] as const;
export type CallAnalysisSignalKind = (typeof CALL_ANALYSIS_SIGNAL_KINDS)[number];

/**
 * The signal kinds that make a buying signal; frozen. A bare `pricing_question` is not one:
 * David's decision on product question Q3 (2 October 2026), "a bare pricing question is not
 * enough. Buying interest requires evidence connected to their own evaluation of Callie." A
 * price asked as part of their own evaluation is reported as `evaluation`.
 */
export const CALL_ANALYSIS_QUALIFYING_SIGNALS: readonly CallAnalysisSignalKind[] = Object.freeze([
  'demo_request',
  'evaluation',
  'adoption_question',
]);

export const CALL_ANALYSIS_OBJECTION_CATEGORIES = [
  /** "We're all set", "we don't need it". */
  'no_need',
  /** "We already use AppFolio / a portal / a vendor for that." */
  'has_solution',
  /** "Not now", "maybe next year", "call after the busy season". */
  'timing',
  /** Cost, budget. */
  'price',
  /** "We're too small for software." */
  'too_small',
  /** "I'm not the one who decides that." */
  'not_decision_maker',
  /** A bare "not interested" with no reason, or getting off the phone. */
  'brush_off',
  'other',
] as const;
export type CallAnalysisObjectionCategory = (typeof CALL_ANALYSIS_OBJECTION_CATEGORIES)[number];

export const CALL_ANALYSIS_FOLLOW_UP_KINDS = ['none', 'overview_email', 'other_email', 'other'] as const;
export type CallAnalysisFollowUpKind = (typeof CALL_ANALYSIS_FOLLOW_UP_KINDS)[number];

/** `this_number`: stop calling this number or person. `all_contact`: no one at the firm, no channel. */
export const CALL_ANALYSIS_STOP_SCOPES = ['this_number', 'all_contact', 'unclear'] as const;
export type CallAnalysisStopScope = (typeof CALL_ANALYSIS_STOP_SCOPES)[number];

export const CALL_ANALYSIS_DAYS = [
  'today',
  'tomorrow',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;
export type CallAnalysisDay = (typeof CALL_ANALYSIS_DAYS)[number];

export const CALL_ANALYSIS_DAY_QUALIFIERS = ['next', 'next_week', 'this'] as const;
export type CallAnalysisDayQualifier = (typeof CALL_ANALYSIS_DAY_QUALIFIERS)[number];

export const CALL_ANALYSIS_SIDES = CALL_SUMMARY_SIDES;
export type CallAnalysisSide = (typeof CALL_ANALYSIS_SIDES)[number];

// ---------------------------------------------------------------------------
// The stored result: the validated answer, references enriched from the transcript
// ---------------------------------------------------------------------------

const lineNumber = z.number().int().min(1).max(5_000);

/** One transcript line, as the reader found it: 1-based line number, its side and its times. */
export const callAnalysisLineRefSchema = z.strictObject({
  line: lineNumber,
  side: z.enum(CALL_ANALYSIS_SIDES),
  start: z.number().min(0),
  end: z.number().min(0),
});
export type CallAnalysisLineRef = z.infer<typeof callAnalysisLineRefSchema>;

/** A quote checked to be verbatim in its line (`verbatimIn`), with that line's reference. */
export const callAnalysisQuoteRefSchema = callAnalysisLineRefSchema.extend({
  quote: z.string().min(1).max(500),
});
export type CallAnalysisQuoteRef = z.infer<typeof callAnalysisQuoteRefSchema>;

const shortText = z.string().min(1).max(500);

export const callAnalysisResultSchema = z.strictObject({
  reached: z.enum(CALL_ANALYSIS_REACHED),
  summary: z.string().min(1).max(2_000),
  facts: z.array(z.strictObject({ text: shortText, ref: callAnalysisLineRefSchema })).max(12),
  interest: z.strictObject({
    level: z.enum(CALL_ANALYSIS_INTEREST_LEVELS),
    signals: z.array(z.strictObject({ kind: z.enum(CALL_ANALYSIS_SIGNAL_KINDS), ref: callAnalysisQuoteRefSchema })).max(10),
  }),
  objections: z
    .array(
      z.strictObject({
        category: z.enum(CALL_ANALYSIS_OBJECTION_CATEGORIES),
        ref: callAnalysisQuoteRefSchema,
        answered: callAnalysisLineRefSchema.nullable(),
      }),
    )
    .max(10),
  followUpRequest: z
    .strictObject({
      kind: z.enum(CALL_ANALYSIS_FOLLOW_UP_KINDS).exclude(['none']),
      /** Them's request, or David's offer when Them agreed to it on `agreed`. */
      ref: callAnalysisQuoteRefSchema,
      /** The Them line that agreed to an offer David made; null when Them asked. */
      agreed: callAnalysisLineRefSchema.nullable(),
    })
    .nullable(),
  callback: z
    .strictObject({
      exact: z.boolean(),
      phrase: callAnalysisQuoteRefSchema,
      /** The Them line that agreed to a callback phrase David said; null when Them said it. */
      agreed: callAnalysisLineRefSchema.nullable(),
      day: z.enum(CALL_ANALYSIS_DAYS).nullable(),
      /**
       * How the weekday was qualified in the callback's own lines (the phrase's line and the
       * agreeing line), found by the reader whatever the model quoted: `next` ("next
       * Tuesday", or any "next" beside a weekday: ambiguous, never resolved), `next_week`
       * ("next week Tuesday", "Tuesday next week"), `this` ("this Tuesday"), or null.
       */
      dayQualifier: z.enum(CALL_ANALYSIS_DAY_QUALIFIERS).nullable(),
      dateText: z.string().min(1).max(120).nullable(),
      time: z.string().min(1).max(60).nullable(),
    })
    .nullable(),
  stop: z.strictObject({ scope: z.enum(CALL_ANALYSIS_STOP_SCOPES), ref: callAnalysisQuoteRefSchema }).nullable(),
  wrongNumber: z
    .strictObject({ ref: callAnalysisQuoteRefSchema, otherNumberGiven: z.string().min(1).max(40).nullable() })
    .nullable(),
  referral: z
    .strictObject({ name: z.string().min(1).max(120), role: z.string().min(1).max(120).nullable(), ref: callAnalysisQuoteRefSchema })
    .nullable(),
  voicemailLeft: z.boolean(),
  commitments: z
    .array(
      z.strictObject({
        speaker: z.enum(CALL_ANALYSIS_SIDES),
        ref: callAnalysisQuoteRefSchema,
        duePhrase: z.string().min(1).max(120).nullable(),
      }),
    )
    .max(10),
  coaching: z.strictObject({ observation: shortText, lines: z.array(callAnalysisLineRefSchema).max(5) }).nullable(),
  /**
   * Stop language the reader found itself on Them lines ("stop calling", "take me off",
   * "I don't want these calls"), whatever the model said: the policy's safety net, so a
   * stop the model missed or read as a rejection never becomes a park. `general` when the
   * words do not name only the speaker or this number.
   */
  stopPhrases: z.array(z.strictObject({ general: z.boolean(), ref: callAnalysisQuoteRefSchema })).max(10),
  /** Items the reader removed because they failed a rule, per field. Counts only. */
  dropped: z.record(z.string().max(32), z.number().int().min(0)),
});
export type CallAnalysisResult = z.infer<typeof callAnalysisResultSchema>;

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

/**
 * `apply`: one of the first-time apply keys (`POST /calls/proposals/apply`). `review`: a Needs
 * review item that links to an existing surface.
 */
export const CALL_PROPOSAL_MODES = ['apply', 'review'] as const;
export type CallProposalMode = (typeof CALL_PROPOSAL_MODES)[number];

export const CALL_PROPOSAL_KINDS = [
  'outcome',
  'callback',
  'follow_up',
  'buying_signal',
  'park',
  'task',
  'outcome_unclear',
  'stop_scope',
  'stop_with_email',
  'corrected_number',
  'referral_contact',
  'callback_zone_unknown',
] as const;
export type CallProposalKind = (typeof CALL_PROPOSAL_KINDS)[number];

const reason = z.string().min(1).max(200);
const evidence = z.array(callAnalysisQuoteRefSchema).max(10);

/**
 * One proposal. `key` is unique within a set: the kind for every kind but a task, and
 * `task:<first 16 hex of sha256(fold(quote))>` for a task, so one spoken promise keeps one
 * key across line shifts, splits and merges of the transcript.
 */
export const callProposalSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    key: z.literal('outcome'),
    kind: z.literal('outcome'),
    mode: z.literal('apply'),
    reason,
    params: z.strictObject({
      outcome: z.enum(CALL_OUTCOMES),
      /** `do_not_call` covers the dialled number only; the firm scope is David's explicit choice. */
      doNotCallCoversAllContact: z.literal(false).optional(),
      evidence,
    }),
  }),
  z.strictObject({
    key: z.literal('callback'),
    kind: z.literal('callback'),
    mode: z.literal('apply'),
    reason,
    /** The `logCallOutcome` callback body, resolved by `resolveSpokenCallback`. */
    params: z.strictObject({
      localDate: z.iso.date(),
      localTime: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/u),
      dueAt: instant,
      sourceTimeZone: z.string().min(1).max(64),
      evidence,
    }),
  }),
  z.strictObject({
    key: z.literal('follow_up'),
    kind: z.literal('follow_up'),
    mode: z.literal('apply'),
    reason,
    params: z.strictObject({ requestKind: z.enum(['overview_email', 'other_email']), evidence }),
  }),
  z.strictObject({
    key: z.literal('buying_signal'),
    kind: z.literal('buying_signal'),
    mode: z.literal('apply'),
    reason,
    params: z.strictObject({ evidence }),
  }),
  z.strictObject({
    key: z.literal('park'),
    kind: z.literal('park'),
    mode: z.literal('apply'),
    reason,
    params: z.strictObject({ evidence }),
  }),
  z.strictObject({
    key: z.string().regex(/^task:[0-9a-f]{16}$/u),
    kind: z.literal('task'),
    mode: z.literal('apply'),
    reason,
    params: z.strictObject({
      text: z.string().min(1).max(300),
      /** The quote the key was computed from. */
      quote: z.string().min(1).max(500),
      duePhrase: z.string().min(1).max(120).nullable(),
      evidence,
    }),
  }),
  z.strictObject({
    key: z.literal('outcome_unclear'),
    kind: z.literal('outcome_unclear'),
    mode: z.literal('review'),
    reason,
    params: z.strictObject({ evidence }),
  }),
  z.strictObject({
    key: z.literal('stop_scope'),
    kind: z.literal('stop_scope'),
    mode: z.literal('review'),
    reason,
    params: z.strictObject({ spokenScope: z.enum(['all_contact', 'unclear']), evidence }),
  }),
  z.strictObject({
    key: z.literal('stop_with_email'),
    kind: z.literal('stop_with_email'),
    mode: z.literal('review'),
    reason,
    params: z.strictObject({ requestKind: z.enum(['overview_email', 'other_email']), evidence }),
  }),
  z.strictObject({
    key: z.literal('corrected_number'),
    kind: z.literal('corrected_number'),
    mode: z.literal('review'),
    reason,
    params: z.strictObject({ spokenNumber: z.string().min(1).max(40), evidence }),
  }),
  z.strictObject({
    key: z.literal('referral_contact'),
    kind: z.literal('referral_contact'),
    mode: z.literal('review'),
    reason,
    params: z.strictObject({ name: z.string().min(1).max(120), role: z.string().min(1).max(120).nullable(), evidence }),
  }),
  z.strictObject({
    key: z.literal('callback_zone_unknown'),
    kind: z.literal('callback_zone_unknown'),
    mode: z.literal('review'),
    reason,
    params: z.strictObject({ phrase: z.string().min(1).max(500), evidence }),
  }),
]);
export type CallProposal = z.infer<typeof callProposalSchema>;

/** A proposal set: at most one of each non-task key, any number of distinct task keys. */
export const callProposalSetSchema = z
  .array(callProposalSchema)
  .max(40)
  .refine(set => new Set(set.map(proposal => proposal.key)).size === set.length, 'proposal keys are unique');

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u);

// ---------------------------------------------------------------------------
// Versions, notes and the read
// ---------------------------------------------------------------------------

export const CALL_ANALYSIS_ORIGINS = ['model', 'user'] as const;
export type CallAnalysisOrigin = (typeof CALL_ANALYSIS_ORIGINS)[number];

export const CALL_ANALYSIS_REQUESTED_REASONS = ['transcript', 'retry', 'reanalysis', 'user_edit'] as const;
export type CallAnalysisRequestedReason = (typeof CALL_ANALYSIS_REQUESTED_REASONS)[number];

export const CALL_ANALYSIS_STATES = ['pending', 'completed', 'failed'] as const;
export type CallAnalysisState = (typeof CALL_ANALYSIS_STATES)[number];

/** Why a model version failed: a code, never text from the call. */
export const CALL_ANALYSIS_FAILURE_REASONS = [
  'malformed',
  'schema_invalid',
  'refused',
  'provider_error',
  'transcript_changed',
  'transcript_missing',
  'transcript_too_long',
  'not_channel_labelled',
  'budget_exhausted',
  'off',
] as const;
export type CallAnalysisFailureReason = (typeof CALL_ANALYSIS_FAILURE_REASONS)[number];

/**
 * The notes David reads and edits: the summary and the facts. A user version stores exactly
 * this; a model version's notes are derived from its result.
 */
export const callAnalysisNotesSchema = z.strictObject({
  summary: z.string().trim().min(1).max(2_000),
  facts: z.array(z.string().trim().min(1).max(500)).max(12),
});
export type CallAnalysisNotes = z.infer<typeof callAnalysisNotesSchema>;

export const callAnalysisVersionSummarySchema = z.strictObject({
  analysisId: uuid,
  version: z.number().int().min(1),
  origin: z.enum(CALL_ANALYSIS_ORIGINS),
  state: z.enum(CALL_ANALYSIS_STATES),
  requestedReason: z.enum(CALL_ANALYSIS_REQUESTED_REASONS),
  model: z.string().min(1).max(64).nullable(),
  transcriptSha256: sha256Hex.nullable(),
  failureReason: z.enum(CALL_ANALYSIS_FAILURE_REASONS).nullable(),
  createdAt: instant,
  completedAt: instant.nullable(),
});
export type CallAnalysisVersionSummary = z.infer<typeof callAnalysisVersionSummarySchema>;

/**
 * `GET /calls/analysis?callSessionId=`.
 *
 *  * `current`: the notes shown — the latest user version, otherwise the latest completed
 *    model version. A model version completed after an edit is in `versions` but never
 *    replaces David's notes.
 *  * `authoritative`: the latest completed model version whose transcript hash is the
 *    current transcript's. Its stored `proposalHash` is what an Apply must echo.
 *  * `pending`: the open model version, if any. `failure`: the latest version, when it failed.
 */
export const callAnalysisResponseSchema = z.strictObject({
  callSessionId: uuid,
  current: z
    .strictObject({
      analysisId: uuid,
      version: z.number().int().min(1),
      origin: z.enum(CALL_ANALYSIS_ORIGINS),
      notes: callAnalysisNotesSchema,
    })
    .nullable(),
  notesVersion: z.number().int().min(1).nullable(),
  authoritative: z
    .strictObject({
      analysisId: uuid,
      version: z.number().int().min(1),
      transcriptSha256: sha256Hex,
      proposalHash: sha256Hex,
      policyVersion: z.string().min(1).max(64),
      proposals: callProposalSetSchema,
      result: callAnalysisResultSchema,
    })
    .nullable(),
  pending: z.strictObject({ analysisId: uuid, version: z.number().int().min(1), createdAt: instant }).nullable(),
  failure: z
    .strictObject({ analysisId: uuid, version: z.number().int().min(1), reason: z.enum(CALL_ANALYSIS_FAILURE_REASONS) })
    .nullable(),
  versions: z.array(callAnalysisVersionSummarySchema).max(50),
});
export type CallAnalysisResponse = z.infer<typeof callAnalysisResponseSchema>;

/** `POST /calls/analysis/edit`: David's notes become a new user version. Answers the read above. */
export const editCallAnalysisCommandSchema = z.strictObject({
  commandId: commandIdSchema,
  clientVersion: semanticVersionSchema,
  callSessionId: uuid,
  notes: callAnalysisNotesSchema,
});
export type EditCallAnalysisCommand = z.infer<typeof editCallAnalysisCommandSchema>;

