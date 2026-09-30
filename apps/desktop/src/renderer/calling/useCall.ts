import { useCallback, useEffect, useRef, useState } from 'react';
import type { CallStart } from '../../shared/operations.ts';
import { CALL_FAILED_SENTENCE, MICROPHONE_DENIED_SENTENCE, callRefusalSentence, isMicrophoneDenied } from './callText.ts';
import { twilioVoiceDevice, type VoiceCall, type VoiceDevice, type VoiceDeviceFactory } from './voiceDevice.ts';

/**
 * One call placed from Callie, as the page sees it (slice C1).
 *
 *   idle → starting (main: cadence, session, token) → ringing (Device connected with the
 *   session id) → connected (the prospect answered; the timer runs) → ended (the outcome
 *   form records it, linked to the session).
 *
 * A refusal from the server is a sentence and nothing is dialled; a microphone macOS
 * refused is its own sentence, saying where to allow it. The main process is told when a
 * call becomes live and when it ends, so an update never relaunches the app under it.
 */

export type CallPhase =
  | { readonly phase: 'idle' }
  | { readonly phase: 'starting'; readonly firmId: string; readonly routeId: string }
  | CallLive
  | { readonly phase: 'ended'; readonly firmId: string; readonly routeId: string; readonly sessionId: string; readonly seconds: number }
  | { readonly phase: 'refused'; readonly firmId: string; readonly routeId: string; readonly sentence: string };

interface CallLive {
  readonly phase: 'ringing' | 'connected';
  readonly firmId: string;
  readonly routeId: string;
  readonly sessionId: string;
  readonly attempt: number | null;
  readonly voicemailScript: string | null;
  /** When the prospect answered (ms), for the timer; null while ringing. */
  readonly answeredAt: number | null;
}

export interface CallPorts {
  start(input: { readonly firmId: string; readonly contactId: string | null; readonly routeId: string }): Promise<CallStart>;
  setActive(active: boolean): Promise<unknown>;
  device?: VoiceDeviceFactory;
  now?: () => number;
}

export interface CallControl {
  readonly state: CallPhase;
  readonly muted: boolean;
  /** Whole seconds since the prospect answered; 0 until then. */
  readonly seconds: number;
  place(input: { readonly firmId: string; readonly contactId: string | null; readonly routeId: string }): void;
  toggleMute(): void;
  hangUp(): void;
  /** Forget an ended or refused call (the outcome form took over, or the card closed). */
  dismiss(): void;
}

export function useCall(ports: CallPorts | null): CallControl {
  const [state, setState] = useState<CallPhase>({ phase: 'idle' });
  const [muted, setMuted] = useState(false);
  const [tick, setTick] = useState(0);
  const call = useRef<VoiceCall | null>(null);
  const device = useRef<VoiceDevice | null>(null);
  const live = useRef(false);
  const portsRef = useRef(ports);
  portsRef.current = ports;
  const now = (): number => (portsRef.current?.now ?? Date.now)();

  const setLive = useCallback((next: boolean): void => {
    if (live.current === next) return;
    live.current = next;
    void portsRef.current?.setActive(next).catch(() => undefined);
  }, []);

  const finish = useCallback(
    (update: (current: CallPhase) => CallPhase): void => {
      call.current = null;
      device.current?.destroy();
      device.current = null;
      setMuted(false);
      setLive(false);
      setState(update);
    },
    [setLive],
  );

  const place = useCallback<CallControl['place']>(
    input => {
      const current = portsRef.current;
      if (current === null || live.current) return;
      setState({ phase: 'starting', firmId: input.firmId, routeId: input.routeId });
      void (async () => {
        let started: CallStart;
        try {
          started = await current.start(input);
        } catch {
          setState({ phase: 'refused', firmId: input.firmId, routeId: input.routeId, sentence: CALL_FAILED_SENTENCE });
          return;
        }
        if (!started.ok) {
          setState({ phase: 'refused', firmId: input.firmId, routeId: input.routeId, sentence: callRefusalSentence(started.reason) });
          return;
        }
        const ringing: CallLive = {
          phase: 'ringing',
          firmId: input.firmId,
          routeId: input.routeId,
          sessionId: started.sessionId,
          attempt: started.attempt,
          voicemailScript: started.voicemailScript,
          answeredAt: null,
        };
        setLive(true);
        setState(ringing);
        const ended = (): void => {
          finish(prior => ({
            phase: 'ended',
            firmId: input.firmId,
            routeId: input.routeId,
            sessionId: started.sessionId,
            seconds: prior.phase === 'connected' && prior.answeredAt !== null ? Math.floor((now() - prior.answeredAt) / 1000) : 0,
          }));
        };
        try {
          const made = await (current.device ?? twilioVoiceDevice)(started.token);
          device.current = made;
          // The session id, and nothing else: the number is the server's to put in <Dial>.
          const placed = await made.connect({ sessionId: started.sessionId });
          call.current = placed;
          placed.on('accept', () => {
            setState(prior => (prior.phase === 'ringing' ? { ...prior, phase: 'connected', answeredAt: now() } : prior));
          });
          placed.on('disconnect', ended);
          placed.on('cancel', ended);
          placed.on('reject', ended);
          placed.on('error', (error?: unknown) => {
            if (isMicrophoneDenied(error)) {
              finish(() => ({ phase: 'refused', firmId: input.firmId, routeId: input.routeId, sentence: MICROPHONE_DENIED_SENTENCE }));
            }
          });
        } catch (error: unknown) {
          finish(() => ({
            phase: 'refused',
            firmId: input.firmId,
            routeId: input.routeId,
            sentence: isMicrophoneDenied(error) ? MICROPHONE_DENIED_SENTENCE : CALL_FAILED_SENTENCE,
          }));
        }
      })();
    },
    [finish, setLive],
  );

  const toggleMute = useCallback((): void => {
    const current = call.current;
    if (current === null) return;
    setMuted(prior => {
      current.mute(!prior);
      return !prior;
    });
  }, []);

  const hangUp = useCallback((): void => {
    call.current?.disconnect();
  }, []);

  const dismiss = useCallback((): void => {
    setState(prior => (prior.phase === 'ended' || prior.phase === 'refused' ? { phase: 'idle' } : prior));
  }, []);

  // The timer: once a second while connected.
  const connected = state.phase === 'connected';
  useEffect(() => {
    if (!connected) return;
    const timer = setInterval(() => {
      setTick(value => value + 1);
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [connected]);

  // Leaving the page mid-call hangs up and tells the main process the call is over.
  useEffect(
    () => () => {
      call.current?.disconnect();
      device.current?.destroy();
      if (live.current) {
        live.current = false;
        void portsRef.current?.setActive(false).catch(() => undefined);
      }
    },
    [],
  );

  void tick;
  const seconds = state.phase === 'connected' && state.answeredAt !== null ? Math.floor((now() - state.answeredAt) / 1000) : 0;
  return { state, muted, seconds, place, toggleMute, hangUp, dismiss };
}

/** The ports the app uses: the operation registry and the real SDK. */
export function registryCallPorts(): CallPorts | null {
  const api = globalThis.callieApi;
  if (api === undefined) return null;
  return {
    start: async input => await api.command('calling.start', input),
    setActive: async active => await api.command('calling.setActive', { active }),
  };
}
