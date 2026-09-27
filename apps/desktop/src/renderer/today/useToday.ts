import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TodayState } from '../todayContract.ts';
import { TODAY_TICK_MS, refreshDue } from '../todayView.ts';

/**
 * Today's reads, as a Query cache in memory (1.0.12).
 *
 * TanStack Query is a request cache and nothing else here: there is no persister, so
 * nothing it holds reaches the disk. The list that survives an outage is the main
 * process's encrypted 24-hour cache (`offlineCache.ts`), which is where 5.3 puts it;
 * what this holds is the answer to the last read, in memory, under the person signed in,
 * so it goes when they do.
 *
 * **The list keeps itself current (lane g84, audit item G05).** It is read again when the
 * window regains focus and the last read is a minute old, and at the business day's
 * rollover — `refreshDue` in `todayView.ts` has the rules. The list on screen stays while
 * the read is in flight. Neither read runs while somebody is typing in the lanes: it
 * waits for the next tick. Since the typed text lives above the route (`app/drafts.tsx`)
 * a read that did land would not lose it, but a list that reorders under somebody's hands
 * is still the wrong thing to do to them.
 */

const TODAY_KEY = 'today';

export function clearToday(client: QueryClient): void {
  void client.removeQueries({ queryKey: [TODAY_KEY] });
}

const bridge = (): NonNullable<typeof globalThis.callieToday> | undefined => globalThis.callieToday;

export interface Today {
  readonly state: TodayState | null;
  /** How many calls to the bridge are in flight; the lanes are `aria-busy` while any are. */
  readonly pending: number;
  /**
   * How many of those are commands. The column is read-only while any is on the wire, so
   * a second press of Snooze, Record or Call sends nothing; a read never does that.
   */
  readonly commands: number;
  /** Whether a read has answered since sign-in; until then no failure is claimed. */
  readonly refreshAnswered: boolean;
  /** Re-rendered every half minute so the "Updated" line's minutes are current. */
  readonly now: number;
  /** Refresh, or Retry: a fresh look, which clears the notice on screen. */
  refresh(): void;
  /** A card's command — snooze, dial, record, resume, expand — and the state it answers. */
  apply(next: Promise<TodayState>): void;
  /** A read Today makes by itself, if one is due. */
  autoRefresh(trigger: 'focus' | 'tick', now?: number): void;
}

export function useToday(identity: string | null, isTyping: () => boolean): Today {
  const client = useQueryClient();
  const enabled = identity !== null && bridge() !== undefined;
  const [pending, setPending] = useState(0);
  const [commands, setCommands] = useState(0);
  const [refreshAnswered, setRefreshAnswered] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const lastRefreshAt = useRef<number | null>(null);
  const typing = useRef(isTyping);
  typing.current = isTyping;

  const query = useQuery({
    queryKey: [TODAY_KEY, identity],
    // The cached list first, so the morning's list is on screen without a press.
    queryFn: async () => (await bridge()?.state()) ?? null,
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const state = query.data ?? null;

  const keep = useCallback(
    (next: Promise<TodayState>, read: boolean): void => {
      setPending(count => count + 1);
      if (!read) setCommands(count => count + 1);
      void next
        .then(
          value => {
            client.setQueryData([TODAY_KEY, identity], value);
            if (read) setRefreshAnswered(true);
          },
          // A bridge that rejects — an IPC fault, never a refusal, which arrives as a
          // state — leaves what was on screen and says nothing in a dialog.
          (error: unknown) => {
            console.error(error);
          },
        )
        .finally(() => {
          setPending(count => count - 1);
          if (!read) setCommands(count => count - 1);
        });
    },
    [client, identity],
  );

  const apply = useCallback(
    (next: Promise<TodayState>): void => {
      keep(next, false);
    },
    [keep],
  );

  const read = useCallback(
    (quiet: boolean): void => {
      const value = bridge();
      if (value === undefined) return;
      lastRefreshAt.current = Date.now();
      keep(quiet ? value.refresh({ quiet: true }) : value.refresh(), true);
    },
    [keep],
  );

  const refresh = useCallback((): void => {
    read(false);
  }, [read]);

  const autoRefresh = useCallback(
    (trigger: 'focus' | 'tick', at: number = Date.now()): void => {
      const value = bridge();
      if (value === undefined || state === null || pending > 0) return;
      const zone = state.businessTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (!refreshDue({ trigger, now: at, lastAttempt: lastRefreshAt.current, zone })) return;
      if (typing.current()) return;
      lastRefreshAt.current = at;
      keep(value.refresh({ quiet: true }), true);
    },
    [state, pending, keep],
  );

  // The cached list, then the list as the server has it now — the two reads 1.0.11 made
  // at sign-in, once per person rather than once per mount.
  const firstRead = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || identity === null || state === null || firstRead.current === identity) return;
    firstRead.current = identity;
    // Not quiet: the first read of the day is a fresh look, and there is no notice yet
    // for it to keep.
    read(false);
  }, [enabled, identity, state, read]);

  useEffect(() => {
    setRefreshAnswered(false);
    lastRefreshAt.current = null;
  }, [identity]);

  const auto = useRef(autoRefresh);
  auto.current = autoRefresh;
  useEffect(() => {
    // Every half minute: the "Updated" line's minutes, and the rollover check.
    const ticker = setInterval(() => {
      setNow(Date.now());
      auto.current('tick');
    }, TODAY_TICK_MS);
    const onFocus = (): void => {
      setNow(Date.now());
      auto.current('focus');
    };
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(ticker);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  return { state, pending, commands, refreshAnswered, now, refresh, apply, autoRefresh };
}
