import { useCallback, useEffect, useRef, useState } from 'react';
import type { CallingView } from '../../shared/operations.ts';

/**
 * Whether this firm's Call button places the call in Callie, and its cadence (slice C1).
 * Null until the main process answers, and the Call button waits; `tel` only when the
 * server said calling is off; `unavailable` when it could not say (review of C1, fold 1).
 */
export interface CallingStatus {
  readonly view: CallingView | null;
  readonly resuming: boolean;
  reload(): void;
  /** "Resume calling". Resolves once the server answered, so the card can be read again. */
  resume(): Promise<void>;
}

export function useCallingStatus(firmId: string | null): CallingStatus {
  const [view, setView] = useState<CallingView | null>(null);
  const [resuming, setResuming] = useState(false);
  const asked = useRef(0);

  const reload = useCallback((): void => {
    const api = globalThis.callieApi;
    if (api === undefined || firmId === null) {
      setView(null);
      return;
    }
    asked.current += 1;
    const mine = asked.current;
    void api.read('calling.status', { firmId }).then(
      answer => {
        if (mine === asked.current) setView(answer);
      },
      () => {
        // The bridge did not answer: not "calling is off", so not the phone app either.
        if (mine === asked.current) setView({ provider: 'unavailable', cadence: null });
      },
    );
  }, [firmId]);

  const resume = useCallback(async (): Promise<void> => {
    const api = globalThis.callieApi;
    if (api === undefined || firmId === null) return;
    setResuming(true);
    asked.current += 1;
    const mine = asked.current;
    await api
      .command('calling.resume', { firmId })
      .then(
        answer => {
          if (mine === asked.current) setView(answer);
        },
        () => undefined,
      )
      .finally(() => {
        setResuming(false);
      });
  }, [firmId]);

  useEffect(() => {
    setView(null);
    reload();
  }, [reload]);

  return { view, resuming, reload, resume };
}
