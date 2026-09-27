// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RepliesRoute } from '../src/renderer/replies/RepliesRoute.tsx';
import type { OperationApi, OperationName } from '../src/shared/operations.ts';
import type { ReplyState } from '../src/renderer/replyContract.ts';
import { MESSAGE_ID, replyCard, replyState, replyWire } from './e2e/support/replyFixtures.ts';
import { replyConfirmationAnswer } from './support/replyAnswers.ts';

/**
 * The Replies view as a React component (specification 8.3, 12.4).
 *
 * Three things the end-to-end specs cannot state as plainly, because they are about the
 * *shape* of the page rather than about what a person sees:
 *
 *   * ⚠ D5.1's first guard — there is no `<form>` on the card and Confirm is a
 *     `type="button"`. The end-to-end spec presses Enter and Space and asserts nothing
 *     is sent; this asserts there is nothing there that could have sent it, which is what
 *     stops the guard being re-broken by somebody wrapping the choices in a form later.
 *   * the content is not cached: unmounting the view leaves no reply body anywhere, and
 *     an answer that arrives after it was left draws nothing.
 *   * offline is a banner where the list would be, never a card from an earlier read.
 */

const BODY = 'Tuesday works. Send an invite.';

const state = (overrides: Partial<ReplyState> = {}): ReplyState => ({
  ...replyWire(replyState({ open: replyCard() })),
  ...overrides,
});

type Scripted = Readonly<Partial<Record<OperationName, (input: unknown) => Promise<ReplyState>>>>;

/** D4's two functions, scripted: the operation is the whole vocabulary. */
function install(scripted: Scripted, answer: ReplyState = state()): void {
  const answerOne = async (operation: OperationName, input: unknown): Promise<unknown> =>
    await (scripted[operation]?.(input) ?? Promise.resolve(answer));
  globalThis.callieApi = {
    read: answerOne,
    command: answerOne,
  } as unknown as OperationApi;
}

afterEach(() => {
  cleanup();
  globalThis.callieApi = undefined;
});

const column = { current: null };

describe('the Replies view', () => {
  it('⚠ D5.1: has no form on the card, and Confirm is a plain button', async () => {
    install({});
    const { container } = render(<RepliesRoute column={column} />);

    await screen.findByTestId('reply-card');
    // No form to submit means no keystroke anywhere can confirm: `replyPage.ts` had
    // Confirm as a form's submit until 1.0.11, so Enter from any field sent it.
    expect(container.querySelectorAll('form')).toHaveLength(0);
    const confirm = screen.getByTestId('confirm');
    expect(confirm.tagName).toBe('BUTTON');
    expect(confirm.getAttribute('type')).toBe('button');
    // And the guess is already the answer, marked as a guess beside the choice.
    expect((screen.getByTestId('choice-interested') as HTMLInputElement).checked).toBe(true);
    expect(screen.getAllByTestId('suggested-hint')).toHaveLength(1);
    expect(confirm.textContent).toBe('Stop automated sending and take this firm over');
  });

  it('confirms on the button and on nothing else', async () => {
    const confirm = vi.fn(async (_input: unknown) => await Promise.resolve(state({ open: null, notice: 'confirmed' })));
    install({ 'replies.confirm': confirm });
    render(<RepliesRoute column={column} />);
    await screen.findByTestId('reply-card');

    const user = userEvent.setup();
    await user.click(screen.getByTestId('note'));
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(confirm).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('confirm'));
    await waitFor(() => {
      expect(confirm).toHaveBeenCalledTimes(1);
    });
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({ messageId: MESSAGE_ID, disposition: 'interested' });
  });

  it('keeps no reply body once the view is left, and draws nothing for an answer that arrives after', async () => {
    let settle: (value: ReplyState) => void = () => undefined;
    const slow = new Promise<ReplyState>(resolve => {
      settle = resolve;
    });
    install({ 'replies.refresh': async () => await slow });
    const view = render(<RepliesRoute column={column} />);
    expect((await screen.findByTestId('card-body')).textContent).toBe(BODY);

    // A read in flight when the person leaves the view.
    await userEvent.click(screen.getByTestId('refresh'));
    view.unmount();
    expect(document.body.textContent).not.toContain(BODY);
    // The answer to a read this view no longer wants: nothing is drawn, and nothing
    // throws. `useReplies` bumps a generation on unmount for exactly this.
    settle(state());
    await slow;
    expect(document.body.textContent).not.toContain(BODY);
  });

  it('shows the offline banner where the list would be, and no body at all', async () => {
    install({}, state({ online: false, cards: [], open: null }));
    render(<RepliesRoute column={column} />);

    expect((await screen.findByTestId('banner-warning')).textContent).toBe('Callie cannot reach the server.');
    expect(screen.getByTestId('reply-empty').textContent).toBe(
      'Callie cannot reach the server. Replies are never kept on this Mac.',
    );
    expect(screen.queryByTestId('card-body')).toBeNull();
    expect(document.body.textContent).not.toContain(BODY);
  });

  it('records what a confirmation did, and never that the guess was reviewed', async () => {
    install({}, state({ open: replyCard({ confirmation: replyConfirmationAnswer({ corrected: false }) }) }));
    render(<RepliesRoute column={column} />);
    await screen.findByTestId('reply-card');
    const text = document.body.textContent ?? '';
    for (const word of ['reviewed', 'you reviewed', 'checked by']) expect(text.toLowerCase()).not.toContain(word);
  });
});
