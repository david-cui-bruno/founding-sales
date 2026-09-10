import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReviewSnapshot } from '../../shared/contracts/reviewContract';
import type { ReviewApi } from '../features/review/ReviewRoute';

export type ReviewBadgeState = { status: 'loading' } | { status: 'failed' }
  | { status: 'ready'; count: number; observedAt: string };
export type ReviewObservationToken = symbol;

/** Lives only inside the initialized healthy workspace, never the startup/recovery gate. */
export function useReviewSummary(api: ReviewApi) {
  const [state, setState] = useState<ReviewBadgeState>({ status: 'loading' });
  const latest = useRef<ReviewObservationToken | null>(null);
  const active = useRef(false);
  const begin = useCallback(() => {
    // Child page effects can start before this owner's passive effect activates.
    const token = Symbol('review-observation');
    latest.current = token;
    if (active.current) setState({ status: 'loading' });
    return token;
  }, []);
  const accept = useCallback((snapshot: ReviewSnapshot, token: ReviewObservationToken) => {
    if (active.current && token === latest.current) {
      setState({ status: 'ready', count: snapshot.totalOpenCount, observedAt: snapshot.observedAt });
    }
  }, []);
  const fail = useCallback((token: ReviewObservationToken) => {
    if (active.current && token === latest.current) setState({ status: 'failed' });
  }, []);
  const refresh = useCallback(() => {
    if (!active.current) return;
    const token = begin();
    void api.list({ kinds: [], cursor: null, limit: 1 })
      .then(snapshot => accept(snapshot, token)).catch(() => fail(token));
  }, [api, begin, accept, fail]);
  useEffect(() => {
    active.current = true;
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      active.current = false;
      latest.current = null;
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);
  return { state, refresh, begin, accept, fail };
}
