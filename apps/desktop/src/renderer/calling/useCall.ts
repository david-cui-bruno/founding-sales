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
  /** Give up the current start in the main process, so nothing of it is bound (fold 2). */
  cancel?(): Promise<unknown>;
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
  /**
   * Which press of Call is current (review of C1, fold 1, finding 5). Hanging up while the
   * call is still being set up, and leaving the card, move it on; every await in `place`
   * compares its own number afterwards, and whatever it created in the meantime — a
   * Device, a Call — is disconnected and destroyed at once. No call outlives its controls.
   */
  const generation = useRef(0);
  /** A start is between Call and a connected call (for unmount's cancel). */
  const starting = useRef(false);
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
      starting.current = false;
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
      generation.current += 1;
      const mine = generation.current;
      const cancelled = (): boolean => mine !== generation.current;
      starting.current = true;
      setState({ phase: 'starting', firmId: input.firmId, routeId: input.routeId });
      void (async () => {
        let started: CallStart;
        try {
          started = await current.start(input);
        } catch {
          if (!cancelled()) {
            starting.current = false;
            setState({ phase: 'refused', firmId: input.firmId, routeId: input.routeId, sentence: CALL_FAILED_SENTENCE });
          }
          return;
        }
        // Hung up or left while the session and token were being made: nothing is dialled.
        if (cancelled()) return;
        if (!started.ok) {
          starting.current = false;
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
          if (cancelled()) return;
          finish(prior => ({
            phase: 'ended',
            firmId: input.firmId,
            routeId: input.routeId,
            sessionId: started.sessionId,
            seconds: prior.phase === 'connected' && prior.answeredAt !== null ? Math.floor((now() - prior.answeredAt) / 1000) : 0,
          }));
        };
        let made: VoiceDevice | null = null;
        try {
          made = await (current.device ?? twilioVoiceDevice)(started.token);
          if (cancelled()) {
            made.destroy();
            return;
          }
          device.current = made;
          // The session id, and nothing else: the number is the server's to put in <Dial>.
          const placed = await made.connect({ sessionId: started.sessionId });
          if (cancelled()) {
            // Created after the person hung up or left: gone at once, never an invisible call.
            placed.disconnect();
            made.destroy();
            return;
          }
          call.current = placed;
          starting.current = false;
          placed.on('accept', () => {
            if (cancelled()) return;
            setState(prior => (prior.phase === 'ringing' ? { ...prior, phase: 'connected', answeredAt: now() } : prior));
          });
          placed.on('disconnect', ended);
          placed.on('cancel', ended);
          placed.on('reject', ended);
          placed.on('error', (error?: unknown) => {
            if (!cancelled() && isMicrophoneDenied(error)) {
              finish(() => ({ phase: 'refused', firmId: input.firmId, routeId: input.routeId, sentence: MICROPHONE_DENIED_SENTENCE }));
            }
          });
        } catch (error: unknown) {
          if (cancelled()) {
            made?.destroy();
            return;
          }
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
    const placed = call.current;
    if (placed !== null) {
      placed.disconnect();
      return;
    }
    // Still being set up: cancel it. Whatever the pending start creates is torn down, and
    // the main process binds nothing of it.
    generation.current += 1;
    void portsRef.current?.cancel?.().catch(() => undefined);
    starting.current = false;
    device.current?.destroy();
    device.current = null;
    setLive(false);
    setState(prior => (prior.phase === 'starting' || prior.phase === 'ringing' ? { phase: 'idle' } : prior));
  }, [setLive]);

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
      // A start still pending is cancelled: what it creates after this is torn down.
      generation.current += 1;
      if (call.current === null && starting.current) void portsRef.current?.cancel?.().catch(() => undefined);
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
    cancel: async () => await api.command('calling.cancel', {}),
  };
}
