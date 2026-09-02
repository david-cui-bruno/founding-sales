import type { FridayReport } from '../../../shared/contracts/fridayContract';
import { PageHeader } from '../../components/PageHeader';

// Local-time display only: the domain owns the window bounds; the renderer
// never re-derives them and never prints raw UTC strings.
const day = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric',
});
const stamp = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

/** Pure display formatting for the report window; no date math. */
export function formatPeriod(report: FridayReport): string {
  return `${day.format(new Date(report.periodStartsAt))} – ${day.format(
    new Date(report.periodEndsAt),
  )}`;
}

export function formatAsOf(report: FridayReport): string {
  return `As of ${stamp.format(new Date(report.asOf))}`;
}

/** Matches the -520 floor in fridayReportRequestSchema. */
const MIN_WEEK_OFFSET = -520;

export type ScoreboardHeaderProps = {
  report: FridayReport;
  weekOffset: number;
  onPreviousWeek(): void;
  onNextWeek(): void;
};

/**
 * Scoreboard page header: the domain-provided week bounds inside a ‹ › week
 * picker, plus the as-of stamp. The next-week button stops at the current
 * week because future windows cannot contain events.
 */
export function ScoreboardHeader({
  report,
  weekOffset,
  onPreviousWeek,
  onNextWeek,
}: ScoreboardHeaderProps) {
  return (
    <PageHeader
      title="Friday scoreboard"
      trailing={
        <div className="friday__period-controls">
          <div className="friday__week-picker">
            <button
              type="button"
              className="friday__week-step"
              aria-label="Previous week"
              disabled={weekOffset <= MIN_WEEK_OFFSET}
              onClick={onPreviousWeek}
            >
              ‹
            </button>
            <span className="friday__period numeric">{formatPeriod(report)}</span>
            <button
              type="button"
              className="friday__week-step"
              aria-label="Next week"
              disabled={weekOffset >= 0}
              onClick={onNextWeek}
            >
              ›
            </button>
          </div>
          <span className="friday__as-of numeric">{formatAsOf(report)}</span>
        </div>
      }
    />
  );
}
