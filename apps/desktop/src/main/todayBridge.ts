import { randomUUID } from 'node:crypto';
import { todayFirmResponseSchema, todaySnoozeResultSchema } from '@fss/contracts';
import {
  todayStateSchema,
  type DialRequest,
  type OutcomeRequest,
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
 * The window sees a `TodayState` and nothing else: no ticket, no access token, no
 * command id. That is 14.2's "Electron owns presentation ... it contains no
 * authoritative sequence, suppression, policy, eligibility, or send logic" made
 * structural — the renderer cannot dial without the main process, and the main process
 * cannot dial without a server-issued ticket it consumes immediately before the open.
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
 * arithmetic a renderer should not be doing. `Intl` does it, in the main process,
 * beside the zone the API reported.
 */

export const TODAY_IPC_CHANNELS = {
  state: 'callie:today:state',
  refresh: 'callie:today:refresh',
  expand: 'callie:today:expand',
  collapse: 'callie:today:collapse',
  snooze: 'callie:today:snooze',
  dial: 'callie:today:dial',
  recordOutcome: 'callie:today:outcome',
} as const;
export type TodayIpcChannel = (typeof TODAY_IPC_CHANNELS)[keyof typeof TODAY_IPC_CHANNELS];

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
      readonly device: { readonly role: 'admin' | 'salesperson' } | null;
      readonly today: { readonly snapshotDate: string; readonly businessTimeZone: string; readonly cards: readonly TodayCard[] } | null;
    }>;
    refreshToday(): Promise<unknown>;
  };
}

export interface TodayBridgeHost {
  state(): Promise<TodayState>;
  refresh(): Promise<TodayState>;
  expand(input: { readonly firmId: string }): Promise<TodayState>;
  collapse(): Promise<TodayState>;
  snooze(input: SnoozeRequest): Promise<TodayState>;
  dial(input: DialRequest): Promise<TodayState>;
  recordOutcome(input: OutcomeRequest): Promise<TodayState>;
}

/**
 * `YYYY-MM-DDTHH:MM` in `zone`, as a UTC instant.
 *
 * `Intl` both ways rather than an offset table: America/New_York is -300 in January
 * and -240 in July, and a fixed offset is wrong for half the year. The guess is
 * corrected once, which is exact everywhere except inside a DST gap — where it lands
 * on the instant the clock skipped to, which is the same answer G0's calendar rules
 * chose (docs/decisions/g0-dst-gap-resolution.md).
 */
export function localToInstant(local: string, zone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(local.trim());
  if (match === null) return null;
  const asUtc = Date.parse(`${local.trim()}:00.000Z`);
  if (!Number.isFinite(asUtc)) return null;
  const offsetAt = (instant: number): number => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(instant));
    const read = (type: string): number => Number(parts.find(part => part.type === type)?.value ?? '0');
    const asIfUtc = Date.UTC(read('year'), read('month') - 1, read('day'), read('hour'), read('minute'), read('second'));
    return asIfUtc - instant;
  };
  try {
    const corrected = asUtc - offsetAt(asUtc);
    return new Date(corrected - (offsetAt(corrected) - offsetAt(asUtc))).toISOString();
  } catch {
    return null;
  }
}

