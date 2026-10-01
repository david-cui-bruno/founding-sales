import { z } from 'zod';
import { instant } from './foundationRows.ts';

/**
 * After-call summaries (slice C3b, migration 0032).
 *
 * After a recorded call has a transcript, the worker asks a model for a short summary,
 * up to five suggested next steps, and the commitments it heard, quoted. **Suggestions
 * only**: nothing here is sent or scheduled by anybody but David, and the Mac shows them
 * as text under the call.
 *
 * The two sides are named by the recording's channel, never by a voice: `you` is the
 * caller (David, the Twilio parent leg), `them` is the person called.
 */

export const CALL_SUMMARY_SIDES = ['you', 'them'] as const;
export type CallSummarySide = (typeof CALL_SUMMARY_SIDES)[number];

/** The most next steps one summary keeps. */
export const CALL_SUMMARY_MAX_NEXT_STEPS = 5;
/** The most commitments one summary keeps. */
export const CALL_SUMMARY_MAX_COMMITMENTS = 10;

export const callSummaryNextStepSchema = z.strictObject({
  /** What to do, in a short imperative phrase. */
  action: z.string().min(1).max(300),
  /** Whose step it is, when the call made that clear. */
  owner: z.enum(CALL_SUMMARY_SIDES).nullable(),
  /** When, in the call's own words ("by Friday"), checked to be in the transcript. */
  due: z.string().min(1).max(120).nullable(),
});
export type CallSummaryNextStep = z.infer<typeof callSummaryNextStepSchema>;

export const callSummaryCommitmentSchema = z.strictObject({
  speaker: z.enum(CALL_SUMMARY_SIDES),
  /** Verbatim from that side's lines; one that is not found there is not kept. */
  quote: z.string().min(1).max(500),
});
export type CallSummaryCommitment = z.infer<typeof callSummaryCommitmentSchema>;

/**
 * One call's summary as the history read carries it (`GET /calls/history?firmId=…&
 * include=summary`). Absent from a call that has none, and absent from every call unless
 * the reader asked: an older Mac never asks, so its strict parser never meets it.
 */
export const callSummaryDtoSchema = z.strictObject({
  summary: z.string().min(1).max(2_000),
  nextSteps: z.array(callSummaryNextStepSchema).max(CALL_SUMMARY_MAX_NEXT_STEPS),
  commitments: z.array(callSummaryCommitmentSchema).max(CALL_SUMMARY_MAX_COMMITMENTS),
  model: z.string().min(1).max(64),
  createdAt: instant,
});
export type CallSummaryDto = z.infer<typeof callSummaryDtoSchema>;

/** The `include` value that adds `summary` to each call of the history read. */
export const CALL_HISTORY_INCLUDE_SUMMARY = 'summary';

/**
 * How one side of a call is shown: by the recording's channel (slice C3a's mapping —
 * channel 0 is the Twilio parent leg, the caller; channel 1 is the person called).
 */
export const CALL_SIDE_LABELS: Readonly<Record<CallSummarySide, string>> = Object.freeze({ you: 'You', them: 'Them' });
