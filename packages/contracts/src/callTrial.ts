import { z } from 'zod';
import { CALL_ANALYSIS_FAILURE_REASONS, CALL_PROPOSAL_KINDS, CALL_PROPOSAL_MODES } from './callAnalysis.ts';
import { CALL_OUTCOMES } from './dial.ts';
import { callProposalKeySchema } from './callProposals.ts';
import { TRANSCRIPTION_MINIMUM_SECONDS } from './callSessions.ts';
import { instant, uuid } from './foundationRows.ts';

/**
 * The 10-call shadow trial (slice S3T; David's rules of 2 October 2026).
 *
 * `GET /calls/trial?since=<ISO>` says which calls since `since` count toward the trial,
 * which do not and why, what happened to each counted call's analysis, and how David decided
 * each suggestion, per type. Nothing here changes what is analysed: the eligibility rule is
 * the one the analysis path already applies (`packages/domain/calls/analysisEligibility.ts`).
 */

/**
 * The audit action a later correction of a decided suggestion writes lives with the
 * correction's contract (`callCorrections.ts`, S3X lane X2); re-exported here for the trial
 * read's existing importers.
 */
export { CALL_PROPOSAL_CORRECTED_ACTION } from './callCorrections.ts';

/** The 3a release: the trial's default start. */
export const CALL_TRIAL_DEFAULT_SINCE = '2026-10-02T07:14:00.000Z';

/** The checkpoint: this many answered, eligible, analysed calls. */
export const CALL_TRIAL_TARGET_CALLS = 10;

/** The share of suggestions of a type that must be applied unchanged. */
export const CALL_TRIAL_UNCHANGED_BAR = 0.9;

/** The threshold the trial reports, the one the analysis path uses. */
export const CALL_ANALYSIS_MINIMUM_RECORDING_SECONDS = TRANSCRIPTION_MINIMUM_SECONDS;

/**
 * Why a call is not analysed, in the order the rule asks. `not_answered` is the unanswered
 * calls (counted apart from the rest); every other code is an answered call that is excluded.
 *
 *   * `not_answered` — no `answered_at`, and the provider's status is not `completed`;
 *   * `answered_at_missing` — the provider said `completed`, but no answer was ever recorded
 *     (`answered_at` is null): the analysis path does not transcribe it;
 *   * `not_terminal` — answered, no recording yet, and the call has not ended;
 *   * `no_recording` — answered and ended, with no recording;
 *   * `too_short` — the recording is shorter than `CALL_ANALYSIS_MINIMUM_RECORDING_SECONDS`;
 *   * `transcription_off` — call transcription was off when the call was recorded;
 *   * `transcription_unconfigured` — on, but no transcription worker took the call;
 *   * `transcription_failed` — the transcription provider failed, or the paid attempts ran out;
 *   * `not_channel_labelled` — the transcript is not channel-labelled (Deepgram diarized):
 *     the analysis source never offers it;
 *   * `summary_path` — the call is on the older summary path.
 */
export const CALL_ANALYSIS_EXCLUSION_REASONS = [
  'not_answered',
  'answered_at_missing',
  'not_terminal',
  'no_recording',
  'too_short',
  'transcription_off',
  'transcription_unconfigured',
  'transcription_failed',
  'not_channel_labelled',
  'summary_path',
] as const;
export type CallAnalysisExclusionReason = (typeof CALL_ANALYSIS_EXCLUSION_REASONS)[number];

const count = z.number().int().min(0);

export const callTrialQuerySchema = z.strictObject({ since: instant.optional() });

const excludedSessionSchema = z.object({
  callSessionId: uuid,
  firmId: uuid,
  firmName: z.string(),
  occurredAt: instant,
  /** The call's own duration, from the status callback. */
  callSeconds: count.nullable(),
  /** The recording's duration: the one the threshold reads. */
  recordingSeconds: count.nullable(),
  providerStatus: z.string().nullable(),
  reason: z.enum(CALL_ANALYSIS_EXCLUSION_REASONS),
});

