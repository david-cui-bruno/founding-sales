import { useEffect, useRef, useState, type JSX } from 'react';
import {
  hasReasonSentence,
  reasonSentence,
  transcriptIsChannelLabelled,
  transcriptSpeakerLabels,
  type CallSessionDto,
  type CallTranscriptResponse,
} from '@fss/contracts';
import { CallSummaryBlock } from './CallSummary.tsx';
import { Button } from '../ui/button.tsx';
import { callTimer } from './callText.ts';
import { playRecording, type Playback } from './playRecording.ts';

/**
 * The firm's calls placed from Callie, with their duration and a Play control (slice C1).
 * Shown on the firm page (`FirmPage.tsx`). The audio comes through the API's proxy — the
 * Mac never holds a Twilio URL — and plays from a `blob:` URL revoked when it stops
 * (`playRecording.ts`).
 *
 * Slice C2: a call with a transcript has a "Transcript" disclosure under its row. Opening
 * it reads the transcript once; each utterance is its speaker — "You" and "Them" for a
 * channel-labelled transcript (slice C3a: the recording's legs), "Speaker 1", "Speaker 2", …
 * for C2's diarized ones (`transcriptSpeakerLabels`) — its time
 * in grey, and what was said. A call with no
 * transcript shows nothing; a read that failed is a sentence from `reasonSentence`.
 *
 * Slice C3b: a call with a summary shows it under its row, above the transcript: a few
 * sentences, the suggested next steps and the commitments heard (`CallSummary.tsx`).
 */

const STATUS_WORDS: Readonly<Record<CallSessionDto['status'], string>> = Object.freeze({
  authorized: 'Not placed',
  ringing: 'Ringing',
  in_progress: 'In progress',
  completed: 'Completed',
  failed: 'Failed',
  canceled: 'Cancelled',
});

const when = (value: string | null): string =>
  value === null
    ? ''
    : new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export interface CallHistoryPorts {
  history(firmId: string): Promise<{ readonly calls: readonly CallSessionDto[] | null }>;
  recording(sessionId: string): Promise<{
    readonly recording: { readonly audioBase64: string; readonly contentType: string } | null;
    readonly reason: string | null;
  }>;
  play?: (audioBase64: string, contentType: string) => Promise<Playback>;
  /** Slice C2. Absent (an older host) means no disclosure is offered. */
  transcript?: (callSessionId: string) => Promise<{
    readonly transcript: CallTranscriptResponse | null;
    readonly reason: string | null;
  }>;
}

export function registryHistoryPorts(): CallHistoryPorts | null {
  const api = globalThis.callieApi;
  if (api === undefined) return null;
  return {
    history: async firmId => await api.read('calling.history', { firmId }),
    recording: async sessionId => await api.read('calling.recording', { sessionId }),
    transcript: async callSessionId => await api.read('calling.transcript', { callSessionId }),
  };
}