export function createTodayBridge(deps: TodayBridgeDeps): TodayBridgeHost {
  let expanded: TodayFirm | null = null;
  let notice: string | null = null;

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
    // One read: the tasks, the routes with the versions `authorizeDial` will compare,
    // and the actor's own calling identity, all at one instant (9.2 step 3).
    const page = await deps.api.read('/today/firm', value => todayFirmResponseSchema.parse(value), { firmId });
    if (!page.ok) {
      expanded = null;
      note(page, null);
      return;
    }
    expanded = page.value;
    notice = null;
  };

  return {
    state: snapshot,

    async refresh() {
      await deps.session.refreshToday();
      if (expanded !== null) await loadExpansion(expanded.firmId);
      return await snapshot();
    },

    async expand(input) {
      await loadExpansion(input.firmId);
      return await snapshot();
    },

    async collapse() {
      expanded = null;
      notice = null;
      return await snapshot();
    },

    async snooze(input) {
      const session = await deps.session.state();
      const zone = session.today?.businessTimeZone ?? null;
      // The window sends what a `datetime-local` gives it. A zone-less instant is not
      // something the server may be asked to guess at.
      const returnAt = input.returnAt.includes('Z')
        ? input.returnAt
        : zone === null
          ? null
          : localToInstant(input.returnAt, zone);
      if (returnAt === null) {
        notice = 'snooze_return_not_future';
        return await snapshot();
      }
      const answer = await deps.api.command(
        '/today/snooze',
        { itemId: input.itemId, reason: input.reason, returnAt },
        value => todaySnoozeResultSchema.parse(value),
      );
      if (note(answer, null) && answer.ok) notice = answer.value.outcome;
      if (expanded !== null) await loadExpansion(expanded.firmId);
      return await snapshot();
    },

    async dial(input) {
      // 9.1: the identity must be "active and owned by the acting salesperson", so it
      // is the one the server reported with this card. A window with none has no Call
      // button, and a request that arrived without one is refused here rather than
      // spending a ticket finding out.
      const callingIdentityId = expanded?.callingIdentityId ?? null;
      if (callingIdentityId === null) {
        notice = 'identity_not_verified';
        return await snapshot();
      }
      const setup = await deps.handoff.checkSetup();
      if (!setup.ready) {
        notice = setup.reason;
        return await snapshot();
      }
      // Two command ids: the authorization and the consumption are two commands with
      // two receipts (5.3), and reusing one would make the consumption a replay.
      const outcome = await deps.handoff.dial({
        commandId: randomUUID(),
        consumeCommandId: randomUUID(),
        firmId: input.firmId,
        ...(input.contactId === null ? {} : { contactId: input.contactId }),
        routeId: input.routeId,
        routeVersion: input.routeVersion,
        callingIdentityId,
      });
      notice =
        outcome.status === 'opened'
          ? 'dial_opened'
          : outcome.status === 'opened_unknown'
            ? 'dial_opened_unknown'
            : outcome.reason;
      return await snapshot();
    },

    async recordOutcome(input) {
      const session = await deps.session.state();
      const zone = session.today?.businessTimeZone ?? null;
      const callback =
        input.callback === null
          ? undefined
          : {
              localDate: input.callback.localDate,
              ...(input.callback.localTime === '' ? {} : { localTime: input.callback.localTime }),
              sourceTimeZone: input.callback.sourceTimeZone === '' ? (zone ?? '') : input.callback.sourceTimeZone,
              dueAt:
                localToInstant(
                  `${input.callback.localDate}T${input.callback.localTime === '' ? '09:00' : input.callback.localTime}`,
                  input.callback.sourceTimeZone === '' ? (zone ?? 'UTC') : input.callback.sourceTimeZone,
                ) ?? input.callback.dueAt,
            };
      const answer = await deps.api.command(
        '/calls/log',
        {
          firmId: input.firmId,
          ...(input.contactId === null ? {} : { contactId: input.contactId }),
          ...(input.routeId === null ? {} : { routeId: input.routeId }),
          outcome: input.outcome,
          occurredAt: new Date().toISOString(),
          ...(input.note === '' ? {} : { note: input.note }),
          ...(callback === undefined ? {} : { callback }),
          ...(input.outcome === 'do_not_call'
            ? { doNotCallCoversAllContact: input.doNotCallCoversAllContact }
            : {}),
        },
        () => null,
      );
      note(answer, 'outcome_recorded');
      // The outcome may have created a callback, stopped a sequence or suppressed a
      // number. Re-read rather than patching the page: the server decided, not us.
      await deps.session.refreshToday();
      if (expanded !== null) await loadExpansion(expanded.firmId);
      return await snapshot();
    },
  };
}
