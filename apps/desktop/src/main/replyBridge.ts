import {
  classifierSettingsResponseSchema,
  confirmReplyResultSchema,
  replyCardDtoSchema,
  replyListResponseSchema,
} from '@fss/contracts';
import {
  replyStateSchema,
  replySummaryOf,
  type ConfirmReplyRequest,
  type ReplyCard,
  type ReplyState,
  type ReplySummary,
  type ResolveReplyRequest,
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

/*
 * There are no channels of this view's own since 1.0.12: the six that stood here are six
 * operations of `shared/operations.ts`, answered on `callie:op:read` and
 * `callie:op:command`. The authority boundary is unchanged and is now stated in one
 * place — there is no operation that closes an opportunity, records a suppression,
 * releases a hold or resumes automation, and a renderer cannot name one that is not in
 * the list.
 */

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
  resolve(input: ResolveReplyRequest): Promise<ReplyState>;
  /**
   * Drop everything: the lane, the open card and the body in it (1.0.12).
   *
   * Called when the view unmounts and when the session changes — a sign-out, another
   * workspace, a changed role, a revoked device. A read already on the wire when this
   * happens does not store what it brings back: it was made for somebody who is no
   * longer the person at this Mac.
   */
  forget(): Promise<ReplyState>;
}

export function createReplyBridge(deps: ReplyBridgeDeps): ReplyBridgeHost {
  let cards: readonly ReplySummary[] = [];
  let businessDate: string | null = null;
  let open: ReplyCard | null = null;
  let classifier: ReplyState['classifier'] = null;
  let notice: string | null = null;
  /*
   * Bumped by `forget`. Every load takes a copy before it awaits and compares after:
   * an answer from before the clear is dropped rather than stored, which is the
   * difference between "the lane is empty" and "the lane is empty until the read that
   * was already in flight fills it in again".
   */
  let generation = 0;

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

  /**
   * Whether the view this work was started for is still the view (1.0.12).
   *
   * `forget` moves the number. A **command** has to ask this as well as a read: a
   * confirmation and an ambiguity resolution both re-read the lane and the card after
   * the server answers, and those reads, started after the clear, would be started
   * under the new number and store what they brought back — putting a body and a lane
   * back into a process the view has already left.
   */
  const stale = (mine: number): boolean => mine !== generation;

  const note = (outcome: ApiOutcome<unknown>, accepted: string | null): boolean => {
    if (outcome.ok) {
      notice = accepted;
      return true;
    }
    notice = outcome.reason;
    return false;
  };

  const loadLane = async (): Promise<void> => {
    const mine = generation;
    const lane = await deps.api.read('/replies', value => replyListResponseSchema.parse(value), {});
    if (mine !== generation) return;
    if (!lane.ok) {
      // 4.2: nothing here is cached, so an outage is an empty lane and a notice —
      // never a stale card somebody might answer. The open card goes with it: a body
      // is held only while a live read says it is still there to read.
      cards = [];
      businessDate = null;
      open = null;
      note(lane, null);
      return;
    }
    // The bodies are dropped here, where the answer is parsed. Nothing downstream has
    // to remember to: `cards` is a shape that cannot hold one.
    cards = lane.value.cards.map(replySummaryOf);
    businessDate = lane.value.businessDate;
    notice = null;
    const settings = await deps.api.read('/replies/settings', value => classifierSettingsResponseSchema.parse(value), {});
    if (mine !== generation) return;
    // The three the window shows. The caps and who changed them last stay on the server.
    classifier = settings.ok
      ? { enabled: settings.value.enabled, modelName: settings.value.modelName, effort: settings.value.effort }
      : null;
  };

  const loadCard = async (messageId: string): Promise<void> => {
    const mine = generation;
    const card = await deps.api.read('/replies/card', value => replyCardDtoSchema.parse(value), { messageId });
    // A card that arrives after a clear is not kept: the person it was read for has
    // signed out, changed workspace, or left the view.
    if (mine !== generation) return;
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
      const mine = generation;
      await loadLane();
      if (stale(mine)) return await snapshot();
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

    async forget() {
      generation += 1;
      cards = [];
      businessDate = null;
      open = null;
      classifier = null;
      notice = null;
      return await snapshot();
    },

    async confirm(input) {
      const mine = generation;
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
      // The view was left, or the person signed out, while the confirmation was on the
      // wire. The command itself stands — the server recorded it — but nothing it
      // brought back is written here, and the lane is not read again to hold it.
      if (stale(mine)) return await snapshot();
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
      if (stale(mine)) return await snapshot();
      notice = said;
      open = null;
      return await snapshot();
    },

    /**
     * Which conversation an ambiguous reply belongs to (12.3; lane g88, audit G07).
     *
     * G7's command, `/messages/resolve-ambiguity`, as `docs/decisions/g7b-ambiguity-stays-where-g7-put-it.md`
     * says the window should send — there is one resolution per message and one path to
     * it. `human` is false: choosing the conversation is not saying the reply is a
     * person's, and the disposition the person confirms next is what sets the firm to
     * manual and releases the reply's own hold. The only consequence here is 12.3's own:
     * the other candidates' ambiguity holds are released after a fresh check, and the
     * chosen one keeps a hold until the reply is answered.
     *
     * The card stays open and is read again, so the next thing on screen is the question
     * the resolution unlocked.
     */
    async resolve(input) {
      const mine = generation;
      const card = open;
      if (card === null || card.messageId !== input.messageId) {
        notice = 'message_unknown';
        return await snapshot();
      }
      if (!card.impact.candidates.some(candidate => candidate.opportunityId === input.opportunityId)) {
        notice = 'match_unknown';
        return await snapshot();
      }
      const answer = await deps.api.command(
        '/messages/resolve-ambiguity',
        { messageId: input.messageId, selectedOpportunityId: input.opportunityId, human: false },
        () => null,
      );
      // As in `confirm`: the resolution stands, and nothing it would have drawn is put
      // back into a bridge the view has left. This is the one that would have restored
      // a body, because it reads the card again.
      if (stale(mine)) return await snapshot();
      note(answer, 'resolved');
      // The re-read must not swallow what the command said, as in `confirm`.
      const said = notice;
      await loadLane();
      if (stale(mine)) return await snapshot();
      await loadCard(input.messageId);
      if (stale(mine)) return await snapshot();
      notice = said;
      return await snapshot();
    },
  };
}
