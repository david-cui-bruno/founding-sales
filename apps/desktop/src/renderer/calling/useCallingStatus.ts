import { useCallback, useEffect, useRef, useState } from 'react';
import type { CallingView } from '../../shared/operations.ts';

/**
 * Whether this firm's Call button places the call in Callie, and its cadence (slice C1).
 * Null until the main process answers; `tel` whenever it cannot say twilio, so the
 * phone-app handoff is what the card shows while it waits and when in doubt.
 */
export interface CallingStatus {
  readonly view: CallingView | null;
  readonly resuming: boolean;
  reload(): void;
  resume(): void;
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
        if (mine === asked.current) setView({ provider: 'tel', cadence: null });
      },
    );
  }, [firmId]);

  const resume = useCallback((): void => {
    const api = globalThis.callieApi;
    if (api === undefined || firmId === null) return;
    setResuming(true);
    asked.current += 1;
    const mine = asked.current;
    void api
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
