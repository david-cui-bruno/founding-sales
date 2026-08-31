import { useCallback, useEffect, useRef, useState } from 'react';

import type { PipelineSnapshot } from '../../../shared/contracts/pipelineContract';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { PipelinePage } from './PipelinePage';

export type PipelineApi = {
  get(): Promise<PipelineSnapshot>;
};

export type PipelineRouteProps = {
  api: PipelineApi;
  onOpenLead(personId: string): void;
};

type PipelineRouteState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; snapshot: PipelineSnapshot };

/**
 * Route container: fetches the projection through the injected API and
 * ignores stale responses. Rendering never mutates lifecycle state.
 */
export function PipelineRoute({ api, onOpenLead }: PipelineRouteProps) {
  const [state, setState] = useState<PipelineRouteState>({ kind: 'loading' });
  const requestSequence = useRef(0);

  const load = useCallback(() => {
    requestSequence.current += 1;
    const requestId = requestSequence.current;
    setState({ kind: 'loading' });
    api
      .get()
      .then((snapshot) => {
        if (requestSequence.current === requestId) {
          setState({ kind: 'ready', snapshot });
        }
      })
      .catch(() => {
        if (requestSequence.current === requestId) {
          setState({ kind: 'error' });
        }
      });
  }, [api]);

  useEffect(() => {
    load();
    return () => {
      requestSequence.current += 1;
    };
  }, [load]);

  if (state.kind === 'loading') {
    return <LoadingState label="Loading pipeline" />;
  }

  if (state.kind === 'error') {
    return (
      <ErrorState
        title="The pipeline could not load"
        description="Retry to fetch the latest snapshot."
        onRetry={load}
      />
    );
  }

  return <PipelinePage snapshot={state.snapshot} onOpenLead={onOpenLead} />;
}
