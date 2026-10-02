import type { BoardCard } from '@fss/contracts';
import type { PipelineView } from '../firmWorkspaceContract.ts';

/**
 * The board's totals (UI criterion 5). Pure, so a test holds them to the cards.
 *
 * An **agreed** monthly value is a commitment and an **estimated** one is a guess, so they
 * are never added into one figure: each is its own total. A firm with no value yet is
 * counted apart as well, and that count is the one a person can act on (it opens the list).
 * Lost firms are not "open".
 */

export interface Totals {
  readonly firms: number;
  readonly agreedCents: number;
  readonly estimatedCents: number;
  /** Firms in the count whose card carries no value at all. */
  readonly withoutValue: number;
}

export const NO_TOTALS: Totals = { firms: 0, agreedCents: 0, estimatedCents: 0, withoutValue: 0 };

export function totalsOf(cards: readonly (BoardCard | undefined)[]): Totals {
  let agreedCents = 0;
  let estimatedCents = 0;
  let withoutValue = 0;
  for (const card of cards) {
    const value = card?.value ?? null;
    if (value === null) withoutValue += 1;
    else if (value.kind === 'agreed') agreedCents += value.monthlyCents;
    else estimatedCents += value.monthlyCents;
  }
  return { firms: cards.length, agreedCents, estimatedCents, withoutValue };
}

const MONEY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
export const moneyOf = (cents: number): string => MONEY.format(Math.round(cents / 100));

/** "$1,240 agreed + $2,000 estimated", leaving out a part that is zero; empty when both are. */
export function valueSummary(totals: Pick<Totals, 'agreedCents' | 'estimatedCents'>): string {
  const parts: string[] = [];
  if (totals.agreedCents > 0) parts.push(`${moneyOf(totals.agreedCents)}/mo agreed`);
  if (totals.estimatedCents > 0) parts.push(`${moneyOf(totals.estimatedCents)}/mo estimated`);
  return parts.join(' + ');
}

/** Every firm in a column that is not Lost: what is on the board now. */
export function openTotals(pipeline: PipelineView): Totals {
  const cards: (BoardCard | undefined)[] = [];
  for (const column of pipeline.columns) {
    if (column.stage.terminalKind === 'lost') continue;
    for (const firm of column.firms) cards.push(pipeline.cards?.[firm.id]);
  }
  return totalsOf(cards);
}
