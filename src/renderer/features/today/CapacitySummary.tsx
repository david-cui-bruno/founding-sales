import type { TodaySnapshot } from '../../../shared/contracts/todayContract';

export type CapacitySummaryProps = {
  snapshot: TodaySnapshot;
};

/**
 * Capacity is a label, never a filter: promised lanes stay visible even at
 * zero budget. Values come straight from the strict snapshot.
 */
export function CapacitySummary({ snapshot }: CapacitySummaryProps) {
  return (
    <div className="capacity-summary">
      <span className="capacity-summary__dials">
        {`${snapshot.scheduledDials} of ${snapshot.dialBudget} dials scheduled`}
      </span>
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
