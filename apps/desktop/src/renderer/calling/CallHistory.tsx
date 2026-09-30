import { useEffect, useRef, useState, type JSX } from 'react';
import type { CallSessionDto } from '@fss/contracts';
import { Button } from '../ui/button.tsx';
import { callTimer } from './callText.ts';
import { playRecording, type Playback } from './playRecording.ts';

/**
 * The firm's calls placed from Callie, with their duration and a Play control (slice C1).
 * Shown on the firm page (`FirmPage.tsx`). The audio comes through the API's proxy — the
 * Mac never holds a Twilio URL — and plays from a `blob:` URL revoked when it stops
 * (`playRecording.ts`).
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
}

export function registryHistoryPorts(): CallHistoryPorts | null {
  const api = globalThis.callieApi;
  if (api === undefined) return null;
  return {
    history: async firmId => await api.read('calling.history', { firmId }),
    recording: async sessionId => await api.read('calling.recording', { sessionId }),
  };
}

export function CallHistory({ firmId, ports = registryHistoryPorts() }: { readonly firmId: string; readonly ports?: CallHistoryPorts | null }): JSX.Element | null {
  const [calls, setCalls] = useState<readonly CallSessionDto[] | null | undefined>(undefined);
  const [playing, setPlaying] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const playback = useRef<Playback | null>(null);
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
      playback.current?.stop();
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
    playback.current?.stop();
    setProblem(null);
    setPlaying(sessionId);
    try {
      const answer = await ports.recording(sessionId);
      if (answer.recording === null) {
        setProblem('Callie could not read that recording just now. Try again in a minute.');
        setPlaying(null);
        return;
      }
      const started = await (ports.play ?? playRecording)(answer.recording.audioBase64, answer.recording.contentType);
      playback.current = started;
      await started.ended;
    } catch {
      setProblem('That recording could not be played.');
    }
    setPlaying(current => (current === sessionId ? null : current));
  };

  return (
    <section data-testid="call-history" className="flex flex-col">
      <h3 className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Calls</h3>
      <ul className="flex flex-col border-t border-border">
        {calls.map(call => (
          <li key={call.sessionId} data-testid="call-history-row" className="group/row flex items-center gap-3 border-b border-border py-1.5 text-sm">
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
                    playback.current?.stop();
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
