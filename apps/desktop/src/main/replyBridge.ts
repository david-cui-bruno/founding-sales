import {
  classifierSettingsResponseSchema,
  confirmReplyResultSchema,
  replyCardDtoSchema,
  replyListResponseSchema,
} from '@fss/contracts';
import {
  replyStateSchema,
  type ConfirmReplyRequest,
  type ReplyCard,
  type ReplyState,
} from '../renderer/replyContract.ts';
import type { AuthedClient } from './authedClient.ts';
import { localToInstant } from './todayBridge.ts';
import type { ApiOutcome } from './apiClient.ts';

/**
 * The reply cards' half of the bridge, in the main process (specification 8.3, 12.4,
 * 14.2).
 *
 * The renderer sees a `ReplyState` and nothing else: no access token, no command id,
 * and no way to ask for anything this file does not offer. What it offers is four
 * things — read the lane, open a card, put it away, confirm a disposition — and that
 * list is the authority boundary in its most enforceable form. There is no `close`,
 * no `suppress`, no `release`, no `resume`; 12.4 gives those to the deterministic
 * layer or to a person on another surface, and a bridge that cannot name them cannot
 * be talked into them.
 *
 * Three decisions are worth naming.
 *
 * **Nothing here is cached.** G2's session cache holds the Today list for 24 hours
 * encrypted (5.3); a reply card holds a message body, a contact's name and a
 * quotation, so it is read from the cloud each time and is simply absent without it.
 * `ReplyState` is not part of `DesktopState` and cannot reach the cache at all.
 *
 * **A local wall-clock callback becomes a UTC instant here**, through G6's
 * `localToInstant`, against the business zone the API reported. One implementation of
 * that arithmetic in this process, not two.
 *
 * **The model's proposed callback is a prefill and never a value.** `confirm` sends
 * the instant the person's form produced, or nothing. A bridge that filled in the
 * model's proposal when the form was empty would be the model committing a callback
 * through somebody else's click, which is exactly what 12.4 forbids — the server
 * refuses that case with `callback_required` and this file does not try to be clever
 * about it.
 */

export const REPLY_IPC_CHANNELS = {
  state: 'callie:replies:state',
  refresh: 'callie:replies:refresh',
  open: 'callie:replies:open',
  collapse: 'callie:replies:collapse',
  confirm: 'callie:replies:confirm',
} as const;
export type ReplyIpcChannel = (typeof REPLY_IPC_CHANNELS)[keyof typeof REPLY_IPC_CHANNELS];

/*
 * `/replies`, `/replies/card`, `/replies/settings` and `/replies/confirm` are parsed with
 * `@fss/contracts`' schemas (lane g78), the ones the routes' own tests hold the real
 * answers to. Until g78 the settings schema here stopped the effort at `high`, so a
 * workspace at `xhigh` or `max` read back as `classifier: null` (D03).
 */

export interface ReplyBridgeDeps {
  readonly api: AuthedClient;
  /** G2's session manager: the token, the version gate, the online rule, the wipe. */
  readonly session: {
    state(): Promise<{
      readonly online: boolean;
      readonly mayMutate: boolean;
      readonly today: { readonly businessTimeZone: string } | null;
    }>;
  };
}

export interface ReplyBridgeHost {
  state(): Promise<ReplyState>;
  refresh(): Promise<ReplyState>;
  open(input: { readonly messageId: string }): Promise<ReplyState>;
  collapse(): Promise<ReplyState>;
  confirm(input: ConfirmReplyRequest): Promise<ReplyState>;
}