/** What `startsTicked` reads of a suggestion: nothing more. Strict, so nothing more can pass. */
export const callTrialSampleSchema = z.strictObject({
  kind: z.enum(CALL_PROPOSAL_KINDS),
  mode: z.enum(CALL_PROPOSAL_MODES),
  /** The proposed outcome, for an `outcome` suggestion; null for every other kind. */
  outcome: z.enum(CALL_OUTCOMES).nullable(),
});
export type CallTrialSample = z.infer<typeof callTrialSampleSchema>;

const trialTypeSchema = z.object({
  type: z.string().min(1).max(64),
  unchanged: count,
  edited: count,
  declined: count,
  bypassed: count,
  /** No decision yet: "unresolved" on screen. */
  undecided: count,
  /**
   * Decided, then corrected later (the outcome-correction slice, S3X; 0 until it ships): the
   * distinct (analysis, key) pairs with at least one `call.proposal_corrected` row, counted as
   * `original_error` if any of its rows says so, else as `new_information`. The decision rows
   * are never rewritten, so `unchanged` stays the initial acceptance. A correction of an
   * original model error counts against the bar; one for genuinely new information is not a
   * model error.
   */
  correctedOriginalError: count.default(0),
  correctedNewInformation: count.default(0),
  /**
   * The bar's share: (unchanged − the unchanged pairs corrected for an original error) /
   * decided, decided = unchanged + edited + declined + bypassed; null with nothing decided. A
   * correction is not a second decision, so it never changes `decided`.
   */
  acceptedUnchangedShare: z.number().min(0).max(1).nullable(),
  /** Fewer than `minimumDecided` decided: the type stays manual. */
  insufficient: z.boolean(),
  /** How many suggestions of this type were offered to apply, and how many only for review. */
  applyMode: count,
  reviewMode: count,
  /**
   * The shape of one suggestion of this type offered to apply (the newest), or null when none
   * was: the desktop asks its own `startsTicked` of it, so the rule lives in one place. Only
   * what that rule reads — the kind, the mode and the outcome value — and never a quote, an
   * evidence line or any other parameter (review S3T, finding 1: no transcript text here).
   */
  applySample: callTrialSampleSchema.nullable(),
});

export const callTrialResponseSchema = z.object({
  since: instant,
  minimumRecordingSeconds: z.number().int().min(1),
  target: z.number().int().min(1),
  minimumDecided: z.number().int().min(1),
  progress: z.object({
    /** Placed calls that were answered (`answered_at`, or the provider's `completed`). */
    answered: count,
    /** Answered calls the analysis path takes. */
    eligible: count,
    /** Eligible calls with a completed model analysis: the checkpoint counts these toward `target`. */
    analysed: count,
    /** Analysed calls with every suggestion decided. */
    fullyDecided: count,
  }),
  unanswered: z.object({
    total: count,
    byProviderStatus: z.array(z.object({ providerStatus: z.string(), count })),
  }),
  excluded: z.object({
    /** Answered but excluded, per reason (`not_answered` is never here). */
    byReason: z.array(z.object({ reason: z.enum(CALL_ANALYSIS_EXCLUSION_REASONS), count })),
    sessions: z.array(excludedSessionSchema),
  }),
  analysis: z.object({
    completed: count,
    failed: count,
    failedByReason: z.array(z.object({ reason: z.enum(CALL_ANALYSIS_FAILURE_REASONS), count })),
    /** Transcribing, queued or being analysed. */
    pending: count,
    /** Waiting on a switch, a cap or a ceiling: nothing will move it until a setting changes. */
    held: count,
  }),
  /**
   * The check line: calls held for review that the analysis path excludes. 0 by
   * construction (the hold is admitted on the analysis rule, S3T); anything else is a defect.
   */
  heldButExcluded: count,
  types: z.array(trialTypeSchema),
  /**
   * Every stop or deal-opening suggestion on these calls that David declined or edited, or
   * (once corrections exist) corrected later for an original model error, by id.
   */
  incorrect: z.array(
    z.object({
      analysisId: uuid,
      callSessionId: uuid,
      key: callProposalKeySchema,
      type: z.enum(['buying_signal', 'stop']),
      result: z.enum(['declined', 'edited', 'corrected']),
      decidedAt: instant,
    }),
  ),
});
export type CallTrialResponse = z.infer<typeof callTrialResponseSchema>;
