import { useCallback, useEffect, useRef, useState } from 'react';

import type { MutationReceipt } from '../../../shared/contracts/commonContract';
import type {
  AddEvidenceRequest,
  CaptureLearningRequest,
  LearningCategory,
  LearningStatus,
  LearningsListRequest,
  LearningsListResponse,
  UpdateLearningStatusRequest,
} from '../../../shared/contracts/learningsContract';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { LearningsPage } from './LearningsPage';

export type LearningsApi = {
  list(request: LearningsListRequest): Promise<LearningsListResponse>;
  capture(request: CaptureLearningRequest): Promise<MutationReceipt>;
  addEvidence(request: AddEvidenceRequest): Promise<MutationReceipt>;
  updateStatus(request: UpdateLearningStatusRequest): Promise<MutationReceipt>;
};

export type LearningsRouteProps = {
  api: LearningsApi;
  onOpenLead(personId: string): void;
  /** Injected clock for evidence notedAt timestamps; defaults to wall time. */
  now?(): string;
};

type LearningsRouteState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; response: LearningsListResponse };

/**
 * Route container: fetches learnings through the injected API whenever the
 * founder's filters change and refetches after every mutation. Stale
 * responses are ignored.
 */
export function LearningsRoute({
  api,
  onOpenLead,
  now = () => new Date().toISOString(),
}: LearningsRouteProps) {
  const [state, setState] = useState<LearningsRouteState>({ kind: 'loading' });
  const [categories, setCategories] = useState<LearningCategory[]>([]);
  const [statuses, setStatuses] = useState<LearningStatus[]>([]);
  const [query, setQuery] = useState('');
  const [mutationFailed, setMutationFailed] = useState(false);
  const requestSequence = useRef(0);

  const load = useCallback(() => {
    requestSequence.current += 1;
    const requestId = requestSequence.current;
    api
      .list({ categories, statuses, query, limit: 200 })
      .then((response) => {
        if (requestSequence.current === requestId) {
          setState({ kind: 'ready', response });
        }
      })
      .catch(() => {
        if (requestSequence.current === requestId) {
          setState({ kind: 'error' });
        }
      });
  }, [api, categories, statuses, query]);

  useEffect(() => {
    load();
    return () => {
      requestSequence.current += 1;
    };
  }, [load]);

  const mutate = useCallback(
    (operation: Promise<MutationReceipt>): Promise<void> => {
      setMutationFailed(false);
      return operation.then(
        () => {
          load();
        },
        () => {
          setMutationFailed(true);
          return Promise.reject(new Error('The learning mutation failed.'));
        },
      );
    },
    [load],
  );

  if (state.kind === 'loading') {
    return <LoadingState label="Loading learnings" />;
  }

  if (state.kind === 'error') {
    return (
      <ErrorState
        title="The learnings could not load"
        description="Retry to fetch the latest learnings."
        onRetry={() => {
          setState({ kind: 'loading' });
          load();
        }}
      />
    );
  }

  return (
    <>
      {mutationFailed && (
        <div className="learnings__mutation-alert" role="alert">
          The learning could not be saved. It may have changed; the list below
          refreshes after every save.
        </div>
      )}
      <LearningsPage
        response={state.response}
        categories={categories}
        statuses={statuses}
        query={query}
        onCategoriesChange={setCategories}
        onStatusesChange={setStatuses}
        onQueryChange={setQuery}
        onCapture={(request) => mutate(api.capture(request))}
        onAddEvidence={(request) => mutate(api.addEvidence(request))}
        onUpdateStatus={(request) => mutate(api.updateStatus(request))}
        onOpenLead={onOpenLead}
        now={now}
      />
    </>
  );
}
