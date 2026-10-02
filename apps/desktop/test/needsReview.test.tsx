// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReviewItem } from '@fss/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import { ReviewGroup, ReviewPanel, itemLabel, type ReviewFirm } from '../src/renderer/today/ReviewItems.tsx';
import { TaskRow } from '../src/renderer/today/TaskRow.tsx';
import type { TodayActions } from '../src/renderer/today/useToday.ts';
import type { TodayState, TodayTask } from '../src/renderer/todayContract.ts';
import { buildTodayView } from '../src/renderer/todayView.ts';
import { ANALYSIS_ID, FIRM_ID, HASH, HOLD_ITEM, PROPOSALS, SESSION_ID, STAGE_ITEM, proposalItem } from './support/analysisAnswers.ts';

/**
 * Slice 3a, lane C — C-2: Needs review. Each inline correction opens in place with the right
 * focus, closes on a second click or Escape and keeps its draft; the firm stop is one confirm
 * and posts the firm scope only after it; Dismiss works for each source; a pending hold is
 * worded from what it is; a task is a card with Complete.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  (globalThis as { callieApi?: unknown }).callieApi = undefined;
});

interface Call {
  readonly name: string;
  readonly input: unknown;
}

function install(answers: Readonly<Record<string, unknown>> = {}): Call[] {
  const calls: Call[] = [];
  const answer = async (name: string, input: unknown): Promise<unknown> => {
    calls.push({ name, input });
    return await Promise.resolve(answers[name] ?? { ok: false });
  };
  (globalThis as { callieApi?: unknown }).callieApi = { read: answer, command: answer };
  return calls;
}

const firm = (overrides: Partial<ReviewFirm> = {}): ReviewFirm => ({
  firmId: FIRM_ID,
  values: { locality: 'Providence', regionCode: 'RI', timeZone: null },
  phone: { routeId: '99999999-9999-4999-8999-9999999999aa', e164: '+14015550187' },
  enabled: true,
  loggedSessions: new Set<string>(),
  ...overrides,
});

function panel(items: readonly ReviewItem[], overrides: Partial<ReviewFirm> = {}, extra: { onChanged?: () => void; onLog?: (callSessionId: string) => void } = {}) {
  const onChanged = extra.onChanged ?? vi.fn();
  const onLog = extra.onLog ?? vi.fn();
  render(
    <DraftsProvider>
      <ReviewPanel items={items} firm={firm(overrides)} onChanged={onChanged} onLog={onLog} />
    </DraftsProvider>,
  );
  return { onChanged, onLog };
}

describe('inline corrections open in place', () => {
  it('a corrected number opens the phone editor with the cursor in the phone field, beside the spoken number and Copy', () => {
    panel([proposalItem(PROPOSALS.correctedNumber)]);
    expect(screen.getByTestId('review-spoken-number').textContent).toBe('617 555 0199');
    expect(screen.getByTestId('review-copy')).toBeTruthy();
    expect(screen.queryByTestId('basics-editor')).toBeNull();
    fireEvent.click(screen.getByTestId('review-correct-phone'));
    expect(screen.getByTestId('basics-phone')).toBe(document.activeElement);
    // The draft starts from the current number, not the spoken one: the editor is unchanged.
    expect((screen.getByTestId('basics-phone') as HTMLInputElement).value).toBe('+14015550187');
  });

  it('an unknown callback time zone opens the editor with the cursor in the time zone field', () => {
    panel([proposalItem(PROPOSALS.zoneUnknown)]);
    fireEvent.click(screen.getByTestId('review-correct-zone'));
    expect(screen.getByTestId('basics-zone')).toBe(document.activeElement);
  });

  it('a second click closes it and keeps the draft; so does Escape', () => {
    panel([proposalItem(PROPOSALS.correctedNumber)]);
    const open = (): void => {
      fireEvent.click(screen.getByTestId('review-correct-phone'));
    };
    open();
    fireEvent.change(screen.getByTestId('basics-phone'), { target: { value: '6175550199' } });
    open();
    expect(screen.queryByTestId('basics-editor')).toBeNull();
    open();
    expect((screen.getByTestId('basics-phone') as HTMLInputElement).value).toBe('6175550199');
    fireEvent.keyDown(screen.getByTestId('basics-phone'), { key: 'Escape' });
    expect(screen.queryByTestId('basics-editor')).toBeNull();
    open();
    expect((screen.getByTestId('basics-phone') as HTMLInputElement).value).toBe('6175550199');
  });
});

describe('the firm stop', () => {
  it('after a log it is one inline confirm, and posts the firm scope only after it', async () => {
    const calls = install({ 'suppressions.firmStop': { stopped: true, reason: null } });
    const { onChanged } = panel([proposalItem(PROPOSALS.stopScope)], { loggedSessions: new Set([SESSION_ID]) });
    fireEvent.click(screen.getByTestId('review-stop'));
    expect(screen.getByTestId('review-stop-confirm')).toBeTruthy();
    expect(calls).toEqual([]);
    // A second click closes it and still posts nothing.
    fireEvent.click(screen.getByTestId('review-stop'));
    expect(screen.queryByTestId('review-stop-confirm')).toBeNull();
    fireEvent.click(screen.getByTestId('review-stop'));
    fireEvent.click(screen.getByTestId('review-stop-confirm-button'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls).toEqual([{ name: 'suppressions.firmStop', input: { firmId: FIRM_ID } }]);
  });

  it('with no log yet there is no stop button: the outcome Apply carries it', () => {
    panel([proposalItem(PROPOSALS.stopScope)]);
    expect(screen.queryByTestId('review-stop')).toBeNull();
    expect(screen.getByTestId('review-stop-unlogged').textContent).toContain('tick “Stop”');
  });

  it('a refused stop says so on the item and changes nothing', async () => {
    install({ 'suppressions.firmStop': { stopped: false, reason: 'not_assigned' } });
    const { onChanged } = panel([proposalItem(PROPOSALS.stopScope)], { loggedSessions: new Set([SESSION_ID]) });
    fireEvent.click(screen.getByTestId('review-stop'));
    fireEvent.click(screen.getByTestId('review-stop-confirm-button'));
    await waitFor(() => expect(screen.getByTestId('review-item-note').textContent).toContain('Nothing was changed'));
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('items that are information only', () => {
  it('a referral shows the name and role and no way to add them; stop-with-e-mail has facts, a quote and Dismiss only', () => {
    panel([proposalItem(PROPOSALS.referral), proposalItem(PROPOSALS.stopWithEmail)]);
    expect(screen.getByTestId('review-referral').textContent).toContain('Sam Placeholder, Operations');
    const items = screen.getAllByTestId('review-item');
    for (const item of items) {
      expect(within(item).queryByTestId('basics-editor')).toBeNull();
      expect(within(item).getAllByRole('button').map(button => button.textContent)).toEqual(['Dismiss']);
    }
  });
});

describe('Dismiss', () => {
  it('declines a review proposal by its analysis, hash and key', async () => {
    const calls = install({ 'calling.proposalsDecline': { declined: true, reason: null } });
    const { onChanged } = panel([proposalItem(PROPOSALS.referral)]);
    fireEvent.click(screen.getByTestId('review-item-dismiss'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls).toEqual([{ name: 'calling.proposalsDecline', input: { analysisId: ANALYSIS_ID, proposalHash: HASH, keys: ['referral_contact'] } }]);
  });

  it('releases a pending hold, and resolves a stage item by its id', async () => {
    const calls = install({ 'calling.pendingDismiss': { dismissed: true, reason: null }, 'review.stageResolve': { resolved: true, reason: null } });
    panel([HOLD_ITEM, STAGE_ITEM]);
    const [hold, stage] = screen.getAllByTestId('review-item');
    fireEvent.click(within(hold as HTMLElement).getByTestId('review-item-dismiss'));
    fireEvent.click(within(stage as HTMLElement).getByTestId('review-item-dismiss'));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls).toEqual([
      { name: 'calling.pendingDismiss', input: { callSessionId: SESSION_ID } },
      { name: 'review.stageResolve', input: { itemId: STAGE_ITEM.source === 'stage' ? STAGE_ITEM.itemId : '' } },
    ]);
  });

  it('a failed dismissal says so on the item and keeps it', async () => {
    install({ 'calling.proposalsDecline': { declined: false, reason: 'stale_proposal' } });
    const { onChanged } = panel([proposalItem(PROPOSALS.referral)]);
    fireEvent.click(screen.getByTestId('review-item-dismiss'));
    await waitFor(() => expect(screen.getByTestId('review-item-note')).toBeTruthy());
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByTestId('review-item')).toBeTruthy();
  });
});

describe('the pending hold', () => {
  it('is worded from what it is, never as paused calling, and offers Log or Dismiss', () => {
    const { onLog } = panel([HOLD_ITEM]);
    const text = screen.getByTestId('review-item').textContent ?? '';
    expect(screen.getByTestId('review-item-label').textContent).toBe('Waiting for this call’s notes');
    expect(text).toContain('Calling is not stopped');
    expect(text.toLowerCase()).not.toContain('paused');
    expect(within(screen.getByTestId('review-item')).getAllByRole('button').map(button => button.textContent)).toEqual(['Log', 'Dismiss']);
    fireEvent.click(screen.getByTestId('review-log'));
    expect(onLog).toHaveBeenCalledWith(SESSION_ID);
    expect(itemLabel(HOLD_ITEM)).toBe('Waiting for this call’s notes');
  });
});

describe('the Needs review group in the Queue', () => {
  const cards = [{ firmId: FIRM_ID, firmName: 'Elm Fork Test Rentals', lane: 'new_firm', dueAt: '2026-10-02T13:00:00.000Z', counts: { replies: 0, emailsDue: 0, callsDue: 0 } }] as const;

  it('lists each item as a row for its firm, opens the firm on a click, and dismisses on hover', async () => {
    const calls = install({ 'calling.pendingDismiss': { dismissed: true, reason: null } });
    const onSelect = vi.fn();
    const onChanged = vi.fn();
    render(<ReviewGroup items={[HOLD_ITEM, proposalItem(PROPOSALS.referral)]} cards={cards} selected={null} onSelect={onSelect} onChanged={onChanged} />);
    expect(screen.getByTestId('queue-group-count').textContent).toBe('2');
    expect(screen.getAllByTestId('review-firm').map(node => node.textContent)).toEqual(['Elm Fork Test Rentals', 'Elm Fork Test Rentals']);
    expect(screen.getAllByTestId('review-label').map(node => node.textContent)).toEqual(['Waiting for this call’s notes', 'Referred to someone']);
    fireEvent.click(screen.getAllByTestId('review-row')[0] as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith(FIRM_ID);
    fireEvent.click(screen.getAllByTestId('review-dismiss')[0] as HTMLElement);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(calls[0]?.name).toBe('calling.pendingDismiss');
  });

  it('draws nothing when there is nothing to review, so it never takes room from the queue', () => {
    render(<ReviewGroup items={[]} cards={cards} selected={null} onSelect={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.queryByTestId('queue-group')).toBeNull();
  });
});

describe('a task is a quiet card with Complete', () => {
  const state = { snapshotDate: '2026-10-02', businessTimeZone: 'America/New_York' } as unknown as TodayState;
  const task = (overrides: Partial<TodayTask> = {}): TodayTask => ({
    itemId: '12121212-1212-4121-8121-121212121212',
    contactId: null,
    contactName: null,
    kind: 'task',
    lane: 'due_work',
    dueAt: '2026-10-02T18:00:00.000Z',
    status: 'open',
    automated: false,
    snoozeUntil: null,
    callTaskId: '13131313-1313-4131-8131-131313131313',
    taskText: 'Send the pricing sheet',
    ...overrides,
  });
  const entry = (value: TodayTask) => ({ ...buildTodayView({ ...state, cards: [], expanded: null, online: true, stale: false, notice: null, mayMutate: true } as unknown as TodayState), task: value, label: 'Task', delayLabel: 'Snooze', enabled: true, paused: false, needsTime: false, callable: false });

  it('shows its own words and Complete, and completing sends the call task id', () => {
    const completeTask = vi.fn();
    const actions = { busy: () => false, completeTask } as unknown as TodayActions;
    render(
      <DraftsProvider>
        <ul>
          <TaskRow entry={entry(task()) as never} state={state} actionsEnabled actions={actions} />
        </ul>
      </DraftsProvider>,
    );
    expect(screen.getByTestId('task-text').textContent).toBe('Send the pricing sheet');
    expect(screen.queryByTestId('snooze-form')).toBeNull();
    fireEvent.click(screen.getByTestId('task-complete'));
    expect(completeTask).toHaveBeenCalledWith({ taskId: '13131313-1313-4131-8131-131313131313' });
  });
});

describe('B’s contract: review items name their firm', () => {
  it('the row reads the item’s own firmName, even for a firm that is not on today’s list', () => {
    render(<ReviewGroup items={[{ ...HOLD_ITEM, firmName: 'Maple Court Test Lettings' } as ReviewItem]} cards={[]} selected={null} onSelect={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.getByTestId('review-firm').textContent).toBe('Maple Court Test Lettings');
  });
});

describe('fix round (review S3C)', () => {
  it('finding 4: an unclear outcome logs its own call, by session', () => {
    const OLD = '99999999-9999-4999-8999-9999999999cc';
    const { onLog } = panel([proposalItem(PROPOSALS.outcomeUnclear, { callSessionId: OLD })]);
    fireEvent.click(screen.getByTestId('review-set-outcome'));
    expect(onLog).toHaveBeenCalledWith(OLD);
  });

  it('finding 9: a logged call the analysis says was a wrong number opens the phone editor inline', () => {
    const wrong = { ...PROPOSALS.outcome, params: { outcome: 'wrong_number', evidence: PROPOSALS.outcome.params.evidence } } as unknown as Parameters<typeof proposalItem>[0];
    panel([proposalItem(wrong, { reviewKind: 'outcome' })]);
    expect(screen.queryByTestId('basics-editor')).toBeNull();
    fireEvent.click(screen.getByTestId('review-correct-phone'));
    expect(screen.getByTestId('basics-phone')).toBe(document.activeElement);
  });

  it('minor: only the clicked row is current, not every row of the selected firm', () => {
    const cards = [{ firmId: FIRM_ID, firmName: 'Elm Fork Test Rentals', lane: 'new_firm', dueAt: '2026-10-02T13:00:00.000Z', counts: { replies: 0, emailsDue: 0, callsDue: 0 } }] as const;
    render(<ReviewGroup items={[HOLD_ITEM, proposalItem(PROPOSALS.referral)]} cards={cards} selected={FIRM_ID} onSelect={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.getAllByTestId('review-row').map(row => row.getAttribute('aria-current'))).toEqual([null, null]);
    fireEvent.click(screen.getAllByTestId('review-row')[1] as HTMLElement);
    expect(screen.getAllByTestId('review-row').map(row => row.getAttribute('aria-current'))).toEqual([null, 'true']);
  });
});
