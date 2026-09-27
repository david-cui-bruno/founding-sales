import { useCallback, useMemo, useRef, useState } from 'react';

/**
 * The session generation, and the one guard every view writes through (1.0.12).
 *
 * The main process reports session transitions — a sign-out, another workspace, a role a
 * renewal came back with, a revoked device — and the window empties everything it was
 * holding when one arrives. What is left over after that is *work already on the wire*:
 * a Today refresh, a sidebar read, the mailbox row, the session state itself. Each was
 * asked for as one person and can answer into a window that now belongs to another.
 *
 * So every write of something that was read carries the number it was read under, and is
 * dropped when that number has moved. There is one of these per window, handed down from
 * `useSession`, and the rule is the same everywhere rather than four nearly-identical
 * ones: a view that forgets to ask is the bug this exists to make findable.
 *
 * The number is kept in a ref as well as in state, and the ref moves **synchronously**
 * when the event arrives: an answer that lands in the same tick, before React has
 * re-rendered anything, is already stale by then and is dropped like the rest.
 */
export interface Generation {
  /** The number this read is starting under. Keep it; hand it back to `fresh`. */
  now(): number;
  /** Whether an answer that started under `started` may still be written. */
  fresh(started: number): boolean;
  /**
   * Run `write` with the answer, unless the session moved while it was being fetched.
   * `guard` is taken **before** the call, which is the whole point: it closes over the
   * number the question was asked under, not the one the answer happens to arrive under.
   */
  keep<T>(write: (value: T) => void): (value: T) => void;
}

/** The guard and the number, without React, so the rule has one implementation. */
export interface GenerationSource {
  readonly guard: Generation;
  /** The main process reported a transition. */
  note(next: number): void;
  current(): number;
}

export function createGeneration(): GenerationSource {
  let current = 0;
  const guard: Generation = {
    now: () => current,
    fresh: started => started === current,
    keep: <T,>(write: (value: T) => void) => {
      const started = current;
      return (value: T) => {
        if (started === current) write(value);
      };
    },
  };
  return {
    guard,
    note: next => {
      current = next;
    },
    current: () => current,
  };
}

export interface SessionGeneration {
  /** What the views key on, so a transition is a fresh mount rather than a stale one. */
  readonly generation: number;
  readonly guard: Generation;
  /** The main process reported a transition. */
  note(next: number): void;
}

export function useSessionGeneration(): SessionGeneration {
  const [generation, setGeneration] = useState(0);
  const source = useRef<GenerationSource | null>(null);
  source.current ??= createGeneration();
  const live = source.current;

  const note = useCallback(
    (next: number): void => {
      // The number moves synchronously, before React re-renders anything: an answer
      // landing in the same tick is already stale by then, which is the point.
      live.note(next);
      setGeneration(next);
    },
    [live],
  );

  return useMemo(() => ({ generation, guard: live.guard, note }), [generation, live, note]);
}
