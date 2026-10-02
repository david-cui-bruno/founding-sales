// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import { RepliesRoute } from '../src/renderer/replies/RepliesRoute.tsx';
import { countQueue, filterQueue, isUncertain } from '../src/renderer/replies/queue.ts';
import { replySummaryOf, type ReplyState } from '../src/renderer/replyContract.ts';
import type { OperationApi, OperationName } from '../src/shared/operations.ts';
import { MESSAGE_ID, OTHER_MESSAGE_ID, replyAnswer, replyCard, replyState, replyWire, type ReplyLane } from './e2e/support/replyFixtures.ts';

/**
 * S4F-R: the Replies "uncertain" count, from the classifier's own class.
 *
 * The definition is the send path's: `applyClassificationEffects` opens an `uncertain_reply`
 * hold for class `human` or `uncertain` (`packages/domain/mail/effects.ts:220`), and the
 * class that says "the classifier could not tell" is `uncertain`. No threshold is applied to
 * confidence anywhere. These are the kept-state tests for the new read (K1, K4, K7) and the
 * count itself.
 */

const THIRD = '44444444-4444-4444-8444-444444444444';
const column = { current: null };
const reply = (id: string, receivedAt: string, extra: Parameters<typeof replyCard>[0] = {}) =>
  replyCard({ messageId: id, receivedAt, firmName: `Firm ${id.slice(0, 2)}`, ...extra });

let lane: ReplyLane;
let calls: { readonly method: string; readonly argument: unknown }[];

function install(initial: ReplyLane): void {
  lane = initial;
  calls = [];
  const answer = async (operation: OperationName, input: unknown): Promise<unknown> => {
    const method = operation.replace('replies.', '');
    calls.push({ method, argument: input });
    if (method === 'forget') lane = { ...lane, open: null };
    else if (method !== 'state' && method !== 'refresh') lane = replyAnswer(lane, method, input, []);
    return await Promise.resolve(replyWire(lane));
  };
  globalThis.callieApi = { read: answer, command: answer } as unknown as OperationApi;
}

const threeReplies = (): ReplyLane =>
  replyState({
    cards: [
      reply(MESSAGE_ID, '2026-09-21T09:00:00.000Z', { deterministicClass: 'human' }),
      reply(OTHER_MESSAGE_ID, '2026-09-21T11:00:00.000Z', { deterministicClass: 'uncertain', confidence: 0.3 }),
      reply(THIRD, '2026-09-21T10:00:00.000Z', { deterministicClass: 'uncertain', proposedDisposition: null, proposedBy: 'none', confidence: null }),
    ],
  });

afterEach(() => {
  cleanup();
  globalThis.callieApi = undefined;
});

