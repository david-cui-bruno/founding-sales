import { useCallback, useEffect, useRef, useState } from 'react';

import type { MutationReceipt } from '../../../shared/contracts/commonContract';
import type {
  AttachTranscriptRequest,
  ConversationDetail,
  ConversationDetailRequest,
  ConversationRow,
  ConversationsListRequest,
  ConversationsListResponse,
} from '../../../shared/contracts/conversationsContract';
import { ConversationsPage, type DetailState } from './ConversationsPage';

export type ConversationsApi = {
  list(request: ConversationsListRequest): Promise<ConversationsListResponse>;
  get(request: ConversationDetailRequest): Promise<ConversationDetail>;
  attachTranscript(request: AttachTranscriptRequest): Promise<MutationReceipt>;
};

export type ConversationsRouteProps = {
  api: ConversationsApi;
  onOpenLead(personId: string): void;
};

type ListState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; rows: ConversationRow[]; total: number; nextCursor: string | null };

type AttachState = {
  open: boolean;
  failed: boolean;
  submitting: boolean;
};

const PAGE_LIMIT = 200;
const CLOSED_ATTACH: AttachState = { open: false, failed: false, submitting: false };

/**
 * Route container for the conversations workspace: fetches the list through
 * the injected API on every query change, loads one detail per selection,
 * and refreshes both after a successful transcript attach. The channel
 * filter is fixed to 'all': search alone narrows the list at founder data
 * sizes. Stale responses are ignored.
 */
export function ConversationsRoute({ api, onOpenLead }: ConversationsRouteProps) {
  const [query, setQuery] = useState('');
  const [listState, setListState] = useState<ListState>({ kind: 'loading' });
  const [selectedActivityId, setSelectedActivityId] = useState<string | null>(null);
  const [detailState, setDetailState] = useState<DetailState>({ kind: 'idle' });
  const [attachState, setAttachState] = useState<AttachState>(CLOSED_ATTACH);
  const listSequence = useRef(0);
  const detailSequence = useRef(0);

  const loadList = useCallback((showLoading: boolean) => {
    listSequence.current += 1;
    const requestId = listSequence.current;
    if (showLoading) {
      setListState({ kind: 'loading' });
    }
    api
      .list({ query, filter: 'all', limit: PAGE_LIMIT, cursor: null })
      .then((response) => {
        if (listSequence.current === requestId) {
          setListState({
            kind: 'ready',
            rows: response.rows,
            total: response.total,
            nextCursor: response.nextCursor,
          });
        }
      })
      .catch(() => {
        if (listSequence.current === requestId) {
          setListState({ kind: 'error' });
        }
      });
  }, [api, query]);

  useEffect(() => {
    loadList(true);
    return () => {
      listSequence.current += 1;
    };
  }, [loadList]);

  const loadMore = useCallback(() => {
    if (listState.kind !== 'ready' || listState.nextCursor === null) return;
    listSequence.current += 1;
    const requestId = listSequence.current;
    const previous = listState;
    api
      .list({ query, filter: 'all', limit: PAGE_LIMIT, cursor: previous.nextCursor })
      .then((response) => {
        if (listSequence.current === requestId) {
          setListState({
            kind: 'ready',
            rows: [...previous.rows, ...response.rows],
            total: response.total,
            nextCursor: response.nextCursor,
          });
        }
      })
      .catch(() => {
        if (listSequence.current === requestId) {
          setListState({ kind: 'error' });
        }
      });
  }, [api, query, listState]);

  const loadDetail = useCallback((activityId: string) => {
    detailSequence.current += 1;
    const requestId = detailSequence.current;
    setDetailState({ kind: 'loading' });
    api
      .get({ activityId })
      .then((detail) => {
        if (detailSequence.current === requestId) {
          setDetailState({ kind: 'ready', detail });
        }
      })
      .catch(() => {
        if (detailSequence.current === requestId) {
          setDetailState({ kind: 'error' });
        }
      });
  }, [api]);

  const handleSelect = useCallback((activityId: string) => {
    setAttachState(CLOSED_ATTACH);
    setSelectedActivityId(activityId);
    loadDetail(activityId);
  }, [loadDetail]);

  const handleAttachSubmit = useCallback((rawText: string) => {
    if (detailState.kind !== 'ready') return;
    const { activityId, personId } = detailState.detail;
    setAttachState({ open: true, failed: false, submitting: true });
    api
      .attachTranscript({ activityId, personId, rawText })
      .then(() => {
        setAttachState(CLOSED_ATTACH);
        loadDetail(activityId);
        loadList(false);
      })
      .catch(() => {
        setAttachState({ open: true, failed: true, submitting: false });
      });
  }, [api, detailState, loadDetail, loadList]);

  return (
    <ConversationsPage
      listState={listState}
      query={query}
      selectedActivityId={selectedActivityId}
      detailState={detailState}
      attachOpen={attachState.open}
      attachFailed={attachState.failed}
      attachSubmitting={attachState.submitting}
      onQueryChange={setQuery}
      onSelect={handleSelect}
      onLoadMore={loadMore}
      onRetryList={() => loadList(true)}
      onRetryDetail={() => {
        if (selectedActivityId !== null) loadDetail(selectedActivityId);
      }}
      onOpenLead={onOpenLead}
      onOpenAttach={() => setAttachState({ open: true, failed: false, submitting: false })}
      onCloseAttach={() => setAttachState(CLOSED_ATTACH)}
      onSubmitAttach={handleAttachSubmit}
    />
  );
}
