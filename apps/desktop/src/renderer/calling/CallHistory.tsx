import { useEffect, useRef, useState, type JSX } from 'react';
import {
  hasReasonSentence,
  reasonSentence,
  transcriptIsChannelLabelled,
  transcriptSpeakerLabels,
  type CallLogRowDto,
  type CallSessionDto,
  type CallTranscriptResponse,
} from '@fss/contracts';
import { currentCrmMemory } from '../firms/crmMemory.ts';
import { OUTCOME_LABELS } from '../outcomeForm.ts';
import { ChangeOutcome, type CorrectionPorts } from './ChangeOutcome.tsx';
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
 *
 * S3X lane X2 (RESET C): the history also reads every call log of the firm from the database
 * alone (`calling.logs`, `GET /calls?firmId=&include=corrections`). Each session row with a log
 * gains its outcome with "Change" (`ChangeOutcome.tsx`), showing "Interested · corrected from
 * No answer, 2 Oct"; every log no session row shows — a form or incoming log, a log linked to an
 * unconsumed session, or every log while the session read failed — gets a row of its own,
 * newest first. A correction or a lift re-fetches both reads.
 *
 * K7 (review of X2, finding 1): both reads are kept with the firm and the read generation they
 * answered. An answer for a firm no longer shown, or for an older read, is dropped; a row shows
 * only when it belongs to the firm shown; and "Change" is disabled while the shown firm's log
 * read is pending, so nothing on screen can correct another firm's call.
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
  /** S3X lane X2: every call log of the firm. Absent (an older host) means no outcome can be changed. */
  logs?: (firmId: string) => Promise<{ readonly calls: readonly CallLogRowDto[] | null }>;
  /** S3X lane X2: the correction's three operations; absent means the registry's. */
  correction?: CorrectionPorts | null;
}

export function registryHistoryPorts(): CallHistoryPorts | null {
  const api = globalThis.callieApi;
  if (api === undefined) return null;
  return {
    history: async firmId => await api.read('calling.history', { firmId }),
    recording: async sessionId => await api.read('calling.recording', { sessionId }),
    transcript: async callSessionId => await api.read('calling.transcript', { callSessionId }),
    logs: async firmId => await api.read('calling.logs', { firmId }),
  };
}

/**
 * The note typed when the call was logged (S4F), two lines of it with the rest behind "Show
 * more". Whether it is open is kept above the route by call, so it is as it was left.
 */
