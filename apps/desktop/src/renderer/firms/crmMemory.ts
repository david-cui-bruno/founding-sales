import { useCallback, useEffect, useReducer, useState } from 'react';
import { useSessionEpoch } from '../app/drafts.tsx';

export interface BoardMemory {
  /** Horizontal offset of the board, and each column's vertical offset by stage key. */
  left: number;
  columns: Record<string, number>;
}

export const emptyBoardMemory = (): BoardMemory => ({ left: 0, columns: {} });

/**
 * What Pipeline and the firm page remember while David is somewhere else (UI criterion 7).
 *
 * `FirmsRoute` is mounted per route, so anything held in its refs or state is gone the moment
 * he opens Today and comes back. This store is module-level, so it outlives the view; it is
 * keyed by the signed-in identity and replaced when that changes, because a selected card
 * and a scroll offset are one person's place and the next person must not inherit them.
 * The text typed into an editor is not here: it is a draft above the route
 * (`app/drafts.tsx`), which has the same lifetime rule.
 *
 * Until the shell offers a hook of its own (`useTodayMemory` is the precedent), this is the
 * shell-level memory for these views.
 */

export type CardEditor = 'move' | 'value';

/** A card's own outcome, shown next to the card and nowhere else (criterion 6). */
export interface CardFeedback {
  readonly code: string;
}

export interface CrmMemory {
  /** The board's search text and the "no value" / "Lost" filters. */
  search: string;
  onlyWithoutValue: boolean;
  /** Horizontal and per-column scroll of the board. */
  board: BoardMemory;
  /** The firm whose panel is open beside the board; null when none is. */
  panelFirmId: string | null;
  /** The panel's own scroll. */
  panelScroll: number;
  /**
   * The firm whose page or panel is on screen now, or null (lane PB, review finding 4). A late
   * answer about another firm reads this and refreshes nothing it would have to open.
   */
  shownFirmId: string | null;
  /** Which editor is open on a card, by opportunity. Its draft text is in the drafts. */
  cardEditor: Record<string, CardEditor | undefined>;
  /** The last answer to a stage or value command, by opportunity. */
  feedback: Record<string, CardFeedback | undefined>;
  /** The full firm page's scroll, by firm. */
  pageScroll: Record<string, number | undefined>;
  /** Which inline editors are open on the firm page, by firm and editor. */
  pageEditors: Record<string, boolean | undefined>;
  /**
   * Text typed into this view's own editors, by key. A key never typed in is absent. Every
   * key names its entity (`value:<opportunity>:text`): a key without one would cross firms.
   */
  drafts: Record<string, string | undefined>;
  /**
   * The command last sent for each card, by opportunity (rule K3): what it was, and whether
   * David has touched that card's editor since. Its answer lands in `feedback` whenever it
   * arrives, even after the view was left.
   */
  pending: Record<string, PendingCommand | undefined>;
}

export interface PendingCommand {
  readonly editor: CardEditor;
  readonly commandId: number;
  /** David opened or closed the editor after sending: a late refusal must leave it alone. */
  touched: boolean;
  /** The editor closes itself right after sending; that one close is not David touching it. */
  submitClose: boolean;
}

const fresh = (): CrmMemory => ({
  search: '',
  onlyWithoutValue: false,
  board: emptyBoardMemory(),
  panelFirmId: null,
  panelScroll: 0,
  shownFirmId: null,
  cardEditor: {},
  feedback: {},
  pageScroll: {},
  pageEditors: {},
  drafts: {},
  pending: {},
});

let current: { session: string; epoch: object | null; memory: CrmMemory } = { session: '', epoch: null, memory: fresh() };

/**
 * The memory for this session: the person, the shell's session generation and the drafts
 * provider's epoch together. Any of them changing (a sign-out, another workspace, signing back
 * in as the same person) starts clean; so does a different identity (rule K1).
 */
export function crmMemoryFor(identity: string | null, generation = 0, epoch: object | null = null): CrmMemory {
  const session = `${identity ?? ''}:${String(generation)}`;
  if (current.session !== session || current.epoch !== epoch) current = { session, epoch, memory: fresh() };
  return current.memory;
}

let commandCounter = 0;
export const nextCommandId = (): number => (commandCounter += 1);

/** Tests: forget everything, as a sign-out does. */
export function resetCrmMemory(): void {
  current = { session: '', epoch: null, memory: fresh() };
}

/** The memory and a `touch()` that redraws the caller after changing it. */
export function useCrmMemory(identity: string | null, generation = 0): { readonly memory: CrmMemory; touch(): void } {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const touch = useCallback((): void => {
    bump();
  }, []);
  const epoch = useSessionEpoch();
  return { memory: crmMemoryFor(identity, generation, epoch), touch };
}

/** The memory of whoever is signed in now (set by `useCrmMemory`); for the small editors. */
export const currentCrmMemory = (): CrmMemory => current.memory;

/**
 * One editor field's text, kept across the editor closing and the view being left. `fallback`
 * is only what it shows before anybody has typed: a field emptied on purpose stays empty.
 */
export function useKeptText(key: string, fallback = ''): readonly [string, (value: string) => void] {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const memory = currentCrmMemory();
  const set = useCallback(
    (value: string): void => {
      currentCrmMemory().drafts[key] = value;
      bump();
    },
    [key],
  );
  return [memory.drafts[key] ?? fallback, set];
}

/** Forget the drafts under a prefix: after a command was sent, or a form was cancelled on purpose. */
export function clearKeptText(prefix: string): void {
  const drafts = currentCrmMemory().drafts;
  for (const key of Object.keys(drafts)) if (key.startsWith(prefix)) delete drafts[key];
}

/**
 * Rule K2: an edit of a value the server owns remembers the value it started from. Called as
 * the edit is shown: when the server's value has moved since, the kept edit is dropped (it
 * would otherwise be sent over somebody else's change) and `changedElsewhere` says so.
 */
export function useBaseGuard(prefix: string, base: string): { readonly changedElsewhere: boolean; begin(): void } {
  const reconcile = (): boolean => {
    const drafts = currentCrmMemory().drafts;
    const kept = drafts[`${prefix}:base`];
    if (kept === undefined || kept === base) return false;
    clearKeptText(`${prefix}:`);
    return true;
  };
  const [changedElsewhere, setChanged] = useState(reconcile);
  useEffect(() => {
    if (reconcile()) setChanged(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefix, base]);
  const begin = useCallback((): void => {
    const drafts = currentCrmMemory().drafts;
    // The first edit of a fresh draft starts from what the server has now; an edit already in
    // progress keeps the base it began with.
    const inProgress = Object.keys(drafts).some(key => key.startsWith(`${prefix}:`) && key !== `${prefix}:base`);
    if (!inProgress || drafts[`${prefix}:base`] === undefined) drafts[`${prefix}:base`] = base;
    setChanged(false);
  }, [prefix, base]);
  return { changedElsewhere, begin };
}
