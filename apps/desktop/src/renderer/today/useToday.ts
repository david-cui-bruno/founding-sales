import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OperationInput } from '../../shared/operations.ts';
import type { TodayState } from '../todayContract.ts';
import type { Generation } from '../app/generation.ts';
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

const api = (): NonNullable<typeof globalThis.callieApi> | undefined => globalThis.callieApi;
const dialBridge = (): NonNullable<typeof globalThis.callieDial> | undefined => globalThis.callieDial;

/**
 * The commands a card offers, each one operation of the registry. The components call
 * these; nothing in the view holds a channel name or a path.
 */
export interface TodayActions {
  expand(firmId: string): void;
  collapse(firmId: string): void;
  snooze(input: OperationInput<'today.snooze'>): void;
  recordOutcome(input: OperationInput<'today.recordOutcome'>): void;
  scheduleCallback(input: OperationInput<'today.scheduleCallback'>): void;
  releasePause(input: OperationInput<'today.releasePause'>): void;
  /** Its own channel: it opens a URI on the operating system rather than answering one. */
  dial(input: { readonly firmId: string; readonly contactId: string | null; readonly routeId: string }): void;
  /**
   * Read this firm's site again (lane R).
   *
   * A research command that answers a `ResearchState`, so the Today list is read again
   * afterwards rather than the answer being drawn: the brief on the card comes from
   * `/today/firm` and a queued run has not produced one yet. The card is told the run
   * was queued and the next refresh brings it.
   */
  researchAgain(firmId: string): void;
  /**
   * Whether *this* control's own command is on the wire (1.0.13, P1-4).
   *
   * Until the review a command held the whole column read-only, so snoozing one task
   * froze every other card, the Refresh button and the sidebar. A person waits for the
   * thing they pressed and for nothing else; the names are `todayForm`'s.
   */
  busy(form: string): boolean;
}

/**
 * What counts as one form here. A form is the smallest thing somebody presses: a card's
 * Open, one task's snooze, one callback's time, one hold's Resume, one number's Call.
 */
export const todayForm = {
  card: (firmId: string): string => `card:${firmId}`,
  task: (itemId: string): string => `task:${itemId}`,
  outcome: (firmId: string): string => `outcome:${firmId}`,
  callback: (callLogId: string): string => `callback:${callLogId}`,
  research: (firmId: string): string => `research-run:${firmId}`,
  hold: (holdId: string): string => `hold:${holdId}`,
  dial: (routeId: string): string => `dial:${routeId}`,
} as const;

export interface Today {
  readonly state: TodayState | null;
  /** How many calls to the bridge are in flight; the lanes are `aria-busy` while any are. */
  readonly pending: number;
  /**
   * How many of those are commands. Kept as a number for the tests and the lanes'
   * `aria-busy`; what makes a control read-only is `actions.busy(form)`, which waits
   * for that form's own command and for no other (P1-4).
   */
  readonly commands: number;
  /** Whether a read has answered since sign-in; until then no failure is claimed. */
  readonly refreshAnswered: boolean;
  /** Re-rendered every half minute so the "Updated" line's minutes are current. */
  readonly now: number;
  /** Refresh, or Retry: a fresh look, which clears the notice on screen. */
  refresh(): void;
  /** A card's commands. Each holds its own control read-only until it answers. */
  readonly actions: TodayActions | null;
  /** A read Today makes by itself, if one is due. */
  autoRefresh(trigger: 'focus' | 'tick', now?: number): void;
}

/**
 * The list, keyed on the person **and on the session generation** (1.0.12).
 *
 * A read is made under a generation and lands under one. When the main process reports a
 * transition — a sign-out, another workspace, a changed role, a revoked device — the
 * number moves, and a read that was already on the wire writes nothing: it is dropped at
 * the `keep` below and its key is not the key anything is watching. Without that, a
 * `/today` read started as one person could repopulate the cache `App` had just emptied.
 */
