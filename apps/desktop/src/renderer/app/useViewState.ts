import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { OperationApi } from '../../shared/operations.ts';
import { holdInert } from '../busy.ts';
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
 *   * the column is **read-only while one of this view's commands is on the wire**, under
 *     this view's own reason, so a second press of Save sends nothing and an update being
 *     installed and a command in flight neither release the other;
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
  /** How many of those are commands. The column is read-only while any is on the wire. */
  readonly commands: number;
  /** Whether the registry is present at all: a page built without the preload has none. */
  readonly available: boolean;
  /** A read. Its answer replaces the state; it does not hold the column. */
  read(next: (api: OperationApi) => Promise<T>): void;
  /** A command. The column is read-only until it answers. */
  command(next: (api: OperationApi) => Promise<T>): void;
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
  const [commands, setCommands] = useState(0);
  /*
   * One name per mounted view.
   *
   * It is the inert reason, so two views' commands never release each other's hold on
   * the column; and it is part of the Query key, so *asking for a view is asking the
   * main process what it is holding now*. The shell mounts these afresh whenever
   * somebody navigates (`viewKeyOf`'s epoch), and a key without the mount in it would
   * mean a second visit drew the cache and asked nothing — pressing Firms while a firm
   * page was open would stay on the firm, and an answer still on the wire from the last
   * mount would land in the view that replaced it.
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

  const keep = useCallback(
    (next: Promise<T>, isCommand: boolean): void => {
      setPending(count => count + 1);
      if (isCommand) setCommands(count => count + 1);
      const started = guard.now();
      void next
        .then(
          value => {
            // The answer to a question asked by somebody who has since left this Mac.
            if (!guard.fresh(started)) return;
            client.setQueryData([key, identity, started, reason], value);
          },
          (error: unknown) => {
            console.error(error);
          },
        )
        .finally(() => {
          setPending(count => count - 1);
          if (isCommand) setCommands(count => count - 1);
        });
    },
    [client, guard, identity, key, reason],
  );

  const read = useCallback(
    (next: (bridge: OperationApi) => Promise<T>): void => {
      const bridge = operations();
      if (bridge === undefined) return;
      keep(next(bridge), false);
    },
    [keep],
  );

  const command = useCallback(
    (next: (bridge: OperationApi) => Promise<T>): void => {
      const bridge = operations();
      if (bridge === undefined) return;
      keep(next(bridge), true);
    },
    [keep],
  );

  useEffect(() => {
    // The column, not whichever node this view happens to draw into: the rule is about
    // the whole column, as it was when each view was its own window.
    const column = document.querySelector('[data-region="column"]');
    if (column instanceof HTMLElement) holdInert(column, reason, commands > 0);
    return () => {
      if (column instanceof HTMLElement) holdInert(column, reason, false);
    };
  }, [commands, reason]);

  return useMemo(
    () => ({ state: query.data ?? null, pending, commands, available, read, command }),
    [query.data, pending, commands, available, read, command],
  );
}
