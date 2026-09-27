import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { OperationApi } from '../../shared/operations.ts';
import { operations } from './bridges.ts';
import type { Generation } from './generation.ts';

/**
 * One view's state, read through the operation registry and kept in memory (1.0.13).
 *
 * Firms, Sequences and Settings are all the same shape: the main process holds the
 * screen, every call answers the whole of it, and the view draws what came back. There
 * is no local model to go stale and no optimistic update to reconcile, which is 14.2's
 * "contains no authoritative … logic" made structural rather than promised. This is that
 * shape, once, so the three views cannot drift on the parts that matter:
 *
 *   * the answer is kept **under the person signed in and the session generation**, so a
 *     sign-out, another workspace or a changed role drops it with everything else, and a
 *     read still on the wire when that happens writes nothing (`generation.ts`);
 *   * **the form that sent a command is the only thing that waits for it.** A second
 *     press of that Save sends nothing; a Save somewhere else on the page, and reading
 *     the page at all, are unaffected. Until the review of 1.0.13 one command made the
 *     whole column inert, which is a page that stops answering because one field was
 *     saved — and worse on a page like Administration, where the sections are
 *     independent. `busy(form)` is the scope, and the form name is the caller's;
 *   * a bridge that *rejects* — an IPC fault, never a refusal, which arrives as a state —
 *     leaves what was on screen and says nothing in a dialog.
 *
 * TanStack Query is a request cache and nothing else here: there is no persister, so
 * nothing it holds reaches the disk.
 */

export interface ViewState<T> {
  readonly state: T | null;
  /** How many calls are in flight; the view is `aria-busy` while any are. */
  readonly pending: number;
  /** How many of those are commands. */
  readonly commands: number;
  /**
   * Whether this form's own command is on the wire.
   *
   * The name is the caller's, and it names *the thing being saved* rather than the
   * control — `setting:business_time_zone`, `contact:<id>` — so two rows of the same
   * kind wait for their own command and not for each other's.
   */
  busy(form: string): boolean;
  /** Whether the registry is present at all: a page built without the preload has none. */
  readonly available: boolean;
  /** A read. Its answer replaces the state; nothing waits for it. */
  read(next: (api: OperationApi) => Promise<T>): void;
  /** A command. `busy(form)` is true until it answers. */
  command(form: string, next: (api: OperationApi) => Promise<T>): void;
}

let views = 0;

export function useViewState<T>(options: {
  /** The Query key this view's state hangs under. */
  readonly key: string;
  readonly identity: string | null;
  readonly generation: number;
  readonly guard: Generation;
  /** The first read, made once per person: what the main process is already holding. */
  readonly first: (api: OperationApi) => Promise<T>;
}): ViewState<T> {
  const { key, identity, generation, guard, first } = options;
  const client = useQueryClient();
  const api = operations();
  const available = api !== undefined;
  const enabled = identity !== null && available;
  const [pending, setPending] = useState(0);
  /** The forms whose command is on the wire, each with how many (a press each). */
  const [inFlight, setInFlight] = useState<ReadonlyMap<string, number>>(() => new Map());
  const commands = [...inFlight.values()].reduce((total, count) => total + count, 0);
  /*
   * One name per mounted view, and part of the Query key.
   *
   * *Asking for a view is asking the main process what it is holding now.* The shell
   * mounts these afresh whenever somebody navigates (`viewKeyOf`'s epoch), and a key
   * without the mount in it would mean a second visit drew the cache and asked nothing
   * — pressing Firms while a firm page was open would stay on the firm, and an answer
   * still on the wire from the last mount would land in the view that replaced it.
   */
  const reason = useMemo(() => {
    views += 1;
    return `view-${String(views)}`;
  }, []);

  const query = useQuery({
    queryKey: [key, identity, generation, reason],
    queryFn: async () => {
      const bridge = operations();
      return bridge === undefined ? null : await first(bridge);
    },
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    // Asking for a view is asking the main process what it is holding *now*. The shell
    // mounts these afresh whenever somebody navigates (`viewKeyOf`'s epoch), and the
    // answer is kept under the person rather than under the mount, so without this a
    // second visit would draw the cache and ask nothing — pressing Firms while a firm
    // page was open would stay on the firm. What is cached is still drawn at once, so
    // the re-read is a correction rather than a blank screen.
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    retry: false,
  });

  const hold = useCallback((form: string | null, by: 1 | -1): void => {
    if (form === null) return;
    setInFlight(current => {
      const next = new Map(current);
      const count = (next.get(form) ?? 0) + by;
      if (count <= 0) next.delete(form);
      else next.set(form, count);
      return next;
    });
  }, []);

  /*
   * The order answers are *kept* in, which is not the order they arrive in (1.0.13, P2).
   *
   * Every one of these bridges answers with the whole view, so the last answer written
   * is the view. Once two forms may be saving at once (P1-4) a slow first save can land
   * after a quick second one and put the older state back on the screen — the second
   * row's new value visibly reverting a moment after it was accepted. Each call takes
   * the next number on the way out; an answer is kept only if no higher number has been
   * kept already. The numbers are per mounted view, which is what a Query key is.
   */
  const issued = useRef(0);
  const applied = useRef(0);

  const keep = useCallback(
    (next: Promise<T>, form: string | null): void => {
      setPending(count => count + 1);
      hold(form, 1);
      const started = guard.now();
      issued.current += 1;
      const ordinal = issued.current;
      void next
        .then(
          value => {
            // The answer to a question asked by somebody who has since left this Mac.
            if (!guard.fresh(started)) return;
            // An answer older than one already on screen. The newer call read the same
            // state from the same process, so nothing is lost by dropping this.
            if (ordinal < applied.current) return;
            applied.current = ordinal;
            client.setQueryData([key, identity, started, reason], value);
          },
          (error: unknown) => {
            console.error(error);
          },
        )
        .finally(() => {
          setPending(count => count - 1);
          hold(form, -1);
        });
    },
    [client, guard, hold, identity, key, reason],
  );

  const read = useCallback(
    (next: (bridge: OperationApi) => Promise<T>): void => {
      const bridge = operations();
      if (bridge === undefined) return;
      keep(next(bridge), null);
    },
    [keep],
  );

  const command = useCallback(
    (form: string, next: (bridge: OperationApi) => Promise<T>): void => {
      const bridge = operations();
      if (bridge === undefined) return;
      keep(next(bridge), form);
    },
    [keep],
  );

  const busy = useCallback((form: string): boolean => inFlight.has(form), [inFlight]);

  return useMemo(
    () => ({ state: query.data ?? null, pending, commands, available, busy, read, command }),
    [query.data, pending, commands, available, busy, read, command],
  );
}
