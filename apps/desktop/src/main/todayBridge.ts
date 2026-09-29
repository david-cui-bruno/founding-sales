import {
  TODAY_CARD_VERSION,
  callbackInstant,
  callsPlacedTodayResponseSchema,
  dialCheckResponseSchema,
  loggedCallResultSchema,
  todayFirmResponseSchema,
  todayPauseReleaseResultSchema,
  todaySnoozeResultSchema,
  type CallsPlacedTodayResponse,
  type LoggedCallResult,
} from '@fss/contracts';
import {
  todayStateSchema,
  type DialAdviceView,
  type DialRequest,
  type OutcomeRequest,
  type RefreshRequest,
  type ReleasePauseRequest,
  type ScheduleCallbackRequest,
  type SnoozeRequest,
  type TodayCard,
  type TodayFirm,
  type TodayState,
} from '../renderer/todayContract.ts';
import type { AuthedClient } from './authedClient.ts';
import { HANDOFF_LIMITATION_NOTICE, type DialHandoff } from './dialHandoff.ts';
import type { ApiOutcome } from './apiClient.ts';

/**
 * The Today window's half of the bridge, in the main process (specification 8.2,
 * 9.2, 14.2).
 *
 * The window sees a `TodayState` and nothing else: no `tel:` URI, no access token, no
 * command id. That is 14.2's "Electron owns presentation ... it contains no
 * authoritative sequence, suppression, policy, eligibility, or send logic" made
 * structural — the renderer cannot dial without the main process, and the main process
 * will not open anything the server has not just advised it to open.
 *
 * Two decisions are worth naming.
 *
 * **The cards come from G2's cache and the expansion does not.** `refresh` delegates
 * to the session manager, which is the one thing that knows about the encrypted
 * 24-hour cache, the stale rule and the revocation wipe (5.3, 4.2). The expansion is a
 * separate read that is never written to disk, because it names contacts.
 *
 * **A local `datetime-local` becomes a UTC instant here.** The window has no zone but
 * the workspace's business zone, and resolving a wall-clock time against a zone is
 * arithmetic a renderer should not be doing. The domain's own calendar clock does it
 * (`callbackInstant` from `@fss/contracts`), in the main process, beside the zone the
 * API reported — and the server checks the answer against its own (lane g79, C18).
 *
 * Lane g79 added three more (audit items C04, C15, C16, C17):
 *
 * **A call is recorded against its task and its number.** A successful Call keeps the
 * number it was placed to, here and nowhere else; the next outcome recorded for the same
 * firm names it, the contact and the Today task, so the server can apply the outcome to
 * the step or callback behind the task. There is no ticket to name since 1.0.12:
 * `POST /dial/check` advises and `POST /calls/log` records, and neither needs one.
 *
 * **"Just now" is the server's clock.** The outcome carries no `occurredAt`: a Mac a
 * few seconds fast used to fail the database's `recorded_at >= occurred_at`.
 *
 * **What a recorded call still needs is shown, not refused.** The answer's
 * `followUps` become the notice — a callback that needs a time, a number that was not
 * named — and "Callback — needs a time" on the card is where the time is set.
 */

/*
 * There are no channels of this view's own since 1.0.12: the nine that stood here are
 * nine operations of `shared/operations.ts`, answered on `callie:op:read` and
 * `callie:op:command`, and dialling is `callie:dial:call`. What is left in this file is
 * the transformations those operations name.
 */

/*
 * `/today/firm` and the snooze result are parsed with `@fss/contracts`' schemas (lane
 * g78). The list itself is read by the session manager, through `apiClient.today`, into
 * the cache; the second copy of its schema that stood here was used by nothing.
 */

/** What the bridge needs from the rest of the process. All of it injectable. */
export interface TodayBridgeDeps {
  readonly api: AuthedClient;
  readonly handoff: DialHandoff;
  /** G2's session manager: the cache, the stale rule, the version gate, the wipe. */
  readonly session: {
    state(): Promise<{
      readonly online: boolean;
      readonly stale: boolean;
      readonly asOf: string | null;
      readonly mayMutate: boolean;
      /** `deviceId` names whose expansions the in-memory cache holds (wave 1). */
      readonly device: { readonly role: 'admin' | 'salesperson'; readonly deviceId?: string } | null;
      readonly today: { readonly snapshotDate: string; readonly businessTimeZone: string; readonly cards: readonly TodayCard[] } | null;
    }>;
    refreshToday(): Promise<unknown>;
  };
}

