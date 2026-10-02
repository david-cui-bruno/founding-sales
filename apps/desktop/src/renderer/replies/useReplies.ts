import { useCallback, useEffect, useRef, useState } from 'react';
import { useClearDrafts } from '../app/drafts.tsx';
import type { OperationInput } from '../../shared/operations.ts';
import { REPLY_DISPOSITIONS, type ReplyDisposition, type ReplyState } from '../replyContract.ts';
import { useKept } from './kept.ts';
import { nextAfter } from './queue.ts';

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
 *
 * ## What outlives the view (S4R, criterion 7)
 *
 * Only what the person did: which reply they had open (an id), the answer they picked on
 * it, and what they typed (`kept.ts`, the shell's drafts store). Coming back finds the same
 * reply opened again — a fresh read of its body from the server — with its draft in place.
 * Nothing Callie read, and no message, is kept.
 *
 * ## Which answer wins
 *
 * Every answer here is the whole lane. An answer to a request that a newer request has
 * overtaken refreshes the lane's lines but never moves what is open: a late answer for a
 * reply that is no longer on screen does not bring it back.
 */

const api = (): NonNullable<typeof globalThis.callieApi> | undefined => globalThis.callieApi;

/** What the last command on a reply said: a stable code, kept with the message it was about. */
export interface Outcome {
  readonly messageId: string;
  readonly code: string;
}

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
  /** What the last confirmation or resolution said, beside the message it was about. */
  readonly outcome: Outcome | null;
  /** A call that did not answer at all (an IPC fault, never a refusal, which is a state). */
  readonly failed: boolean;
  /** Read the lane again after a failure; the first read when there is none yet. */
  retry(): void;
  refresh(): void;
  open(messageId: string): void;
  close(): void;
  confirm(input: OperationInput<'replies.confirm'>): void;
  resolve(input: OperationInput<'replies.resolve'>): void;
}

type Kind = 'read' | 'open' | 'confirm' | 'resolve';

