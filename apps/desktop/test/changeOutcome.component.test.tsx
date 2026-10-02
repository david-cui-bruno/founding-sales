// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallCorrectionEffect, CallOutcome, CorrectCallOutcomeResult, CorrectionPreviewResponse } from '@fss/contracts';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import { ChangeOutcome, type CorrectionPorts } from '../src/renderer/calling/ChangeOutcome.tsx';
import { resetCorrectionMemory } from '../src/renderer/calling/correctionMemory.ts';
import { correctionBody } from '../src/renderer/calling/correctionModel.ts';
import type { CorrectedView, CorrectionPreviewView, OperationApi, OperationInput } from '../src/shared/operations.ts';

/**
 * "Change outcome" (S3X lane X2, X2-7 and the kept-state rules K1–K7). Written before the
 * entry points: the toggle rule, nothing preselected, the collapsed line, the reason exactly
 * when §3.7 needs it, Keep stop / Lift stop… and the separate lift confirm, Retry resending
 * the stored body, the reload on `effects_changed`, remount, sign-out, a late answer, and the
 * navigation keys. No real firm or person appears.
 */

const LOG_ID = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
const OTHER_LOG_ID = '1e1e1e1e-1e1e-4e1e-8e1e-1e1e1e1e1e1e';
const ANALYSIS_ID = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';
const CALLBACK_ID = 'cbcbcbcb-cbcb-4cbc-8cbc-cbcbcbcbcbcb';
const STOP_ID = 'stop-event-0001';

const callbackEffect = (over: Partial<CallCorrectionEffect> = {}): CallCorrectionEffect => ({
  kind: 'callback',
  id: CALLBACK_ID,
  state: 'open',
  conflicts: true,
  decisions: ['keep', 'undo'],
  appliedKey: { analysisId: ANALYSIS_ID, key: 'callback' },
  facts: { dueAt: '2030-01-09T19:00:00.000Z' },
  ...over,
});
const stopEffect: CallCorrectionEffect = {
  kind: 'stop',
  id: STOP_ID,
  state: 'effective',
  conflicts: true,
  decisions: ['keep', 'lift'],
  appliedKey: null,
  facts: { scope: 'handle', channel: 'phone', canonicalKey: '+14015550187' },
};
const historyEffect: CallCorrectionEffect = {
  kind: 'history',
  id: `history:${LOG_ID}`,
  state: 'done',
  conflicts: false,
  decisions: [],
  appliedKey: null,
  facts: { manualOrEnded: true },
};

function previewOf(over: Partial<CorrectionPreviewResponse> = {}): CorrectionPreviewResponse {
  return {
    callLogId: LOG_ID,
    currentOutcome: 'interested',
    originalOutcome: 'interested',
    corrections: [],
    outcomeAppliedKey: null,
    effects: [callbackEffect(), historyEffect],
    callbackTimeRequired: false,
    alsoHappens: [],
    ...over,
  };
}

