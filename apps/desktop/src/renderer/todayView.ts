import type { TodayCard, TodayRoute, TodayState, TodayTask } from './todayContract.ts';

/**
 * What the Today window shows, as a pure function of the state the main process sent
 * (specification 8.2, 14.2).
 *
 * The same split G2 made in `viewModel.ts`, for the same reason: "when offline or
 * below the minimum client version, cloud-dependent controls show a clear
 * non-actionable state" is a rule, and keeping it out of the DOM makes it a unit test
 * rather than a screenshot.
 *
 * Three rules live here.
 *
 * **A stale list is readable and nothing on it is pressable.** 4.2: the client "shows
 * its unexpired cached Today view marked stale" and "mutations fail closed". So a
 * stale card renders, its counts render, and its dial, snooze and outcome controls
 * are disabled — including the expansion, because expanding needs the cloud.
 *
 * **The order is the server's.** This file never sorts. 8.2's order is decided by the
 * snapshot and proved by a property test in `@fss/domain`; a second sort here would be
 * a second implementation of it, and the two would disagree the day one changed.
 *
 * **A refusal is a code, and this is the one place it becomes a sentence.** The window
 * composes nothing of its own, so the words a person reads are versioned with the
 * release and one code never says two things.
 */

export interface BannerView {
  readonly tone: 'info' | 'warning' | 'blocking';
  readonly text: string;
}

export const LANE_LABELS: Readonly<Record<TodayCard['lane'], string>> = Object.freeze({
  reply: 'Reply',
  callback: 'Callback',
  due_work: 'Due today',
  new_firm: 'New firm',
});

export const TASK_LABELS: Readonly<Record<TodayTask['kind'], string>> = Object.freeze({
  reply: 'Reply to read',
  callback: 'Callback',
  email_due: 'Email due',
  call_due: 'Call due',
  linkedin_due: 'LinkedIn task',
  new_firm: 'Not yet contacted',
});

const NOTICES: Readonly<Record<string, string>> = Object.freeze({
  offline: 'Callie cannot reach the server.',
  not_signed_in: 'Sign in on the main window before working today’s list.',
  client_upgrade_required: 'This version of Callie is out of date. Install the current build to continue.',
  snoozed: 'Snoozed.',
  held: 'That send is automated, so Callie recorded a hold instead of a snooze.',
  snooze_cancelled: 'Back on the list.',
  item_not_open: 'That task is already finished.',
  item_unknown: 'That task is no longer on today’s list.',
  snooze_reason_required: 'A snooze needs a reason.',
  snooze_return_not_future: 'Pick a moment in the future for it to come back.',
  outcome_recorded: 'Call recorded.',
  dial_opened: 'Handed to the phone app.',
  dial_opened_unknown: 'Callie could not confirm the phone app opened. Record what happened either way.',
  no_tel_handler: 'This Mac has no phone app registered for tel: links.',
  handler_changed: 'The phone app changed while Callie was asking. Try again.',
  invalid_target: 'The server’s number did not match its own link. Nothing was dialed.',
  firm_suppressed: 'This firm asked not to be contacted.',
  handle_suppressed: 'That number is suppressed.',
  route_version_stale: 'This card is out of date. Refresh before dialing.',
  already_consumed: 'That authorization was already used. Ask for another.',
  identity_not_verified: 'Callie has no verified number of yours to call from.',
  refused: 'The server refused that.',
  unreadable_answer: 'Callie could not read the server’s answer.',
});

/** The one place a refusal code becomes English. Unknown codes are shown as-is. */
export function noticeSentence(code: string): string {
  return NOTICES[code] ?? code;
}

export interface CardView {
  readonly card: TodayCard;
  readonly laneLabel: string;
  /** "2 emails, 1 call" — the aggregate 8.2 puts on the card, as text. */
  readonly countsLabel: string;
  readonly expanded: boolean;
}

export interface TaskView {
  readonly task: TodayTask;
  readonly label: string;
  /** Automated work is held, not snoozed (8.2); the control says so. */
  readonly delayLabel: string;
  readonly enabled: boolean;
}

export interface TodayScreenView {
  readonly heading: string;
  readonly banners: readonly BannerView[];
  readonly cards: readonly CardView[];
  readonly tasks: readonly TaskView[];
  /** Routes that may be dialed right now, in the versions the server just sent. */
  readonly dialableRoutes: readonly TodayRoute[];
  /** Whether anything that would mutate cloud state may be offered at all. */
  readonly actionsEnabled: boolean;
  /** Whether a card may be expanded. Expansion is a cloud read, so not when stale. */
  readonly expandEnabled: boolean;
  readonly showingCachedList: boolean;
  readonly emptyMessage: string | null;
}

export const TODAY_HEADING = 'Today';
const EMPTY_LIST = 'Nothing is due today.';
const EMPTY_OFFLINE = 'Callie has no saved list for today.';

function plural(count: number, one: string, many: string): string | null {
  if (count === 0) return null;
  return `${String(count)} ${count === 1 ? one : many}`;
}

export function countsLabel(counts: TodayCard['counts']): string {
  const parts = [
    plural(counts.replies, 'reply', 'replies'),
    plural(counts.emailsDue, 'email', 'emails'),
    plural(counts.callsDue, 'call', 'calls'),
    plural(counts.linkedInDue, 'LinkedIn task', 'LinkedIn tasks'),
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? 'Nothing outstanding' : parts.join(', ');
}

export function buildTodayView(state: TodayState): TodayScreenView {
  const banners: BannerView[] = [];
  if (!state.online) banners.push({ tone: 'warning', text: noticeSentence('offline') });
  if (state.stale) {
    banners.push({
      tone: 'warning',
      text:
        state.asOf === null
          ? 'This list is from an earlier read. Nothing here can be changed until Callie reconnects.'
          : `This list is from an earlier read, at ${state.asOf}. Nothing here can be changed until Callie reconnects.`,
    });
  }
  if (state.notice !== null) banners.push({ tone: 'info', text: noticeSentence(state.notice) });

  const actionsEnabled = state.mayMutate && state.online && !state.stale;
  const expandEnabled = state.online && !state.stale;

  const cards = state.cards.map(card => ({
    card,
    laneLabel: LANE_LABELS[card.lane],
    countsLabel: countsLabel(card.counts),
    expanded: state.expanded?.firmId === card.firmId,
  }));

  const tasks = (state.expanded?.tasks ?? []).map(task => ({
    task,
    label: TASK_LABELS[task.kind],
    // 8.2: "Automated sends are not snoozed ad hoc; delaying them creates a recorded
    // hold." The button says which of the two it will do, so nobody presses "snooze"
    // and gets a hold they did not ask for.
    delayLabel: task.automated ? 'Hold this send' : 'Snooze',
    enabled: actionsEnabled && task.status === 'open',
  }));

  return {
    heading: TODAY_HEADING,
    banners,
    cards,
    tasks,
    // 9.1: a route that is not `usable` is shown on the Firm page and is not dialable
    // from here. The server refuses it anyway; offering it would only be a button
    // whose whole purpose is to be refused.
    dialableRoutes:
      actionsEnabled && state.expanded?.callingIdentityId !== null
        ? (state.expanded?.routes ?? []).filter(route => route.eligibility === 'usable')
        : [],
    actionsEnabled,
    expandEnabled,
    showingCachedList: state.stale && state.cards.length > 0,
    emptyMessage: state.cards.length > 0 ? null : state.online ? EMPTY_LIST : EMPTY_OFFLINE,
  };
}
