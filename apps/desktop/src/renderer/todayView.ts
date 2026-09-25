import { callbackInstant, localParts } from '@fss/contracts';
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

/**
 * What a card with numbers and no calling identity says (lane g60). 9.1 requires the
 * number a call leaves on to be the salesperson's own and attested, and until that
 * exists the card has no Call button — so the card says where to add it rather than
 * leaving a person to wonder why the button is missing.
 */
export const NO_CALLING_NUMBER =
  'Callie has no attested number of yours to call from. Add it in Window › Administration, under Your calling number.';

const NOTICES: Readonly<Record<string, string>> = Object.freeze({
  offline: 'Callie cannot reach the server.',
  not_signed_in: 'Sign in on the main window before working today’s list.',
  client_upgrade_required: 'This version of Callie is out of date. Install the current build to continue.',
  snoozed: 'Snoozed.',
  // Lane g79 (C22): an automated send is paused until somebody presses Resume, not
  // until a time. The wire word is still `held`.
  held: 'Paused. Callie will not send it until you press Resume on the task.',
  pause_released: 'Resumed. Callie will send it at its next slot.',
  pause_already_released: 'That send was already resumed.',
  pause_unknown: 'That pause is no longer there.',
  snooze_return_required: 'Pick when it should come back.',
  outcome_recorded_callback_time_needed:
    'Call recorded. The callback has no time yet, so “Callback — needs a time” is on today’s list.',
  outcome_recorded_route_not_named:
    'Call recorded. No number was chosen, so Callie did not retire or suppress one. Do that from the firm’s page.',
  outcome_recorded_effects_not_applied:
    'Call recorded, but Callie could not apply what it means. Nothing else changed; check the firm’s page.',
  callback_scheduled: 'Callback scheduled.',
  callback_time_invalid: 'That is not a day and time Callie can place a callback at.',
  callback_already_scheduled: 'That call already has its callback.',
  callback_instant_mismatch: 'The callback time changed while you were entering it. Check it and record it again.',
  occurred_at_in_future: 'That call time is in the future.',
  ticket_mismatch: 'That call does not match the number Callie dialed. Refresh and record it again.',
  route_unknown: 'That number is not this firm’s. Refresh and record it again.',
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
  identity_not_verified: NO_CALLING_NUMBER,
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
  /** Automated work is paused, not snoozed (8.2); the control says so. */
  readonly delayLabel: string;
  readonly enabled: boolean;
  /** A paused automated task: the card shows Resume instead of Pause (lane g79, C22). */
  readonly paused: boolean;
  /** "Callback — needs a time": the card offers a day and a time (lane g79, C13). */
  readonly needsTime: boolean;
  /** Whether a call's outcome can be recorded against this task (a call due or a callback). */
  readonly callable: boolean;
}

export interface TodayScreenView {
  readonly heading: string;
  readonly banners: readonly BannerView[];
  readonly cards: readonly CardView[];
  readonly tasks: readonly TaskView[];
  /**
   * The task an outcome is recorded against by default: the callable task of the
   * contact just called, else the first callable task, else none (lane g79).
   */
  readonly outcomeItemId: string | null;
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
/** A callback a recorded call asked for without a time (lane g79, C13). */
export const NEEDS_TIME_LABEL = 'Callback — needs a time';
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
  // A card with a number to dial and nothing to dial it from. Said once, and not again
  // when the notice already says it.
  if (
    state.expanded !== null &&
    state.expanded.callingIdentityId === null &&
    state.expanded.routes.some(route => route.eligibility === 'usable') &&
    state.notice !== 'identity_not_verified'
  ) {
    banners.push({ tone: 'info', text: NO_CALLING_NUMBER });
  }

  const actionsEnabled = state.mayMutate && state.online && !state.stale;
  const expandEnabled = state.online && !state.stale;

  const cards = state.cards.map(card => ({
    card,
    laneLabel: LANE_LABELS[card.lane],
    countsLabel: countsLabel(card.counts),
    expanded: state.expanded?.firmId === card.firmId,
  }));

  const tasks = (state.expanded?.tasks ?? []).map(task => {
    const needsTime = typeof task.callLogId === 'string';
    return {
      task,
      label: needsTime ? NEEDS_TIME_LABEL : TASK_LABELS[task.kind],
      // 8.2: "Automated sends are not snoozed ad hoc; delaying them creates a recorded
      // hold." The button says which of the two it will do, and since lane g79 it says
      // "Pause", because the hold lasts until Resume rather than until a time.
      delayLabel: task.automated ? 'Pause sending' : 'Snooze',
      enabled: actionsEnabled && task.status === 'open',
      paused: typeof task.pauseHoldId === 'string',
      needsTime,
      callable: task.status === 'open' && (task.kind === 'call_due' || task.kind === 'callback'),
    };
  });
  const callable = tasks.filter(entry => entry.callable);
  const lastCall = state.lastCall ?? null;
  const calledContact =
    lastCall !== null && lastCall.firmId === state.expanded?.firmId && lastCall.contactId !== null
      ? callable.find(entry => entry.task.contactId === lastCall.contactId)
      : undefined;
  const outcomeItemId = (calledContact ?? callable[0])?.task.itemId ?? null;

  return {
    heading: TODAY_HEADING,
    banners,
    cards,
    tasks,
    outcomeItemId,
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

// ---------------------------------------------------------------------------
// Keeping the list current (lane g84, audit item G05)
// ---------------------------------------------------------------------------

/**
 * Home read the list at sign-in and on Refresh, and nowhere else, so a window left open
 * overnight showed yesterday's list at nine the next morning and said nothing about its
 * age. These are the rules that replace that, as values: when Home reads again by
 * itself, and the line that says how old the list on screen is.
 *
 * **When.** On focus, when the last read is at least a minute old — coming back from the
 * phone app or the browser is the moment the list may have moved. And at the business
 * day's rollover: 05:00 in the workspace's business zone, when the day's list is built
 * (8.2, "built at 05:00 in the configurable workspace zone"), and 05:10 again for a
 * build that took longer than the minute. A Mac asleep through both reads on the first
 * tick after it wakes, because the question is whether a rollover has passed since the
 * last read, not whether it is 05:00 now.
 *
 * **Not over a person's typing.** Home defers either read while somebody is typing in
 * the lanes; that rule needs the page, so it lives in `homePage.ts`.
 */

/** How old the last read must be before a focus reads again. */
export const FOCUS_REFRESH_AFTER_MS = 60_000;
/** How often Home looks at the clock: the "Updated" line's minutes, and the rollover. */
export const TODAY_TICK_MS = 30_000;
/** The business day's rollover, and the second look for a slow build. */
export const ROLLOVER_TIMES: readonly string[] = Object.freeze(['05:00', '05:10']);

/** The day before a `YYYY-MM-DD`, as one. */
function previousDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const before = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) - 1));
  return before.toISOString().slice(0, 10);
}

