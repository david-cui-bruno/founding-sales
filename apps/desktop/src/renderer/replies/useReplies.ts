import { useCallback, useEffect, useRef, useState } from 'react';
import type { OperationInput } from '../../shared/operations.ts';
import type { ReplyDisposition, ReplyState } from '../replyContract.ts';

/**
 * The reply lane's reads, deliberately **not** through Query (specification 8.3, 12.4).
 *
 * `GET /replies` answers full cards, bodies and all (`packages/contracts/src/replies.ts`),
 * so a reply DTO in a request cache would be a message somebody wrote sitting in memory
 * under a key, surviving the card being closed and the view being left, and one persister
 * away from the disk. Today may use Query because its list is cards and counts; Replies
 * may not, and the way to make that structural rather than remembered is for this hook to
 * have no cache in it at all.
 *
 * What follows from that, and what the tests assert:
 *
 *   * the content is React state in the mounted view, so leaving the view is the end of it;
 *   * a read that failed replaces what was on screen with the bridge's answer — which
 *     holds no cards, because nothing about replies is kept on this Mac — rather than
 *     leaving the last good one up;
 *   * closing a card drops it;
 *   * the view is keyed on the person signed in, so a sign-out, another workspace, a
 *     changed role or a revoked device unmounts it and takes the content with it.
 *
 * `chosen` is the disposition on the form. Since D5.1 (26 September 2026) it starts as
 * Callie's guess rather than as nothing — see `RepliesView.tsx` for the guards that
 * decision came with.
 */

const api = (): NonNullable<typeof globalThis.callieApi> | undefined => globalThis.callieApi;

export interface Replies {
  readonly state: ReplyState | null;
  /** How many calls are in flight; the list is `aria-busy` while any is. */
  readonly pending: number;
  /**
   * Whether *this* card's own call is on the wire (1.0.13, P1-4).
   *
   * Until the review a call held the whole column read-only, so confirming one reply
   * froze every other card, Refresh and the sidebar. The name is the message's id.
   */
  busy(form: string): boolean;
  readonly chosen: ReplyDisposition | null;
  choose(disposition: ReplyDisposition): void;
  refresh(): void;
  open(messageId: string): void;
  close(): void;
  confirm(input: OperationInput<'replies.confirm'>): void;
  resolve(input: OperationInput<'replies.resolve'>): void;
}

export function useReplies(): Replies {
  const [state, setState] = useState<ReplyState | null>(null);
  const [pending, setPending] = useState(0);
  /** One count per card on the wire, so a card waits for its own call only. */
  const [inFlight, setInFlight] = useState<ReadonlyMap<string, number>>(() => new Map());
  /** What a person picked, and on which card. Null until they pick on this one. */
  const [picked, setPicked] = useState<{ readonly messageId: string; readonly disposition: ReplyDisposition } | null>(null);
  /** Bumped on unmount, so an answer to a read this view no longer wants draws nothing. */
  const generation = useRef(0);

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

  const apply = useCallback((next: Promise<ReplyState> | undefined, form: string | null = null): void => {
    if (next === undefined) return;
    const mine = generation.current;
    setPending(count => count + 1);
    hold(form, 1);
    void next
      .then(
        value => {
          if (mine === generation.current) setState(value);
        },
        (error: unknown) => {
          console.error(error);
        },
      )
      .finally(() => {
        setPending(count => count - 1);
        hold(form, -1);
      });
  }, [hold]);

  useEffect(() => {
    apply(api()?.read('replies.state', {}));
    return () => {
      generation.current += 1;
      // Nothing a reply card carried outlives the view: not the body, not the sender's
      // name, not the model's quotation from it. That is true of the main process too —
      // it held the lane and the open card until 1.0.12 — so leaving the view tells it
      // to forget, and a read still on the wire will not store what it brings back.
      void api()?.read('replies.forget', {});
      setState(null);
      setPicked(null);
    };
  }, [apply]);

  /**
   * ⚠ D5.1: the card opens with Callie's guess already chosen, and a person's pick
   * replaces it.
   *
   * Derived rather than kept, so the card is never drawn once with nothing selected and
   * again with the guess — and so "a different card is a different question" needs no
   * code of its own: a pick belongs to the message it was made on, and opening another
   * card falls back to that card's guess. A card the model had no guess for opens with
   * nothing chosen, and Confirm stays dead until it has one.
   */
  const open = state?.open ?? null;
  const openMessageId = open?.messageId ?? null;
  const chosen =
    picked !== null && picked.messageId === openMessageId ? picked.disposition : (open?.proposedDisposition ?? null);

  const choose = useCallback(
    (disposition: ReplyDisposition): void => {
      if (openMessageId === null) return;
      setPicked({ messageId: openMessageId, disposition });
    },
    [openMessageId],
  );

  const refresh = useCallback((): void => {
    apply(api()?.read('replies.refresh', {}));
  }, [apply]);

  const openCard = useCallback(
    (messageId: string): void => {
      apply(api()?.read('replies.open', { messageId }), messageId);
    },
    [apply],
  );

  const close = useCallback((): void => {
    apply(api()?.read('replies.collapse', {}));
  }, [apply]);

  const confirm = useCallback(
    (input: OperationInput<'replies.confirm'>): void => {
      apply(api()?.command('replies.confirm', input), input.messageId);
    },
    [apply],
  );

  const resolve = useCallback(
    (input: OperationInput<'replies.resolve'>): void => {
      apply(api()?.command('replies.resolve', input), input.messageId);
    },
    [apply],
  );

  const busy = useCallback((form: string): boolean => (inFlight.get(form) ?? 0) > 0, [inFlight]);

  return { state, pending, busy, chosen, choose, refresh, open: openCard, close, confirm, resolve };
}
