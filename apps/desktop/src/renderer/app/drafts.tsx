import { createContext, useCallback, useContext, useMemo, useState, type JSX, type ReactNode } from 'react';

/**
 * Everything somebody has typed and not yet sent, held above the route.
 *
 * The acceptance list from 1.0.11: "typed text survives navigation away and back for the
 * converted views". A field whose value lives in the component that draws it loses it the
 * moment the column shows something else, so the values live here, in the shell, and the
 * fields read and write them by key. The keys name the thing being typed about — the
 * task a snooze reason belongs to, the firm an outcome note belongs to — so two cards
 * never share a draft and a card that leaves the list takes its draft nowhere.
 *
 * It is cleared when the person changes, with the Query cache, because a draft is a
 * sentence somebody wrote and the next person to sign in on this Mac must not read it.
 */

interface DraftStore {
  readonly values: Readonly<Record<string, string>>;
  set(key: string, value: string): void;
  clear(prefix: string): void;
}

const DraftContext = createContext<DraftStore | null>(null);

export function DraftsProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});

  const set = useCallback((key: string, value: string): void => {
    setValues(current => ({ ...current, [key]: value }));
  }, []);

  const clear = useCallback((prefix: string): void => {
    setValues(current => {
      const next = Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(prefix)));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, []);

  const store = useMemo<DraftStore>(() => ({ values, set, clear }), [values, set, clear]);
  return <DraftContext.Provider value={store}>{children}</DraftContext.Provider>;
}

/** One field's text, and the setter that keeps it. `''` until somebody types. */
export function useDraft(key: string): readonly [string, (value: string) => void] {
  const store = useContext(DraftContext);
  const set = useCallback(
    (value: string): void => {
      store?.set(key, value);
    },
    [store, key],
  );
  return [store?.values[key] ?? '', set];
}

/** Whether anything is typed under a prefix: a read Today makes by itself waits for it. */
export function useHasDrafts(prefix: string): boolean {
  const store = useContext(DraftContext);
  const values = store?.values ?? {};
  return Object.entries(values).some(([key, value]) => key.startsWith(prefix) && value.trim().length > 0);
}

/** Forget every draft under a prefix — a card that was answered, a form that was sent. */
export function useClearDrafts(): (prefix: string) => void {
  const store = useContext(DraftContext);
  return useCallback(
    (prefix: string): void => {
      store?.clear(prefix);
    },
    [store],
  );
}
