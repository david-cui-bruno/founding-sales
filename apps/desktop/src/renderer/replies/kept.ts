import { useCallback, useState } from 'react';
import { useDraft, useDraftStoreAvailable } from '../app/drafts.tsx';

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
