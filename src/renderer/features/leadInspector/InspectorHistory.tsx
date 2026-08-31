import type { HistoryEvent } from '../../../shared/contracts/leadDetailContract';
import { EmptyState } from '../../components/EmptyState';

export type InspectorHistoryProps = {
  history: HistoryEvent[];
};

const formatWhen = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

/** Stage transition audit trail in transition order. */
export function InspectorHistory({ history }: InspectorHistoryProps) {
  if (history.length === 0) {
    return (
      <EmptyState
        title="No stage history"
        description="Stage changes will appear here as they happen."
      />
    );
  }

  return (
    <ol className="lead-inspector__timeline">
      {history.map((event) => (
        <li key={event.id} className="lead-inspector__timeline-item">
          <p className="lead-inspector__timeline-summary">{event.label}</p>
          <p className="lead-inspector__timeline-meta">
            <span>{formatWhen(event.occurredAt)}</span>
            {event.detail !== null && <span> · {event.detail}</span>}
          </p>
        </li>
      ))}
    </ol>
  );
}
