// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import { RepliesRoute } from '../src/renderer/replies/RepliesRoute.tsx';
import { countQueue, filterQueue, nextAfter, orderQueue } from '../src/renderer/replies/queue.ts';
import { replySummaryOf, type ReplyState } from '../src/renderer/replyContract.ts';
import type { OperationApi, OperationName } from '../src/shared/operations.ts';
import { OTHER_MESSAGE_ID, MESSAGE_ID, replyAnswer, replyCard, replyState, replyWire, type ReplyLane } from './e2e/support/replyFixtures.ts';

/**
 * S4R: the Replies queue and panel.
 *
 *   * the order and the counts are pure (`replies/queue.ts`) and tested as such;
 *   * after a reply is answered the next waiting one opens (criterion: next-item selection);
 *   * what the person did survives Replies → elsewhere → Replies (criterion 7): the open
 *     reply, the answer picked, the note, the filter and the list's scroll;
 *   * the counts name their period, keep the uncertain ones apart and open the list they count.
 */

const THIRD_ID = '44444444-4444-4444-8444-444444444444';
const column = { current: null };

const waiting = (messageId: string, receivedAt: string, extra: Parameters<typeof replyCard>[0] = {}) =>
  replyCard({ messageId, receivedAt, firmName: `Firm ${messageId.slice(0, 2)}`, ...extra });

let lane: ReplyLane;
let calls: { readonly method: string; readonly argument: unknown }[];

/** A stateful stand-in for the main process: the lane, and the operations a view asks of it. */
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

const opened = (): string[] => calls.filter(call => call.method === 'open').map(call => (call.argument as { messageId: string }).messageId);

afterEach(() => {
  cleanup();
  globalThis.callieApi = undefined;
  vi.useRealTimers();
});

describe('the reply queue (pure)', () => {
  const a = replySummaryOf(waiting(MESSAGE_ID, '2026-09-21T09:00:00.000Z'));
  const b = replySummaryOf(waiting(OTHER_MESSAGE_ID, '2026-09-21T11:00:00.000Z'));
  const c = replySummaryOf(waiting(THIRD_ID, '2026-09-21T10:00:00.000Z', { proposedDisposition: null, proposedBy: 'none', confidence: null }));
  const done = replySummaryOf(waiting('55555555-5555-4555-8555-555555555551', '2026-09-21T12:00:00.000Z', { nextAction: 'nothing_to_do' }));

  it('puts what is waiting first, newest first, and the rest after', () => {
    expect(orderQueue([a, done, b, c]).map(card => card.messageId)).toEqual([b.messageId, c.messageId, a.messageId, done.messageId]);
  });

  it('counts a reply with no suggestion apart from the others', () => {
    expect(countQueue([a, b, c, done])).toEqual({ waiting: 2, unsure: 1, all: 4 });
    expect(filterQueue([a, b, c, done], 'unsure').map(card => card.messageId)).toEqual([c.messageId]);
    expect(filterQueue([a, b, c, done], 'waiting').map(card => card.messageId)).toEqual([a.messageId, b.messageId]);
  });

  it('picks the next waiting reply below the answered one, else the first, else none', () => {
    const lanes = [a, b, c, done];
    expect(nextAfter(lanes, b.messageId)).toBe(c.messageId);
    expect(nextAfter(lanes, a.messageId)).toBe(b.messageId);
    expect(nextAfter([a], a.messageId)).toBeNull();
  });
});