/** `m:ss` from the start of the recording. */
export function transcriptTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60))}:${String(whole % 60).padStart(2, '0')}`;
}

type TranscriptState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'shown'; readonly transcript: CallTranscriptResponse }
  | { readonly kind: 'none' }
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * One call's "Transcript" disclosure. Closed until opened, and the read is made on the
 * first opening only. Nothing at all is rendered when the read says there is none.
 */
export function TranscriptDisclosure({
  callSessionId,
  read,
}: {
  readonly callSessionId: string;
  readonly read: NonNullable<CallHistoryPorts['transcript']>;
}): JSX.Element | null {
  const [state, setState] = useState<TranscriptState | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (state?.kind === 'none') return null;
  const load = (): void => {
    if (state !== null) return;
    setState({ kind: 'loading' });
    read(callSessionId).then(
      answer => {
        if (!mounted.current) return;
        if (answer.transcript !== null) setState({ kind: 'shown', transcript: answer.transcript });
        else if (answer.reason === null) setState({ kind: 'none' });
        else setState({ kind: 'refused', reason: answer.reason });
      },
      () => {
        if (mounted.current) setState({ kind: 'refused', reason: 'transcript_unavailable' });
      },
    );
  };
  return (
    <details
      data-testid="call-transcript"
      className="text-xs"
      onToggle={event => {
        if ((event.currentTarget as HTMLDetailsElement).open) load();
      }}
    >
      <summary className="cursor-default text-muted-foreground">Transcript</summary>
      {state === null || state.kind === 'loading' ? (
        <p className="py-1 text-muted-foreground">Reading the transcript…</p>
      ) : state.kind === 'refused' ? (
        <p data-testid="call-transcript-problem" className="py-1 text-muted-foreground">
          {reasonSentence(hasReasonSentence(state.reason) ? state.reason : 'transcript_unavailable')}
        </p>
      ) : state.kind === 'shown' ? (
        <TranscriptLines transcript={state.transcript} />
      ) : null}
    </details>
  );
}

function TranscriptLines({ transcript }: { readonly transcript: CallTranscriptResponse }): JSX.Element {
  // Slice C3a: a channel-labelled transcript names its two legs "You" and "Them".
  const labels = transcriptSpeakerLabels(transcript.utterances, { channelLabelled: transcriptIsChannelLabelled(transcript) });
  return (
    <ol data-testid="call-transcript-lines" className="flex flex-col gap-1 py-1">
      {transcript.utterances.map((utterance, index) => (
        <li key={index} data-testid="call-transcript-line" className="flex gap-2">
          <span data-testid="call-transcript-time" className="w-10 shrink-0 text-right text-muted-foreground tabular-nums">
            {transcriptTime(utterance.start)}
          </span>
          <span data-testid="call-transcript-speaker" className="w-16 shrink-0 font-medium">
            {labels.get(utterance.speaker) ?? `Speaker ${String(utterance.speaker + 1)}`}
          </span>
          <span className="min-w-0 flex-1">{utterance.text}</span>
        </li>
      ))}
    </ol>
  );
}

export function CallHistory({ firmId, ports = registryHistoryPorts() }: { readonly firmId: string; readonly ports?: CallHistoryPorts | null }): JSX.Element | null {
  const [calls, setCalls] = useState<readonly CallSessionDto[] | null | undefined>(undefined);
  const [playing, setPlaying] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const playback = useRef<Playback | null>(null);
  /**
   * Which Play press is current (review of C1, fold 2, finding 4). Stop and leaving the
   * page move it on; a recording that arrives afterwards creates no audio and no blob URL,
   * and playback that had already started for it is stopped (which revokes the URL).
   */
  const playRequest = useRef(0);
  const stopPlayback = (): void => {
    playRequest.current += 1;
    playback.current?.stop();
    playback.current = null;
  };
  const portsRef = useRef(ports);
  portsRef.current = ports;

  useEffect(() => {
    let current = true;
    setCalls(undefined);
    void portsRef.current?.history(firmId).then(
      answer => {
        if (current) setCalls(answer.calls);
      },
      () => {
        if (current) setCalls(null);
      },
    );
    return () => {
      current = false;
      stopPlayback();
    };
  }, [firmId]);

  if (ports === null || calls === undefined) return null;
  if (calls === null) {
    return (
      <p data-testid="call-history-unavailable" className="text-xs text-muted-foreground">
        Callie could not read this firm’s calls just now.
      </p>
    );
  }
  if (calls.length === 0) return null;

  const play = async (sessionId: string): Promise<void> => {
    stopPlayback();
    const mine = playRequest.current;
    const cancelled = (): boolean => mine !== playRequest.current;
    setProblem(null);
    setPlaying(sessionId);
    try {
      const answer = await ports.recording(sessionId);
      // Stopped, or the page left, while the recording was on the wire: nothing is made.
      if (cancelled()) return;
      if (answer.recording === null) {
        setProblem('Callie could not read that recording just now. Try again in a minute.');
        setPlaying(null);
        return;
      }
      const started = await (ports.play ?? playRecording)(answer.recording.audioBase64, answer.recording.contentType);
      if (cancelled()) {
        started.stop();
        return;
      }
      playback.current = started;
      await started.ended;
    } catch {
      if (cancelled()) return;
      setProblem('That recording could not be played.');
    }
    if (cancelled()) return;
    playback.current = null;
    setPlaying(current => (current === sessionId ? null : current));
  };

  return (
    <section data-testid="call-history" className="flex flex-col">
      <h3 className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Calls</h3>
      <ul className="flex flex-col border-t border-border">
        {calls.map(call => (
          <li key={call.sessionId} data-testid="call-history-row" className="group/row flex flex-col border-b border-border py-1.5 text-sm">
            <div className="flex items-center gap-3">
              <span className="flex-1 truncate">{when(call.startedAt ?? call.endedAt)}</span>
              <span className="text-xs text-muted-foreground">{STATUS_WORDS[call.status]}</span>
              <span data-testid="call-history-duration" className="w-14 text-right text-xs text-muted-foreground tabular-nums">
                {call.durationSeconds === null ? '—' : callTimer(call.durationSeconds)}
              </span>
              {call.hasRecording ? (
                <Button
                  variant="quiet"
                  size="sm"
                  data-testid="call-history-play"
                  onClick={() => {
                    if (playing === call.sessionId) {
                      stopPlayback();
                      setPlaying(null);
                      return;
                    }
                    void play(call.sessionId);
                  }}
                >
                  {playing === call.sessionId ? 'Stop' : 'Play'}
                </Button>
              ) : (
                <span className="w-12" />
              )}
            </div>
            {call.summary === undefined ? null : <CallSummaryBlock summary={call.summary} />}
            {call.hasTranscript === true && ports.transcript !== undefined ? (
              <TranscriptDisclosure callSessionId={call.sessionId} read={ports.transcript} />
            ) : null}
          </li>
        ))}
      </ul>
      {problem === null ? null : (
        <p data-testid="call-history-problem" className="mt-1 text-xs text-muted-foreground">
          {problem}
        </p>
      )}
    </section>
  );
}
