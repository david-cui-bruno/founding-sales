import type {
  ConversationDetail,
  ConversationRow,
} from '../../../shared/contracts/conversationsContract';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { PageHeader } from '../../components/PageHeader';
import { AttachTranscriptDialog } from './AttachTranscriptDialog';
import { ConversationDetailPanel } from './ConversationDetail';
import { ConversationList } from './ConversationList';

import './conversations.css';

export type DetailState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; detail: ConversationDetail };

export type ConversationsPageProps = {
  listState:
    | { kind: 'loading' }
    | { kind: 'error' }
    | { kind: 'ready'; rows: ConversationRow[]; total: number; nextCursor: string | null };
  query: string;
  selectedActivityId: string | null;
  detailState: DetailState;
  attachOpen: boolean;
  attachFailed: boolean;
  attachSubmitting: boolean;
  onQueryChange(query: string): void;
  onSelect(activityId: string): void;
  onLoadMore(): void;
  onRetryList(): void;
  onRetryDetail(): void;
  onOpenLead(personId: string): void;
  onOpenAttach(): void;
  onCloseAttach(): void;
  onSubmitAttach(rawText: string): void;
};

/**
 * Master-detail conversations workspace: a searchable list of
 * call/voicemail activities on the left, the selected conversation with its
 * transcript on the right. Search alone filters the list at founder data
 * sizes; there are no channel filter chips. A workspace with no
 * conversations carries ONE full empty state in the detail pane and a
 * compact one-liner in the list.
 */
export function ConversationsPage(props: ConversationsPageProps) {
  const {
    listState, query, selectedActivityId, detailState,
    attachOpen, attachFailed, attachSubmitting,
  } = props;

  const workspaceEmpty =
    listState.kind === 'ready' && listState.rows.length === 0;

  return (
    <div className="conversations-page">
      <PageHeader
        title="Conversations"
        description="Calls and voicemails, with transcripts"
        count={
          listState.kind === 'ready'
            ? `${listState.total} ${listState.total === 1 ? 'call' : 'calls'}`
            : undefined
        }
      />
      <div className="conversations">
      <section className="conversations__list-pane" aria-label="Conversations">
        <div className="conversations__controls">
          <input
            type="search"
            className="conversations__search"
            aria-label="Search conversations"
            placeholder="Search by name"
            value={query}
            onChange={(event) => props.onQueryChange(event.target.value)}
          />
        </div>
        {listState.kind === 'loading' && <LoadingState label="Loading conversations" />}
        {listState.kind === 'error' && (
          <ErrorState
            title="The conversations could not load"
            description="Retry to fetch the latest calls and voicemails."
            onRetry={props.onRetryList}
          />
        )}
        {listState.kind === 'ready' && (
          <ConversationList
            rows={listState.rows}
            selectedActivityId={selectedActivityId}
            hasMore={listState.nextCursor !== null}
            onSelect={props.onSelect}
            onLoadMore={props.onLoadMore}
          />
        )}
      </section>
      <section className="conversations__detail-pane" aria-label="Conversation detail">
        <ConversationDetailPanel
          state={detailState}
          workspaceEmpty={workspaceEmpty}
          onRetry={props.onRetryDetail}
          onOpenLead={props.onOpenLead}
          onOpenAttach={props.onOpenAttach}
        />
      </section>
      {attachOpen && detailState.kind === 'ready' && (
        <AttachTranscriptDialog
          personName={detailState.detail.personName}
          failed={attachFailed}
          submitting={attachSubmitting}
          onClose={props.onCloseAttach}
          onSubmit={props.onSubmitAttach}
        />
      )}
      </div>
    </div>
  );
}
