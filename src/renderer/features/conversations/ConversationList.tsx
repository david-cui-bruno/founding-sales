import { PhoneIncoming, PhoneOutgoing, Voicemail } from 'lucide-react';

import type { ConversationRow } from '../../../shared/contracts/conversationsContract';
import { titleCaseDisplayName } from '../../../shared/displayText';
import { Button } from '../../components/Button';
import { StatusPill } from '../../components/StatusPill';
import { formatRelativeTime } from './relativeTime';

export type ConversationListProps = {
  rows: readonly ConversationRow[];
  selectedActivityId: string | null;
  hasMore: boolean;
  onSelect(activityId: string): void;
  onLoadMore(): void;
};

function formatDuration(durationSeconds: number | null): string | null {
  if (durationSeconds === null) return null;
  const minutes = Math.floor(durationSeconds / 60);
  const seconds = durationSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function channelLabel(row: ConversationRow): string {
  if (row.kind === 'voicemail') return 'Voicemail';
  return row.direction === 'inbound' ? 'Inbound call' : 'Outbound call';
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
 * two-line row button (Enter opens it). When the workspace has no
 * conversations at all, this pane shows only a compact one-liner; the
 * detail pane carries the single full empty state.
 */
export function ConversationList({
  rows,
  selectedActivityId,
  hasMore,
  onSelect,
  onLoadMore,
}: ConversationListProps) {
  if (rows.length === 0) {
    return <p className="conversation-list__none">No calls yet</p>;
  }

  return (
    <>
      <ul className="conversation-list">
        {rows.map((row) => {
          const duration = formatDuration(row.durationSeconds);
          const snippet = row.summary ?? channelLabel(row);
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
                  <span className="conversation-list__top">
                    <span className="conversation-list__name">
                      {titleCaseDisplayName(row.personName)}
                    </span>
                    <span className="conversation-list__when numeric">
                      {formatRelativeTime(row.occurredAt)}
                    </span>
                  </span>
                  <span className="conversation-list__meta">
                    {snippet}
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
