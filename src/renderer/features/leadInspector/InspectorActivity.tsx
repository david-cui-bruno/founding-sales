import type { ActivitySummary } from '../../../shared/contracts/leadDetailContract';
import { EmptyState } from '../../components/EmptyState';

export type InspectorActivityProps = {
  activities: ActivitySummary[];
};

const formatWhen = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/**
 * Chronological touch log. Summaries come pre-sanitized from the domain.
 * Amended activities (audit 2.7) stay visible but render struck through
 * with an explicit "Marked in error" note; nothing is ever deleted.
 */
export function InspectorActivity({ activities }: InspectorActivityProps) {
  if (activities.length === 0) {
    return (
      <EmptyState
        title="No activity yet"
        description="Touches and system events will appear here."
      />
    );
  }

  return (
    <ol className="lead-inspector__timeline">
      {activities.map((activity) => (
        <li
          key={activity.id}
          className={
            activity.markedInError
              ? 'lead-inspector__timeline-item lead-inspector__timeline-item--in-error'
              : 'lead-inspector__timeline-item'
          }
        >
          <p className="lead-inspector__timeline-summary">{activity.summary}</p>
          <p className="lead-inspector__timeline-meta">
            <span>{activity.kind}</span>
            <span> · {formatWhen(activity.occurredAt)}</span>
            {activity.outcome !== null && <span> · {activity.outcome}</span>}
            {activity.markedInError && <span> · Marked in error</span>}
          </p>
        </li>
      ))}
    </ol>
  );
}