export function createReplyBridge(deps: ReplyBridgeDeps): ReplyBridgeHost {
  let cards: readonly ReplyCard[] = [];
  let businessDate: string | null = null;
  let open: ReplyCard | null = null;
  let classifier: ReplyState['classifier'] = null;
  let notice: string | null = null;

  const snapshot = async (): Promise<ReplyState> => {
    const session = await deps.session.state();
    return replyStateSchema.parse({
      businessDate,
      businessTimeZone: session.today?.businessTimeZone ?? null,
      cards,
      open,
      online: session.online,
      mayMutate: session.mayMutate,
      classifier,
      notice,
    });
  };

  const note = (outcome: ApiOutcome<unknown>, accepted: string | null): boolean => {
    if (outcome.ok) {
      notice = accepted;
      return true;
    }
    notice = outcome.reason;
    return false;
  };

  const loadLane = async (): Promise<void> => {
    const lane = await deps.api.read('/replies', value => replyListResponseSchema.parse(value), {});
    if (!lane.ok) {
      // 4.2: nothing here is cached, so an outage is an empty lane and a notice —
      // never a stale card somebody might answer.
      cards = [];
      businessDate = null;
      note(lane, null);
      return;
    }
    cards = lane.value.cards;
    businessDate = lane.value.businessDate;
    notice = null;
    const settings = await deps.api.read('/replies/settings', value => classifierSettingsResponseSchema.parse(value), {});
    // The three the window shows. The caps and who changed them last stay on the server.
    classifier = settings.ok
      ? { enabled: settings.value.enabled, modelName: settings.value.modelName, effort: settings.value.effort }
      : null;
  };

  const loadCard = async (messageId: string): Promise<void> => {
    const card = await deps.api.read('/replies/card', value => replyCardDtoSchema.parse(value), { messageId });
    if (!card.ok) {
      open = null;
      note(card, null);
      return;
    }
    open = card.value;
    notice = null;
  };

  return {
    state: snapshot,

    async refresh() {
      await loadLane();
      if (open !== null) await loadCard(open.messageId);
      return await snapshot();
    },

    async open(input) {
      await loadCard(input.messageId);
      return await snapshot();
    },

    async collapse() {
      open = null;
      notice = null;
      return await snapshot();
    },

    async confirm(input) {
      const session = await deps.session.state();
      const zone = session.today?.businessTimeZone ?? null;
      let callback: Record<string, unknown> | undefined;
      if (input.callback !== null) {
        const sourceTimeZone = input.callback.sourceTimeZone === '' ? zone : input.callback.sourceTimeZone;
        const localTime = input.callback.localTime === '' ? '09:00' : input.callback.localTime;
        const dueAt =
          sourceTimeZone === null ? null : localToInstant(`${input.callback.localDate}T${localTime}`, sourceTimeZone);
        if (dueAt === null || sourceTimeZone === null) {
          // A zone-less wall clock is not something the server may be asked to guess
          // at, and the model's proposal is not a substitute for the person's answer.
          notice = 'callback_required';
          return await snapshot();
        }
        callback = { localDate: input.callback.localDate, localTime, sourceTimeZone, dueAt };
      }

      const answer = await deps.api.command(
        '/replies/confirm',
        {
          messageId: input.messageId,
          disposition: input.disposition,
          ...(callback === undefined ? {} : { callback }),
          ...(input.disposition === 'opt_out' ? { firmWideOptOut: input.firmWideOptOut } : {}),
          ...(input.note === '' ? {} : { note: input.note }),
        },
        value => confirmReplyResultSchema.parse(value),
      );
      // `suggestsLost` is a suggestion and stays one: the window says so and offers
      // no button that would act on it (9.1). Closing the opportunity is a separate,
      // deliberate command on the firm page.
      if (note(answer, 'confirmed') && answer.ok && answer.value.suggestsLost) notice = 'suggests_lost';

      // The confirmation set the firm to manual, released a hold and may have
      // completed a today item. Re-read rather than patching: the server decided.
      // The re-read must not swallow what the command said, though — "recorded, and
      // this one looks lost" is the whole point of having asked.
      const said = notice;
      await loadLane();
      notice = said;
      open = null;
      return await snapshot();
    },
  };
}
