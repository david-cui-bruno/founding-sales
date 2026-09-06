// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MutationReceipt } from '../../../shared/contracts/commonContract';
import type { LeadDetail } from '../../../shared/contracts/leadDetailContract';
import type { TodaySnapshot } from '../../../shared/contracts/todayContract';
import { CallOutcomeSection, type CallOutcomeApi } from './CallOutcomeSection';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const detail = {
  outboundAttempts: [],
  personId: 'person-kevin',
  salesCycleId: 'cycle-kevin',
  personName: 'Kevin Shin',
} as LeadDetail;

const receipt: MutationReceipt = {
  revision: 1,
  affectedPersonIds: ['person-kevin'],
  affectedSalesCycleIds: ['cycle-kevin'],
};

const snapshotWithNext = (nextPersonId: string | null): TodaySnapshot => ({
  lanes: [
    {
      id: 'p1',
      items:
        nextPersonId === null
          ? []
          : [
            {
              id: 'cycle-next',
              lane: 'p1',
              personId: nextPersonId,
              salesCycleId: 'cycle-next',
              personName: 'Next Person',
              contextLabel: null,
              stage: 'ready',
              priorityContext: null,
              action: { id: 'a', type: 'call_lead', channel: 'call', label: 'Call lead' },
              reason: 'ready_p1',
              activeTriggers: [],
              verifyFirst: false,
              pinned: false,
              consentRequirement: null,
              cloudScores: null,
            },
          ],
      overflowCount: 0,
    },
  ],
  dialBudget: 40,
  scheduledDials: 1,
  conversationTarget: 5,
  reviewErrorCount: 0,
  unreviewedBacklogCount: 0,
  unreviewedCloudSignalCount: 0,
  conversationsHeld: 0,
  revision: 1,
});

const fakeApi = (nextPersonId: string | null): CallOutcomeApi => ({
  logCallOutcome: vi.fn(async () => receipt),
  addLeadNote: vi.fn(async () => receipt),
  get: vi.fn(async () => snapshotWithNext(nextPersonId)),
});

describe('CallOutcomeSection', () => {
  it('renders the six outcome chips and disables Save until one is picked', () => {
    const api = fakeApi(null);
    render(<CallOutcomeSection detail={detail} api={api} onSaved={vi.fn()} />);

    for (const label of [
      'No answer', 'Voicemail', 'Spoke', 'Interview booked', 'Not interested', 'Opted out',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    expect(
      (screen.getByRole('button', { name: 'Save & next' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'No answer' }));
    expect(
      (screen.getByRole('button', { name: 'Save & next' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('saves the outcome with a callback date and hands over the next lead', async () => {
    const api = fakeApi('person-next');
    const onSaved = vi.fn();
    render(<CallOutcomeSection detail={detail} api={api} onSaved={onSaved} />);

    fireEvent.click(screen.getByRole('button', { name: 'Spoke' }));
    fireEvent.change(screen.getByLabelText('Callback promised'), {
      target: { value: '2030-05-06' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save & next' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('person-next'));
    expect(api.logCallOutcome).toHaveBeenCalledTimes(1);
    const request = (api.logCallOutcome as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(request.outcome).toBe('spoke');
    expect(request.personId).toBe('person-kevin');
    expect(new Date(request.callbackAt).getFullYear()).toBe(2030);
    // No note text: addLeadNote is skipped entirely.
    expect(api.addLeadNote).not.toHaveBeenCalled();
  });

  it('logs an optional founder note and saves with Cmd+Enter', async () => {
    const api = fakeApi(null);
    const onSaved = vi.fn();
    render(<CallOutcomeSection detail={detail} api={api} onSaved={onSaved} />);

    fireEvent.click(screen.getByRole('button', { name: 'No answer' }));
    const note = screen.getByLabelText('Note');
    fireEvent.change(note, { target: { value: 'Left with the office manager.' } });
    fireEvent.keyDown(note, { key: 'Enter', metaKey: true });

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(null));
    expect(api.addLeadNote).toHaveBeenCalledWith({
      personId: 'person-kevin',
      salesCycleId: 'cycle-kevin',
      text: 'Left with the office manager.',
    });
  });

  it('surfaces a safe error and keeps the form on failure', async () => {
    const api = fakeApi(null);
    (api.logCallOutcome as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('SQLITE_BUSY at /tmp/db'),
    );
    const onSaved = vi.fn();
    render(<CallOutcomeSection detail={detail} api={api} onSaved={onSaved} />);

    fireEvent.click(screen.getByRole('button', { name: 'Voicemail' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save & next' }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/SQLITE_BUSY/)).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe('linked manual retry', () => {
  it('preserves linked request on association conflict with no automatic unlinked save', async () => {
    const api = fakeApi(null);
    vi.mocked(api.logCallOutcome).mockRejectedValue(new Error('private wrong cycle details'));
    const commandId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    render(<CallOutcomeSection detail={detail} api={api} onSaved={vi.fn()} outboundCommandId={commandId} />);
    fireEvent.click(screen.getByRole('button', { name: 'Spoke' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save & next' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Nothing will be saved unlinked automatically');
    expect(screen.queryByText(/private wrong cycle/)).toBeNull();
    expect(api.logCallOutcome).toHaveBeenCalledTimes(1);
    const first = vi.mocked(api.logCallOutcome).mock.calls[0][0];
    fireEvent.click(screen.getByRole('button', { name: 'Save & next' }));
    await waitFor(() => expect(api.logCallOutcome).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.logCallOutcome).mock.calls[1][0]).toEqual(first);
    expect(first.outboundCommandId).toBe(commandId);
    expect(api.addLeadNote).not.toHaveBeenCalled(); expect(api.get).not.toHaveBeenCalled();
  });

  it('does not relog a confirmed outcome or note when the separate next-lead fetch fails', async () => {
    const api = fakeApi(null);
    vi.mocked(api.get).mockRejectedValueOnce(new Error('queue failed'));
    render(<CallOutcomeSection detail={detail} api={api} onSaved={vi.fn()} outboundCommandId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />);
    fireEvent.click(screen.getByRole('button', { name: 'No answer' }));
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: 'A manual note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save & next' }));
    expect((await screen.findByRole('alert')).textContent).toContain('outcome was saved');
    fireEvent.click(screen.getByRole('button', { name: 'Save & next' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect(api.logCallOutcome).toHaveBeenCalledTimes(1);
    expect(api.addLeadNote).toHaveBeenCalledTimes(1);
  });

  it('retains exact effective timestamp and callback payload after unresolved response', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime('2026-09-06T15:00:00.000Z');
    const api = fakeApi(null);
    vi.mocked(api.logCallOutcome).mockRejectedValueOnce(new Error('response lost'));
    const commandId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    render(<CallOutcomeSection detail={detail} api={api} onSaved={vi.fn()} outboundCommandId={commandId} />);
    fireEvent.click(screen.getByRole('button', { name: 'No answer' }));
    fireEvent.change(screen.getByLabelText('Callback promised'), { target: { value: '2030-05-06' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save & next' }));
    await screen.findByRole('alert');
    const first = vi.mocked(api.logCallOutcome).mock.calls[0][0];
    expect(first.outboundCommandId).toBe(commandId);
    vi.setSystemTime('2026-09-06T16:00:00.000Z');
    fireEvent.click(screen.getByRole('button', { name: 'Save & next' }));
    await waitFor(() => expect(api.logCallOutcome).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.logCallOutcome).mock.calls[1][0]).toEqual(first);
  });
});
