import { useEffect, useRef } from 'react';

/**
 * The prototype's keyboard map. Pure, so the two rules are tested rather than claimed
 * (`test/prototypeShortcuts.test.ts`):
 *
 * - **No shortcut dials.** There is no `call` action in the map at all; starting a call is
 *   the Call button and nothing else.
 * - **Typing never navigates.** While focus is in a text field, a select or anything
 *   editable, only Escape (leave the field / close) and ⌘K (search) are honoured.
 */

export type ShortcutAction = 'next' | 'previous' | 'search' | 'edit' | 'help' | 'close' | 'today' | 'pipeline' | 'firm';

export interface KeyLike {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly target: { readonly tagName?: string; readonly isContentEditable?: boolean; readonly type?: string } | null;
}

export const SHORTCUTS: readonly { readonly keys: readonly string[]; readonly action: ShortcutAction; readonly label: string }[] = [
  { keys: ['J', '↓'], action: 'next', label: 'Next firm' },
  { keys: ['K', '↑'], action: 'previous', label: 'Previous firm' },
  { keys: ['/', '⌘K'], action: 'search', label: 'Search firms' },
  { keys: ['E'], action: 'edit', label: 'Edit the firm’s details' },
  { keys: ['⌘1'], action: 'today', label: 'Today' },
  { keys: ['⌘2'], action: 'pipeline', label: 'Pipeline' },
  { keys: ['⌘3'], action: 'firm', label: 'Firm detail' },
  { keys: ['?'], action: 'help', label: 'Keyboard shortcuts' },
  { keys: ['Esc'], action: 'close', label: 'Close or leave a field' },
];

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'tel', 'url', 'number', 'password', '']);

export function isTyping(target: KeyLike['target']): boolean {
  if (target === null) return false;
  if (target.isContentEditable === true) return true;
  const tag = (target.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return TEXT_INPUT_TYPES.has((target.type ?? '').toLowerCase());
  return false;
}

export function shortcutFor(event: KeyLike): ShortcutAction | null {
  const command = event.metaKey || event.ctrlKey;
  if (event.key === 'Escape') return 'close';
  if (command && !event.altKey && event.key.toLowerCase() === 'k') return 'search';
  if (isTyping(event.target)) return null;
  if (command && !event.altKey) {
    if (event.key === '1') return 'today';
    if (event.key === '2') return 'pipeline';
    if (event.key === '3') return 'firm';
    return null;
  }
  if (event.altKey) return null;
  switch (event.key) {
    case 'j':
    case 'ArrowDown':
      return 'next';
    case 'k':
    case 'ArrowUp':
      return 'previous';
    case '/':
      return 'search';
    case 'e':
      return 'edit';
    case '?':
      return 'help';
    default:
      return null;
  }
}

/** Installs the map on the document; `handlers` may change on every render. */
export function useShortcuts(handlers: Partial<Record<ShortcutAction, () => void>>): void {
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      const action = shortcutFor({
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        target: target === null ? null : { tagName: target.tagName, isContentEditable: target.isContentEditable, type: (target as HTMLInputElement).type },
      });
      if (action === null) return;
      // Arrow keys inside a focused button group or list still belong to the page.
      const handler = latest.current[action];
      if (handler === undefined) return;
      event.preventDefault();
      handler();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}
