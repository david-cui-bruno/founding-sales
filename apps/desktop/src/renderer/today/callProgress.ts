import { TRANSCRIPTION_MINIMUM_SECONDS, type CallSessionDto } from '@fss/contracts';

/**
 * What happened after a call, as a pure function of the firm's latest call session and
 * the clock (slice S2: "call, recording, transcription and analysis status refresh in place
 * with understandable states").
 *
 * The four steps are facts the server already reports on `GET /calls/history?include=summary`:
 * the session's status, whether a recording arrived, whether a transcript exists, and the
 * summary. What the Mac cannot know is whether transcription or summaries are switched on
 * (an integration setting it never reads here), so "still coming" is bounded by time: a
 * step that has not arrived well after its usual delay says so plainly rather than spinning
 * for ever. The bounds are deliberately generous — a transcription look runs every 20 s
 * and backs off to 5 min — because the wrong answer here is "failed" for something that is
 * merely slow.
 */

export type StepState = 'waiting' | 'pending' | 'done' | 'failed' | 'skipped';

export interface CallStep {
  readonly state: StepState;
  /** The short word the chip shows after the step's name: "in progress", "done", "not recorded". */
  readonly word: string;
}

export interface CallProgress {
  readonly sessionId: string;
  readonly call: CallStep;
  readonly recording: CallStep;
  readonly transcription: CallStep;
  readonly analysis: CallStep;
  /** One sentence under the chips, or null when the chips say it all. */
  readonly sentence: string | null;
  /** True while a step is still expected: the history is read again, and only then. */
  readonly polling: boolean;
}

/** How long after the call ends each step is still "on its way". */
export const RECORDING_GRACE_MS = 5 * 60_000;
export const TRANSCRIPT_GRACE_MS = 20 * 60_000;
export const SUMMARY_GRACE_MS = 30 * 60_000;

const LIVE = new Set(['authorized', 'ringing', 'in_progress']);

const step = (state: StepState, word: string): CallStep => ({ state, word });

function endedAt(call: CallSessionDto): number | null {
  const at = call.endedAt ?? call.answeredAt ?? call.startedAt;
  if (at === null) return null;
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? parsed : null;
}

export function callProgress(call: CallSessionDto, now: number): CallProgress {
  if (LIVE.has(call.status)) {
    return {
      sessionId: call.sessionId,
      call: step('pending', call.status === 'in_progress' ? 'connected' : 'ringing'),
      recording: step('waiting', 'waiting'),
      transcription: step('waiting', 'waiting'),
      analysis: step('waiting', 'waiting'),
      sentence: null,
      polling: true,
    };
  }
  const answered = call.answeredAt !== null;
  const since = (() => {
    const at = endedAt(call);
    return at === null ? Number.POSITIVE_INFINITY : now - at;
  })();

  if (call.status === 'failed' || call.status === 'canceled' || !answered) {
    const word = call.status === 'failed' ? 'failed' : call.status === 'canceled' ? 'cancelled' : 'not answered';
    return {
      sessionId: call.sessionId,
      call: step(call.status === 'failed' ? 'failed' : 'done', word),
      recording: step('skipped', 'none'),
      transcription: step('skipped', 'none'),
      analysis: step('skipped', 'none'),
      sentence: 'Nobody answered, so there is nothing to record or transcribe.',
      polling: false,
    };
  }

  const recording = call.hasRecording
    ? step('done', 'saved')
    : since < RECORDING_GRACE_MS
      ? step('pending', 'on its way')
      : step('failed', 'missing');

  const tooShort = (call.durationSeconds ?? 0) < TRANSCRIPTION_MINIMUM_SECONDS;
  const hasTranscript = call.hasTranscript === true;
  const transcription = hasTranscript
    ? step('done', 'done')
    : tooShort
      ? step('skipped', 'too short')
      : !call.hasRecording
        ? step('waiting', 'waiting')
        : since < TRANSCRIPT_GRACE_MS
          ? step('pending', 'in progress')
          : step('failed', 'not back');

  // The summary is made from the transcript: with none coming, there is none to wait for.
  const noTranscriptComing = transcription.state === 'skipped' || transcription.state === 'failed';
  const analysis =
    call.summary !== undefined
      ? step('done', 'done')
      : hasTranscript
        ? since < SUMMARY_GRACE_MS
          ? step('pending', 'in progress')
          : step('failed', 'not back')
        : noTranscriptComing
          ? step('skipped', 'none')
          : step('waiting', 'waiting');

  const sentence =
    recording.state === 'failed'
      ? 'No recording arrived for this call. Write what matters in a note.'
      : transcription.state === 'skipped'
        ? 'Too short to transcribe. Add a note if anything was said.'
        : transcription.state === 'failed'
          ? 'No transcript came back (transcription may be off). The recording is kept; add a note or set the outcome yourself.'
          : analysis.state === 'failed'
            ? 'No summary came back. The transcript is on the firm page.'
            : analysis.state === 'done'
              ? 'Summary saved to the firm.'
              : 'The summary arrives here on its own. You can move on.';

  const polling =
    since < SUMMARY_GRACE_MS && [recording, transcription, analysis].some(entry => entry.state === 'pending' || entry.state === 'waiting');

  return {
    sessionId: call.sessionId,
    call: step('done', 'ended'),
    recording,
    transcription,
    analysis,
    sentence,
    polling,
  };
}

/** The firm's latest placed call, by when it started; null when it has none. */
export function latestCall(calls: readonly CallSessionDto[]): CallSessionDto | null {
  let latest: CallSessionDto | null = null;
  let latestAt = Number.NEGATIVE_INFINITY;
  for (const call of calls) {
    const at = Date.parse(call.startedAt ?? call.endedAt ?? '') || 0;
    if (latest === null || at > latestAt) {
      latest = call;
      latestAt = at;
    }
  }
  return latest;
}

/** How often the history is read again while something is still on its way. */
export const CALL_PROGRESS_POLL_MS = 4_000;
