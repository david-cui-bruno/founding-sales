import { useCallback, useState } from 'react';
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
