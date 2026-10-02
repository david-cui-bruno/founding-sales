// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { JSX } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import { OutcomeForm } from '../src/renderer/today/OutcomeForm.tsx';
import type { TodayActions } from '../src/renderer/today/useToday.ts';
import { todayStateSchema, type TodayState } from '../src/renderer/todayContract.ts';
import { buildTodayView } from '../src/renderer/todayView.ts';

/**
 * The outcome form reset (X1F): the follow-up review's probes, made permanent.
 *
 *   * rule 1: "the call just placed" is resolved to a call, its session included, and the
 *     request names it; call B gets its own command, never call A's retry;
 *   * rule 2: every outcome draft is kept by firm and call, so call B never inherits call A's
 *     stop choice or fields;
 *   * rule 3: a recorded answer clears its own call's drafts by key and closes only its form.
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


describe('X1 follow-up independent probes', () => {
  it('a late A success preserves B edits even when B chose the same value', async () => {
    const h = outcomeActions();
    const bClosed = vi.fn();
    const drawn = render(<DraftsProvider>{form(h.actions, SESSION_A)}</DraftsProvider>);
    choose('outcome-select', 'no_answer');
    fireEvent.click(screen.getByTestId('outcome-submit'));
    drawn.rerender(<DraftsProvider>{form(h.actions, SESSION_B, bClosed)}</DraftsProvider>);
    // Explicit edits for B, ending with the same text value as A's sent outcome.
    choose('outcome-select', 'voicemail_left');
    choose('outcome-select', 'no_answer');
    choose('outcome-note', 'A new note for call B.');
    await h.answer(0, {recorded: true, reason: null});
    expect(bClosed).not.toHaveBeenCalled();
    expect((screen.getByTestId('outcome-note') as HTMLTextAreaElement).value).toBe('A new note for call B.');
    expect((screen.getByTestId('outcome-select') as HTMLSelectElement).value).toBe('no_answer');
  });

  function current(h: ReturnType<typeof outcomeActions>, session: string, route = ROUTE_ID): JSX.Element {
    const state = baseState();
    state.lastCall = {...state.lastCall!, routeId: route, e164: session === SESSION_A ? '+14015550187' : '+14015550188'};
    return <OutcomeForm state={state} view={buildTodayView(state)} enabled actions={h.actions} callSessionId={session} target={{kind:'current'}} />;
  }
  it('ordinary call B does not inherit call A stop choice', () => {
    const h = outcomeActions();
    const drawn = render(<DraftsProvider>{current(h, SESSION_A)}</DraftsProvider>);
    choose('outcome-select', 'do_not_call');
    choose('do-not-call-choice', 'firm_all');
    drawn.rerender(<DraftsProvider><p>closed</p></DraftsProvider>);
    drawn.rerender(<DraftsProvider>{current(h, SESSION_B, SESSION_B)}</DraftsProvider>);
    // Rule 2: B's outcome is B's own (the probe predates it and read A's shared outcome).
    expect((screen.getByTestId('outcome-select') as HTMLSelectElement).value).toBe('');
    choose('outcome-select', 'do_not_call');
    expect(stopChoice()).toBe('contact_phone');
  });
  it('ordinary call B gets a new command instead of retrying A', async () => {
    const h = outcomeActions();
    const drawn = render(<DraftsProvider>{current(h, SESSION_A)}</DraftsProvider>);
    choose('outcome-select', 'no_answer');
    fireEvent.click(screen.getByTestId('outcome-submit'));
    await h.answer(0, null);
    drawn.rerender(<DraftsProvider><p>closed</p></DraftsProvider>);
    drawn.rerender(<DraftsProvider>{current(h, SESSION_B, SESSION_B)}</DraftsProvider>);
    // B is not locked by A's unanswered command, and its fields are its own.
    expect(screen.queryByTestId('outcome-unanswered')).toBeNull();
    expect((screen.getByTestId('outcome-select') as HTMLSelectElement).disabled).toBe(false);
    choose('outcome-select', 'no_answer');
    fireEvent.click(screen.getByTestId('outcome-submit'));
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]!['callSessionId']).toBe(SESSION_B);
    expect(h.sent[0]!['callSessionId']).toBe(SESSION_A);
    expect(h.sent[1]!.commandId).not.toBe(h.sent[0]!.commandId);
    expect(h.sent[1]!['routeId']).toBe(SESSION_B);
  });
  it('a definite success retires the old id and the next Record mints a new one', async () => {
    const h = outcomeActions();
    render(<DraftsProvider>{form(h.actions, SESSION_A)}</DraftsProvider>);
    choose('outcome-select', 'no_answer');
    fireEvent.click(screen.getByTestId('outcome-submit'));
    await h.answer(0, {recorded:true, reason:null});
    choose('outcome-select', 'voicemail_left');
    fireEvent.click(screen.getByTestId('outcome-submit'));
    expect(h.sent[1]!.commandId).not.toBe(h.sent[0]!.commandId);
    expect(h.sent[1]!['outcome']).toBe('voicemail_left');
  });
  it('a pending outcome and late answer cannot touch a new sign-in epoch', async () => {
    const h = outcomeActions();
    const newClosed = vi.fn();
    const drawn = render(<DraftsProvider key="old">{form(h.actions, SESSION_A)}</DraftsProvider>);
    choose('outcome-select', 'no_answer');
    fireEvent.click(screen.getByTestId('outcome-submit'));
    drawn.rerender(<DraftsProvider key="new">{form(h.actions, SESSION_A, newClosed)}</DraftsProvider>);
    expect((screen.getByTestId('outcome-select') as HTMLSelectElement).disabled).toBe(false);
    choose('outcome-select', 'no_answer');
    await h.answer(0, {recorded:true, reason:null});
    expect(newClosed).not.toHaveBeenCalled();
    expect((screen.getByTestId('outcome-select') as HTMLSelectElement).value).toBe('no_answer');
    expect(screen.queryByTestId('outcome-unanswered')).toBeNull();
  });
});

describe('X1 additional entity and recovery boundaries', () => {
  it('a late answer neither clears nor closes a different firm form', async () => {
    const h = outcomeActions();
    const close = vi.fn();
    const b = {...baseState(), expanded:{...baseState().expanded!, firmId:SESSION_B}, lastCall:null};
    const drawn = render(<DraftsProvider>{form(h.actions, SESSION_A)}</DraftsProvider>);
    choose('outcome-select', 'no_answer');
    fireEvent.click(screen.getByTestId('outcome-submit'));
    drawn.rerender(<DraftsProvider><OutcomeForm state={b} view={buildTodayView(b)} enabled actions={h.actions} target={{kind:'session',callSessionId:SESSION_A}} onSubmitted={close}/></DraftsProvider>);
    choose('outcome-select', 'no_answer');
    await h.answer(0,{recorded:true,reason:null});
    expect(close).not.toHaveBeenCalled();
    expect((screen.getByTestId('outcome-select') as HTMLSelectElement).value).toBe('no_answer');
  });
  it('a lost answer survives remount and a definite retry refusal unlocks it without restart', async () => {
    const h = outcomeActions();
    const drawn = render(<DraftsProvider>{form(h.actions, SESSION_A)}</DraftsProvider>);
    choose('outcome-select', 'no_answer');
    fireEvent.click(screen.getByTestId('outcome-submit'));
    await h.answer(0,null);
    drawn.rerender(<DraftsProvider><p>closed</p></DraftsProvider>);
    drawn.rerender(<DraftsProvider>{form(h.actions, SESSION_A)}</DraftsProvider>);
    expect((screen.getByTestId('outcome-submit') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('outcome-submit'));
    expect(h.sent[1]).toEqual(h.sent[0]);
    await h.answer(1,{recorded:false,reason:'step_ineligible'});
    expect((screen.getByTestId('outcome-select') as HTMLSelectElement).disabled).toBe(false);
    expect(screen.queryByTestId('outcome-unanswered')).toBeNull();
    choose('outcome-select','voicemail_left');
    fireEvent.click(screen.getByTestId('outcome-submit'));
    expect(h.sent[2]!.commandId).not.toBe(h.sent[0]!.commandId);
  });
});
