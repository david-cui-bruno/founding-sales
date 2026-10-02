// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { JSX } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import { OutcomeForm } from '../src/renderer/today/OutcomeForm.tsx';
import { ReviewPanel } from '../src/renderer/today/ReviewItems.tsx';
import type { TodayActions } from '../src/renderer/today/useToday.ts';
import { todayStateSchema, type TodayState } from '../src/renderer/todayContract.ts';
import { buildTodayView } from '../src/renderer/todayView.ts';
import { PROPOSALS, SESSION_ID, proposalItem } from './support/analysisAnswers.ts';

/**
 * Kept-state rules K1, K3, K5 and K6 for the stops (the X1 code review's three desktop
 * findings; its probes, made permanent).
 *
 *   * K5/K6: an outcome is cleared, and its form closed, on a definite success only. A refusal
 *     or a lost answer keeps the editor, the stop choice and every field; a retry after a lost
 *     answer resends the stored request under the same command id.
 *   * K1: the stop choice belongs to the call the form records, never to the firm alone.
 *   * K3: a Needs review stop's command and answer live in the shell, by item; a late success
 *     closes only the editor that sent it.
 */

afterEach(() => {
  cleanup();
  globalThis.callieApi = undefined;
});

const FIRM_ID = '11111111-1111-4111-8111-111111111111';
const ROUTE_ID = '44444444-4444-4444-8444-444444444444';
const CONTACT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SESSION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function baseState(): TodayState {
  return todayStateSchema.parse({
    snapshotDate: '2026-10-02',
    businessTimeZone: 'America/New_York',
    cards: [
      {
        firmId: FIRM_ID,
        firmName: 'Northwind Test Holdings',
        lane: 'due_work',
        dueAt: '2026-10-02T13:00:00.000Z',
        counts: { replies: 0, emailsDue: 0, callsDue: 1 },
      },
    ],
    expanded: {
      firmId: FIRM_ID,
      firmName: 'Northwind Test Holdings',
      snapshotDate: '2026-10-02',
      lane: 'due_work',
      counts: { replies: 0, emailsDue: 0, callsDue: 1 },
      tasks: [],
      routes: [{ routeId: ROUTE_ID, contactId: CONTACT_ID, e164: '+14015550187', version: 1, eligibility: 'usable' }],
      callingIdentityId: null,
    },
    online: true,
    stale: false,
    asOf: '2026-10-02T13:00:00.000Z',
    mayMutate: true,
    role: 'salesperson',
    notice: null,
    handoffNotice: 'Once a call is handed to the phone app, Callie cannot recall it.',
    dialAdvice: [],
    lastCall: { firmId: FIRM_ID, routeId: ROUTE_ID, contactId: CONTACT_ID, e164: '+14015550187' },
    followUpTemplates: [],
    followUpSequences: [],
  });
}

type Sent = Record<string, unknown> & { readonly commandId: string };

/** The outcome form's actions, each answer resolved by the test. */
function outcomeActions(): {
  readonly actions: TodayActions;
  readonly sent: Sent[];
  answer(index: number, outcomeAnswer: { recorded: boolean; reason: string | null } | null): Promise<void>;
} {
  const sent: Sent[] = [];
  const pending: ((state: TodayState | null) => void)[] = [];
  const actions = {
    busy: () => false,
    previewFollowUp: vi.fn(),
    recordOutcome: (input: Sent) => {
      sent.push(input);
      return new Promise<TodayState | null>(resolve => pending.push(resolve));
    },
  } as unknown as TodayActions;
  return {
    actions,
    sent,
    answer: async (index, outcomeAnswer) => {
      await act(async () => {
        pending[index]?.(outcomeAnswer === null ? null : { ...baseState(), outcomeAnswer: { commandId: sent[index]!.commandId, ...outcomeAnswer } });
        await Promise.resolve();
      });
    },
  };
}

const choose = (testId: string, value: string): void => {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
};
const stopChoice = (): string => (screen.getByTestId('do-not-call-choice') as HTMLSelectElement).value;

