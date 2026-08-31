import { useCallback, useEffect, useRef, useState } from 'react';

import type { AppHealth } from '../../shared/healthContract';

export type FoundationHealthState =
  | { status: 'loading' }
  | { status: 'ready'; health: AppHealth }
  | { status: 'failed' };

export type FoundationHealth = FoundationHealthState & {
  retry(): void;
};

type HealthApi = {
  get(): Promise<AppHealth>;
};

/**
 * Bootstrap health probe for the root App: loads once on mount, ignores
 * stale and post-unmount responses, and exposes one retry entry point.
 */
export function useFoundationHealth(api: HealthApi): FoundationHealth {
  const [state, setState] = useState<FoundationHealthState>({
    status: 'loading',
  });
  const mounted = useRef(true);
  const latestRequest = useRef(0);

  const load = useCallback(async () => {
    const request = ++latestRequest.current;
    if (mounted.current) {
      setState({ status: 'loading' });
    }

    try {
      const health = await api.get();
      if (mounted.current && request === latestRequest.current) {
        setState({ status: 'ready', health });
      }
    } catch {
      if (mounted.current && request === latestRequest.current) {
        setState({ status: 'failed' });
      }
    }
  }, [api]);

  useEffect(() => {
    mounted.current = true;
    void load();

    return () => {
      mounted.current = false;
      latestRequest.current += 1;
    };
  }, [load]);

  return { ...state, retry: () => void load() };
}