export interface TodayBridgeHost {
  /** Drop the snapshot on an identity transition (1.0.13, P0-A). */
  forget(): Promise<TodayState>;
  state(): Promise<TodayState>;
  refresh(input?: RefreshRequest): Promise<TodayState>;
  expand(input: { readonly firmId: string }): Promise<TodayState>;
  collapse(): Promise<TodayState>;
  /**
   * How many calls were placed on the workspace's own business date (29 September 2026).
   *
   * Not part of `TodayState`: the state is the cached list and what the window is doing
   * with it, and this is a live count that moves every time somebody rings off. A read
   * that did not answer is null, so the figure says nothing rather than zero — "no calls
   * yet this morning" and "Callie could not ask" are different facts.
   */
  callsPlaced(): Promise<CallsPlacedTodayResponse | null>;
  snooze(input: SnoozeRequest): Promise<TodayState>;
  dial(input: DialRequest): Promise<TodayState>;
  recordOutcome(input: OutcomeRequest): Promise<TodayState>;
  scheduleCallback(input: ScheduleCallbackRequest): Promise<TodayState>;
  releasePause(input: ReleasePauseRequest): Promise<TodayState>;
}

/** The last handed-off call, so the outcome recorded next can name the number. */
interface LastCall {
  readonly firmId: string;
  readonly routeId: string;
  readonly contactId: string | null;
  readonly e164: string;
}

/**
 * The notice a recorded call answers with: plain "recorded", or recorded with the one
 * thing it still needs from the person, most pressing first.
 */
export function outcomeNotice(result: LoggedCallResult | null): string {
  const kinds = new Set((result?.followUps ?? []).map(entry => entry.kind));
  if (kinds.has('effects_not_applied')) return 'outcome_recorded_effects_not_applied';
  if (kinds.has('callback_time_needed')) return 'outcome_recorded_callback_time_needed';
  if (kinds.has('route_not_named')) return 'outcome_recorded_route_not_named';
  return 'outcome_recorded';
}

/**
 * `YYYY-MM-DDTHH:MM` in `zone`, as a UTC instant.
 *
 * One implementation, and it is the domain's: `localInstant` from `@fss/contracts`,
 * which is what `packages/domain/src/rules/localClock.ts` re-exports and what the
 * server checks a callback's `dueAt` against (lane g79, audit item C18). Until then
 * this was a second, local two-step `Intl` correction that put New York's 02:30 on
 * 8 March 2026 at 01:30 EST, an hour *before* the wall clock the person typed, where
 * the domain resolves a DST gap forward to 03:30 EDT
 * (docs/decisions/g0-dst-gap-resolution.md). The reply bridge imports this function
 * too, so both of the Mac's callback forms resolve the way the server does.
 */
export function localToInstant(local: string, zone: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/u.exec(local.trim());
  if (match === null) return null;
  return callbackInstant(match[1] ?? '', match[2] ?? '', zone);
}

/** How many firms' expansions the in-memory cache keeps: more than a day's list. */
const EXPANSION_CACHE_LIMIT = 200;