describe('after an answer', () => {
  beforeEach(() => {
    install(
      replyState({
        cards: [
          waiting(MESSAGE_ID, '2026-09-21T09:00:00.000Z'),
          waiting(OTHER_MESSAGE_ID, '2026-09-21T11:00:00.000Z'),
          waiting(THIRD_ID, '2026-09-21T10:00:00.000Z'),
        ],
      }),
    );
  });

  it('opens the next waiting reply, and says what happened beside the answered one', async () => {
    render(<RepliesRoute column={column} />);
    const user = userEvent.setup();
    // Newest first: OTHER (11:00), THIRD (10:00), MESSAGE (09:00).
    const rows = await screen.findAllByTestId('reply-open');
    expect(rows).toHaveLength(3);
    await user.click(rows[0] as HTMLElement);
    await screen.findByTestId('reply-card');
    expect(opened()).toEqual([OTHER_MESSAGE_ID]);

    await user.click(screen.getByTestId('confirm'));
    await waitFor(() => {
      expect(opened()).toEqual([OTHER_MESSAGE_ID, THIRD_ID]);
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('reply-open')[1]?.getAttribute('aria-current')).toBe('true');
    });
    // "Recorded." is beside the reply it is about, not above the page.
    const first = screen.getAllByTestId('reply-summary')[0] as HTMLElement;
    expect(within(first).getByTestId('banner-info').textContent).toBe('Recorded.');
    expect(screen.getAllByTestId('banner-info')).toHaveLength(1);
  });

  it('opens nothing when nothing else is waiting', async () => {
    install(replyState({ cards: [waiting(MESSAGE_ID, '2026-09-21T09:00:00.000Z')] }));
    render(<RepliesRoute column={column} />);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('reply-open'));
    await screen.findByTestId('reply-card');
    await user.click(screen.getByTestId('confirm'));
    await screen.findByTestId('banner-info');
    expect(opened()).toEqual([MESSAGE_ID]);
    expect(screen.queryByTestId('reply-card')).toBeNull();
  });

  it('walks the queue with J and K and opens with Enter', async () => {
    render(<RepliesRoute column={column} />);
    const user = userEvent.setup();
    await screen.findAllByTestId('reply-open');
    await user.keyboard('j');
    expect(document.activeElement).toBe(screen.getAllByTestId('reply-open')[0]);
    await user.keyboard('j');
    expect(document.activeElement).toBe(screen.getAllByTestId('reply-open')[1]);
    await user.keyboard('k');
    expect(document.activeElement).toBe(screen.getAllByTestId('reply-open')[0]);
    await user.keyboard('{Enter}');
    await screen.findByTestId('reply-card');
    expect(opened()).toEqual([OTHER_MESSAGE_ID]);
    // Typing in the note never moves the queue.
    await user.click(screen.getByTestId('note'));
    await user.keyboard('jjk');
    expect(opened()).toEqual([OTHER_MESSAGE_ID]);
    expect((screen.getByTestId('note') as HTMLTextAreaElement).value).toBe('jjk');
  });
});

describe('context kept (criterion 7)', () => {
  let scrollTop = 0;
  beforeEach(() => {
    scrollTop = 0;
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value;
      },
    });
    install(
      replyState({
        cards: [waiting(MESSAGE_ID, '2026-09-21T09:00:00.000Z'), waiting(OTHER_MESSAGE_ID, '2026-09-21T11:00:00.000Z')],
      }),
    );
  });
  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollTop');
  });

  function Shell({ onReplies }: { readonly onReplies: boolean }): JSX.Element {
    // The drafts store sits above the route, as in the shell; the route swaps under it.
    return <DraftsProvider>{onReplies ? <RepliesRoute column={column} /> : <p data-testid="today">Today</p>}</DraftsProvider>;
  }

  it('brings back the open reply, the answer picked, the note, the filter and the scroll', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const view = render(<Shell onReplies />);
    await screen.findAllByTestId('reply-open');
    await user.click(screen.getAllByTestId('reply-open')[1] as HTMLElement); // MESSAGE_ID
    await screen.findByTestId('reply-card');
    await user.click(screen.getByTestId('choice-opt_out'));
    await user.type(screen.getByTestId('note'), 'call Dana first');
    await user.click(screen.getByTestId('count-all'));
    scrollTop = 120;
    fireEvent.scroll(screen.getByTestId('queue-list'));
    act(() => {
      vi.advanceTimersByTime(200);
    });

    view.rerender(<Shell onReplies={false} />);
    expect(screen.queryByTestId('reply-card')).toBeNull();
    expect(calls.some(call => call.method === 'forget')).toBe(true);
    scrollTop = 0;

    view.rerender(<Shell onReplies />);
    await screen.findByTestId('reply-card');
    expect(opened().at(-1)).toBe(MESSAGE_ID);
    expect((screen.getByTestId('choice-opt_out') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('note') as HTMLTextAreaElement).value).toBe('call Dana first');
    expect(screen.getByTestId('count-all').getAttribute('aria-pressed')).toBe('true');
    expect(scrollTop).toBe(120);
  });

  it('keeps the draft when the reply is closed with Escape and opened again', async () => {
    const user = userEvent.setup();
    render(<Shell onReplies />);
    await user.click((await screen.findAllByTestId('reply-open'))[0] as HTMLElement);
    await user.type(await screen.findByTestId('note'), 'draft');
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByTestId('reply-card')).toBeNull();
    });
    await user.click(screen.getAllByTestId('reply-open')[0] as HTMLElement);
    expect((await screen.findByTestId('note') as HTMLTextAreaElement).value).toBe('draft');
    // And a second click on the row closes it, keeping the draft too.
    await user.click(screen.getAllByTestId('reply-open')[0] as HTMLElement);
    await waitFor(() => {
      expect(screen.queryByTestId('reply-card')).toBeNull();
    });
  });

  it('does not reopen a reply from a late answer once another is open', async () => {
    let settle: (value: ReplyState) => void = () => undefined;
    const slow = new Promise<ReplyState>(resolve => {
      settle = resolve;
    });
    const base = globalThis.callieApi as unknown as { read: (operation: OperationName, input: unknown) => Promise<unknown>; command: unknown };
    globalThis.callieApi = {
      ...base,
      read: async (operation: OperationName, input: unknown) =>
        operation === 'replies.open' && (input as { messageId: string }).messageId === MESSAGE_ID ? await slow : await base.read(operation, input),
    } as unknown as OperationApi;
    const user = userEvent.setup();
    render(<Shell onReplies />);
    const rows = await screen.findAllByTestId('reply-open');
    await user.click(rows[1] as HTMLElement); // MESSAGE_ID: the slow one
    await user.click(rows[0] as HTMLElement); // OTHER: answers at once
    await waitFor(() => {
      expect(screen.getByTestId('card-firm').textContent).toBe(`Firm ${OTHER_MESSAGE_ID.slice(0, 2)}`);
    });
    settle(replyWire({ ...lane, open: lane.cards.find(card => card.messageId === MESSAGE_ID) ?? null }));
    await slow;
    await Promise.resolve();
    expect(screen.getByTestId('card-firm').textContent).toBe(`Firm ${OTHER_MESSAGE_ID.slice(0, 2)}`);
  });
});