export function useToday(identity: string | null, generation: number, guard: Generation, isTyping: () => boolean): Today {
  const client = useQueryClient();
  const enabled = identity !== null && api() !== undefined;
  const [pending, setPending] = useState(0);
  const [commands, setCommands] = useState(0);
  /** One count per form on the wire, so a control waits for its own command only. */
  const [inFlight, setInFlight] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [refreshAnswered, setRefreshAnswered] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const lastRefreshAt = useRef<number | null>(null);
  const typing = useRef(isTyping);
  typing.current = isTyping;

  const query = useQuery({
    queryKey: [TODAY_KEY, identity, generation],
    // The cached list first, so the morning's list is on screen without a press.
    queryFn: async () => (await api()?.read('today.state', {})) ?? null,
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const state = query.data ?? null;

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

  const keep = useCallback(
    (next: Promise<TodayState>, read: boolean, form: string | null = null): void => {
      setPending(count => count + 1);
      if (!read) setCommands(count => count + 1);
      hold(form, 1);
      const started = guard.now();
      void next
        .then(
          value => {
            // The answer to a question asked by somebody who has since left this Mac.
            if (!guard.fresh(started)) return;
            client.setQueryData([TODAY_KEY, identity, started], value);
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
          hold(form, -1);
        });
    },
    [client, guard, hold, identity],
  );

  const actions = useMemo<TodayActions | null>(() => {
    const value = api();
    if (value === undefined) return null;
    const command = (next: Promise<TodayState>, form: string): void => {
      keep(next, false, form);
    };
    return {
      expand: firmId => {
        command(value.read('today.expand', { firmId }), todayForm.card(firmId));
      },
      collapse: firmId => {
        command(value.read('today.collapse', {}), todayForm.card(firmId));
      },
      snooze: input => {
        command(value.command('today.snooze', input), todayForm.task(input.itemId));
      },
      recordOutcome: input => {
        // The one form under the expanded card, so its own id is the firm's: `itemId`
        // is optional there — an outcome can be recorded with no task chosen.
        command(value.command('today.recordOutcome', input), todayForm.outcome(input.firmId));
      },
      scheduleCallback: input => {
        command(value.command('today.scheduleCallback', input), todayForm.callback(input.callLogId));
      },
      releasePause: input => {
        command(value.command('today.releasePause', input), todayForm.hold(input.holdId));
      },
      dial: input => {
        const bridge = dialBridge();
        if (bridge === undefined) return;
        command(bridge.call(input), todayForm.dial(input.routeId));
      },
      researchAgain: firmId => {
        // The research command's own answer is a `ResearchState`, which is not this
        // view's; what Today wants is the card again once the run has produced a brief.
        // So the command is awaited and the *expansion* is what is kept.
        command(
          value.command('research.run', { firmId }).then(async () => await value.read('today.expand', { firmId })),
          todayForm.research(firmId),
        );
      },
      busy: form => (inFlight.get(form) ?? 0) > 0,
    };
  }, [inFlight, keep]);

  const read = useCallback(
    (quiet: boolean): void => {
      const value = api();
      if (value === undefined) return;
      lastRefreshAt.current = Date.now();
      keep(value.read('today.refresh', quiet ? { quiet: true } : {}), true);
    },
    [keep],
  );

  const refresh = useCallback((): void => {
    read(false);
  }, [read]);

  const autoRefresh = useCallback(
    (trigger: 'focus' | 'tick', at: number = Date.now()): void => {
      const value = api();
      if (value === undefined || state === null || pending > 0) return;
      const zone = state.businessTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (!refreshDue({ trigger, now: at, lastAttempt: lastRefreshAt.current, zone })) return;
      if (typing.current()) return;
      lastRefreshAt.current = at;
      keep(value.read('today.refresh', { quiet: true }), true);
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

  return { state, pending, commands, refreshAnswered, now, refresh, actions, autoRefresh };
}