/**
 * The most recent rollover at or before `now` in `zone`, as epoch milliseconds, or null
 * when the zone is not one this Mac knows.
 */
export function latestRollover(now: number, zone: string): number | null {
  let today: string;
  try {
    today = localParts(now, zone).date;
  } catch {
    return null;
  }
  let latest: number | null = null;
  for (const date of [previousDate(today), today]) {
    for (const time of ROLLOVER_TIMES) {
      const instant = callbackInstant(date, time, zone);
      const at = instant === null ? Number.NaN : Date.parse(instant);
      if (Number.isFinite(at) && at <= now && (latest === null || at > latest)) latest = at;
    }
  }
  return latest;
}

/**
 * Whether Home should read the list again by itself. `lastAttempt` is when it last asked
 * — at sign-in, on Refresh, on Retry or by itself — or null when it never has.
 */
export function refreshDue(input: {
  readonly trigger: 'focus' | 'tick';
  readonly now: number;
  readonly lastAttempt: number | null;
  readonly zone: string;
}): boolean {
  if (input.lastAttempt === null) return true;
  const rollover = latestRollover(input.now, input.zone);
  if (rollover !== null && input.lastAttempt < rollover) return true;
  return input.trigger === 'focus' && input.now - input.lastAttempt >= FOCUS_REFRESH_AFTER_MS;
}

/**
 * "Updated just now", "Updated 4 min ago": how old the list on screen is, from the
 * instant the session says it was fetched. Null when there is no list. A clock a few
 * seconds behind the server's is "just now", never "in the future".
 */
export function updatedLine(asOf: string | null, now: number): string | null {
  if (asOf === null) return null;
  const at = Date.parse(asOf);
  if (!Number.isFinite(at)) return null;
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'Updated just now';
  if (minutes < 60) return `Updated ${String(minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? 'Updated 1 hour ago' : `Updated ${String(hours)} hours ago`;
  return 'Updated more than a day ago';
}

/**
 * Whether the last read failed: the session fell back to the cache (stale), could not
 * reach the server, or has no list at all. A read that succeeds always sets `asOf`.
 */
export function refreshFailed(state: TodayState): boolean {
  return !state.online || state.stale || state.asOf === null;
}

/**
 * The part of the state the lanes are drawn from, as text. `asOf` changes on every read
 * and the lanes never show it, so it is left out: a focus read that found the same list
 * must not redraw the lanes and drop what somebody was typing in them.
 */
export function lanesKey(state: TodayState | null): string {
  return state === null ? 'null' : JSON.stringify({ ...state, asOf: null });
}
