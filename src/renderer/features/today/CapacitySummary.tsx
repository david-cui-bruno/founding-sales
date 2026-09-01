import type { TodaySnapshot } from '../../../shared/contracts/todayContract';

export type CapacitySummaryProps = {
  snapshot: TodaySnapshot;
};

/**
 * Capacity is a label, never a filter: promised lanes stay visible even at
 * zero budget. The dial budget renders as a real progress bar; values come
 * straight from the strict snapshot.
 */
export function CapacitySummary({ snapshot }: CapacitySummaryProps) {
  const budget = snapshot.dialBudget;
  const scheduled = Math.min(snapshot.scheduledDials, budget);
  const percent = budget === 0 ? 0 : Math.round((scheduled / budget) * 100);
  const label = `${snapshot.scheduledDials} of ${budget} dials today`;

  return (
    <div className="capacity-summary">
      <div className="capacity-summary__progress">
        <span className="capacity-summary__dials">{label}</span>
        <div
          className="capacity-summary__track"
          role="progressbar"
          aria-label="Dial budget"
          aria-valuemin={0}
          aria-valuemax={budget}
          aria-valuenow={snapshot.scheduledDials}
          aria-valuetext={label}
        >
          <div
            className="capacity-summary__fill"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
      <span className="capacity-summary__conversations">
        {`Conversation target ${snapshot.conversationTarget}`}
      </span>
      {snapshot.reviewErrorCount > 0 && (
        <span className="capacity-summary__errors">
          {`${snapshot.reviewErrorCount} review ${
            snapshot.reviewErrorCount === 1 ? 'error' : 'errors'
          }`}
        </span>
      )}
    </div>
  );
}