export function useReplies(): Replies {
  const [state, setState] = useState<ReplyState | null>(null);
  const [pending, setPending] = useState(0);
  /** One count per card on the wire, so a card waits for its own call only. */
  const [inFlight, setInFlight] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [failed, setFailed] = useState(false);
  /** The reply that was open, by id: kept above the route so coming back reopens it. */
  const [selected, setSelected] = useKept('replies:selected', '');
  const clearDrafts = useClearDrafts();
  /** Bumped on unmount, so an answer to a read this view no longer wants draws nothing. */
  const generation = useRef(0);
  /** The number of the newest request issued; an answer older than it may not move what is open. */
  const issued = useRef(0);
  const restored = useRef(false);
  const latest = useRef({ selected, setSelected });
  latest.current = { selected, setSelected };

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

  const apply = useCallback(
    (next: Promise<ReplyState> | undefined, kind: Kind = 'read', form: string | null = null): void => {
      if (next === undefined) return;
      const mine = generation.current;
      issued.current += 1;
      const number = issued.current;
      setPending(count => count + 1);
      hold(form, 1);
      void next
        .then(
          value => {
            if (mine !== generation.current) return;
            setFailed(false);
            const overtaken = number !== issued.current;
            // Lines from a late answer are still the lane; the open card is not theirs to move.
            setState(current => (overtaken && current !== null ? { ...value, open: current.open } : value));
            if (form !== null && (kind === 'confirm' || kind === 'resolve')) {
              setOutcome(value.notice === null ? null : { messageId: form, code: value.notice });
            }
            if (!overtaken && kind === 'confirm' && form !== null && value.open === null) {
              // The next reply is opened for the person, so answering is one motion after another.
              const following = nextAfter(value.cards, form);
              latest.current.setSelected(following ?? '');
              if (following !== null) apply(api()?.read('replies.open', { messageId: following }), 'open', following);
            }
          },
          (error: unknown) => {
            console.error(error);
            if (mine === generation.current) setFailed(true);
          },
        )
        .finally(() => {
          setPending(count => count - 1);
          hold(form, -1);
        });
    },
    [hold],
  );

  useEffect(() => {
    const first = api()?.read('replies.state', {});
    if (first === undefined) setFailed(true);
    apply(first);
    return () => {
      generation.current += 1;
      // Nothing a reply card carried outlives the view: not the body, not the sender's
      // name, not the model's quotation from it. That is true of the main process too —
      // it held the lane and the open card until 1.0.12 — so leaving the view tells it
      // to forget, and a read still on the wire will not store what it brings back.
      void api()?.read('replies.forget', {});
      setState(null);
      setOutcome(null);
    };
  }, [apply]);

  // The first lane of a mount: reopen the reply that was open when the person left, and
  // forget a selection whose message is no longer in the lane.
  useEffect(() => {
    if (state === null) return;
    const wanted = latest.current.selected;
    if (wanted === '') {
      restored.current = true;
      return;
    }
    const present = state.cards.some(card => card.messageId === wanted);
    if (!present) {
      latest.current.setSelected('');
      restored.current = true;
      return;
    }
    if (!restored.current && state.open === null) {
      restored.current = true;
      apply(api()?.read('replies.open', { messageId: wanted }), 'open', wanted);
    }
    restored.current = true;
  }, [state, apply]);

  /**
   * ⚠ D5.1: the card opens with Callie's guess already chosen, and a person's pick
   * replaces it.
   *
   * Derived rather than kept, so the card is never drawn once with nothing selected and
   * again with the guess — and so "a different card is a different question" needs no
   * code of its own: a pick belongs to the message it was made on (its key), and opening
   * another card falls back to that card's guess. A card the model had no guess for opens
   * with nothing chosen, and Confirm stays dead until it has one. The pick is the
   * person's, so it is kept above the route with the rest of their draft.
   */
  const open = state?.open ?? null;
  const openMessageId = open?.messageId ?? null;
  const [pick, setPick] = useKept(`replies:m:${openMessageId ?? ''}:choice`, '');
  const chosen = REPLY_DISPOSITIONS.find(disposition => disposition === pick) ?? open?.proposedDisposition ?? null;

  const choose = useCallback(
    (disposition: ReplyDisposition): void => {
      if (openMessageId === null) return;
      setPick(disposition);
    },
    [openMessageId, setPick],
  );

  const retry = useCallback((): void => {
    setFailed(false);
    apply(api()?.read('replies.state', {}));
  }, [apply]);

  const refresh = useCallback((): void => {
    apply(api()?.read('replies.refresh', {}));
  }, [apply]);

  const openCard = useCallback(
    (messageId: string): void => {
      setSelected(messageId);
      setOutcome(null);
      apply(api()?.read('replies.open', { messageId }), 'open', messageId);
    },
    [apply, setSelected],
  );

  const close = useCallback((): void => {
    // Closing keeps the draft: reopening the reply shows what was typed (criterion 2).
    setSelected('');
    apply(api()?.read('replies.collapse', {}), 'open');
  }, [apply, setSelected]);

  const confirm = useCallback(
    (input: OperationInput<'replies.confirm'>): void => {
      setOutcome(null);
      // What was sent is on its way; the typed text is spent, as it always was.
      clearDrafts(`replies:m:${input.messageId}:note`);
      apply(api()?.command('replies.confirm', input), 'confirm', input.messageId);
    },
    [apply, clearDrafts],
  );

  const resolve = useCallback(
    (input: OperationInput<'replies.resolve'>): void => {
      setOutcome(null);
      apply(api()?.command('replies.resolve', input), 'resolve', input.messageId);
    },
    [apply],
  );

  const busy = useCallback((form: string): boolean => (inFlight.get(form) ?? 0) > 0, [inFlight]);

  return { state, pending, busy, chosen, choose, outcome, failed, retry, refresh, open: openCard, close, confirm, resolve };
}
