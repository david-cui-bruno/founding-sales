import type { ResearchSetupStatus } from '../../../shared/contracts/researchSetupContract';
import type { UsageSummary, UsageWindow } from '../../../shared/contracts/usageContract';
import { WEEKLY_SUMMARY_COPY } from './todayCopy';

/**
 * Discovery and research spend, from the last worker status the footer already
 * read. Nothing here calls the worker: the footer reads it once per stored sync
 * attempt and hands the result down. A status this renderer could not read is
 * `Spend unknown`, never a zero, and an absent ledger is unknown for that ledger
 * alone. These are running totals against the standing caps, not a weekly figure:
 * the worker keeps one ledger per workspace and no weekly breakdown exists.
 */
export function describeWeeklySpend(status: ResearchSetupStatus | null): string {
  const usd = (micros: number) => (micros / 1_000_000).toFixed(2);
  const ledger = (label: string, value: { limitMicros: number; reservedOrSpentMicros: number } | null | undefined) =>
    value ? `${label} USD ${usd(value.reservedOrSpentMicros)} of ${usd(value.limitMicros)}` : `${label} unknown`;
  if (!status?.remote) return WEEKLY_SUMMARY_COPY.spendUnknown;
  return `${ledger('Discovery', status.remote.discoveryLedger)} · ${ledger('research', status.remote.researchLedger)} (to date)`;
}

const OUTCOME_ORDER = ['connected', 'interested', 'not_interested', 'gatekeeper', 'voicemail', 'no_answer', 'busy', 'wrong_number'] as const;

/** One window as a plain definition list. No chart, no ranking, no target. */
function windowRows(window: UsageWindow): readonly (readonly [string, string])[] {
  const { labels, outcomes, holdReasons, noHolds } = WEEKLY_SUMMARY_COPY;
  return [
    [labels.mornings, String(window.mornings)],
    [labels.firms, String(window.firms)],
    [labels.callsPlaced, String(window.callsPlaced)],
    ...OUTCOME_ORDER.map(kind => [outcomes[kind], String(window.outcomes[kind])] as const),
    [labels.notes, String(window.notes)],
    [labels.callbacksPromised, String(window.callbacksPromised)],
    [labels.callbacksKept, String(window.callbacksKept)],
    [labels.drafts, String(window.drafts)],
    [labels.replies, String(window.replies)],
    [labels.holds, window.holds.length
      ? window.holds.map(hold => `${holdReasons[hold.reason]} ${hold.count}`).join(' · ')
      : noHolds],
  ];
}

/** "Last week" is one line: the same facts, compressed, so the trend is readable without a chart. */
function lastWeekLine(window: UsageWindow): string {
  const { labels } = WEEKLY_SUMMARY_COPY;
  const connected = window.outcomes.connected + window.outcomes.interested + window.outcomes.not_interested + window.outcomes.gatekeeper;
  return `${WEEKLY_SUMMARY_COPY.lastWeekHeading} (${window.from} to ${window.to}): `
    + `${labels.mornings.toLowerCase()} ${window.mornings} · ${labels.callsPlaced.toLowerCase()} ${window.callsPlaced} · connected ${connected}`
    + ` · ${labels.replies.toLowerCase()} ${window.replies} · ${labels.callbacksKept.toLowerCase()} ${window.callbacksKept}`;
}

/**
 * The weekly block below the footer. Collapsed by default: the morning list is
 * the work, and the numbers are for the week's review, not the morning's.
 */
export function WeeklySummary({ usage, status }: { usage?: UsageSummary; status: ResearchSetupStatus | null }) {
  if (!usage) {
    // No role="status" here: the footer's one line is the status region, and a second one would
    // make the footer announce twice and make every strict locator for it ambiguous.
    return <section aria-label={WEEKLY_SUMMARY_COPY.heading}>
      <p>{WEEKLY_SUMMARY_COPY.unavailable}</p>
    </section>;
  }
  return <section aria-label={WEEKLY_SUMMARY_COPY.heading}>
    <details>
      <summary>{WEEKLY_SUMMARY_COPY.heading} ({usage.thisWeek.from} to {usage.thisWeek.to})</summary>
      <p>{WEEKLY_SUMMARY_COPY.derivation}</p>
      <dl>
        {windowRows(usage.thisWeek).map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        <div key="spend">
          <dt>Spend</dt>
          <dd>{describeWeeklySpend(status)}</dd>
        </div>
      </dl>
      <p>{lastWeekLine(usage.lastWeek)}</p>
    </details>
  </section>;
}