function form(actions: TodayActions, sessionId?: string, onSubmitted?: () => void): JSX.Element {
  const state = baseState();
  return (
    <OutcomeForm
      state={state}
      view={buildTodayView(state)}
      enabled
      actions={actions}
      {...(sessionId === undefined ? {} : { target: { kind: 'session' as const, callSessionId: sessionId } })}
      {...(onSubmitted === undefined ? {} : { onSubmitted })}
    />
  );
}

describe('K5/K6: an outcome is cleared on a definite success and on nothing else', () => {
  it('keeps the wider stop while no answer has arrived (the reviewer’s probe)', () => {
    const actions = { busy: () => false, recordOutcome: vi.fn(), previewFollowUp: vi.fn() } as unknown as TodayActions;
    render(<DraftsProvider>{form(actions)}</DraftsProvider>);
    choose('outcome-select', 'do_not_call');
    choose('do-not-call-choice', 'firm_all');
    fireEvent.click(screen.getByTestId('outcome-submit'));
    expect(screen.queryByTestId('do-not-call-choice')).not.toBeNull();
    expect(stopChoice()).toBe('firm_all');
  });

  it('a refusal keeps the editor, the stop choice and every field, and the next Record is a new command', async () => {
    const harness = outcomeActions();
    const submitted = vi.fn();
    render(<DraftsProvider>{form(harness.actions, SESSION_A, submitted)}</DraftsProvider>);
    choose('outcome-select', 'do_not_call');
    choose('do-not-call-choice', 'firm_all');
    fireEvent.change(screen.getByTestId('outcome-note'), { target: { value: 'Asked us to stop.' } });
    fireEvent.click(screen.getByTestId('outcome-submit'));
    await harness.answer(0, { recorded: false, reason: 'step_ineligible' });
    expect(submitted).not.toHaveBeenCalled();
    expect((screen.getByTestId('outcome-select') as HTMLSelectElement).value).toBe('do_not_call');
    expect(stopChoice()).toBe('firm_all');
    expect((screen.getByTestId('outcome-note') as HTMLTextAreaElement).value).toBe('Asked us to stop.');
    // A refusal is definite: nothing was recorded, the fields are David's again, and the next
    // Record is a new command built from them.
    expect(screen.queryByTestId('outcome-unanswered')).toBeNull();
    expect((screen.getByTestId('do-not-call-choice') as HTMLSelectElement).disabled).toBe(false);
    choose('do-not-call-choice', 'contact_all');
    fireEvent.click(screen.getByTestId('outcome-submit'));
    expect(harness.sent).toHaveLength(2);
    expect(harness.sent[1]!.commandId).not.toBe(harness.sent[0]!.commandId);
    expect(harness.sent[1]!['doNotCall']).toEqual({ scope: 'contact', channel: 'all' });
  });

  it('a lost answer keeps everything, and Record again resends exactly the stored request under its id', async () => {
    const harness = outcomeActions();
    const submitted = vi.fn();
    render(<DraftsProvider>{form(harness.actions, SESSION_A, submitted)}</DraftsProvider>);
    choose('outcome-select', 'do_not_call');
    choose('do-not-call-choice', 'firm_all');
    fireEvent.click(screen.getByTestId('outcome-submit'));
    // Offline is not an answer: nobody knows whether the call was recorded.
    await harness.answer(0, { recorded: false, reason: 'offline' });
    expect(submitted).not.toHaveBeenCalled();
    expect(stopChoice()).toBe('firm_all');
    expect(screen.getByTestId('outcome-unanswered').textContent).toContain('never recorded twice');
    expect(screen.getByTestId('outcome-submit').textContent).toBe('Record again');
    fireEvent.click(screen.getByTestId('outcome-submit'));
    // No answer at all (an IPC fault) is lost too.
    await harness.answer(1, null);
    expect(harness.sent[1]).toEqual(harness.sent[0]);
    fireEvent.click(screen.getByTestId('outcome-submit'));
    expect(harness.sent[2]).toEqual(harness.sent[0]);
    expect(harness.sent[0]).toMatchObject({ callSessionId: SESSION_A, outcome: 'do_not_call', doNotCall: { scope: 'firm', channel: 'all' } });
    // The retry is answered: now, and only now, the draft goes and the form closes.
    await harness.answer(2, { recorded: true, reason: null });
    expect(submitted).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('outcome-unanswered')).toBeNull();
    expect((screen.getByTestId('outcome-select') as HTMLSelectElement).value).toBe('');
  });

  it('a late success closes no form opened since, and keeps what was typed after it was sent', async () => {
    const harness = outcomeActions();
    const closedA = vi.fn();
    const closedB = vi.fn();
    const drawn = render(<DraftsProvider>{form(harness.actions, SESSION_A, closedA)}</DraftsProvider>);
    choose('outcome-select', 'do_not_call');
    choose('do-not-call-choice', 'firm_all');
    fireEvent.click(screen.getByTestId('outcome-submit'));
    // David opens session B's form before A's answer lands, and records something else there.
    drawn.rerender(<DraftsProvider>{form(harness.actions, SESSION_B, closedB)}</DraftsProvider>);
    choose('outcome-select', 'no_answer');
    await harness.answer(0, { recorded: true, reason: null });
    expect(closedA).not.toHaveBeenCalled();
    expect(closedB).not.toHaveBeenCalled();
    expect((screen.getByTestId('outcome-select') as HTMLSelectElement).value).toBe('no_answer');
    // A's own stop choice was sent and recorded, so it is gone: A starts from the default.
    drawn.rerender(<DraftsProvider>{form(harness.actions, SESSION_A, closedA)}</DraftsProvider>);
    choose('outcome-select', 'do_not_call');
    expect(stopChoice()).toBe('contact_phone');
    expect(screen.queryByTestId('outcome-unanswered')).toBeNull();
  });

  it('a success closes the form for its call even after a remount', async () => {
    const harness = outcomeActions();
    const first = vi.fn();
    const second = vi.fn();
    const drawn = render(<DraftsProvider>{form(harness.actions, SESSION_A, first)}</DraftsProvider>);
    choose('outcome-select', 'no_answer');
    fireEvent.click(screen.getByTestId('outcome-submit'));
    drawn.rerender(
      <DraftsProvider>
        <p>elsewhere</p>
      </DraftsProvider>,
    );
    drawn.rerender(<DraftsProvider>{form(harness.actions, SESSION_A, second)}</DraftsProvider>);
    // While the command is on the wire with no answer, the fields are as sent and locked.
    expect((screen.getByTestId('outcome-select') as HTMLSelectElement).disabled).toBe(true);
    await harness.answer(0, { recorded: true, reason: null });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('K1: the stop choice belongs to the call the form records', () => {
  it('does not carry a stop choice from one call into another at the same firm (the reviewer’s probe)', () => {
    const actions = { busy: () => false, recordOutcome: vi.fn(), previewFollowUp: vi.fn() } as unknown as TodayActions;
    const drawn = render(<DraftsProvider>{form(actions, SESSION_A)}</DraftsProvider>);
    choose('outcome-select', 'do_not_call');
    choose('do-not-call-choice', 'firm_all');
    drawn.rerender(<DraftsProvider>{form(actions, SESSION_B)}</DraftsProvider>);
    choose('outcome-select', 'do_not_call');
    expect(stopChoice()).toBe('contact_phone');
    // …and coming back to session A finds A's choice.
    drawn.rerender(<DraftsProvider>{form(actions, SESSION_A)}</DraftsProvider>);
    expect(stopChoice()).toBe('firm_all');
  });
});

describe('K3: a Needs review stop’s command and answer live in the shell, by item', () => {
  const item = proposalItem(PROPOSALS.stopScope);
  const panel = (): JSX.Element => (
    <ReviewPanel
      items={[item]}
      firm={{ firmId: item.firmId!, values: { locality: 'Providence', regionCode: 'RI', timeZone: null }, phone: null, enabled: true, loggedSessions: new Set([SESSION_ID]) }}
      onChanged={() => {}}
      onLog={() => {}}
    />
  );
  const answering = (): { finish(value: unknown): void } => {
    let finish!: (value: unknown) => void;
    globalThis.callieApi = { command: () => new Promise(resolve => (finish = resolve)) } as unknown as typeof globalThis.callieApi;
    return { finish: value => finish(value) };
  };

  it('a late phone-stop success does not close the all-contact editor opened meanwhile (the reviewer’s probe)', async () => {
    const wire = answering();
    render(<DraftsProvider>{panel()}</DraftsProvider>);
    fireEvent.click(screen.getByTestId('review-stop-calls'));
    fireEvent.click(screen.getByTestId('review-stop-calls-confirm-button'));
    fireEvent.click(screen.getByTestId('review-stop'));
    expect(screen.getByTestId('review-stop-confirm')).toBeTruthy();
    await act(async () => wire.finish({ stopped: true, reason: null }));
    expect(screen.queryByTestId('review-stop-confirm')).not.toBeNull();
    expect(screen.getByTestId('review-item-note').textContent).toBe('Stopped: nobody at this firm will be called.');
  });

  it('a late success leaves the same editor alone when David closed and reopened it since', async () => {
    const wire = answering();
    render(<DraftsProvider>{panel()}</DraftsProvider>);
    fireEvent.click(screen.getByTestId('review-stop-calls'));
    fireEvent.click(screen.getByTestId('review-stop-calls-confirm-button'));
    fireEvent.click(screen.getByTestId('review-stop-calls'));
    fireEvent.click(screen.getByTestId('review-stop-calls'));
    expect(screen.getByTestId('review-stop-calls-confirm')).toBeTruthy();
    await act(async () => wire.finish({ stopped: true, reason: null }));
    expect(screen.queryByTestId('review-stop-calls-confirm')).not.toBeNull();
  });

  it('a success nobody touched since closes the editor that sent it', async () => {
    const wire = answering();
    render(<DraftsProvider>{panel()}</DraftsProvider>);
    fireEvent.click(screen.getByTestId('review-stop-calls'));
    fireEvent.click(screen.getByTestId('review-stop-calls-confirm-button'));
    await act(async () => wire.finish({ stopped: true, reason: null }));
    expect(screen.queryByTestId('review-stop-calls-confirm')).toBeNull();
  });

  it('a phone-stop refusal is retained for its item after navigation and remount (the reviewer’s probe)', async () => {
    const wire = answering();
    const drawn = render(<DraftsProvider>{panel()}</DraftsProvider>);
    fireEvent.click(screen.getByTestId('review-stop-calls'));
    fireEvent.click(screen.getByTestId('review-stop-calls-confirm-button'));
    drawn.rerender(
      <DraftsProvider>
        <p>another firm</p>
      </DraftsProvider>,
    );
    await act(async () => wire.finish({ stopped: false, reason: 'journal_unavailable' }));
    drawn.rerender(<DraftsProvider>{panel()}</DraftsProvider>);
    expect(screen.queryByText('Could not record the stop. Nothing was changed.')).not.toBeNull();
  });

  it('the next session starts clean: an answer kept for one person is not shown to the next', async () => {
    const wire = answering();
    const drawn = render(<DraftsProvider key="one">{panel()}</DraftsProvider>);
    fireEvent.click(screen.getByTestId('review-stop-calls'));
    fireEvent.click(screen.getByTestId('review-stop-calls-confirm-button'));
    await act(async () => wire.finish({ stopped: false, reason: 'journal_unavailable' }));
    expect(screen.queryByText('Could not record the stop. Nothing was changed.')).not.toBeNull();
    drawn.rerender(<DraftsProvider key="two">{panel()}</DraftsProvider>);
    expect(screen.queryByText('Could not record the stop. Nothing was changed.')).toBeNull();
  });
});
