import type { FridayReport } from '../../../shared/contracts/fridayContract';

const day = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', timeZone: 'UTC',
});
const stamp = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  timeZone: 'UTC', timeZoneName: 'short',
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

export type ScoreboardHeaderProps = {
  report: FridayReport;
};

/** Scoreboard heading with the domain-provided week bounds and as-of time. */
export function ScoreboardHeader({ report }: ScoreboardHeaderProps) {
  return (
    <header className="friday__header">
      <h1 className="friday__title">Friday scoreboard</h1>
      <p className="friday__period">
        <span>{formatPeriod(report)}</span>
        <span className="friday__as-of">{formatAsOf(report)}</span>
      </p>
    </header>
  );
}