const result = (over: Partial<CorrectCallOutcomeResult> = {}): CorrectCallOutcomeResult => ({
  callLogId: LOG_ID,
  outcome: 'no_answer',
  revision: 1,
  applied: { suppressionEventIds: [], retiredRouteId: null, callbackId: null, parkHoldId: null, reopenedTodayItemId: null },
  liftNext: [],
  suggestedStageKey: null,
  ...over,
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}
function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

interface Fake extends CorrectionPorts {
  readonly previews: OperationInput<'calling.correctionPreview'>[];
  readonly corrections: OperationInput<'calling.correctOutcome'>[];
  readonly lifts: OperationInput<'suppressions.supersede'>[];
  previewAnswer: (input: OperationInput<'calling.correctionPreview'>) => Promise<CorrectionPreviewView>;
  correctAnswer: () => Promise<CorrectedView>;
  liftAnswer: () => Promise<{ lifted: boolean; reason: string | null }>;
}

function fake(preview: CorrectionPreviewResponse = previewOf()): Fake {
  const ports: Fake = {
    previews: [],
    corrections: [],
    lifts: [],
    previewAnswer: async () => await Promise.resolve({ preview, reason: null }),
    correctAnswer: async () => await Promise.resolve({ corrected: result(), reason: null }),
    liftAnswer: async () => await Promise.resolve({ lifted: true, reason: null }),
    async preview(input) {
      ports.previews.push(input);
      return await ports.previewAnswer(input);
    },
    async correct(input) {
      ports.corrections.push(input);
      return await ports.correctAnswer();
    },
    async supersede(input) {
      ports.lifts.push(input);
      return await ports.liftAnswer();
    },
  };
  return ports;
}

function Subject({
  ports,
  outcome = 'interested',
  onChanged = () => undefined,
  logId = LOG_ID,
}: {
  readonly ports: CorrectionPorts;
  readonly outcome?: CallOutcome;
  readonly onChanged?: () => void;
  readonly logId?: string;
}): JSX.Element {
  return <ChangeOutcome callLogId={logId} currentOutcome={outcome} timeZone="America/New_York" onChanged={onChanged} ports={ports} />;
}

/** The shell: one drafts provider for the session; `session` changes as a sign-out does. */
function Shell({ session, children }: { readonly session: string; readonly children: JSX.Element }): JSX.Element {
  return <DraftsProvider key={session}>{children}</DraftsProvider>;
}

beforeEach(() => {
  resetCorrectionMemory();
});
afterEach(() => {
  cleanup();
  globalThis.callieApi = undefined;
});

async function openAndChoose(outcome: CallOutcome = 'no_answer'): Promise<void> {
  fireEvent.click(screen.getByTestId('change-outcome-toggle'));
  fireEvent.change(screen.getByTestId('change-outcome-select'), { target: { value: outcome } });
  await screen.findByTestId('change-outcome-conflicts');
}

const checked = (): string[] =>
  screen.queryAllByRole('radio').filter(button => button.getAttribute('aria-checked') === 'true').map(button => button.textContent ?? '');

describe('X2-7: the compact review', () => {
  it('nothing is preselected; Save waits for every decision; unaffected effects are one collapsed line', async () => {
    const ports = fake(previewOf({ alsoHappens: ['cadence_checked'] }));
    render(<Shell session="a"><Subject ports={ports} /></Shell>);
    await openAndChoose();
    expect(checked()).toEqual([]);
    expect((screen.getByTestId('change-outcome-save') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('change-outcome-problem').textContent).toBe('Choose what happens to each item above.');
    const collapsed = screen.getByTestId('change-outcome-collapsed');
    expect(within(collapsed).getByText(/1 other thing stays as it is/u)).toBeTruthy();
    expect(within(collapsed).getAllByTestId('change-outcome-also').map(line => line.textContent)).toEqual([
      'Also happens: The firm is paused if this was its last allowed try.',
    ]);
    fireEvent.click(screen.getByTestId('change-outcome-decide-keep'));
    expect((screen.getByTestId('change-outcome-save') as HTMLButtonElement).disabled).toBe(false);
  });

  it('the reason appears exactly when §3.7 needs it, and toggles with the Undo choice', async () => {
    const ports = fake();
    render(<Shell session="a"><Subject ports={ports} /></Shell>);
    await openAndChoose();
    expect(screen.queryByTestId('change-outcome-reason')).toBeNull();
    fireEvent.click(screen.getByTestId('change-outcome-decide-undo'));
    expect(screen.getByTestId('change-outcome-reason')).toBeTruthy();
    expect(screen.getByTestId('change-outcome-problem').textContent).toBe('Say why the outcome changed.');
    fireEvent.click(screen.getByTestId('change-outcome-decide-keep'));
    expect(screen.queryByTestId('change-outcome-reason')).toBeNull();
    fireEvent.click(screen.getByTestId('change-outcome-decide-undo'));
    fireEvent.click(screen.getByTestId('change-outcome-reason-new_information'));
    fireEvent.click(screen.getByTestId('change-outcome-save'));
    await waitFor(() => expect(ports.corrections).toHaveLength(1));
    expect(ports.corrections[0]).toMatchObject({
      callLogId: LOG_ID,
      expectedOutcome: 'interested',
      outcome: 'no_answer',
      reason: 'new_information',
      effects: [{ kind: 'callback', id: CALLBACK_ID, state: 'open', decision: 'undo' }],
    });
  });

  it('an applied outcome always asks for the reason', async () => {
    render(<Shell session="a"><Subject ports={fake(previewOf({ outcomeAppliedKey: { analysisId: ANALYSIS_ID, key: 'outcome' } }))} /></Shell>);
    await openAndChoose();
    expect(screen.getByTestId('change-outcome-reason')).toBeTruthy();
  });

  it('C0: a second click or Escape closes the review and keeps the draft', async () => {
    render(<Shell session="a"><Subject ports={fake()} /></Shell>);
    await openAndChoose();
    fireEvent.click(screen.getByTestId('change-outcome-decide-keep'));
    fireEvent.click(screen.getByTestId('change-outcome-toggle'));
    expect(screen.queryByTestId('change-outcome-review')).toBeNull();
    fireEvent.click(screen.getByTestId('change-outcome-toggle'));
    await screen.findByTestId('change-outcome-conflicts');
    expect((screen.getByTestId('change-outcome-select') as HTMLSelectElement).value).toBe('no_answer');
    expect(checked()).toEqual(['Keep it']);
    fireEvent.keyDown(screen.getByTestId('change-outcome-select'), { key: 'Escape' });
    expect(screen.queryByTestId('change-outcome-review')).toBeNull();
  });

  it('Keep stop / Lift stop…; the lift is its own confirm after the save; cancelling it leaves the stop and lifts nothing', async () => {
    const ports = fake(previewOf({ currentOutcome: 'do_not_call', effects: [stopEffect] }));
    ports.correctAnswer = async () => await Promise.resolve({ corrected: result({ outcome: 'interested', liftNext: [{ eventId: STOP_ID, scope: 'handle', channel: 'phone' }] }), reason: null });
    render(<Shell session="a"><Subject ports={ports} outcome="do_not_call" /></Shell>);
    await openAndChoose('interested');
    expect(screen.getAllByTestId(/change-outcome-decide-/u).map(button => button.textContent)).toEqual(['Keep stop', 'Lift stop…']);
    fireEvent.click(screen.getByTestId('change-outcome-decide-lift'));
    expect(screen.queryByTestId('lift-confirm')).toBeNull();
    fireEvent.click(screen.getByTestId('change-outcome-save'));
    const confirm = await screen.findByTestId('lift-confirm');
    expect(confirm.textContent).toContain('Lift the do-not-call stop on +14015550187? It will no longer block calls.');
    expect(ports.lifts).toEqual([]);
    fireEvent.click(screen.getByTestId('lift-confirm-no'));
    expect(screen.queryByTestId('lift-confirm')).toBeNull();
    expect(screen.getByTestId('change-outcome-note').textContent).toBe('The stop stays.');
    expect(ports.lifts).toEqual([]);
  });

  it('K5/K6: a refused lift keeps its confirm with the reason; its own success consumes it', async () => {
    const ports = fake(previewOf({ currentOutcome: 'do_not_call', effects: [stopEffect] }));
    ports.correctAnswer = async () => await Promise.resolve({ corrected: result({ outcome: 'interested', liftNext: [{ eventId: STOP_ID, scope: 'handle', channel: 'phone' }] }), reason: null });
    const changed = vi.fn();
    render(<Shell session="a"><Subject ports={ports} outcome="do_not_call" onChanged={changed} /></Shell>);
    await openAndChoose('interested');
    fireEvent.click(screen.getByTestId('change-outcome-decide-lift'));
    fireEvent.click(screen.getByTestId('change-outcome-save'));
    await screen.findByTestId('lift-confirm');
    ports.liftAnswer = async () => await Promise.resolve({ lifted: false, reason: 'admin_only' });
    fireEvent.click(screen.getByTestId('lift-confirm-yes'));
    expect((await screen.findByTestId('lift-note')).textContent).toBe('Only an administrator can lift a stop. It stays.');
    expect(screen.getByTestId('lift-confirm')).toBeTruthy();
    ports.liftAnswer = async () => await Promise.resolve({ lifted: true, reason: null });
    fireEvent.click(screen.getByTestId('lift-confirm-yes'));
    await waitFor(() => expect(screen.queryByTestId('lift-confirm')).toBeNull());
    expect(ports.lifts.map(lift => lift.eventId)).toEqual([STOP_ID, STOP_ID]);
    // A refusal was a definite answer: the second lift is a new command.
    expect(ports.lifts[0]?.commandId).not.toBe(ports.lifts[1]?.commandId);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('Retry after a lost answer resends the stored body under the same id', async () => {
    const ports = fake();
    ports.correctAnswer = async () => await Promise.resolve({ corrected: null, reason: 'offline' });
    render(<Shell session="a"><Subject ports={ports} /></Shell>);
    await openAndChoose();
    fireEvent.click(screen.getByTestId('change-outcome-decide-keep'));
    fireEvent.click(screen.getByTestId('change-outcome-save'));
    expect((await screen.findByTestId('change-outcome-note')).textContent).toBe('The answer was lost. Retry sends the same request again.');
    expect(screen.getByTestId('change-outcome-save').textContent).toBe('Retry');
    expect((screen.getByTestId('change-outcome-select') as HTMLSelectElement).disabled).toBe(true);
    ports.correctAnswer = async () => await Promise.resolve({ corrected: result(), reason: null });
    fireEvent.click(screen.getByTestId('change-outcome-save'));
    await waitFor(() => expect(ports.corrections).toHaveLength(2));
    expect(ports.corrections[1]).toEqual(ports.corrections[0]);
    expect((await screen.findByTestId('change-outcome-note')).textContent).toBe('Changed to No answer.');
  });

  it('effects_changed: reloaded, the chosen outcome stays, the decisions are cleared', async () => {
    const ports = fake();
    ports.correctAnswer = async () => await Promise.resolve({ corrected: null, reason: 'effects_changed' });
    const changed = vi.fn();
    render(<Shell session="a"><Subject ports={ports} onChanged={changed} /></Shell>);
    await openAndChoose();
    fireEvent.click(screen.getByTestId('change-outcome-decide-keep'));
    fireEvent.click(screen.getByTestId('change-outcome-save'));
    expect((await screen.findByTestId('change-outcome-note')).textContent).toBe('This call changed since you opened it. Reloaded.');
    await waitFor(() => expect(ports.previews).toHaveLength(2));
    await screen.findByTestId('change-outcome-conflicts');
    expect((screen.getByTestId('change-outcome-select') as HTMLSelectElement).value).toBe('no_answer');
    expect(checked()).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(1);
  });
});

describe('kept state', () => {
  it('K3 (remount): an answer that lands after the control unmounted is shown when it mounts again', async () => {
    const ports = fake();
    const answer = deferred<CorrectedView>();
    ports.correctAnswer = async () => await answer.promise;
    const changed = vi.fn();
    const { rerender } = render(<Shell session="a"><Subject ports={ports} onChanged={changed} /></Shell>);
    await openAndChoose();
    fireEvent.click(screen.getByTestId('change-outcome-decide-keep'));
    fireEvent.click(screen.getByTestId('change-outcome-save'));
    rerender(<Shell session="a"><div /></Shell>);
    await act(async () => {
      answer.resolve({ corrected: result(), reason: null });
      await answer.promise;
    });
    expect(changed).toHaveBeenCalledTimes(1);
    rerender(<Shell session="a"><Subject ports={ports} outcome="no_answer" /></Shell>);
    expect(screen.getByTestId('change-outcome-note').textContent).toBe('Changed to No answer.');
    expect(screen.queryByTestId('change-outcome-review')).toBeNull();
  });

  it('K3 (late answer): a late refusal updates only the feedback and never reopens a review David closed', async () => {
    const ports = fake();
    const answer = deferred<CorrectedView>();
    ports.correctAnswer = async () => await answer.promise;
    render(<Shell session="a"><Subject ports={ports} /></Shell>);
    await openAndChoose();
    fireEvent.click(screen.getByTestId('change-outcome-decide-keep'));
    fireEvent.click(screen.getByTestId('change-outcome-save'));
    fireEvent.click(screen.getByTestId('change-outcome-toggle'));
    expect(screen.queryByTestId('change-outcome-review')).toBeNull();
    await act(async () => {
      answer.resolve({ corrected: null, reason: 'not_call_actor' });
      await answer.promise;
    });
    expect(screen.getByTestId('change-outcome-note').textContent).toBe('Only the person who made the call can change its outcome.');
    expect(screen.queryByTestId('change-outcome-review')).toBeNull();
  });

  it('K3: two logs keep their own commands and answers', async () => {
    const ports = fake();
    const first = deferred<CorrectedView>();
    ports.correctAnswer = async () => await first.promise;
    render(
      <Shell session="a">
        <div>
          <div data-testid="one"><Subject ports={ports} /></div>
          <div data-testid="two"><Subject ports={ports} logId={OTHER_LOG_ID} /></div>
        </div>
      </Shell>,
    );
    const one = within(screen.getByTestId('one'));
    fireEvent.click(one.getByTestId('change-outcome-toggle'));
    fireEvent.change(one.getByTestId('change-outcome-select'), { target: { value: 'no_answer' } });
    fireEvent.click(await one.findByTestId('change-outcome-decide-keep'));
    fireEvent.click(one.getByTestId('change-outcome-save'));
    const two = within(screen.getByTestId('two'));
    expect(two.queryByTestId('change-outcome-note')).toBeNull();
    expect(two.getByTestId('change-outcome-toggle')).toBeTruthy();
    await act(async () => {
      first.resolve({ corrected: null, reason: 'effects_changed' });
      await first.promise;
    });
    expect(one.getByTestId('change-outcome-note').textContent).toBe('This call changed since you opened it. Reloaded.');
    expect(two.queryByTestId('change-outcome-note')).toBeNull();
  });

  it('K1: a sign-out empties the draft, the open review and the pending command', async () => {
    const ports = fake();
    ports.correctAnswer = async () => await Promise.resolve({ corrected: null, reason: 'offline' });
    const { rerender } = render(<Shell session="a"><Subject ports={ports} /></Shell>);
    await openAndChoose();
    fireEvent.click(screen.getByTestId('change-outcome-decide-keep'));
    fireEvent.click(screen.getByTestId('change-outcome-save'));
    await screen.findByTestId('change-outcome-note');
    rerender(<Shell session="b"><Subject ports={ports} /></Shell>);
    expect(screen.queryByTestId('change-outcome-review')).toBeNull();
    expect(screen.queryByTestId('change-outcome-note')).toBeNull();
    fireEvent.click(screen.getByTestId('change-outcome-toggle'));
    expect((screen.getByTestId('change-outcome-select') as HTMLSelectElement).value).toBe('');
    expect(screen.getByTestId('change-outcome-save').textContent).toBe('Save');
  });

  it('K2: a draft based on an outcome that changed elsewhere is dropped, and says so', async () => {
    const ports = fake();
    const { rerender } = render(<Shell session="a"><Subject ports={ports} /></Shell>);
    await openAndChoose();
    fireEvent.click(screen.getByTestId('change-outcome-decide-keep'));
    rerender(<Shell session="a"><Subject ports={ports} outcome="busy" /></Shell>);
    expect(await screen.findByTestId('change-outcome-changed-elsewhere')).toBeTruthy();
    expect((screen.getByTestId('change-outcome-select') as HTMLSelectElement).value).toBe('');
    expect(ports.corrections).toEqual([]);
  });

  it('K4: J then Enter while Save has focus sends nothing', async () => {
    const ports = fake();
    render(<Shell session="a"><Subject ports={ports} /></Shell>);
    await openAndChoose();
    fireEvent.click(screen.getByTestId('change-outcome-decide-keep'));
    const user = userEvent.setup();
    screen.getByTestId('change-outcome-save').focus();
    await user.keyboard('j{Enter}');
    expect(ports.corrections).toEqual([]);
    expect(document.activeElement?.getAttribute('data-testid')).not.toBe('change-outcome-save');
  });

  it('K7: a preview answer for an outcome no longer chosen is dropped', async () => {
    const ports = fake();
    const slow = deferred<CorrectionPreviewView>();
    ports.previewAnswer = async input =>
      input.outcome === 'busy' ? await slow.promise : await Promise.resolve({ preview: previewOf({ effects: [historyEffect] }), reason: null });
    render(<Shell session="a"><Subject ports={ports} /></Shell>);
    fireEvent.click(screen.getByTestId('change-outcome-toggle'));
    fireEvent.change(screen.getByTestId('change-outcome-select'), { target: { value: 'busy' } });
    fireEvent.change(screen.getByTestId('change-outcome-select'), { target: { value: 'no_answer' } });
    await screen.findByTestId('change-outcome-collapsed');
    await act(async () => {
      slow.resolve({ preview: previewOf(), reason: null });
      await slow.promise;
    });
    expect(screen.queryByTestId('change-outcome-conflicts')).toBeNull();
    expect((screen.getByTestId('change-outcome-save') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('review of X2 (findings 2 and 3)', () => {
  it('K2: a preview reporting another current outcome drops the edit, says so and reloads; nothing is sent over it', async () => {
    // History shows Conversation; another correction moved the call to Callback requested.
    const ports = fake(previewOf({ currentOutcome: 'callback_requested', effects: [historyEffect] }));
    const changed = vi.fn();
    const { rerender } = render(<Shell session="a"><Subject ports={ports} onChanged={changed} /></Shell>);
    fireEvent.click(screen.getByTestId('change-outcome-toggle'));
    fireEvent.change(screen.getByTestId('change-outcome-select'), { target: { value: 'no_answer' } });
    expect((await screen.findByTestId('change-outcome-changed-elsewhere')).textContent).toContain('The outcome is now Callback requested.');
    expect((screen.getByTestId('change-outcome-select') as HTMLSelectElement).value).toBe('');
    expect((screen.getByTestId('change-outcome-save') as HTMLButtonElement).disabled).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('change-outcome-save'));
    expect(ports.corrections).toEqual([]);
    // The history read again: the new outcome is the one David now sees, and Save sends it.
    rerender(<Shell session="a"><Subject ports={ports} outcome="callback_requested" onChanged={changed} /></Shell>);
    fireEvent.change(screen.getByTestId('change-outcome-select'), { target: { value: 'no_answer' } });
    await screen.findByTestId('change-outcome-collapsed');
    fireEvent.click(screen.getByTestId('change-outcome-save'));
    await waitFor(() => expect(ports.corrections).toHaveLength(1));
    expect(ports.corrections[0]).toMatchObject({ expectedOutcome: 'callback_requested', outcome: 'no_answer' });
  });

  it('K2: the base is the outcome shown when Change opened; a history re-read before the choice drops it', async () => {
    const ports = fake(previewOf({ currentOutcome: 'busy', effects: [historyEffect] }));
    const { rerender } = render(<Shell session="a"><Subject ports={ports} /></Shell>);
    fireEvent.click(screen.getByTestId('change-outcome-toggle'));
    rerender(<Shell session="a"><Subject ports={ports} outcome="busy" /></Shell>);
    expect((await screen.findByTestId('change-outcome-changed-elsewhere')).textContent).toContain('The outcome is now Busy.');
    expect(ports.previews).toEqual([]);
  });

  it('stale_outcome: the edit is dropped as "Changed elsewhere" once the new outcome is read, never re-sent on the new base', async () => {
    const ports = fake(previewOf({ effects: [historyEffect] }));
    ports.correctAnswer = async () => await Promise.resolve({ corrected: null, reason: 'stale_outcome' });
    const changed = vi.fn();
    const { rerender } = render(<Shell session="a"><Subject ports={ports} onChanged={changed} /></Shell>);
    fireEvent.click(screen.getByTestId('change-outcome-toggle'));
    fireEvent.change(screen.getByTestId('change-outcome-select'), { target: { value: 'no_answer' } });
    await screen.findByTestId('change-outcome-collapsed');
    ports.previewAnswer = async () => await Promise.resolve({ preview: previewOf({ currentOutcome: 'busy', effects: [historyEffect] }), reason: null });
    fireEvent.click(screen.getByTestId('change-outcome-save'));
    expect((await screen.findByTestId('change-outcome-changed-elsewhere')).textContent).toContain('The outcome is now Busy.');
    rerender(<Shell session="a"><Subject ports={ports} outcome="busy" onChanged={changed} /></Shell>);
    expect((screen.getByTestId('change-outcome-select') as HTMLSelectElement).value).toBe('');
    expect((screen.getByTestId('change-outcome-save') as HTMLButtonElement).disabled).toBe(true);
    expect(ports.corrections).toHaveLength(1);
    expect(ports.corrections[0]?.expectedOutcome).toBe('interested');
  });

  it('the body carries the base David saw as expectedOutcome, and none when the review is based elsewhere', () => {
    const draft = { outcome: 'no_answer' as const, doNotCall: 'contact_phone' as const, callbackDate: '', callbackTime: '', reason: null, decisions: {} };
    const review = previewOf({ effects: [historyEffect] });
    expect(correctionBody({ callLogId: LOG_ID, preview: review, draft, base: 'interested', timeZone: null, commandId: 'c' })?.expectedOutcome).toBe('interested');
    expect(correctionBody({ callLogId: LOG_ID, preview: previewOf({ currentOutcome: 'callback_requested', effects: [historyEffect] }), draft, base: 'interested', timeZone: null, commandId: 'c' })).toBeNull();
  });

  it('the registry-backed default ports ask exactly one preview per selection', async () => {
    // Bounded: past five requests the answer never comes, so a loop cannot spin the test forever.
    const read = vi.fn(async (_operation: string, _input: OperationInput<'calling.correctionPreview'>) => {
      return read.mock.calls.length <= 5 ? await Promise.resolve({ preview: previewOf({ effects: [historyEffect] }), reason: null }) : await new Promise(() => undefined);
    });
    globalThis.callieApi = { read, command: vi.fn() } as unknown as OperationApi;
    render(<Shell session="a"><ChangeOutcome callLogId={LOG_ID} currentOutcome="interested" timeZone="America/New_York" onChanged={() => undefined} /></Shell>);
    fireEvent.click(screen.getByTestId('change-outcome-toggle'));
    fireEvent.change(screen.getByTestId('change-outcome-select'), { target: { value: 'no_answer' } });
    await screen.findByTestId('change-outcome-collapsed');
    for (let turn = 0; turn < 10; turn += 1) await act(async () => await new Promise(resolve => setTimeout(resolve, 0)));
    expect(read.mock.calls.map(call => [call[0], call[1].outcome])).toEqual([['calling.correctionPreview', 'no_answer']]);
    fireEvent.change(screen.getByTestId('change-outcome-select'), { target: { value: 'busy' } });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    for (let turn = 0; turn < 10; turn += 1) await act(async () => await new Promise(resolve => setTimeout(resolve, 0)));
    expect(read.mock.calls.map(call => call[1].outcome)).toEqual(['no_answer', 'busy']);
  });
});