export function CallNote({ sessionId, note }: { readonly sessionId: string; readonly note: string }): JSX.Element {
  const [, redraw] = useState(0);
  const key = `note:${sessionId}`;
  const memory = currentCrmMemory();
  const open = memory.pageEditors[key] === true;
  const long = note.length > 140 || note.includes('\n');
  return (
    <div data-testid="call-note" className="mt-0.5 text-sm text-muted-foreground">
      <p data-testid="call-note-text" className={open || !long ? 'whitespace-pre-wrap' : 'line-clamp-2 whitespace-pre-wrap'}>
        {note}
      </p>
      {long ? (
        <button
          type="button"
          data-testid="call-note-toggle"
          aria-expanded={open}
          className="text-xs text-faint hover:text-foreground"
          onClick={() => {
            memory.pageEditors[key] = !open;
            redraw(n => n + 1);
          }}
        >
          {open ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
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

export function CallHistory({
  firmId,
  timeZone = null,
  ports = registryHistoryPorts(),
}: {
  readonly firmId: string;
  /** The firm's zone, for a corrected callback's day and time. */
  readonly timeZone?: string | null;
  readonly ports?: CallHistoryPorts | null;
}): JSX.Element | null {
  // A correction or a lift asks for both reads again (this view does not use React Query).
  const [reads, setReads] = useState(0);
  // Each answer is kept with the firm and the generation it answered (K7).
  const [sessionRead, setSessionRead] = useState<{ readonly firmId: string; readonly read: number; readonly calls: readonly CallSessionDto[] | null } | null>(null);
  const [logRead, setLogRead] = useState<{ readonly firmId: string; readonly read: number; readonly calls: readonly CallLogRowDto[] | null } | null>(null);
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
    // K7: an answer for a firm no longer shown, or for an older read, is dropped.
    void portsRef.current?.history(firmId).then(
      answer => {
        if (current) setSessionRead({ firmId, read: reads, calls: answer.calls });
      },
      () => {
        if (current) setSessionRead({ firmId, read: reads, calls: null });
      },
    );
    void portsRef.current?.logs?.(firmId).then(
      answer => {
        if (current) setLogRead({ firmId, read: reads, calls: answer.calls });
      },
      () => {
        if (current) setLogRead({ firmId, read: reads, calls: null });
      },
    );
    return () => {
      current = false;
    };
  }, [firmId, reads]);
  useEffect(() => () => stopPlayback(), [firmId]);

  // Only the shown firm's answers count. A re-read of the same firm keeps its rows on screen
  // until it answers; another firm's never show.
  const calls = sessionRead !== null && sessionRead.firmId === firmId ? sessionRead.calls : undefined;
  const logs = logRead !== null && logRead.firmId === firmId ? (logRead.calls ?? []).filter(log => log.firmId === firmId) : [];
  const logsPending = logRead === null || logRead.firmId !== firmId || logRead.read !== reads;
  const logById = new Map(logs.map(log => [log.id, log] as const));
  const shownLogIds = new Set((calls ?? []).flatMap(call => (call.callLogId === null ? [] : [call.callLogId])));
  const ownRows = logs.filter(log => !shownLogIds.has(log.id));
  const reread = (): void => {
    setReads(count => count + 1);
  };
  const outcomeCell = (callLogId: string, fallback: CallSessionDto['outcome']): JSX.Element | null => {
    const log = logById.get(callLogId);
    if (log === undefined) {
      return fallback == null ? null : (
        <span data-testid="call-history-outcome" className="text-xs font-medium">
          {OUTCOME_LABELS[fallback]}
        </span>
      );
    }
    return (
      <ChangeOutcome
        key={callLogId}
        callLogId={callLogId}
        currentOutcome={log.outcome}
        corrections={log.corrections}
        timeZone={timeZone}
        enabled={!logsPending}
        onChanged={reread}
        {...(ports?.correction === undefined ? {} : { ports: ports.correction })}
      />
    );
  };

  if (ports === null || calls === undefined) return null;
  if (calls === null && ownRows.length === 0) {
    return (
      <p data-testid="call-history-unavailable" className="text-xs text-muted-foreground">
        Callie could not read this firm’s calls just now.
      </p>
    );
  }
  if ((calls ?? []).length === 0 && ownRows.length === 0) return null;
  // One list, newest first: the placed calls in their order, each log of its own at its time.
  const atOf = (value: string | null): number => (value === null ? 0 : Date.parse(value));
  const merged: ({ readonly kind: 'session'; readonly call: CallSessionDto; readonly at: number } | { readonly kind: 'log'; readonly log: CallLogRowDto; readonly at: number })[] = [];
  const sessions = (calls ?? []).map(call => ({ kind: 'session' as const, call, at: atOf(call.startedAt ?? call.endedAt) }));
  const own = ownRows.map(log => ({ kind: 'log' as const, log, at: atOf(log.occurredAt) }));
  let i = 0;
  let j = 0;
  while (i < sessions.length || j < own.length) {
    const session = sessions[i];
    const log = own[j];
    if (log === undefined || (session !== undefined && session.at >= log.at)) {
      if (session !== undefined) merged.push(session);
      i += 1;
    } else {
      merged.push(log);
      j += 1;
    }
  }

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
      <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">Calls</h3>
      <ul className="flex flex-col border-t border-border">
        {merged.map(entry => entry.kind === 'log' ? logRow(entry.log) : sessionRow(entry.call))}
      </ul>
      {problem === null ? null : (
        <p data-testid="call-history-problem" className="mt-1 text-xs text-muted-foreground">
          {problem}
        </p>
      )}
    </section>
  );

  function sessionRow(call: CallSessionDto): JSX.Element {
    return (
          <li key={call.sessionId} data-testid="call-history-row" className="group/row flex flex-col border-b border-border py-1.5 text-sm">
            <div className="flex items-center gap-3">
              <span className="flex-1 truncate">{when(call.startedAt ?? call.endedAt)}</span>
              {call.callLogId === null ? null : outcomeCell(call.callLogId, call.outcome ?? null)}
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
            {(() => {
              // The history read's note, or the one `GET /calls` returned for the same log.
              const note = call.note ?? (call.callLogId === null ? null : (logById.get(call.callLogId)?.note ?? null));
              return note === null ? null : <CallNote sessionId={call.sessionId} note={note} />;
            })()}
            {call.summary === undefined ? null : <CallSummaryBlock summary={call.summary} />}
            {call.hasTranscript === true && ports?.transcript !== undefined ? (
              <TranscriptDisclosure callSessionId={call.sessionId} read={ports.transcript} />
            ) : null}
          </li>
    );
  }

  function logRow(log: CallLogRowDto): JSX.Element {
    return (
          <li key={log.id} data-testid="call-history-log-row" className="flex flex-col border-b border-border py-1.5 text-sm">
            <div className="flex items-center gap-3">
              <span className="flex-1 truncate">
                {when(log.occurredAt)}
                <span className="ml-2 text-xs text-muted-foreground">{log.direction === 'inbound' ? 'Incoming' : 'Logged'}</span>
              </span>
              {outcomeCell(log.id, log.outcome)}
              <span className="w-14 text-right text-xs text-muted-foreground tabular-nums">
                {log.durationSeconds === null ? '—' : callTimer(log.durationSeconds)}
              </span>
              <span className="w-12" />
            </div>
            {log.note === null ? null : <CallNote sessionId={log.id} note={log.note} />}
          </li>
    );
  }
}
