// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { type JSX } from 'react';
import type { CallProposal } from '@fss/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisView } from '../src/shared/operations.ts';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import { AfterCallAnalysis, type AfterCallAnalysisProps, type ApplyCommand } from '../src/renderer/today/AfterCallAnalysis.tsx';
import { chosenOutcome, editsOf, outcomeChoices, startsTicked } from '../src/renderer/today/afterCallModel.ts';
import { analysisKey, useAnalyses } from '../src/renderer/today/useAnalysis.ts';
import { ANALYSIS_ID, HASH, OTHER_SESSION_ID, PROPOSALS, QUOTES, SESSION_ID, SHA, TASK_KEY, analysisAnswer } from './support/analysisAnswers.ts';

/**
 * Slice 3a, lane C — C-1: the after-call block. Every state of the analysis, the suggestions
 * together, any subset in one Apply with the three identifiers, David's tick as the safety
 * boundary, the checkbox rules, what each refusal says, no correction control here, and the
 * rule that a result for another session never reaches the open panel.
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

function install(handlers: Readonly<Record<string, (input: unknown) => unknown>> = {}): Call[] {
  const calls: Call[] = [];
  const answer = async (name: string, input: unknown): Promise<unknown> => {
    calls.push({ name, input });
    const handler = handlers[name];
    return await Promise.resolve(handler === undefined ? { applied: null, reason: 'offline', keyReasons: {} } : handler(input));
  };
  (globalThis as { callieApi?: unknown }).callieApi = { read: answer, command: answer };
  return calls;
}

const applied = (results: readonly { key: string; kind: string; result?: string }[], callLogId: string | null = '77777777-7777-4777-8777-7777777777aa') => ({
  applied: {
    analysisId: ANALYSIS_ID,
    callSessionId: SESSION_ID,
    callLogId,
    results: results.map(entry => ({ key: entry.key, kind: entry.kind, result: entry.result ?? 'applied', edited: false, id: null })),
    followUps: [],
  },
  reason: null,
  keyReasons: {},
});
const refused = (reason: string, keyReasons: Record<string, string> = {}) => ({ applied: null, reason, keyReasons });

function show(view: AnalysisView | undefined, extra: Partial<AfterCallAnalysisProps> = {}) {
  const props: AfterCallAnalysisProps = {
    view,
    sessionId: SESSION_ID,
    waiting: false,
    logged: false,
    templates: [{ id: '88888888-8888-4888-8888-8888888888bb', name: 'Overview v3' }],
    onReload: vi.fn(),
    onChanged: vi.fn(),
    onEnterManually: vi.fn(),
    ...extra,
  };
  const tree = (current: AfterCallAnalysisProps): JSX.Element => (
    <DraftsProvider>
      <AfterCallAnalysis {...current} />
    </DraftsProvider>
  );
  const result = render(tree(props));
  return { props, rerender: (next: Partial<AfterCallAnalysisProps>) => result.rerender(tree({ ...props, ...next })) };
}

const completed = (proposals: readonly CallProposal[] = [PROPOSALS.outcome, PROPOSALS.callback, PROPOSALS.followUp, PROPOSALS.buyingSignal, PROPOSALS.task]): AnalysisView => ({
  analysis: analysisAnswer({ proposals }),
  reason: null,
});
const check = (key: string): HTMLInputElement => screen.getByTestId(`suggestion-check-${key}`) as HTMLInputElement;

describe('the states of an analysis', () => {
  it('pending: says the notes are being written and that David can move on', () => {
    show({ analysis: analysisAnswer({ state: 'pending' }), reason: null });
    expect(screen.getByTestId('analysis-pending').textContent).toContain('You can move on to the next call');
    expect(screen.queryByTestId('suggestions')).toBeNull();
  });

  it('a call that just ended and has no analysis yet is waited for; an old one with none says nothing', () => {
    const { rerender } = show({ analysis: null, reason: 'not_found' }, { waiting: true });
    expect(screen.getByTestId('analysis-pending').getAttribute('data-phase')).toBe('waiting');
    rerender({ waiting: false });
    expect(screen.queryByTestId('analysis-pending')).toBeNull();
    expect(screen.queryByTestId('analysis-completed')).toBeNull();
  });

  it('failed: says so, retries through the retry operation, and offers to enter it by hand', async () => {
    const calls = install({ 'calling.analysisRetry': () => ({ analysis: analysisAnswer({ state: 'pending' }), reason: null }) });
    const { props } = show({ analysis: analysisAnswer({ state: 'failed' }), reason: null });
    expect(screen.getByTestId('analysis-failed')).toBeTruthy();
    fireEvent.click(screen.getByTestId('analysis-retry'));
    await waitFor(() => expect(props.onReload).toHaveBeenCalled());
    expect(calls.find(call => call.name === 'calling.analysisRetry')?.input).toEqual({ callSessionId: SESSION_ID, reason: 'retry' });
    fireEvent.click(screen.getByTestId('analysis-manual'));
    expect(props.onEnterManually).toHaveBeenCalled();
  });

  it('failed: a refused retry says why, beside the button', async () => {
    install({ 'calling.analysisRetry': () => ({ analysis: null, reason: 'analysis_in_flight' }) });
    show({ analysis: analysisAnswer({ state: 'failed' }), reason: null });
    fireEvent.click(screen.getByTestId('analysis-retry'));
    await waitFor(() => expect(screen.getByTestId('analysis-retry-problem').textContent).toBe('The notes are already being written.'));
  });

  it('completed: the notes, and every suggestion together in one block', () => {
    show(completed());
    expect(screen.getByTestId('analysis-summary-text').textContent).toContain('You reached Dana');
    expect(screen.getAllByTestId('suggestions')).toHaveLength(1);
    const block = screen.getByTestId('suggestions');
    for (const key of ['outcome', 'callback', 'follow_up', 'buying_signal', TASK_KEY]) expect(within(block).getByTestId(`suggestion-${key}`)).toBeTruthy();
    expect(screen.getAllByTestId('apply')).toHaveLength(1);
  });

  it('a review-mode proposal is never a row: it is counted and left to Needs review', () => {
    show(completed([PROPOSALS.outcome, PROPOSALS.correctedNumber, PROPOSALS.stopScope]));
    expect(screen.queryByTestId('suggestion-corrected_number')).toBeNull();
    expect(screen.queryByTestId('suggestion-stop_scope')).toBeNull();
    expect(screen.getByTestId('suggestions-review-count').textContent).toContain('2 more suggestions need review');
  });
});

describe('what starts ticked is David’s boundary', () => {
  it('only the outcome and the promises start ticked; stop, buying signal, e-mail and callback do not', () => {
    show(completed());
    expect(check('outcome').checked).toBe(true);
    expect(check(TASK_KEY).checked).toBe(true);
    for (const key of ['callback', 'follow_up', 'buying_signal']) expect(check(key).checked, key).toBe(false);
  });

  it('a stop starts unticked even though it is the outcome row', () => {
    expect(startsTicked(PROPOSALS.stopOutcome)).toBe(false);
    show(completed([PROPOSALS.stopOutcome]));
    expect(check('outcome').checked).toBe(false);
  });

  it('shows the full evidence line of each, beside it', () => {
    show(completed());
    expect(screen.getByTestId('suggestion-evidence-buying_signal').textContent).toBe(`They said: “${QUOTES.buying.quote}”`);
    expect(screen.getByTestId('suggestion-evidence-follow_up').textContent).toBe(`They said: “${QUOTES.followUp.quote}”`);
    expect(screen.getByTestId('suggestion-evidence-callback').textContent).toBe(`They said: “${QUOTES.callback.quote}”`);
    expect(screen.getByTestId(`suggestion-evidence-${TASK_KEY}`).textContent).toBe(`You said: “${QUOTES.task.quote}”`);
  });
});

describe('one Apply for the selected keys', () => {
  it('sends the ticked subset with the three identifiers and a command id, with no dialog, buying signal included', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    const calls = install({ 'calling.proposalsApply': () => applied([{ key: 'outcome', kind: 'outcome' }, { key: 'buying_signal', kind: 'buying_signal' }, { key: TASK_KEY, kind: 'task' }]) });
    const { props } = show(completed());
    fireEvent.click(check('buying_signal'));
    expect(check('buying_signal').checked).toBe(true);
    fireEvent.click(screen.getByTestId('apply'));
    await waitFor(() => expect(props.onChanged).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    const sent = calls.filter(call => call.name === 'calling.proposalsApply');
    expect(sent).toHaveLength(1);
    const body = sent[0]?.input as Record<string, unknown>;
    expect(body['keys']).toEqual(['outcome', 'buying_signal', TASK_KEY]);
    expect(body).toMatchObject({ analysisId: ANALYSIS_ID, transcriptSha256: SHA, proposalHash: HASH });
    expect(typeof body['commandId']).toBe('string');
    expect(body).not.toHaveProperty('edits');
    expect(screen.getByTestId('suggestion-note-buying_signal').textContent).toBe('Done');
  });

  it('carries David’s edits: a changed callback time, the e-mail he chose, the explicit "covers all contact"', async () => {
    const calls = install({ 'calling.proposalsApply': () => applied([{ key: 'outcome', kind: 'outcome' }]) });
    show(completed());
    fireEvent.click(check('callback'));
    fireEvent.change(screen.getByTestId('suggestion-callback-time'), { target: { value: '15:30' } });
    fireEvent.click(check('follow_up'));
    expect((screen.getByTestId('apply-problem') as HTMLElement).textContent).toBe('Choose the e-mail they agreed to receive.');
    fireEvent.change(screen.getByTestId('suggestion-template'), { target: { value: '88888888-8888-4888-8888-8888888888bb' } });
    fireEvent.click(screen.getByTestId('apply'));
    await waitFor(() => expect(calls.some(call => call.name === 'calling.proposalsApply')).toBe(true));
    const body = calls.find(call => call.name === 'calling.proposalsApply')?.input as { edits: Record<string, unknown> };
    expect(body.edits).toEqual({
      callback: { localDate: '2026-10-06', localTime: '15:30', sourceTimeZone: 'America/New_York' },
      follow_up: { templateVersionId: '88888888-8888-4888-8888-8888888888bb' },
    });
  });

  it('a stop sends doNotCallCoversAllContact only when David ticks that choice', async () => {
    const calls = install({ 'calling.proposalsApply': () => applied([{ key: 'outcome', kind: 'outcome' }]) });
    show(completed([PROPOSALS.stopOutcome]));
    fireEvent.click(check('outcome'));
    fireEvent.click(screen.getByTestId('apply'));
    await waitFor(() => expect(calls.some(call => call.name === 'calling.proposalsApply')).toBe(true));
    expect((calls.at(-1)?.input as Record<string, unknown>)['edits']).toBeUndefined();
    cleanup();
    const second = install({ 'calling.proposalsApply': () => applied([{ key: 'outcome', kind: 'outcome' }]) });
    show(completed([PROPOSALS.stopOutcome]));
    fireEvent.click(check('outcome'));
    fireEvent.click(screen.getByTestId('suggestion-covers-all'));
    fireEvent.click(screen.getByTestId('apply'));
    await waitFor(() => expect(second.some(call => call.name === 'calling.proposalsApply')).toBe(true));
    expect((second.at(-1)?.input as { edits: unknown }).edits).toEqual({ outcome: { doNotCallCoversAllContact: true } });
  });

  it('declines the suggestions that are not selected, only when David chooses to', async () => {
    const calls = install({ 'calling.proposalsDecline': () => ({ declined: true, reason: null }) });
    show(completed());
    expect(calls).toEqual([]);
    fireEvent.click(screen.getByTestId('decline-rest'));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.input).toEqual({ analysisId: ANALYSIS_ID, proposalHash: HASH, keys: ['callback', 'follow_up', 'buying_signal'] });
  });
});

describe('the checkbox rules', () => {
  it('a callback and an e-mail need the outcome in the same Apply: unticking it unticks and disables them', () => {
    show(completed());
    fireEvent.click(check('callback'));
    expect(check('callback').checked).toBe(true);
    fireEvent.click(check('outcome'));
    expect(check('callback').checked).toBe(false);
    expect(check('callback').disabled).toBe(true);
    expect(check('follow_up').disabled).toBe(true);
    expect(screen.getByTestId('suggestion-why-callback').textContent).toContain('needs the call logged');
  });

  it('once a log exists the outcome reads "Logged" and is not selectable, and a callback may stand alone', () => {
    show(completed(), { logged: true, loggedOutcome: 'interested' });
    expect(screen.getByTestId('suggestion-logged').textContent).toBe('Logged: Conversation');
    expect(screen.queryByTestId('suggestion-check-outcome')).toBeNull();
    expect(check('callback').disabled).toBe(false);
    expect(check('follow_up').disabled).toBe(false);
  });
});

describe('what the answers say', () => {
  const applyOnly = async (answer: unknown, extra: Partial<AfterCallAnalysisProps> = {}) => {
    install({ 'calling.proposalsApply': () => answer });
    const shown = show(completed(), extra);
    fireEvent.click(screen.getByTestId('apply'));
    return shown;
  };

  it.each(['stale_analysis', 'stale_proposal', 'call_already_logged'])('%s reloads, with one local sentence', async reason => {
    const { props } = await applyOnly(refused(reason));
    await waitFor(() => expect(props.onReload).toHaveBeenCalled());
    expect(screen.getByTestId('apply-note').textContent).toMatch(/Reloaded/u);
  });

  it('outcome_required is one sentence and reloads nothing', async () => {
    const { props } = await applyOnly(refused('outcome_required'));
    await waitFor(() => expect(screen.getByTestId('apply-note').textContent).toContain('Tick the outcome as well'));
    expect(props.onReload).not.toHaveBeenCalled();
  });

  it('callback_exists and follow_up_expired are shown on their rows, and nothing was applied', async () => {
    await applyOnly(refused('callback_exists', { callback: 'callback_exists' }));
    await waitFor(() => expect(screen.getByTestId('suggestion-note-callback').textContent).toBe('This call already has a callback.'));
    cleanup();
    await applyOnly(refused('follow_up_expired', { follow_up: 'follow_up_expired' }));
    await waitFor(() => expect(screen.getByTestId('suggestion-note-follow_up').textContent).toBe('Over 7 days: in Needs review.'));
  });

  it.each([
    ['callback_instant_mismatch', 'callback', 'do not agree'],
    ['callback_not_created', 'callback', 'could not be created'],
    ['effects_not_applied', 'outcome', 'nothing was written'],
    ['route_not_named', 'outcome', 'number is not known'],
  ])('%s is a per-row refusal: the row says why and every tick and draft stays', async (code, key, words) => {
    const { props } = await applyOnly(refused(code, { [key]: code }));
    await waitFor(() => expect(screen.getByTestId(`suggestion-note-${key}`).textContent).toContain(words));
    expect(check('outcome').checked).toBe(true);
    expect(props.onReload).not.toHaveBeenCalled();
    expect(screen.getByTestId('apply-note').textContent).toContain('Nothing was applied');
  });

  it('follow_up_not_granted names the e-mail row and reloads nothing; already_applied is a success on its row', async () => {
    const reloaded = await applyOnly(refused('follow_up_not_granted', { follow_up: 'follow_up_not_granted' }));
    await waitFor(() => expect(screen.getByTestId('suggestion-note-follow_up').textContent).toContain('can no longer be promised'));
    expect(reloaded.props.onReload).not.toHaveBeenCalled();
    expect(reloaded.props.onChanged).not.toHaveBeenCalled();
    cleanup();
    install({ 'calling.proposalsApply': () => applied([{ key: 'outcome', kind: 'outcome' }, { key: 'buying_signal', kind: 'buying_signal', result: 'already_applied' }]) });
    show(completed());
    fireEvent.click(check('buying_signal'));
    fireEvent.click(screen.getByTestId('apply'));
    await waitFor(() => expect(screen.getByTestId('suggestion-note-buying_signal').textContent).toBe('Already on the deal'));
    expect(screen.queryByTestId('apply-note')).toBeNull();
  });

  it('an atomic refusal keeps every tick and draft, names each refused key beside it, and leaves the batch unapplied', async () => {
    const calls = install({ 'calling.proposalsApply': () => refused('callback_exists', { callback: 'callback_exists', follow_up: 'follow_up_expired' }) });
    show(completed());
    fireEvent.click(check('callback'));
    fireEvent.change(screen.getByTestId('suggestion-callback-time'), { target: { value: '16:00' } });
    fireEvent.click(check('follow_up'));
    fireEvent.change(screen.getByTestId('suggestion-template'), { target: { value: '88888888-8888-4888-8888-8888888888bb' } });
    fireEvent.click(screen.getByTestId('apply'));
    await waitFor(() => expect(screen.getByTestId('suggestion-note-callback')).toBeTruthy());
    expect(screen.getByTestId('suggestion-note-callback').textContent).toBe('This call already has a callback.');
    expect(screen.getByTestId('suggestion-note-follow_up').textContent).toBe('Over 7 days: in Needs review.');
    expect(screen.getByTestId('apply-note').textContent).toContain('Nothing was applied');
    // Ticks and drafts are where they were; nothing is marked done.
    for (const key of ['outcome', 'callback', 'follow_up', TASK_KEY]) expect(check(key).checked, key).toBe(true);
    expect((screen.getByTestId('suggestion-callback-time') as HTMLInputElement).value).toBe('16:00');
    expect((screen.getByTestId('suggestion-template') as HTMLSelectElement).value).toBe('88888888-8888-4888-8888-8888888888bb');
    // Untick what was refused and the same Apply goes through.
    expect(calls.filter(call => call.name === 'calling.proposalsApply')).toHaveLength(1);
  });

  it('already_created and already_parked are successes shown on their row', async () => {
    install({
      'calling.proposalsApply': () => applied([{ key: TASK_KEY, kind: 'task', result: 'already_created' }, { key: 'outcome', kind: 'outcome' }]),
    });
    show(completed());
    fireEvent.click(screen.getByTestId('apply'));
    await waitFor(() => expect(screen.getByTestId(`suggestion-note-${TASK_KEY}`).textContent).toBe('Already a task for this call'));
    expect(screen.queryByTestId('apply-note')).toBeNull();
  });

  it('the same click is the same command: a retry after a lost answer reuses its id', async () => {
    const calls = install({ 'calling.proposalsApply': () => refused('offline') });
    show(completed());
    fireEvent.click(screen.getByTestId('apply'));
    await waitFor(() => expect(screen.getByTestId('apply-note')).toBeTruthy());
    fireEvent.click(screen.getByTestId('apply'));
    await waitFor(() => expect(calls.filter(call => call.name === 'calling.proposalsApply')).toHaveLength(2));
    const ids = calls.map(call => (call.input as { commandId: string }).commandId);
    expect(ids[0]).toBe(ids[1]);
  });
});

describe('no correction control', () => {
  it('the block has no phone, time zone or contact editor: corrections are Needs review’s', () => {
    show(completed([PROPOSALS.outcome, PROPOSALS.correctedNumber, PROPOSALS.zoneUnknown]));
    expect(screen.queryByTestId('basics-editor')).toBeNull();
    expect(screen.queryByTestId('basics-phone')).toBeNull();
    expect(screen.queryByText(/Correct the number/u)).toBeNull();
  });
});

describe('analyses are read by session', () => {
  function Panel({ sessionId, endedAt }: { readonly sessionId: string; readonly endedAt: number }): JSX.Element {
    const map = useAnalyses([
      { callSessionId: sessionId, endedAt },
      { callSessionId: OTHER_SESSION_ID, endedAt },
    ]);
    return (
      <DraftsProvider>
        <AfterCallAnalysis
          view={map.get(sessionId)}
          sessionId={sessionId}
          waiting={false}
          logged={false}
          templates={[]}
          onReload={vi.fn()}
          onChanged={vi.fn()}
          onEnterManually={vi.fn()}
        />
      </DraftsProvider>
    );
  }

  it('a result for a session that is not open never changes the open panel, and every key names its session', async () => {
    install({
      'calling.analysis': input => ((input as { callSessionId: string }).callSessionId === SESSION_ID ? { analysis: analysisAnswer(), reason: null } : { analysis: analysisAnswer({ state: 'pending' }), reason: null }),
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Panel sessionId={SESSION_ID} endedAt={Date.now()} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('analysis-completed')).toBeTruthy());
    const before = screen.getByTestId('analysis-completed').innerHTML;

    // The other call's analysis completes, with different notes and different suggestions.
    client.setQueryData(analysisKey(OTHER_SESSION_ID), {
      analysis: analysisAnswer({ summary: 'A different call entirely.', proposals: [PROPOSALS.stopOutcome] }),
      reason: null,
    });
    await Promise.resolve();
    expect(screen.getByTestId('analysis-completed').innerHTML).toBe(before);
    expect(screen.queryByText('A different call entirely.')).toBeNull();

    const keys = client.getQueryCache().findAll().map(query => query.queryKey);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key[0]).toBe('calling.analysis');
      expect([SESSION_ID, OTHER_SESSION_ID]).toContain(key[1]);
      expect(key).toHaveLength(2);
    }
  });
});

describe('every sensitive outcome starts unticked, with its evidence', () => {
  it.each(['do_not_call', 'wrong_number'] as const)('%s: unticked, its quote shown, nothing sent until David ticks it', async outcome => {
    const proposal = { ...PROPOSALS.outcome, reason: 'x', params: { outcome, evidence: PROPOSALS.outcome.params.evidence } } as unknown as CallProposal;
    expect(startsTicked(proposal)).toBe(false);
    const calls = install({ 'calling.proposalsApply': () => applied([{ key: 'outcome', kind: 'outcome' }]) });
    show(completed([proposal]));
    expect(check('outcome').checked).toBe(false);
    expect(screen.getByTestId('suggestion-evidence-outcome').textContent).toContain('Sure, tell me more');
    expect((screen.getByTestId('apply') as HTMLButtonElement).disabled).toBe(true);
    expect(calls.filter(call => call.name === 'calling.proposalsApply')).toHaveLength(0);
  });
});

describe('fix round (review S3C): the tick boundary, done keys, command ids', () => {
  const selectOptions = (): string[] => [...(screen.getByTestId('suggestion-outcome-select') as HTMLSelectElement).options].map(option => option.value);

  it('finding 1: the outcome editor never offers a stop or a wrong number the analysis did not propose', () => {
    show(completed());
    expect(selectOptions()).not.toContain('do_not_call');
    expect(selectOptions()).not.toContain('wrong_number');
    expect(selectOptions()).toContain('not_interested');
  });

  it('finding 1: a sensitive outcome can only be sent as the proposal’s own, ticked by David', async () => {
    const stop = PROPOSALS.stopOutcome as Extract<CallProposal, { kind: 'outcome' }>;
    const interested = PROPOSALS.outcome as Extract<CallProposal, { kind: 'outcome' }>;
    // However a draft got there, a sensitive outcome the proposal did not carry is ignored.
    expect(chosenOutcome(interested, { outcome: 'do_not_call' })).toBe('interested');
    expect(chosenOutcome(interested, { outcome: 'wrong_number' })).toBe('interested');
    expect(editsOf([interested], new Set(['outcome']), { outcome: 'do_not_call' })).toEqual({});
    expect(outcomeChoices(stop)).toContain('do_not_call');
    // The stop proposal starts unticked, so Apply has nothing until David ticks it.
    const calls = install({ 'calling.proposalsApply': () => applied([{ key: 'outcome', kind: 'outcome' }]) });
    show(completed([stop]));
    expect(check('outcome').checked).toBe(false);
    expect((screen.getByTestId('apply') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(check('outcome'));
    fireEvent.click(screen.getByTestId('apply'));
    await waitFor(() => expect(calls.filter(call => call.name === 'calling.proposalsApply')).toHaveLength(1));
    expect((calls[0]?.input as { keys: string[] }).keys).toEqual(['outcome']);
  });

  it('finding 2: applied keys become Done rows and a later Apply carries only the new tick', async () => {
    const calls = install({
      'calling.proposalsApply': input =>
        (input as { keys: string[] }).keys.includes('outcome')
          ? applied([{ key: 'outcome', kind: 'outcome' }, { key: 'callback', kind: 'callback' }, { key: TASK_KEY, kind: 'task' }])
          : applied([{ key: 'buying_signal', kind: 'buying_signal' }], null),
    });
    show(completed());
    fireEvent.click(check('callback'));
    fireEvent.click(screen.getByTestId('apply'));
    await waitFor(() => expect(screen.getByTestId('suggestion-note-callback').textContent).toBe('Done'));
    expect(check('callback').checked).toBe(false);
    expect(check('callback').disabled).toBe(true);
    expect(check(TASK_KEY).checked).toBe(false);
    fireEvent.click(check('buying_signal'));
    fireEvent.click(screen.getByTestId('apply'));
    await waitFor(() => expect(calls.filter(call => call.name === 'calling.proposalsApply')).toHaveLength(2));
    const sent = calls.filter(call => call.name === 'calling.proposalsApply').map(call => (call.input as { keys: string[] }).keys);
    expect(sent).toEqual([['outcome', 'callback', TASK_KEY], ['buying_signal']]);
  });

  it('finding 2: done keys survive leaving Today and coming back', async () => {
    install({ 'calling.proposalsApply': () => applied([{ key: 'outcome', kind: 'outcome' }, { key: TASK_KEY, kind: 'task' }]) });
    const onChanged = vi.fn();
    const props: AfterCallAnalysisProps = {
      view: completed(), sessionId: SESSION_ID, waiting: false, logged: false, templates: [], onReload: vi.fn(), onChanged, onEnterManually: vi.fn(),
    };
    const tree = (away: boolean): JSX.Element => (
      <DraftsProvider>{away ? <span data-testid="elsewhere" /> : <AfterCallAnalysis {...props} />}</DraftsProvider>
    );
    const { rerender } = render(tree(false));
    fireEvent.click(screen.getByTestId('apply'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    rerender(tree(true));
    expect(screen.queryByTestId('analysis-completed')).toBeNull();
    rerender(tree(false));
    expect(check(TASK_KEY).checked).toBe(false);
    expect(check(TASK_KEY).disabled).toBe(true);
    expect(screen.getByTestId(`suggestion-note-${TASK_KEY}`).textContent).toBe('Done');
  });

  it('S3CF-3: a lost answer is retried with the stored id and body, even after history marks the call logged and the panel was left', async () => {
    const commands = new Map<string, ApplyCommand>();
    const calls = install({ 'calling.proposalsApply': () => refused('offline') });
    const sent = (): { commandId: string; keys: string[] }[] => calls.filter(call => call.name === 'calling.proposalsApply').map(call => call.input as { commandId: string; keys: string[] });
    show(completed(), { commands });
    fireEvent.click(check('callback'));
    fireEvent.click(screen.getByTestId('apply'));
    await waitFor(() => expect(sent()).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId('apply').textContent).toBe('Retry'));
    expect(commands.get(SESSION_ID)?.id).toBe(sent()[0]?.commandId);
    cleanup();
    // The call is now logged (history says so): the outcome row would drop out of a fresh selection.
    show(completed(), { commands, logged: true });
    expect(screen.getByTestId('apply').textContent).toBe('Retry');
    fireEvent.click(screen.getByTestId('apply'));
    await waitFor(() => expect(sent()).toHaveLength(2));
    expect(sent()[1]).toEqual(sent()[0]);
    expect(sent()[1]?.keys).toEqual(['outcome', 'callback', TASK_KEY]);
  });

  it('S3CF-3: a definite answer deletes the stored command, and the next click is a new one', async () => {
    const commands = new Map<string, ApplyCommand>();
    let answer: unknown = refused('outcome_required');
    const calls = install({ 'calling.proposalsApply': () => answer });
    const ids = (): string[] => calls.filter(call => call.name === 'calling.proposalsApply').map(call => (call.input as { commandId: string }).commandId);
    show(completed(), { commands });
    fireEvent.click(screen.getByTestId('apply'));
    await waitFor(() => expect(screen.getByTestId('apply-note')).toBeTruthy());
    expect(commands.size).toBe(0);
    expect(screen.getByTestId('apply').textContent).toBe('Apply selected');
    fireEvent.click(screen.getByTestId('apply'));
    await waitFor(() => expect(ids()).toHaveLength(2));
    expect(ids()[1]).not.toBe(ids()[0]);
    answer = applied([{ key: 'outcome', kind: 'outcome' }, { key: TASK_KEY, kind: 'task' }]);
    fireEvent.click(screen.getByTestId('apply'));
    await waitFor(() => expect(commands.size).toBe(0));
    expect(ids()).toHaveLength(3);
    expect(ids()[2]).not.toBe(ids()[1]);
  });
});
