import { useCallback, useEffect, useRef, useState } from 'react';

import type { MutationReceipt } from '../../../shared/contracts/commonContract';
import type { ResolveReviewRequest, ReviewKind, ReviewListRequest, ReviewSnapshot } from '../../../shared/contracts/reviewContract';
import type { ReviewObservationToken } from '../../app/useReviewSummary';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { ReviewPage } from './ReviewPage';

export type ReviewApi = {
  list(input: ReviewListRequest): Promise<ReviewSnapshot>;
  resolve(input: ResolveReviewRequest): Promise<MutationReceipt>;
};
export type ReviewRouteProps = {
  api: ReviewApi;
  onOpenLead(personId: string): void;
  onReviewRequestStart(): ReviewObservationToken;
  onReviewRequestFailed(token: ReviewObservationToken): void;
  onReviewSnapshot(snapshot: ReviewSnapshot, token: ReviewObservationToken): void;
  /** Successful mutation invalidates the global observation independently of this page read. */
  onReviewResolved(): void;
};
type ReviewRouteState = { kind: 'loading' } | { kind: 'error' }
  | { kind: 'ready'; snapshot: ReviewSnapshot };
type AppendState = 'idle' | 'loading' | 'error';

export function ReviewRoute({ api, onOpenLead, onReviewRequestStart, onReviewRequestFailed, onReviewSnapshot, onReviewResolved }: ReviewRouteProps) {
  const [state, setState] = useState<ReviewRouteState>({ kind: 'loading' });
  const [selectedKind, setSelectedKind] = useState<ReviewKind>('unmatched_communication');
  const [appendState, setAppendState] = useState<AppendState>('idle');
  const [resolutionFailed, setResolutionFailed] = useState(false);
  const [resolutionPending, setResolutionPending] = useState(false);
  const requestSequence = useRef(0);
  const appendPending = useRef(false);
  const mutationPending = useRef(false);
  const active = useRef(false);
  const callbacks = useRef({ onReviewRequestStart, onReviewRequestFailed, onReviewSnapshot, onReviewResolved });
  callbacks.current = { onReviewRequestStart, onReviewRequestFailed, onReviewSnapshot, onReviewResolved };

  const load = useCallback((showLoading: boolean) => {
    const requestId = ++requestSequence.current;
    appendPending.current = false;
    setAppendState('idle');
    if (showLoading) setState({ kind: 'loading' });
    const observation = callbacks.current;
    const token = observation.onReviewRequestStart();
    void api.list({ kinds: [selectedKind], cursor: null, limit: 200 }).then(snapshot => {
      if (active.current && requestSequence.current === requestId) {
        setState({ kind: 'ready', snapshot });
        observation.onReviewSnapshot(snapshot, token);
      }
    }).catch(() => {
      if (active.current && requestSequence.current === requestId) {
        setState({ kind: 'error' });
        observation.onReviewRequestFailed(token);
      }
    });
  }, [api, selectedKind]);
  const reload = useRef(load);
  reload.current = load;

  useEffect(() => {
    active.current = true;
    load(true);
    return () => {
      active.current = false;
      requestSequence.current += 1;
    };
  }, [load]);

  const selectKind = (kind: ReviewKind) => {
    if (kind === selectedKind) return;
    requestSequence.current += 1;
    setState({ kind: 'loading' });
    setSelectedKind(kind);
  };

  const loadMore = () => {
    if (state.kind !== 'ready' || state.snapshot.nextCursor === null || appendPending.current || mutationPending.current) return;
    const previous = state.snapshot;
    const requestId = ++requestSequence.current;
    appendPending.current = true;
    setAppendState('loading');
    const observation = callbacks.current;
    const token = observation.onReviewRequestStart();
    void api.list({ kinds: [selectedKind], cursor: previous.nextCursor, limit: 200 }).then(snapshot => {
      if (!active.current || requestSequence.current !== requestId) return;
      const seen = new Set(previous.items.map(item => item.reviewId));
      const items = [...previous.items];
      for (const item of snapshot.items) {
        if (!seen.has(item.reviewId)) { seen.add(item.reviewId); items.push(item); }
      }
      setState({ kind: 'ready', snapshot: { ...snapshot, items } });
      setAppendState('idle');
      observation.onReviewSnapshot(snapshot, token);
    }).catch(() => {
      if (active.current && requestSequence.current === requestId) {
        setAppendState('error');
        observation.onReviewRequestFailed(token);
      }
    }).finally(() => {
      if (requestSequence.current === requestId) appendPending.current = false;
    });
  };

  const resolve = (input: ResolveReviewRequest) => {
    if (mutationPending.current || appendPending.current) return;
    mutationPending.current = true;
    setResolutionPending(true);
    setResolutionFailed(false);
    void api.resolve(input).then(() => {
      callbacks.current.onReviewResolved();
      if (active.current) reload.current(false);
    }).catch(() => {
      if (active.current) setResolutionFailed(true);
    }).finally(() => {
      mutationPending.current = false;
      if (active.current) setResolutionPending(false);
    });
  };

  return <>
    {resolutionFailed && <div className="review__resolution-alert" role="alert">
      The review item could not be resolved. Your input is kept. Review the record before retrying.
    </div>}
    <ReviewPage snapshot={state.kind === 'ready' ? state.snapshot : null} selectedKind={selectedKind} onSelectKind={selectKind}
      onResolve={resolve} onOpenLead={onOpenLead} resolutionPending={resolutionPending} />
    {state.kind === 'loading' && <LoadingState label="Loading review queues" />}
    {state.kind === 'error' && <ErrorState title="The review queues could not load"
      description="Retry to fetch the latest snapshot." onRetry={() => load(true)} />}
    {state.kind === 'ready' && <>
    <p role="status">Showing {state.snapshot.items.length} of {state.snapshot.matchedCount} in this view.</p>
    {appendState === 'error' && <div role="alert">
      More reviews could not load. The last loaded snapshot is kept.
      <button type="button" onClick={loadMore} disabled={resolutionPending}>Retry more</button>
      <button type="button" onClick={() => load(true)} disabled={resolutionPending}>Refresh list</button>
    </div>}
    {state.snapshot.nextCursor !== null && appendState !== 'error' && <button type="button"
      onClick={loadMore} disabled={appendState === 'loading' || resolutionPending}>
      {appendState === 'loading' ? 'Loading more reviews' : 'Load more'}
    </button>}
    </>}
  </>;
}
