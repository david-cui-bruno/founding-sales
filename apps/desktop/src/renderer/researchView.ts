import type { CallBriefDto } from '@fss/contracts';
import type { ResearchState } from './researchContract.ts';

/**
 * Research, as text and nothing else (lane R).
 *
 * The one place a refusal code, a judgment, a cent count and a source URL become
 * English. Nothing in the components composes a sentence, for the reason every other
 * view here gives: a wire code that changed should break one table rather than five
 * pieces of JSX.
 *
 * David's taste (minimal, Notion-like): grey text and dividers, hover-revealed
 * actions, no colour except a dot. So a judgment is a small grey label and not a
 * badge, and "AI suggestion" is a grey word beside two lines rather than a banner.
 */

const NOTICES: Readonly<Record<string, string>> = Object.freeze({
  offline: 'Callie could not reach the server.',
  not_signed_in: 'Sign in before reading a firm’s research.',
  client_upgrade_required: 'This version of Callie is out of date. Install the current build to continue.',
  research_queued: 'Queued. Callie will read the firm’s site shortly.',
  research_link_added: 'Link added. Callie will read it on the next run.',
  research_settings_saved: 'Saved.',
  research_disabled: 'Research is switched off for this workspace.',
  ceiling_reached: 'Today’s research budget is spent. Callie will pick this firm up tomorrow.',
  daily_firm_ceiling: 'Today’s research budget is spent. Callie will pick this firm up tomorrow.',
  daily_cost_ceiling: 'Today’s research budget is spent. Callie will pick this firm up tomorrow.',
  monthly_cost_ceiling: 'This month’s research budget is spent.',
  run_in_progress: 'Callie is already reading this firm.',
  no_sources: 'This firm publishes no website, and no link has been added.',
  firm_suppressed: 'This firm asked not to be contacted, so Callie does not read its site.',
  firm_merged: 'This firm was merged into another one.',
  firm_unknown: 'That firm is not one you can see.',
  not_assigned: 'That firm is not assigned to you.',
  admin_only: 'Only an admin may change the research settings.',
  link_not_permitted: 'Callie reads https pages, and never a directory, a social network or a job board.',
  provider_failure: 'The last run could not finish. Callie will try again.',
  model_unpriced: 'The configured model has no reviewed price, so nothing may run.',
  invalid_input: 'Callie could not use that.',
  refused: 'The server refused that.',
  unreadable_answer: 'Callie could not read the server’s answer.',
});

/** The one place a research refusal code becomes English. Unknown codes are shown as-is. */
export function researchNotice(code: string): string {
  return NOTICES[code] ?? code;
}

/** The four judgments, in the order the design record names them. */
export const JUDGMENT_LABELS = ['Fit', 'Problem', 'Timing', 'Reach'] as const;

export interface JudgmentChip {
  readonly label: string;
  readonly value: 'yes' | 'no' | 'unknown';
  /** What the value says, as one word. `unknown` is "—": silence, not a denial. */
  readonly text: string;
}

export function judgmentChips(judgments: CallBriefDto['judgments']): readonly JudgmentChip[] {
  const word = (value: 'yes' | 'no' | 'unknown'): string => (value === 'yes' ? 'yes' : value === 'no' ? 'no' : '—');
  return [
    { label: 'Fit', value: judgments.fit, text: word(judgments.fit) },
    { label: 'Problem', value: judgments.problemEvidence, text: word(judgments.problemEvidence) },
    { label: 'Timing', value: judgments.timing, text: word(judgments.timing) },
    { label: 'Reach', value: judgments.reachability, text: word(judgments.reachability) },
  ];
}

/** `example.test` from `https://example.test/about`, or the whole URL when it is not one. */
export function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./u, '');
  } catch {
    return url;
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * `28 Sep 2026`.
 *
 * Composed rather than `toLocaleDateString`: ICU changed `short` for September from
 * `Sep` to `Sept` in en-GB, so a locale format would read differently on two Macs with
 * different ICU data and the retrieval date beside a quote is a fact, not a flourish.
 */
export function shortDate(instant: string): string {
  const parsed = new Date(instant);
  if (Number.isNaN(parsed.getTime())) return '';
  return `${String(parsed.getDate())} ${MONTHS[parsed.getMonth()] ?? ''} ${String(parsed.getFullYear())}`;
}

/** `$0.42` from 42, and `$12.00` from 1200. Cents are the wire unit throughout. */
export function dollars(cents: number): string {
  return `$${(Math.max(0, Math.trunc(cents)) / 100).toFixed(2)}`;
}

/** The one grey line a firm nobody has researched shows in place of a brief. */
export const NOT_RESEARCHED_LINE = 'Not researched yet.';

/** What the runs list says about one run. */
export function runLine(run: {
  readonly startedAt: string;
  readonly outcome: string;
  readonly refusalCode: string | null;
  readonly costCents: number;
  readonly factsRecorded: number;
}): string {
  const when = shortDate(run.startedAt);
  if (run.outcome === 'running') return `${when} — running`;
  if (run.outcome === 'completed') {
    return `${when} — ${String(run.factsRecorded)} fact${run.factsRecorded === 1 ? '' : 's'}, ${dollars(run.costCents)}`;
  }
  return `${when} — ${run.outcome}: ${researchNotice(run.refusalCode ?? 'refused')}`;
}

/** The month-to-date line an admin reads beside the ceilings. */
export function spendLine(state: ResearchState): string | null {
  if (state.spend === null) return null;
  const monthly = state.settings === null ? null : state.settings.monthlyCostCeilingCents;
  const today = `${dollars(state.spend.todayCents)} today`;
  const month =
    monthly === null
      ? `${dollars(state.spend.monthToDateCents)} this month`
      : `${dollars(state.spend.monthToDateCents)} of ${dollars(monthly)} this month`;
  return `${today}, ${month}.`;
}
