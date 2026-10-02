import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import type { CallSessionDto } from '@fss/contracts';
import { CALL_PROGRESS_POLL_MS, callProgress, latestCall, type CallProgress } from './callProgress.ts';

/**
 * The firm's call history, read with React Query, and its latest call's progress (slice S2).
 *
 * Read again every few seconds **only while something is still on its way** — a call in
 * progress, a recording, a transcript or a summary inside its grace period — and not at
 * all otherwise: `refetchInterval` is a function of the last answer. The query is keyed on
 * the firm, so a firm left and come back to shows what it had at once and reads again in
 * place; nothing is cleared by moving between firms.
 */

export const callHistoryKey = (firmId: string): readonly unknown[] => ['calling.history', firmId];

export interface CallProgressRead {
  readonly calls: readonly CallSessionDto[] | null;
  readonly latest: CallSessionDto | null;
  readonly progress: CallProgress | null;
  /** Read again now: a call just ended. */
  refresh(): void;
}

export function useCallProgress(firmId: string | null): CallProgressRead {
  const client = useQueryClient();
  const api = globalThis.callieApi;
  const query = useQuery({
    queryKey: callHistoryKey(firmId ?? 'none'),
    queryFn: async () => (api === undefined || firmId === null ? { calls: null } : await api.read('calling.history', { firmId })),
    enabled: firmId !== null && api !== undefined,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: current => {
      const calls = current.state.data?.calls ?? null;
      const last = calls === null ? null : latestCall(calls);
      return last !== null && callProgress(last, Date.now()).polling ? CALL_PROGRESS_POLL_MS : false;
    },
  });
  // The grace periods move with the clock, so the chips are re-derived every few seconds
  // while a step is pending even if the answer did not change.
  const [tick, setTick] = useState(0);
  const calls = query.data?.calls ?? null;
  const latest = calls === null ? null : latestCall(calls);
  // `tick` re-renders this while a step is pending; the clock is read here, at render.
  void tick;
  const progress = latest === null ? null : callProgress(latest, Date.now());
  const polling = progress?.polling === true;
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => {
      setTick(value => value + 1);
    }, CALL_PROGRESS_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [polling]);
  const refresh = useCallback((): void => {
    if (firmId !== null) void client.invalidateQueries({ queryKey: callHistoryKey(firmId) });
  }, [client, firmId]);
  return { calls, latest, progress, refresh };
}
