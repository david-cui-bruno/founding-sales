import { PhoneIncoming, PhoneOutgoing, Voicemail } from 'lucide-react';

import type { ConversationRow } from '../../../shared/contracts/conversationsContract';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { StatusPill } from '../../components/StatusPill';

export type ConversationListProps = {
  rows: readonly ConversationRow[];
  selectedActivityId: string | null;
  hasMore: boolean;
  onSelect(activityId: string): void;
  onLoadMore(): void;
};

function formatWhen(occurredAt: string): string {
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) return occurredAt;
  return date.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function formatDuration(durationSeconds: number | null): string | null {
  if (durationSeconds === null) return null;
  const minutes = Math.floor(durationSeconds / 60);
  const seconds = durationSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function directionGlyph(row: ConversationRow) {
  if (row.kind === 'voicemail') {
    return <Voicemail aria-label="Voicemail" size={14} />;
  }
  return row.direction === 'inbound'
    ? <PhoneIncoming aria-label="Inbound call" size={14} />
    : <PhoneOutgoing aria-label="Outbound call" size={14} />;
}

/**
 * The master list: every recorded call/voicemail activity as a focusable
 * row button (Enter opens it), with recording/transcript availability pills.
 */
export function ConversationList({
  rows,
  selectedActivityId,
  hasMore,
  onSelect,
  onLoadMore,
}: ConversationListProps) {
  if (rows.length === 0) {
    return (
      <EmptyState
        title="No conversations yet"
        description="Calls and voicemails logged from the lead inspector appear here."
      />
    );
  }

  return (
    <>
      <ul className="conversation-list">
        {rows.map((row) => {
          const duration = formatDuration(row.durationSeconds);
          return (
            <li key={row.activityId} className="conversation-list__item">
              <button
                type="button"
                className="conversation-list__button"
                aria-pressed={row.activityId === selectedActivityId}
                onClick={() => onSelect(row.activityId)}
              >
                <span className="conversation-list__glyph">{directionGlyph(row)}</span>
                <span className="conversation-list__main">
                  <span className="conversation-list__name">{row.personName}</span>
                  <span className="conversation-list__meta">
                    {formatWhen(row.occurredAt)}
                    {duration !== null && ` · ${duration}`}
                  </span>
                </span>
                <span className="conversation-list__pills">
                  {row.recordingAvailable && <StatusPill>Recording</StatusPill>}
                  {row.transcriptAvailable && <StatusPill tone="positive">Transcript</StatusPill>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {hasMore && (
        <div className="conversation-list__more">
          <Button variant="quiet" onClick={onLoadMore}>Load more</Button>
        </div>
      )}
    </>
  );
}
