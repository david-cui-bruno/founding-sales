import { CALL_ANALYSIS_MINIMUM_RECORDING_SECONDS, type CallAnalysisExclusionReason } from '@fss/contracts';

/**
 * Which calls are analysed: the one explicit rule (slice S3T, David's rule of 2 October
 * 2026: "make the analysis eligibility rules explicit, including the 20-second threshold").
 *
 * It states what the code already does, in the order the call travels:
 *
 *   1. **Admission** — what `enqueueCallTranscription` and `listHeldTranscriptions`
 *      (`transcription.ts`) ask before a call is transcribed, and what `admitPendingHold`
 *      (`pendingHold.ts`) asks before the firm is held for review. Since S3T the hold is
 *      admitted on exactly this rule, so a call is held if and only if it is on its way to an
 *      analysis:
 *        * `answered_at` is set (a provider status of `completed` alone is not an answer);
 *        * there is a recording of at least `CALL_ANALYSIS_MINIMUM_RECORDING_SECONDS` (20 s,
 *          the shared `TRANSCRIPTION_MINIMUM_SECONDS`), by the recording's own duration;
 *        * `call_transcription` is on, with a ceiling above 0.
 *      The session's status is not asked: the recording is delivered once the call has ended.
 *   2. **Transcription** — the transcript must be stored; a call whose provider job failed or
 *      whose paid attempts ran out is not; one that no transcription worker took is not.
 *   3. **The analysis source** (`listOwedAnalyses`, `analysisPaid.ts`) — the transcript is
 *      channel-labelled, and the call is not on the older summary path.
 *
 * An eligible call's analysis may still fail (an empty transcript fails `transcript_missing`,
 * as the paid path decides it): that is an outcome of the analysis, reported as one, not an
 * exclusion.
 *
 * The SQL that applies step 1 lives beside the code that owns it (`transcription.ts`
 * `eligible` and `listHeldTranscriptions`; `pendingHold.ts` reads the facts and asks
 * `callAnalysisAdmission`). The agreement table
 * (`test/calls/analysisEligibilityContract.test.ts`) binds them: the same session facts give
 * the same answer from the hold, from the transcription enqueue and from this function.
 */

export { CALL_ANALYSIS_MINIMUM_RECORDING_SECONDS };

/** The session facts admission reads. */
export interface CallAdmissionFacts {
  /** `call_sessions.status`. */
  readonly status: string;
  readonly providerStatus: string | null;
  /** `answered_at IS NOT NULL`. */
  readonly answered: boolean;
  /** `recording_path IS NOT NULL`. */
  readonly recording: boolean;
  /** `recording_duration_seconds`. */
  readonly recordingSeconds: number | null;
  /** `call_transcription` on, with a ceiling above 0. */
  readonly transcriptionOn: boolean;
}

/** What happened after admission. */
export interface CallTranscriptFacts {
  /** The stored transcript, if any, and whether it is channel-labelled. */
  readonly transcript: 'none' | 'channel_labelled' | 'not_channel_labelled';
  /** No transcript, and a `call.transcribe` job was ever queued for the call. */
  readonly transcribeQueued: boolean;
  /** No transcript, and the provider job failed or the paid attempts ran out. */
  readonly transcriptionFailed: boolean;
  /** The call is on the older summary path (`postCallModelPath`). */
  readonly summaryPath: boolean;
}

export type CallAnalysisFacts = CallAdmissionFacts & CallTranscriptFacts;

export type CallAnalysisEligibility =
  | { readonly kind: 'eligible' }
  | { readonly kind: 'excluded'; readonly reason: CallAnalysisExclusionReason; readonly recordingSeconds: number | null };

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'canceled']);

const excluded = (reason: CallAnalysisExclusionReason, facts: CallAdmissionFacts): CallAnalysisEligibility => ({
  kind: 'excluded',
  reason,
  recordingSeconds: facts.recordingSeconds,
});

/** Answered for the report: an answer was recorded, or the provider said `completed`. */
export function callWasAnswered(facts: Pick<CallAdmissionFacts, 'answered' | 'providerStatus'>): boolean {
  return facts.answered || facts.providerStatus === 'completed';
}

/**
 * Step 1, admission: the rule the hold and the transcription enqueue share. The reason is
 * the first gate the call fails; `not_terminal` and `no_recording` say the same thing (no
 * recording) for a call that is still live and one that has ended.
 */
export function callAnalysisAdmission(facts: CallAdmissionFacts): CallAnalysisEligibility {
  if (!facts.answered) return excluded(facts.providerStatus === 'completed' ? 'answered_at_missing' : 'not_answered', facts);
  if (!facts.recording || facts.recordingSeconds === null) return excluded(TERMINAL_STATUSES.has(facts.status) ? 'no_recording' : 'not_terminal', facts);
  if (facts.recordingSeconds < CALL_ANALYSIS_MINIMUM_RECORDING_SECONDS) return excluded('too_short', facts);
  if (!facts.transcriptionOn) return excluded('transcription_off', facts);
  return { kind: 'eligible' };
}

/** The whole rule: admission, then the transcript, then the analysis source. */
export function callAnalysisEligibility(facts: CallAnalysisFacts): CallAnalysisEligibility {
  const admitted = callAnalysisAdmission(facts);
  if (admitted.kind === 'excluded') return admitted;
  if (facts.summaryPath) return excluded('summary_path', facts);
  if (facts.transcript === 'not_channel_labelled') return excluded('not_channel_labelled', facts);
  if (facts.transcript === 'none') {
    if (facts.transcriptionFailed) return excluded('transcription_failed', facts);
    if (!facts.transcribeQueued) return excluded('transcription_unconfigured', facts);
  }
  return { kind: 'eligible' };
}