describe('kept state for the uncertain read (K1, K4, K7)', () => {
  it('K1: the uncertain filter survives Replies → elsewhere → Replies, and sign-out drops it', async () => {
    install(threeReplies());
    const tree = (on: boolean, session: string): JSX.Element => (
      <DraftsProvider key={session}>{on ? <RepliesRoute column={column} /> : <p>away</p>}</DraftsProvider>
    );
    const user = userEvent.setup();
    const view = render(tree(true, 'a'));
    await user.click(await screen.findByTestId('count-uncertain'));
    expect(screen.getAllByTestId('reply-summary')).toHaveLength(2);
    view.rerender(tree(false, 'a'));
    view.rerender(tree(true, 'a'));
    await screen.findAllByTestId('reply-summary');
    expect(screen.getByTestId('count-uncertain').getAttribute('aria-pressed')).toBe('true');
    // A new session (sign-out and back in) is a new store: nothing is carried over.
    view.rerender(tree(false, 'a'));
    view.rerender(tree(true, 'b'));
    await screen.findAllByTestId('reply-summary');
    expect(screen.getByTestId('count-uncertain').getAttribute('aria-pressed')).toBe('false');
  });

  it('a sign-out in the middle of a command discards its answer: nothing opens afterwards', async () => {
    install(threeReplies());
    let answer: (state: ReplyState) => void = () => undefined;
    (globalThis.callieApi as unknown as { command: unknown }).command = () =>
      new Promise<ReplyState>(resolve => {
        answer = resolve;
      });
    const user = userEvent.setup();
    const view = render(
      <DraftsProvider key="a">
        <RepliesRoute column={column} />
      </DraftsProvider>,
    );
    await user.click((await screen.findAllByTestId('reply-open'))[0] as HTMLElement);
    await user.click(await screen.findByTestId('confirm'));
    const before = calls.filter(call => call.method === 'open').length;
    view.rerender(<p data-testid="signed-out">signed out</p>);
    answer(replyWire({ ...lane, open: null, notice: 'confirmed' }));
    await new Promise(resolve => setTimeout(resolve, 20));
    // The success answer would open the next reply; for a view that is gone it opens nothing.
    expect(calls.filter(call => call.method === 'open')).toHaveLength(before);
    expect(screen.queryByTestId('reply-list')).toBeNull();
  });

  it('K7: a late answer for a reply that is no longer selected does not replace the selected one', async () => {
    install(threeReplies());
    let settle: (value: ReplyState) => void = () => undefined;
    const slow = new Promise<ReplyState>(resolve => {
      settle = resolve;
    });
    const base = globalThis.callieApi as unknown as { read: (operation: OperationName, input: unknown) => Promise<unknown> };
    globalThis.callieApi = {
      ...base,
      read: async (operation: OperationName, input: unknown) =>
        operation === 'replies.open' && (input as { messageId: string }).messageId === MESSAGE_ID ? await slow : await base.read(operation, input),
    } as unknown as OperationApi;
    const user = userEvent.setup();
    render(
      <DraftsProvider>
        <RepliesRoute column={column} />
      </DraftsProvider>,
    );
    const rows = await screen.findAllByTestId('reply-open');
    // Queue order: OTHER (11:00), THIRD (10:00), MESSAGE (09:00).
    await user.click(rows[2] as HTMLElement);
    await user.click(rows[0] as HTMLElement);
    await waitFor(() => {
      expect(screen.getByTestId('card-firm').textContent).toBe(`Firm ${OTHER_MESSAGE_ID.slice(0, 2)}`);
    });
    settle(replyWire({ ...lane, open: lane.cards.find(card => card.messageId === MESSAGE_ID) ?? null }));
    await slow;
    await Promise.resolve();
    expect(screen.getByTestId('card-firm').textContent).toBe(`Firm ${OTHER_MESSAGE_ID.slice(0, 2)}`);
  });

  it('K4: J/K then Enter run no command while the uncertain filter is on', async () => {
    install(threeReplies());
    const commands: unknown[] = [];
    (globalThis.callieApi as unknown as { command: unknown }).command = (_name: unknown, input: unknown) => {
      commands.push(input);
      return new Promise(() => undefined);
    };
    const user = userEvent.setup();
    render(
      <DraftsProvider>
        <RepliesRoute column={column} />
      </DraftsProvider>,
    );
    await user.click(await screen.findByTestId('count-uncertain'));
    await user.keyboard('jj{Enter}');
    await screen.findByTestId('reply-card');
    screen.getByTestId('confirm').focus();
    await user.keyboard('k{Enter}');
    expect(commands).toHaveLength(0);
  });
});

describe('the uncertain count (criterion 5)', () => {
  const cards = threeReplies().cards.map(replySummaryOf);

  it('uses the classifier class: `uncertain` is counted apart, `human` is not, and no threshold is applied', () => {
    const [human, lowConfidence, noSuggestion] = cards;
    expect(isUncertain(human as (typeof cards)[number])).toBe(false);
    // 0.3 confidence and no confidence at all are both just `uncertain`: the class decides.
    expect(isUncertain(lowConfidence as (typeof cards)[number])).toBe(true);
    expect(isUncertain(noSuggestion as (typeof cards)[number])).toBe(true);
    // A confident `human` reply with a high-confidence suggestion is not uncertain, however low the number.
    const lowHuman = replySummaryOf(reply('55555555-5555-4555-8555-555555555551', '2026-09-21T09:00:00.000Z', { deterministicClass: 'human', confidence: 0.01 }));
    expect(isUncertain(lowHuman)).toBe(false);
    expect(countQueue(cards)).toEqual({ waiting: 1, uncertain: 2, all: 3 });
    expect(filterQueue(cards, 'uncertain')).toHaveLength(2);
  });

  it('names its period, keeps the uncertain count apart, and opens the list it counts', async () => {
    install(threeReplies());
    render(
      <DraftsProvider>
        <RepliesRoute column={column} />
      </DraftsProvider>,
    );
    expect((await screen.findByTestId('reply-counts')).textContent).toBe('Today: 1 to answer (+2 uncertain) · 3 in all');
    await userEvent.click(screen.getByTestId('count-uncertain'));
    expect(screen.getAllByTestId('reply-summary')).toHaveLength(2);
  });

  it('an answered uncertain reply leaves the uncertain count', () => {
    const answered = replySummaryOf(reply(THIRD, '2026-09-21T10:00:00.000Z', { deterministicClass: 'uncertain', confirmation: { disposition: 'other' } as never }));
    expect(isUncertain(answered)).toBe(false);
  });

  it('the summary carries the class and the confidence the card already has', () => {
    const summary = replySummaryOf(reply(MESSAGE_ID, '2026-09-21T09:00:00.000Z', { deterministicClass: 'uncertain', confidence: 0.42 }));
    expect(summary).toMatchObject({ deterministicClass: 'uncertain', confidence: 0.42 });
  });
});
