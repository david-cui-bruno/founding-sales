import type { TodaySnapshot } from '../../../shared/contracts/todayContract';

export type DialMeterProps = {
  snapshot: TodaySnapshot;
};

/**
 * The header dial meter (audit 4.2): "N of 40 dials" over a thin accent
 * track. Capacity is a label, never a filter; values come straight from the
 * strict snapshot and the track is a real progressbar.
 */
export function DialMeter({ snapshot }: DialMeterProps) {
  const budget = snapshot.dialBudget;
  const clamped = Math.min(snapshot.scheduledDials, budget);
  const percent = budget === 0 ? 0 : Math.round((clamped / budget) * 100);
  const label = `${snapshot.scheduledDials} of ${budget} dials`;

  return (
    <div className="dial-meter">
      <span className="dial-meter__label">{label}</span>
      <div
        className="dial-meter__track"
        role="progressbar"
        aria-label="Dial budget"
        aria-valuemin={0}
        aria-valuemax={budget}
        aria-valuenow={snapshot.scheduledDials}
        aria-valuetext={label}
      >
        <div className="dial-meter__fill" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
