import type { BoardCard } from '@fss/contracts';

/**
 * The words on a Kanban card (slice K). Pure, so the card's rules are tested without
 * drawing it. Nothing here decides anything: every phrase describes a fact the API sent.
 */

const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const DAY_TIME = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const FULL = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });

export const dayOf = (instant: string): string => DAY.format(new Date(instant));
export const dayTimeOf = (instant: string): string => DAY_TIME.format(new Date(instant));
export const fullTimeOf = (instant: string): string => FULL.format(new Date(instant));

/** "$1,200/mo · estimated" — whole dollars unless there are cents. */
export function valueLabel(value: NonNullable<BoardCard['value']>): string {
  const dollars = value.monthlyCents / 100;
  const text = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: Number.isInteger(dollars) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(dollars);
  return `${text}/mo · ${value.kind}`;
}

/**
 * "Call back · Tue 2 pm": the weekday and the hour, in the firm's zone when the board knows
 * it and the Mac's otherwise (an unknown zone name falls back the same way). Minutes only
 * when there are some: "Tue 2:30 pm".
 */
export function nextActionLabel(
  next: { readonly label: string; readonly dueAt: string },
  timeZone: string | null,
): string {
  const at = new Date(next.dueAt);
  const format = (zone: string | undefined): string => {
    const parts = new Intl.DateTimeFormat('en-US', {
      ...(zone === undefined ? {} : { timeZone: zone }),
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).formatToParts(at);
    const get = (type: string): string => parts.find(part => part.type === type)?.value ?? '';
    const minute = get('minute');
    const time = `${get('hour')}${minute === '00' ? '' : `:${minute}`} ${get('dayPeriod').toLowerCase()}`;
    return `${get('weekday')} ${time}`;
  };
  let when: string;
  try {
    when = format(timeZone ?? undefined);
  } catch {
    when = format(undefined);
  }
  return `${next.label} \u00b7 ${when}`;
}

export type ValueParse =
  | { readonly ok: true; readonly monthlyCents: number }
  | { readonly ok: false; readonly problem: 'empty' | 'not_a_number' | 'too_many_decimals' | 'negative' | 'too_large' };

/** "1200", "$1,200" or "1200.50" as whole cents; anything else says why not. */
export function parseMonthlyDollars(text: string): ValueParse {
  const cleaned = text.trim().replace(/^\$/u, '').replace(/,/gu, '');
  if (cleaned === '') return { ok: false, problem: 'empty' };
  if (/^-/u.test(cleaned)) return { ok: false, problem: 'negative' };
  if (!/^\d+(\.\d*)?$/u.test(cleaned)) return { ok: false, problem: 'not_a_number' };
  const [whole = '', fraction = ''] = cleaned.split('.');
  if (fraction.length > 2) return { ok: false, problem: 'too_many_decimals' };
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  // The table's own bound: $1,000,000 a month.
  if (cents > 100_000_000) return { ok: false, problem: 'too_large' };
  return { ok: true, monthlyCents: cents };
}

export const VALUE_PROBLEMS: Readonly<Record<Extract<ValueParse, { ok: false }>['problem'], string>> = {
  empty: 'Enter the amount per month.',
  not_a_number: 'Use digits only, like 1200 or 1,200.50.',
  too_many_decimals: 'Cents only: two digits after the point.',
  negative: 'The amount cannot be negative.',
  too_large: 'That is more than $1,000,000 a month.',
};

const MEETING_WORDS: Readonly<Record<string, string>> = {
  booked: 'Booked',
  rescheduled: 'Rescheduled',
  held: 'Held',
  no_show: 'No-show',
  cancelled: 'Cancelled',
};

/** "Booked · Oct 3, 2:00 PM". An unknown state shows as itself rather than vanishing. */
export function meetingLabel(meeting: NonNullable<BoardCard['meeting']>): string {
  return `${MEETING_WORDS[meeting.state] ?? meeting.state} · ${dayTimeOf(meeting.startsAt)}`;
}

/**
 * Every `stage_rules.evidence_kind` migration 0028 seeds, as a phrase that finishes
 * "Moved to <stage> · ". An unknown kind falls back to its code, so a rule added later
 * still shows evidence instead of a card that moved for no stated reason.
 */
export function evidencePhrase(kind: string, occurredAt: string): string {
  switch (kind) {
    case 'meeting.booked':
      return `booking on ${dayOf(occurredAt)} (Cal.com)`;
    case 'call.interested':
      return `interested call on ${dayOf(occurredAt)}`;
    case 'subscription.accepted':
      return `subscription accepted on ${dayOf(occurredAt)}`;
    case 'customer.live':
      return `customer went live on ${dayOf(occurredAt)}`;
    default:
      return `${kind} on ${dayOf(occurredAt)}`;
  }
}

/** The evidence kinds with their own phrase, exported so a test can hold them to the seed. */
export const KNOWN_EVIDENCE_KINDS = ['meeting.booked', 'call.interested', 'subscription.accepted', 'customer.live'] as const;
