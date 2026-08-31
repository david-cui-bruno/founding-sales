import { useCallback, useEffect, useRef, useState } from 'react';

import type { MutationReceipt } from '../../../shared/contracts/commonContract';
import type {
  ResolveReviewRequest,
  ReviewKind,
  ReviewListRequest,
  ReviewSnapshot,
} from '../../../shared/contracts/reviewContract';
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
  /** Shell badge callback: reports the workspace-wide open review count. */
  onOpenCountChange(count: number): void;
};

type ReviewRouteState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; snapshot: ReviewSnapshot };

const LIST_REQUEST: ReviewListRequest = { kinds: [], limit: 200 };

/**
 * Route container: fetches the full snapshot through the injected API,
 * refetches after every resolution, and reports the open count to the
 * shell. Stale responses are ignored.
 */
export function ReviewRoute({ api, onOpenLead, onOpenCountChange }: ReviewRouteProps) {
  const [state, setState] = useState<ReviewRouteState>({ kind: 'loading' });
  const [selectedKind, setSelectedKind] = useState<ReviewKind>('unmatched_communication');
  const [resolutionFailed, setResolutionFailed] = useState(false);
  const requestSequence = useRef(0);
  const countCallback = useRef(onOpenCountChange);
  countCallback.current = onOpenCountChange;

  const load = useCallback((showLoading: boolean) => {
    requestSequence.current += 1;
    const requestId = requestSequence.current;
    if (showLoading) {
      setState({ kind: 'loading' });
    }
    api
      .list(LIST_REQUEST)
      .then((snapshot) => {
        if (requestSequence.current === requestId) {
          setState({ kind: 'ready', snapshot });
          countCallback.current(snapshot.totalOpenCount);
        }
      })
      .catch(() => {
        if (requestSequence.current === requestId) {
          setState({ kind: 'error' });
        }
      });
  }, [api]);

  useEffect(() => {
    load(true);
    return () => {
      requestSequence.current += 1;
    };
  }, [load]);

  const resolve = useCallback((input: ResolveReviewRequest) => {
    setResolutionFailed(false);
    api
      .resolve(input)
      .then(() => {
        load(false);
      })
      .catch(() => {
        setResolutionFailed(true);
      });
  }, [api, load]);

  if (state.kind === 'loading') {
    return <LoadingState label="Loading review queues" />;
  }

  if (state.kind === 'error') {
    return (
      <ErrorState
        title="The review queues could not load"
        description="Retry to fetch the latest snapshot."
        onRetry={() => load(true)}
      />
    );
  }

  return (
    <>
      {resolutionFailed && (
        <div className="review__resolution-alert" role="alert">
          The review item could not be resolved. It may have changed; the
          queues below are refreshed on every resolution.
        </div>
      )}
      <ReviewPage
        snapshot={state.snapshot}
        selectedKind={selectedKind}
        onSelectKind={setSelectedKind}
        onResolve={resolve}
        onOpenLead={onOpenLead}
      />
    </>
  );
}
