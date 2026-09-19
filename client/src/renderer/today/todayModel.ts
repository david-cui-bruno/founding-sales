import {
  TODAY_LANES,
  type TodayCard,
  type TodayEmptyReason,
  type TodayLane,
  type TodayList,
  type TodayView,
} from '../../../../src/shared/contracts/v1Contract';

/**
 * The Today page's model (FSS target design section 3; slice S1), pure and free of React: how fresh the view
 * is, the four lane sections in order, the posture warning, the counts row and the words on a card. The
 * server computed dialability; nothing here decides a dial, it only shows what the worker said.
 */

/** The page re-reads the view this often. */
export const TODAY_REFRESH_MS = 60_000;
/** A view older than this is stale: the page says so and a dial from it is refused (S2). */
export const TODAY_STALE_MS = 120_000;

export const LANE_TITLES: Readonly<Record<TodayLane, string>> = Object.freeze({
  replies: 'Replies',
  callbacks: 'Callbacks due',
  due: 'Sequence calls due',
  new: 'New firms',
});

/** Where the view came from: the worker just now, or the last good file the main process kept. */
export type ViewSource = 'worker' | 'last_good';
export type Freshness = {
  stale: boolean;
  reason: 'older_than_two_minutes' | 'last_good' | 'worker_unavailable' | null;
  ageSeconds: number;
};

/** Stale when older than two minutes, when served from the last good file, or when the last read failed. */
export function freshness(input: { fetchedAt: string; now: number; source?: ViewSource; unavailable?: boolean }): Freshness {
  const fetched = Date.parse(input.fetchedAt);
  const ageSeconds = Number.isFinite(fetched) ? Math.max(0, Math.floor((input.now - fetched) / 1000)) : Number.POSITIVE_INFINITY;
  if (input.source === 'last_good') return { stale: true, reason: 'last_good', ageSeconds };
  if (input.unavailable) return { stale: true, reason: 'worker_unavailable', ageSeconds };
  if (ageSeconds * 1000 >= TODAY_STALE_MS) return { stale: true, reason: 'older_than_two_minutes', ageSeconds };
  return { stale: false, reason: null, ageSeconds };
}

export function staleSentence(value: Freshness, sentence: string | null = null): string | null {
  if (!value.stale) return null;
  const age = value.ageSeconds === Number.POSITIVE_INFINITY ? 'an unknown time' : `${Math.floor(value.ageSeconds / 60)} min ${value.ageSeconds % 60} s`;
  if (value.reason === 'last_good') return `Showing the last good list saved on this Mac, ${age} old. The worker has not answered.`;
  if (value.reason === 'worker_unavailable') return `Showing the list fetched ${age} ago. ${sentence ?? 'The worker has not answered since.'}`;
  return `This list is ${age} old. It refreshes every minute; a dial from a stale list is refused.`;
}

export type LaneSection = { lane: TodayLane; title: string; cards: TodayCard[] };
/** The four lanes in the order the design fixes: replies, callbacks, due, new. Every lane is shown, empty or not. */
export function laneSections(list: TodayList): LaneSection[] {
  return TODAY_LANES.map(lane => ({ lane, title: LANE_TITLES[lane], cards: list.lanes[lane] }));
}

/** The states the firms derive to that carry no posture, from the header or the empty answer. */
export function statesWithoutPosture(view: TodayView): readonly string[] {
  return view.list === null ? view.statesWithoutPosture : view.list.header.statesWithoutPosture;
}

const joinStates = (states: readonly string[]): string =>
  states.length <= 1 ? states.join('') : `${states.slice(0, -1).join(', ')} and ${states[states.length - 1]}`;

/** The posture warning, or null when every state the firms derive to has a recorded posture. */
export function postureWarning(view: TodayView): string | null {
  const states = statesWithoutPosture(view);
  if (states.length === 0) return null;
  return `No calling posture is recorded for ${joinStates(states)}. Firms in ${states.length > 1 ? 'these states' : 'this state'} are held until you record one.`;
}

export function countsLine(list: TodayList): string {
  const { counts, poolSize } = list.header;
  return `${counts.replies} replies · ${counts.callbacks} callbacks · ${counts.due} due · ${counts.new} new · pool ${poolSize}`;
}

export const EMPTY_SENTENCES: Readonly<Record<TodayEmptyReason, string>> = Object.freeze({
  not_built_yet: 'The morning list has not been built yet. It is built at 05:00 Eastern.',
  no_posture: 'No state has a calling posture yet. The list stays empty until you record one.',
  no_candidates: 'The list was built and nothing is due today: no replies, no callbacks, no sequence calls and no new firms.',
});

/** What the Call control says: the server's verdict, never a local one. */
export function dialSentence(card: TodayCard): string {
  if (card.dialAllowed) return `Dial allowed${card.localTime ? ` (${card.localTime} local)` : ''}`;
  const time = card.localTime ? ` at ${card.localTime} local` : '';
  return `Held: ${card.holdReason ?? 'unknown'}${card.holdCode && card.holdCode !== card.holdReason ? ` (${card.holdCode})` : ''}${time}`;
}

export function nextStepSentence(card: TodayCard): string {
  const step = card.nextStep;
  if (step.kind === 'first_call') return 'First call';
  if (step.kind === 'reply') return 'Reply waiting';
  if (step.kind === 'callback') return step.dueOn ? `Callback promised for ${step.dueOn}` : 'Callback promised';
  return `Call ${step.stepIndex + 1} of ${step.stepCount}${step.dueAt ? `, due ${step.dueAt.slice(0, 10)}` : ''}`;
}

/** The text the Copy number button puts on the clipboard: the number alone, never the verification word. */
export function copyNumberText(card: TodayCard): string | null {
  return card.phone?.number ?? null;
}

export function phoneLabel(card: TodayCard): string {
  if (!card.phone) return 'No phone route';
  return `${card.phone.number} (${card.phone.verification})`;
}

export function placeLabel(card: TodayCard): string {
  const place = [card.city, card.state].filter((part): part is string => part !== null).join(', ');
  return place.length ? place : 'Location unknown';
}
