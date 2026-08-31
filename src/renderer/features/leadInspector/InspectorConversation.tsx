import type { ConversationSummary } from '../../../shared/contracts/leadDetailContract';
import { EmptyState } from '../../components/EmptyState';
import { StatusPill } from '../../components/StatusPill';

export type InspectorConversationProps = {
  conversations: ConversationSummary[];
};

export const formatDuration = (totalSeconds: number): string => {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`;
};

const formatWhen = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/** Real recorded conversations with evidence availability, never transcripts. */
export function InspectorConversation({
  conversations,
}: InspectorConversationProps) {
  if (conversations.length === 0) {
    return (
      <EmptyState
        title="No conversations yet"
        description="Connected calls will appear here with recordings when available."
      />
    );
  }

  return (
    <ul className="lead-inspector__conversations">
      {conversations.map((conversation) => (
        <li key={conversation.id} className="lead-inspector__conversation">
          <p className="lead-inspector__timeline-summary">
            <span>{formatWhen(conversation.occurredAt)}</span>
            {' · '}
            <span>{formatDuration(conversation.durationSeconds)}</span>
          </p>
          <p className="lead-inspector__timeline-meta">
            <StatusPill
              tone={conversation.recordingAvailable ? 'positive' : 'neutral'}
            >
              {conversation.recordingAvailable ? 'recording' : 'no recording'}
            </StatusPill>{' '}
            <StatusPill
              tone={conversation.transcriptAvailable ? 'positive' : 'neutral'}
            >
              {conversation.transcriptAvailable ? 'transcript' : 'no transcript'}
            </StatusPill>
            {conversation.reviewCount > 0 && (
              <span> · reviewed {conversation.reviewCount}×</span>
            )}
          </p>
        </li>
      ))}
    </ul>
  );
}
