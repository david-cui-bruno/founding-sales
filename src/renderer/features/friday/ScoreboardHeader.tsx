import type { FridayReport } from '../../../shared/contracts/fridayContract';
import { PageHeader } from '../../components/PageHeader';

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

/** Scoreboard page header with the domain-provided week bounds and as-of time. */
export function ScoreboardHeader({ report }: ScoreboardHeaderProps) {
  return (
    <PageHeader
      title="Friday scoreboard"
      trailing={
        <p className="friday__period numeric">
          <span>{formatPeriod(report)}</span>
          <span className="friday__as-of">{formatAsOf(report)}</span>
        </p>
      }
    />
  );
}
