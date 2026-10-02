import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import type { AnalysisView, ReviewView } from '../../shared/operations.ts';

/**
 * A call's analysis, read by **session** (slice 3a, lane C; David's Today feedback).
 *
 * The key is `['calling.analysis', callSessionId]` and nothing else: not the open firm, not
 * the selection, not the view. So an analysis that finishes while David is on his next call
 * lands in its own session's entry and changes nothing he is looking at; the panel for a
 * session reads only that session's entry. The firm's call history keeps its own key
 * (`['calling.history', firmId]`, `useCallProgress`).
 *
 * Polling is per session and stops when that session is settled: every 4 s while its
 * analysis is pending, every 10 s while a call that has just ended has none yet (the
 * transcript is on its way), and not at all once it has completed, failed, or is older than
 * twenty minutes, pending or not.
 */

export const analysisKey = (callSessionId: string): readonly unknown[] => ['calling.analysis', callSessionId];
export const REVIEW_KEY: readonly unknown[] = ['review.list'];

export const PENDING_POLL_MS = 4_000;
export const WAITING_POLL_MS = 10_000;
/** A call with no analysis yet is waited for this long after it ended, then given up on. */
export const WAITING_WINDOW_MS = 20 * 60_000;

const api = (): NonNullable<typeof globalThis.callieApi> | undefined => globalThis.callieApi;

export type AnalysisPhase = 'waiting' | 'pending' | 'failed' | 'completed' | 'absent';

export function phaseOf(view: AnalysisView | null | undefined, waiting: boolean): AnalysisPhase {
  const analysis = view?.analysis ?? null;
  if (analysis === null) return view === undefined || view === null || waiting ? 'waiting' : 'absent';
  if (analysis.pending !== null) return 'pending';
  if (analysis.authoritative !== null || analysis.current !== null) return 'completed';
  if (analysis.failure !== null) return 'failed';
  return 'absent';
}

export interface Watch {
  readonly callSessionId: string;
  /** When the call ended, for the waiting window. */
  readonly endedAt: number;
}

/**
 * How often to read a session again, or not at all. **Every** state stops at the same bound:
 * twenty minutes after the call ended, a pending analysis is no longer polled either (a manual
 * refresh still reads it). Within the window: 4 s while pending, 10 s while none exists yet.
 */
export function intervalOf(view: AnalysisView | undefined, endedAt: number, now: number): number | false {
  if (now - endedAt >= WAITING_WINDOW_MS) return false;
  const analysis = view?.analysis ?? null;
  if (analysis?.pending != null) return PENDING_POLL_MS;
  if (analysis === null) return WAITING_POLL_MS;
  return false;
}

/** Watch several sessions at once: each is its own query, keyed by its session. */
export function useAnalyses(watches: readonly Watch[]): ReadonlyMap<string, AnalysisView | undefined> {
  const client = useQueryClient();
  const results = useQueries({
    queries: watches.map(watch => ({
      queryKey: analysisKey(watch.callSessionId),
      queryFn: async (): Promise<AnalysisView> => {
        const bridge = api();
        return bridge === undefined ? { analysis: null, reason: 'unavailable' } : await bridge.read('calling.analysis', { callSessionId: watch.callSessionId });
      },
      staleTime: 0,
      retry: false,
      refetchOnWindowFocus: false,
      refetchInterval: (query: { state: { data: AnalysisView | undefined } }) => intervalOf(query.state.data, watch.endedAt, Date.now()),
    })),
  });
  const map = new Map<string, AnalysisView | undefined>();
  watches.forEach((watch, index) => map.set(watch.callSessionId, results[index]?.data));

  // A session that settles brings its Needs review items with it: read the list again.
  const settled = useRef(new Map<string, AnalysisPhase>());
  useEffect(() => {
    let changed = false;
    for (const watch of watches) {
      const phase = phaseOf(map.get(watch.callSessionId), false);
      const before = settled.current.get(watch.callSessionId);
      if (before !== undefined && before !== phase && (phase === 'completed' || phase === 'failed')) changed = true;
      settled.current.set(watch.callSessionId, phase);
    }
    if (changed) void client.invalidateQueries({ queryKey: REVIEW_KEY });
  });
  return map;
}

/** One session's analysis, for the panel that shows it. */
export function useAnalysis(callSessionId: string | null, endedAt: number): { view: AnalysisView | undefined; reload(): void } {
  const client = useQueryClient();
  const watch: readonly Watch[] = callSessionId === null ? [] : [{ callSessionId, endedAt }];
  const map = useAnalyses(watch);
  return {
    view: callSessionId === null ? undefined : map.get(callSessionId),
    reload: () => {
      if (callSessionId !== null) void client.invalidateQueries({ queryKey: analysisKey(callSessionId) });
    },
  };
}

/**
 * Needs review, as the server lists it. Items are null when the API does not serve the list
 * at all (404: the group hides). Any other failed read keeps the **last known list** and says
 * so through `failed`, because the items on it are unresolved work.
 */
export function useReview(enabled: boolean): { items: ReviewView['items']; failed: boolean; reload(): void } {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: REVIEW_KEY,
    queryFn: async (): Promise<ReviewView> => {
      const bridge = api();
      return bridge === undefined ? { items: null, failed: false } : await bridge.read('review.list', {});
    },
    enabled: enabled && api() !== undefined,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: 60_000,
  });
  // The last list that did answer, kept while later reads fail.
  const known = useRef<ReviewView['items']>(null);
  const data = query.data;
  if (data !== undefined && data.items !== null) known.current = data.items;
  else if (data !== undefined && !data.failed) known.current = null;
  const failed = query.isError || data?.failed === true;
  return { items: known.current, failed: failed && known.current !== null, reload: () => void client.invalidateQueries({ queryKey: REVIEW_KEY }) };
}
