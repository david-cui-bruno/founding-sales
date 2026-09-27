import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo } from 'react';
import { figuresWindow, type FiguresRead } from '../homeView.ts';
import type { AdminState } from '../settingsContract.ts';
import { adminBridge } from './bridges.ts';
import type { Generation } from './generation.ts';

/**
 * The sidebar's status rows and the last seven days.
 *
 * `state()` is the Administration bridge's cached read — it asks the API only the first
 * time — so a number added in Administration a moment ago is on the bridge already and
 * coming back to the window costs nothing. Refresh re-reads: `show({ screen: 'settings' })`
 * asks the API again for the settings, the sending status and the calling numbers.
 *
 * Both are Query keys under the person signed in **and the session generation**, so a
 * sign-out, another workspace or a changed role drops them with everything else rather
 * than showing the next person the last one's figures — and a read already on the wire
 * when that happens is dropped instead of written (`generation.ts`).
 */

export interface HomeAdmin {
  readonly admin: AdminState | null;
  readonly figures: FiguresRead;
  /** Read the status and the figures again, as Refresh does. */
  refresh(): void;
}

const ADMIN_KEY = 'admin';
const FIGURES_KEY = 'figures';

export function useHomeAdmin(identity: string | null, generation: number, guard: Generation): HomeAdmin {
  const client = useQueryClient();
  const enabled = identity !== null && adminBridge() !== undefined;

  const admin = useQuery({
    queryKey: [ADMIN_KEY, identity, generation],
    queryFn: async () => (await adminBridge()?.state()) ?? null,
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
  });

  // One window per sign-in, so the seven days do not slide under the figures while
  // somebody reads them. Refresh asks for a new one.
  const requested = useMemo(() => figuresWindow(new Date()), [identity]); // eslint-disable-line react-hooks/exhaustive-deps

  const dashboard = useQuery({
    queryKey: [FIGURES_KEY, identity, generation, requested.from, requested.to],
    queryFn: async () => (await adminBridge()?.loadDashboard(requested)) ?? null,
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const refetchAdmin = admin.refetch;
  useEffect(() => {
    // Coming back from Administration is when a calling number has just been added: the
    // bridge's `state()` is its own cached read, so this asks the API nothing and the
    // sidebar's status is current the moment the window is in front again.
    const onFocus = (): void => {
      void refetchAdmin();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
    };
  }, [refetchAdmin]);

  const refetchFigures = dashboard.refetch;
  const refresh = useCallback((): void => {
    const bridge = adminBridge();
    if (bridge === undefined) return;
    // Refresh is the one read that goes back to the API for the sidebar's status; until
    // wave 1 it re-read the list and the figures and left the status as the first answer
    // of the day. What is on screen stays there until the answer arrives, so nothing
    // flickers back to "Checking…".
    // The one write in this file, and it carries the number it was asked under: a
    // Refresh that answers after the person changed does not put the last one's status
    // back into a cache the shell has just emptied.
    const started = guard.now();
    void bridge.show({ screen: 'settings' }).then(state => {
      if (guard.fresh(started)) client.setQueryData([ADMIN_KEY, identity, started], state);
    });
    void refetchFigures();
  }, [client, guard, identity, refetchFigures]);

  const figures: FiguresRead = {
    requested: enabled ? requested : null,
    // A refused read is answered: the figures then say so rather than showing zeros.
    answered: dashboard.isSuccess || dashboard.isError,
    dashboard: dashboard.data?.dashboard ?? null,
  };

  return { admin: admin.data ?? null, figures, refresh };
}
