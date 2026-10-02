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
  /** One object per provider instance: a new session is a new provider, so a new token. */
  readonly epoch: object;
  readonly values: Readonly<Record<string, string>>;
  set(key: string, value: string): void;
  clear(prefix: string): void;
  /** Forget each key whose text is still exactly what it was: an edit made since stays. */
  clearUnchanged(expected: Readonly<Record<string, string>>): void;
}

const DraftContext = createContext<DraftStore | null>(null);

export function DraftsProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [epoch] = useState<object>(() => ({}));

  const set = useCallback((key: string, value: string): void => {
    setValues(current => ({ ...current, [key]: value }));
  }, []);

  const clear = useCallback((prefix: string): void => {
    setValues(current => {
      const next = Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(prefix)));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, []);

  const clearUnchanged = useCallback((expected: Readonly<Record<string, string>>): void => {
    setValues(current => {
      const next = Object.fromEntries(Object.entries(current).filter(([key, value]) => expected[key] !== value));
      return Object.keys(next).length === Object.keys(current).length ? current : next;
    });
  }, []);

  const store = useMemo<DraftStore>(() => ({ epoch, values, set, clear, clearUnchanged }), [epoch, values, set, clear, clearUnchanged]);
  return <DraftContext.Provider value={store}>{children}</DraftContext.Provider>;
}

/**
 * One field's text, and the setter that keeps it.
 *
 * `fallback` is what the field shows before anybody has typed in it — the value a
 * refused form came back with, usually — and it is only a fallback: a field somebody
 * emptied on purpose stays empty, which a `value || fallback` would undo on every
 * keystroke.
 */
export function useDraft(key: string, fallback = ''): readonly [string, (value: string) => void] {
  const store = useContext(DraftContext);
  const set = useCallback(
    (value: string): void => {
      store?.set(key, value);
    },
    [store, key],
  );
  return [store?.values[key] ?? fallback, set];
}

/**
 * Every draft under a prefix, and the setter, for a form with more than one field.
 *
 * `values` is the raw record: a key that is not in it has never been typed in, which is
 * different from a field somebody emptied, so a form can fall back to what a refusal came
 * back with without undoing a deliberate clearing.
 */
export function useDrafts(): {
  readonly values: Readonly<Record<string, string>>;
  set(key: string, value: string): void;
} {
  const store = useContext(DraftContext);
  const set = useCallback(
    (key: string, value: string): void => {
      store?.set(key, value);
    },
    [store],
  );
  const values = store?.values ?? EMPTY;
  return useMemo(() => ({ values, set }), [values, set]);
}

const EMPTY: Readonly<Record<string, string>> = Object.freeze({});

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

/**
 * Forget the drafts a command was sent with, once it has been answered, keeping any key somebody
 * has typed in since (kept-state rules K5/K6): an answer that lands late must not take an edit
 * made after it was sent. Used by "Change outcome" (`calling/ChangeOutcome.tsx`).
 */
export function useClearUnchangedDrafts(): (expected: Readonly<Record<string, string>>) => void {
  const store = useContext(DraftContext);
  return useCallback(
    (expected: Readonly<Record<string, string>>): void => {
      store?.clearUnchanged(expected);
    },
    [store],
  );
}

/**
 * Whether a drafts store is mounted above this component. A view rendered on its own — in a
 * component test, say — has none, and keeps what it holds in the component instead
 * (`replies/kept.ts`).
 */
export function useDraftStoreAvailable(): boolean {
  return useContext(DraftContext) !== null;
}

/**
 * The token of the session these drafts belong to, or null outside a provider. Views that keep
 * state of their own across navigation (the CRM memory) reset when it changes, so a sign-out
 * and a new session start clean in the same moment the drafts do (UI kept-state rule K1).
 */
export function useSessionEpoch(): object | null {
  return useContext(DraftContext)?.epoch ?? null;
}
