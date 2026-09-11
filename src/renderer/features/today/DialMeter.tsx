import type { TodaySnapshot } from '../../../shared/contracts/todayContract';

export type DialMeterProps = {
  snapshot: TodaySnapshot;
};

/**
 * The header dial meter (audit 4.2): "N queued discretionary calls · target 40" over a thin accent
 * track. Capacity is a label, never a filter; values come straight from the
 * strict snapshot and the track is an occupancy meter, not completed activity.
 */
export function DialMeter({ snapshot }: DialMeterProps) {
  const budget = snapshot.dialBudget;
  const clamped = Math.min(snapshot.scheduledDials, budget);
  const percent = budget === 0 ? 0 : Math.round((clamped / budget) * 100);
  const label = `${snapshot.scheduledDials} queued discretionary calls · target ${budget}`;

  return (
    <div className="dial-meter">
      <span className="dial-meter__label">{label}</span>
      <div
        className="dial-meter__track"
        role="meter"
        aria-label="Queued discretionary calls"
        aria-valuemin={0}
        aria-valuemax={budget}
        aria-valuenow={clamped}
        aria-valuetext={label}
      >
        <div className="dial-meter__fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