describe('the counts (criterion 5)', () => {
  it('name their period, keep the unsure ones apart, and open the list they count', async () => {
    install(
      replyState({
        cards: [
          waiting(MESSAGE_ID, '2026-09-21T09:00:00.000Z'),
          waiting(OTHER_MESSAGE_ID, '2026-09-21T11:00:00.000Z', { proposedDisposition: null, proposedBy: 'none', confidence: null }),
        ],
      }),
    );
    render(<RepliesRoute column={column} />);
    const counts = await screen.findByTestId('reply-counts');
    expect(counts.textContent).toBe('Today:1 to answer(+1 with no suggestion)·2 in all');
    const user = userEvent.setup();
    await user.click(screen.getByTestId('count-unsure'));
    expect(screen.getAllByTestId('reply-summary')).toHaveLength(1);
    expect(screen.getByTestId('summary-line').textContent).toContain('Needs an answer');
    await user.click(screen.getByTestId('count-waiting'));
    expect(screen.getAllByTestId('reply-summary')).toHaveLength(1);
    expect(screen.getByTestId('summary-line').textContent).toContain('Callie suggests');
    await user.click(screen.getByTestId('count-waiting'));
    expect(screen.getAllByTestId('reply-summary')).toHaveLength(2);
  });
});

describe('the states', () => {
  it('says it could not read, with a retry, when the bridge fails', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('ipc')).mockResolvedValue(replyWire(replyState()));
    globalThis.callieApi = { read, command: read } as unknown as OperationApi;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<RepliesRoute column={column} />);
    await screen.findByTestId('reply-error');
    await userEvent.click(screen.getByTestId('reply-retry'));
    await screen.findByTestId('reply-list');
    expect(screen.queryByTestId('reply-error')).toBeNull();
  });

  it('shows the loading state before the first answer', () => {
    globalThis.callieApi = { read: () => new Promise(() => undefined), command: () => new Promise(() => undefined) } as unknown as OperationApi;
    render(<RepliesRoute column={column} />);
    expect(screen.getByTestId('reply-loading')).toBeTruthy();
  });

  it('says the lane is empty', async () => {
    install(replyState({ cards: [] }));
    render(<RepliesRoute column={column} />);
    expect((await screen.findByTestId('reply-empty')).textContent).toBe('No replies to read.');
  });
});