export function createTodayBridge(deps: TodayBridgeDeps): TodayBridgeHost {
  let expanded: TodayFirm | null = null;
  let notice: string | null = null;
  let lastCall: LastCall | null = null;
  /** `POST /dial/check`'s answer for each of the expanded card's usable numbers. */
  let dialAdvice: readonly DialAdviceView[] = [];
  /**
   * The URI each advised number would open, by route. It never crosses the bridge: a
   * renderer that cannot name a `tel:` string cannot ask for one to be opened, however
   * the page is edited later.
   */
  const telUris = new Map<string, string | null>();
  /**
   * The last expansion read for each firm, in memory only (wave 1). Until then a card
   * opened while the Mac was offline read the network, failed, and closed: the list was
   * on screen from the cache and nothing on it could be opened. It is never written to
   * disk — the offline cache holds the list and nothing more (5.3) — and it belongs to
   * one device: another sign-in starts it empty.
   */
  const expansions = new Map<string, TodayFirm>();
  let expansionsOwner: string | null = null;

  const remember = (page: TodayFirm): void => {
    expansions.delete(page.firmId);
    expansions.set(page.firmId, page);
    if (expansions.size > EXPANSION_CACHE_LIMIT) {
      const oldest = expansions.keys().next().value;
      if (oldest !== undefined) expansions.delete(oldest);
    }
  };

  /** The card as the cached list has it, opened with nothing that needs the server. */
  const fromList = (
    today: Awaited<ReturnType<TodayBridgeDeps['session']['state']>>['today'],
    firmId: string,
  ): TodayFirm | null => {
    const card = today?.cards.find(entry => entry.firmId === firmId);
    if (today === null || card === undefined) return null;
    return {
      firmId: card.firmId,
      firmName: card.firmName,
      snapshotDate: today.snapshotDate,
      lane: card.lane,
      counts: card.counts,
      tasks: [],
      routes: [],
      callingIdentityId: null,
    };
  };

  const snapshot = async (): Promise<TodayState> => {
    const session = await deps.session.state();
    return todayStateSchema.parse({
      snapshotDate: session.today?.snapshotDate ?? null,
      businessTimeZone: session.today?.businessTimeZone ?? null,
      cards: session.today?.cards ?? [],
      expanded,
      online: session.online,
      stale: session.stale,
      asOf: session.asOf,
      mayMutate: session.mayMutate,
      role: session.device?.role ?? null,
      notice,
      handoffNotice: HANDOFF_LIMITATION_NOTICE,
      dialAdvice,
      lastCall:
        lastCall === null
          ? null
          : { firmId: lastCall.firmId, routeId: lastCall.routeId, contactId: lastCall.contactId, e164: lastCall.e164 },
    });
  };

  /** Record what a call answered, and forget any expansion it invalidated. */
  const note = (outcome: ApiOutcome<unknown>, accepted: string | null): boolean => {
    if (outcome.ok) {
      notice = accepted;
      return true;
    }
    notice = outcome.reason;
    return false;
  };

  const loadExpansion = async (firmId: string): Promise<void> => {
    const session = await deps.session.state();
    const owner = session.device?.deviceId ?? null;
    if (owner !== expansionsOwner) {
      expansions.clear();
      expansionsOwner = owner;
    }
    // One read: the tasks, the routes with the versions `authorizeDial` will compare,
    // and the actor's own calling identity, all at one instant (9.2 step 3).
    // `cardVersion: 2` asks for each task's callback, step, needs-a-time call and pause
    // (lane g79). The API answers G6's shape to a client that does not ask.
    const page = await deps.api.read('/today/firm', value => todayFirmResponseSchema.parse(value), {
      firmId,
      cardVersion: TODAY_CARD_VERSION,
    });
    if (!page.ok) {
      dialAdvice = [];
      note(page, null);
      // A read that did not get an answer — the network, or a server that failed —
      // keeps what this Mac last read for the firm, or the list's own card, with the
      // notice saying why it could not read again (wave 1). A refusal is an answer:
      // `not_found` is a firm that left today's list and `not_assigned` one that is no
      // longer this person's, so its card closes and its cached page goes.
      const unanswered = page.offline || page.reason === 'unreadable_answer' || /^http_5\d\d$/u.test(page.reason);
      if (!unanswered) {
        expansions.delete(firmId);
        expanded = null;
        return;
      }
      expanded = expansions.get(firmId) ?? fromList(session.today, firmId);
      return;
    }
    expanded = page.value;
    remember(page.value);
    notice = null;
    dialAdvice = await adviseRoutes(page.value);
  };

  /**
   * "Can I call this number now?", for each of the card's usable numbers (wave 2, S4.5).
   *
   * A read per number rather than one for the firm, because the advice's reasons and its
   * URI are about a number: a firm may have one line inside its calling window and
   * another suppressed, and a card that said "callable" for the firm would be offering a
   * button the server then refuses. The reads run together — the expansion has one or two
   * numbers, not a page of them — and a read that fails leaves that number without advice
   * rather than claiming it is callable.
   *
   * The URI stays in this process. The window is told callable yes or no and why; the
   * string that reaches macOS is re-read at the moment of the press and never crosses the
   * bridge at all.
   */
  const adviseRoutes = async (page: TodayFirm): Promise<readonly DialAdviceView[]> => {
    const usable = page.routes.filter(route => route.eligibility === 'usable');
    const answers: (DialAdviceView | null)[] = await Promise.all(
      usable.map(async route => await adviseRoute(page.firmId, route.routeId)),
    );
    return answers.filter((answer): answer is DialAdviceView => answer !== null);
  };

  const adviseRoute = async (firmId: string, routeId: string): Promise<DialAdviceView | null> => {
    const answer = await deps.api.read('/dial/check', value => dialCheckResponseSchema.parse(value), { firmId, routeId });
    if (!answer.ok) return null;
    const advice = answer.value.advice;
    telUris.set(routeId, advice.telUri);
    return {
      routeId,
      callable: advice.callable,
      reasons: advice.reasons,
      e164: advice.e164,
      firmLocalTime: advice.firmLocalTime,
    };
  };

  /**
   * Re-read after a mutation, keeping the mutation's notice. The re-read's own success
   * would clear it, and a firm whose last task the mutation finished has left today's
   * list — its card closes, and "not found" is not what the person should read.
   */
  const reloadAfterMutation = async (options: { readonly refreshList: boolean }): Promise<void> => {
    if (options.refreshList) await deps.session.refreshToday();
    if (expanded === null) return;
    const kept = notice;
    await loadExpansion(expanded.firmId);
    if (expanded !== null || notice === 'not_found') notice = kept;
  };

  return {
    /**
     * Forget everything this bridge is holding (1.0.13, P0-A).
     *
     * Called on every identity transition, from `registerWindows`. Nothing here is the
     * next person's to read, and a snapshot kept across a sign-out is the last person's
     * work shown to somebody else.
     */
    async forget() {
      expanded = null;
      notice = null;
      lastCall = null;
      dialAdvice = [];
      expansionsOwner = null;
      return await snapshot();
    },

    state: snapshot,

    async refresh(input = {}) {
      // A read Home made by itself — on focus, at the rollover (lane g84, G05) — keeps
      // the last notice, exactly as the re-read after a mutation does: "Call recorded."
      // should not vanish because the person came back to the window. Refresh pressed
      // is a fresh look and clears it, as it always has.
      if (input.quiet === true) {
        await reloadAfterMutation({ refreshList: true });
        return await snapshot();
      }
      await deps.session.refreshToday();
      if (expanded !== null) await loadExpansion(expanded.firmId);
      return await snapshot();
    },

    async expand(input) {
      await loadExpansion(input.firmId);
      return await snapshot();
    },

    async callsPlaced() {
      const answer = await deps.api.read('/today/calls-placed', value => callsPlacedTodayResponseSchema.parse(value));
      // A refusal or an unreadable answer is null. It is not this read's business to put
      // a notice on the day's list: the figure alone goes quiet.
      return answer.ok ? answer.value : null;
    },

    async collapse() {
      expanded = null;
      notice = null;
      dialAdvice = [];
      telUris.clear();
      return await snapshot();
    },

    async snooze(input) {
      const session = await deps.session.state();
      const zone = session.today?.businessTimeZone ?? null;
      // The window sends what a `datetime-local` gives it, or nothing for an automated
      // task's pause. A zone-less instant is not something the server may be asked to
      // guess at.
      const wanted = input.returnAt.trim();
      const returnAt =
        wanted === ''
          ? undefined
          : wanted.includes('Z')
            ? wanted
            : zone === null
              ? null
              : localToInstant(wanted, zone);
      if (returnAt === null) {
        notice = 'snooze_return_not_future';
        return await snapshot();
      }
      const answer = await deps.api.command(
        '/today/snooze',
        { itemId: input.itemId, reason: input.reason, ...(returnAt === undefined ? {} : { returnAt }) },
        value => todaySnoozeResultSchema.parse(value),
      );
      if (note(answer, null) && answer.ok) notice = answer.value.outcome;
      await reloadAfterMutation({ refreshList: false });
      return await snapshot();
    },

    /**
     * Call this number (9.2; wave 2's S4.5 shape).
     *
     * The advice on the card may be a minute old, so it is read again here — the calling
     * window closes at a wall-clock time and a suppression can be recorded while a card
     * is open — and the URI that reaches macOS is the one that read answered with, not
     * the one on screen. A number the server will not advise now is a refusal with its
     * own reason and nothing opened.
     */
    async dial(input) {
      const setup = await deps.handoff.checkSetup();
      if (!setup.ready) {
        notice = setup.reason;
        return await snapshot();
      }
      const fresh = await adviseRoute(input.firmId, input.routeId);
      if (fresh === null) {
        notice = 'dial_advice_unavailable';
        return await snapshot();
      }
      // The card is told what the fresh read found, whether or not the call goes ahead.
      dialAdvice = dialAdvice.map(entry => (entry.routeId === fresh.routeId ? fresh : entry));
      const telUri = telUris.get(input.routeId) ?? null;
      if (!fresh.callable || telUri === null) {
        notice = fresh.reasons[0] ?? 'not_callable';
        return await snapshot();
      }
      const outcome = await deps.handoff.open({ telUri, e164: fresh.e164 ?? '' });
      notice =
        outcome.status === 'opened'
          ? 'dial_opened'
          : outcome.status === 'opened_unknown'
            ? 'dial_opened_unknown'
            : outcome.reason;
      if (outcome.status === 'opened' || outcome.status === 'opened_unknown') {
        // The call may have been placed either way, so the outcome form is told which
        // number it is recording (C16).
        const route = expanded?.routes.find(entry => entry.routeId === input.routeId);
        lastCall = {
          firmId: input.firmId,
          routeId: input.routeId,
          contactId: route?.contactId ?? input.contactId,
          e164: fresh.e164 ?? route?.e164 ?? '',
        };
      }
      return await snapshot();
    },

    async recordOutcome(input) {
      const session = await deps.session.state();
      const zone = session.today?.businessTimeZone ?? null;
      let callback: Record<string, string> | undefined;
      if (input.callback !== null && input.callback.localDate !== '') {
        const sourceTimeZone = input.callback.sourceTimeZone === '' ? zone : input.callback.sourceTimeZone;
        // The domain's clock, so the instant sent is the instant the server will
        // resolve the same fields to; it refuses a disagreement (C18).
        const dueAt =
          sourceTimeZone === null ? null : callbackInstant(input.callback.localDate, input.callback.localTime, sourceTimeZone);
        if (sourceTimeZone !== null) {
          callback = {
            localDate: input.callback.localDate,
            ...(input.callback.localTime === '' ? {} : { localTime: input.callback.localTime }),
            sourceTimeZone,
            ...(dueAt === null ? {} : { dueAt }),
          };
        }
      }
      // The last handed-off call belongs to this outcome when it was to this firm and,
      // if the window named a number, to that number (C16).
      const call =
        lastCall !== null &&
        lastCall.firmId === input.firmId &&
        (input.routeId === null || input.routeId === lastCall.routeId)
          ? lastCall
          : null;
      const routeId = input.routeId ?? call?.routeId ?? null;
      const contactId = input.contactId ?? call?.contactId ?? null;
      const answer = await deps.api.command(
        '/calls/log',
        {
          firmId: input.firmId,
          ...(contactId === null ? {} : { contactId }),
          ...(routeId === null ? {} : { routeId }),
          ...(input.itemId === null ? {} : { itemId: input.itemId }),
          outcome: input.outcome,
          // No `occurredAt`: "just now" is the server's clock (C15).
          ...(input.note === '' ? {} : { note: input.note }),
          ...(callback === undefined ? {} : { callback }),
          ...(input.outcome === 'do_not_call'
            ? { doNotCallCoversAllContact: input.doNotCallCoversAllContact }
            : {}),
        },
        value => {
          const parsed = loggedCallResultSchema.safeParse(value);
          return parsed.success ? parsed.data : null;
        },
      );
      if (note(answer, null) && answer.ok) {
        notice = outcomeNotice(answer.value);
        if (call !== null) lastCall = null;
      }
      // The outcome may have created a callback, stopped a sequence or suppressed a
      // number. Re-read rather than patching the page: the server decided, not us.
      await reloadAfterMutation({ refreshList: true });
      return await snapshot();
    },

    async scheduleCallback(input) {
      const session = await deps.session.state();
      const zone = session.today?.businessTimeZone ?? null;
      const dueAt = zone === null ? null : callbackInstant(input.localDate, input.localTime, zone);
      if (zone === null || dueAt === null) {
        notice = 'callback_time_invalid';
        return await snapshot();
      }
      const answer = await deps.api.command(
        '/callbacks/schedule',
        {
          callLogId: input.callLogId,
          localDate: input.localDate,
          ...(input.localTime === '' ? {} : { localTime: input.localTime }),
          sourceTimeZone: zone,
          dueAt,
        },
        () => null,
      );
      note(answer, 'callback_scheduled');
      await reloadAfterMutation({ refreshList: true });
      return await snapshot();
    },

    async releasePause(input) {
      const answer = await deps.api.command('/today/pause/release', { holdId: input.holdId }, value =>
        todayPauseReleaseResultSchema.parse(value),
      );
      note(answer, 'pause_released');
      await reloadAfterMutation({ refreshList: true });
      return await snapshot();
    },
  };
}
