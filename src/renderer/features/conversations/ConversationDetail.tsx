import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingState } from '../../components/LoadingState';
import { StatusPill } from '../../components/StatusPill';
import type { DetailState } from './ConversationsPage';

export type ConversationDetailPanelProps = {
  state: DetailState;
  onRetry(): void;
  onOpenLead(personId: string): void;
  onOpenAttach(): void;
};

const SPEAKER_LABELS = {
  founder: 'Founder',
  lead: 'Lead',
  unknown: 'Unknown',
} as const;

function formatWhen(occurredAt: string): string {
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) return occurredAt;
  return date.toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

/**
 * The selected conversation: meta header, summary, and the transcript as a
 * plain list of utterances. Transcript text is untrusted pasted data and is
 * rendered strictly as text.
 */
export function ConversationDetailPanel({
  state,
  onRetry,
  onOpenLead,
  onOpenAttach,
}: ConversationDetailPanelProps) {
  if (state.kind === 'idle') {
    return (
      <EmptyState
        title="Select a conversation"
        description="Choose a call or voicemail to read its transcript."
      />
    );
  }

  if (state.kind === 'loading') {
    return <LoadingState label="Loading conversation" />;
  }

  if (state.kind === 'error') {
    return (
      <ErrorState
        title="The conversation could not load"
        description="Retry to fetch the selected conversation."
        onRetry={onRetry}
      />
    );
  }

  const { detail } = state;
  const kindLabel = detail.kind === 'voicemail' ? 'Voicemail' : 'Call';
  const directionLabel = detail.direction === 'inbound' ? 'Inbound' : 'Outbound';

  return (
    <article className="conversation-detail">
      <header className="conversation-detail__header">
        <div className="conversation-detail__heading">
          <h2 className="conversation-detail__name">{detail.personName}</h2>
          <p className="conversation-detail__meta">
            {directionLabel} {kindLabel.toLowerCase()} · {formatWhen(detail.occurredAt)}
          </p>
        </div>
        <div className="conversation-detail__actions">
          <Button variant="quiet" onClick={() => onOpenLead(detail.personId)}>
            Open lead
          </Button>
          <Button
            onClick={onOpenAttach}
            disabled={detail.transcript !== null}
          >
            Attach transcript
          </Button>
        </div>
      </header>
      <div className="conversation-detail__pills">
        {detail.recordingAvailable && <StatusPill>Recording</StatusPill>}
        {detail.transcript !== null && <StatusPill tone="positive">Transcript</StatusPill>}
      </div>
      {detail.summary !== null && (
        <p className="conversation-detail__summary">{detail.summary}</p>
      )}
      {detail.transcript === null ? (
        <EmptyState
          title="No transcript attached"
          description="Paste a transcript to keep the exact words with this call."
        />
      ) : (
        <ol className="conversation-detail__transcript" aria-label="Transcript">
          {detail.transcript.utterances.map((utterance) => (
            <li
              key={utterance.id}
              className={
                utterance.speaker === 'founder'
                  ? 'utterance utterance--founder'
                  : 'utterance'
              }
            >
              <span className="utterance__speaker">
                {SPEAKER_LABELS[utterance.speaker]}
              </span>
              <span className="utterance__text">{utterance.text}</span>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}
