import { reasonSentence, type CallBriefDto } from '@fss/contracts';
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
  lease_lost: 'That run stopped part-way. Callie will try again, and has kept what it may have cost.',
  model_unpriced: 'The configured model has no reviewed price, so nothing may run.',
  over_budget:
    'Callie has already read this firm as often as a day’s budget allows. It will pick it up again tomorrow.',
  invalid_input: 'Callie could not use that.',
  refused: 'The server refused that.',
  unreadable_answer: 'Callie could not read the server’s answer.',
});

/** The one place a research refusal code becomes English. An unknown code gets the shared generic sentence. */
export function researchNotice(code: string): string {
  return NOTICES[code] ?? reasonSentence(code);
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

/**
 * The line a firm whose last runs failed shows above its brief, or null.
 *
 * A provider failure completes its job rather than throwing, because throwing would
 * roll back the accounting of a call that was already paid for, so the retry is the
 * daily sweep's and it stops after three. Without this line the card would show a brief
 * that is quietly a week out of date and nothing to say so — which of the two silences
 * is the worse one.
 */
export function failedTriesLine(failedTries: number): string | null {
  const tries = Math.max(0, Math.trunc(failedTries));
  if (tries === 0) return null;
  const plural = `${String(tries)} tr${tries === 1 ? 'y' : 'ies'}`;
  return tries >= 3
    ? `Research failed, ${plural}. Callie has stopped trying this firm.`
    : `Research failed, ${plural}. Callie will try again tomorrow.`;
}

/**
 * What a fact's source line says: the key, the host, the date — and, when the page is
 * not the firm's own, that it is somebody else's.
 *
 * The brief carries `attribution` for the same reason, from `research/brief.ts`. A
 * quote from a link a person added is not the firm saying anything, and a section that
 * laid it out identically would be presenting it as though it were.
 */
export function factSourceLine(fact: {
  readonly key: string;
  readonly sourceReference: string;
  readonly retrievedAt: string;
  readonly firstParty: boolean;
}): string {
  const own = fact.firstParty ? '' : ' · another source';
  return `${fact.key} · ${sourceHost(fact.sourceReference)} · ${shortDate(fact.retrievedAt)}${own}`;
}

/**
 * What a fact shows in place of a quote when it has none.
 *
 * `named_role`, `phone_listed` and `role` store no quote: the block they name is a
 * block naming a person, and a contact's deletion does not reach a firm's rows
 * (`research/facts.ts`, `PERSON_FACT_KEYS`). The fact is still worth showing — it is
 * what a judgment rests on — so the line says what the page did rather than quoting it.
 */
const QUOTELESS_LINES: Readonly<Record<string, string>> = Object.freeze({
  named_role: 'The firm’s own site names a person with a title.',
  phone_listed: 'The firm’s own site publishes a number to call.',
  role: 'The firm’s own site names a job title.',
});

export function factLine(fact: { readonly key: string; readonly quote: string | null }): string {
  if (fact.quote !== null) return `“${fact.quote}”`;
  return QUOTELESS_LINES[fact.key] ?? 'Recorded from the page, without a quotation.';
}

/**
 * What the runs list says about one run.
 *
 * A cost the provider never reported reads "about $0.03" rather than as a figure: it is
 * what the run reserved, recorded because a call that may have been billed must not be
 * shown as free. `costEstimated` on the wire is the same claim.
 *
 * A completed run with no facts has a reason, and `extraction` is it. `over_budget` is
 * the one worth a word here: the pages were read and kept, and the model was not asked
 * because the request would not fit inside what the ceiling authorized. Without the
 * word it reads as a run that found nothing, which is a different thing entirely.
 */
export function runLine(run: {
  readonly startedAt: string;
  readonly outcome: string;
  readonly refusalCode: string | null;
  readonly costCents: number;
  readonly costEstimated?: boolean | undefined;
  readonly extraction?: string | undefined;
  readonly factsRecorded: number;
}): string {
  const when = shortDate(run.startedAt);
  const cost = run.costEstimated === true ? `about ${dollars(run.costCents)}` : dollars(run.costCents);
  if (run.outcome === 'running') return `${when} — running`;
  if (run.outcome === 'completed') {
    const facts = `${String(run.factsRecorded)} fact${run.factsRecorded === 1 ? '' : 's'}, ${cost}`;
    if (run.extraction === 'over_budget') return `${when} — pages kept, too long to read in one go (${cost})`;
    return `${when} — ${facts}`;
  }
  const why = researchNotice(run.refusalCode ?? 'refused');
  return run.costCents > 0 ? `${when} — ${run.outcome}: ${why} (${cost})` : `${when} — ${run.outcome}: ${why}`;
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
