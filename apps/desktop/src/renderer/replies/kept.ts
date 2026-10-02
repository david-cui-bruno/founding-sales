import { useCallback, useEffect, useState } from 'react';
import { useClearDrafts, useDraft, useDraftStoreAvailable, useDrafts } from '../app/drafts.tsx';

/**
 * One piece of the person's own state, kept above the route (criterion 7).
 *
 * A reply card's note, the day typed for a callback, the answer picked: each is the
 * person's, and each used to be a `useState` in a component that unmounts when the column
 * shows something else. They live in the shell's drafts store instead, keyed by the
 * message they belong to, so Replies → Today → Replies finds them as they were.
 *
 * Only what somebody typed or chose is kept here, never what Callie read: a message body
 * and the model's quotation stay out of every store (`useReplies.ts`). The fallback is what
 * the field shows until somebody has touched it, so a field emptied on purpose stays empty.
 * With no store above (a view rendered on its own) it is plain component state.
 */
export function useKept(key: string, fallback: string): readonly [string, (value: string) => void] {
  const available = useDraftStoreAvailable();
  const [stored, setStored] = useDraft(key, fallback);
  const [local, setLocal] = useState<string | null>(null);
  const set = useCallback(
    (value: string): void => {
      if (available) setStored(value);
      else setLocal(value);
    },
    [available, setStored],
  );
  return [available ? stored : (local ?? fallback), set];
}

/**
 * Many kept values under one prefix, for a form whose fields are not known until the answer
 * arrives (a checklist, one cap per mailbox). `get` falls back to what the server says;
 * `clear` forgets them all. With no store above, plain component state, as in `useKept`.
 */
export function useKeptMap(prefix: string): {
  get(key: string, fallback: string): string;
  set(key: string, value: string): void;
  clear(): void;
} {
  const available = useDraftStoreAvailable();
  const drafts = useDrafts();
  const clearDrafts = useClearDrafts();
  const [local, setLocal] = useState<Readonly<Record<string, string>>>({});
  return {
    get: (key, fallback) => (available ? drafts.values[`${prefix}${key}`] : local[key]) ?? fallback,
    set: (key, value) => {
      if (available) drafts.set(`${prefix}${key}`, value);
      else setLocal(current => ({ ...current, [key]: value }));
    },
    clear: () => {
      if (available) clearDrafts(prefix);
      else setLocal({});
    },
  };
}

const NONE = '\u0000';

/**
 * A kept edit of a value the server holds (K2). It records the server value it was started
 * from, and:
 *
 * - shows the typed value only while the server still says what it said then;
 * - when the server value has moved, drops the edit — silently if the server now holds what
 *   was typed (the person's own save), with `elsewhere` set if somebody else changed it — and
 *   shows the current server value;
 * - reports `touched`, so a save sends only what was actually changed: an untouched field is
 *   filled from the CURRENT server value by the caller, never from a kept one.
 */
export function useKeptBased(
  key: string,
  server: string | null,
  same: (typed: string, saved: string) => boolean = (typed, saved) => typed === saved,
): { readonly value: string; set(next: string): void; clear(): void; readonly touched: boolean; readonly elsewhere: boolean } {
  const [raw, setRaw] = useKept(key, NONE);
  const [base, setBase] = useKept(`${key}#base`, NONE);
  const [flag, setFlag] = useKept(`${key}#elsewhere`, '');
  const has = raw !== NONE;
  // Before the server has answered there is no value to compare with, and nothing is dropped.
  const stale = server !== null && has && base !== server;
  useEffect(() => {
    if (!stale || server === null) return;
    const own = same(raw, server);
    setRaw(NONE);
    setBase(NONE);
    setFlag(own ? '' : 'yes');
  }, [stale, raw, server, same, setRaw, setBase, setFlag]);
  const live = has && !stale;
  return {
    value: live ? raw : (server ?? ''),
    touched: live,
    elsewhere: flag === 'yes' && !live,
    set: next => {
      setRaw(next);
      setBase(server ?? '');
      setFlag('');
    },
    // The edit is spent (it was sent): the field is the saved value again.
    clear: () => {
      setRaw(NONE);
      setBase(NONE);
      setFlag('');
    },
  };
}
