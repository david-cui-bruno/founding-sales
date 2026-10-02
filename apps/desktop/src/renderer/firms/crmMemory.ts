import { useCallback, useReducer } from 'react';

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
  /** Which editor is open on a card, by opportunity. Its draft text is in the drafts. */
  cardEditor: Record<string, CardEditor | undefined>;
  /** The last answer to a stage or value command, by opportunity. */
  feedback: Record<string, CardFeedback | undefined>;
  /** The full firm page's scroll, by firm. */
  pageScroll: Record<string, number | undefined>;
  /** Which inline editors are open on the firm page, by firm and editor. */
  pageEditors: Record<string, boolean | undefined>;
  /** Text typed into this view's own editors, by key. A key never typed in is absent. */
  drafts: Record<string, string | undefined>;
}

const fresh = (): CrmMemory => ({
  search: '',
  onlyWithoutValue: false,
  board: emptyBoardMemory(),
  panelFirmId: null,
  panelScroll: 0,
  cardEditor: {},
  feedback: {},
  pageScroll: {},
  pageEditors: {},
  drafts: {},
});

let current: { identity: string | null; memory: CrmMemory } = { identity: null, memory: fresh() };

/** The memory for this identity; a different one starts clean. */
export function crmMemoryFor(identity: string | null): CrmMemory {
  if (current.identity !== identity) current = { identity, memory: fresh() };
  return current.memory;
}

/** Tests: forget everything, as a sign-out does. */
export function resetCrmMemory(): void {
  current = { identity: null, memory: fresh() };
}

/** The memory and a `touch()` that redraws the caller after changing it. */
export function useCrmMemory(identity: string | null): { readonly memory: CrmMemory; touch(): void } {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const touch = useCallback((): void => {
    bump();
  }, []);
  return { memory: crmMemoryFor(identity), touch };
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
