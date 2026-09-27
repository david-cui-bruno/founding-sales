// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecoveryControls } from '../src/renderer/settings/RecoveryControls.tsx';
import type { OperationApi, OperationName } from '../src/shared/operations.ts';

/**
 * Settings › Diagnostics: the two recoveries (specification 12.5, 13.4).
 *
 * These are the two things done while something is going wrong, so what is asserted here
 * is mostly what they refuse to do: record an outcome for a send nobody just looked at,
 * requeue a job with no reason, or do either of them from a keystroke in a field.
 */

const SEND_ID = '33333333-3333-4333-8333-333333333333';
const JOB_ID = '44444444-4444-4444-8444-444444444444';

const fence = (overrides: Record<string, unknown> = {}) => ({
  id: SEND_ID,
  state: 'unknown_terminal',
  recipientAddress: 'ap@northwind.example',
  dispatchStartedAt: '2026-09-27T13:02:00.000Z',
  sentAt: null,
  heldReason: 'dispatch_unresolved',
  adminResolution: null,
  reconcileAttempts: 3,
  ...overrides,
});

const deadJob = (overrides: Record<string, unknown> = {}) => ({
  id: JOB_ID,
  kind: 'send_email',
  idempotencyKey: 'seq:step:7',
  attempts: 5,
  maxAttempts: 5,
  requeuedCount: 0,
  errorCode: 'gmail_unavailable',
  errorDetail: null,
  deadAt: '2026-09-27T11:00:00.000Z',
  ...overrides,
});

type Scripted = Readonly<Partial<Record<OperationName, (input: unknown) => Promise<unknown>>>>;

function install(scripted: Scripted): { readonly calls: [OperationName, unknown][] } {
  const calls: [OperationName, unknown][] = [];
  const answerOne = async (operation: OperationName, input: unknown): Promise<unknown> => {
    calls.push([operation, input]);
    const scriptedOne = scripted[operation];
    if (scriptedOne === undefined) throw new Error(`${operation} was not scripted`);
    return await scriptedOne(input);
  };
  globalThis.callieApi = { read: answerOne, command: answerOne } as unknown as OperationApi;
  return { calls };
}

afterEach(() => {
  cleanup();
  globalThis.callieApi = undefined;
});

describe('Settings › Diagnostics, the recoveries', () => {
  it('draws nothing in a build without the bridge', () => {
    const { container } = render(<RecoveryControls />);
    expect(container.firstChild).toBeNull();
  });

  it('will not resolve a send nobody has looked at, and names the effect on the button', async () => {
    const resolveSend = vi.fn(async () => ({ outboundMessageId: SEND_ID, resolution: 'delivered' as const }));
    const { calls } = install({
      'diagnostics.sendStatus': async () => ({ fence: fence() }),
      'diagnostics.resolveSend': resolveSend,
    });
    render(<RecoveryControls />);

    // Nothing to confirm before a look-up.
    expect(screen.queryByTestId('recovery-send-confirm')).toBeNull();

    await userEvent.type(screen.getByTestId('recovery-send-id'), SEND_ID);
    await userEvent.click(screen.getByTestId('recovery-send-lookup'));

    await screen.findByTestId('recovery-send-fence');
    expect(screen.getByTestId('recovery-send-state').textContent).toContain('never learned');
    expect(calls[0]).toEqual(['diagnostics.sendStatus', { outboundMessageId: SEND_ID }]);

    // The button says what it is about to do, and changes when the choice does.
    expect(screen.getByTestId('recovery-send-confirm').textContent).toBe('Record it as delivered');
    await userEvent.selectOptions(screen.getByTestId('recovery-send-resolution'), 'skipped');
    expect(screen.getByTestId('recovery-send-confirm').textContent).toBe('Record it as never sent');

    await userEvent.click(screen.getByTestId('recovery-send-confirm'));
    await screen.findByTestId('recovery-send-answer');
    expect(resolveSend).toHaveBeenCalledWith({ outboundMessageId: SEND_ID, resolution: 'skipped' });
    // The state that was on screen was true before the decision, so it is gone.
    expect(screen.queryByTestId('recovery-send-fence')).toBeNull();
  });

  it('Enter in the send id looks it up and records nothing', async () => {
    const resolveSend = vi.fn(async () => ({ outboundMessageId: SEND_ID, resolution: 'delivered' as const }));
    install({ 'diagnostics.sendStatus': async () => ({ fence: fence() }), 'diagnostics.resolveSend': resolveSend });
    render(<RecoveryControls />);

    await userEvent.type(screen.getByTestId('recovery-send-id'), `${SEND_ID}{Enter}`);
    await screen.findByTestId('recovery-send-fence');
    expect(resolveSend).not.toHaveBeenCalled();
  });

  it('says so when the id is not a send id, and asks the server nothing', async () => {
    const { calls } = install({});
    render(<RecoveryControls />);
    await userEvent.type(screen.getByTestId('recovery-send-id'), 'the one from the alert{Enter}');
    await screen.findByTestId('recovery-send-invalid');
    expect(calls).toEqual([]);
  });

  it('will not offer a decision on a send that already has one', async () => {
    install({
      'diagnostics.sendStatus': async () => ({
        fence: fence({ state: 'unknown_terminal', adminResolution: 'delivered' }),
      }),
    });
    render(<RecoveryControls />);
    await userEvent.type(screen.getByTestId('recovery-send-id'), `${SEND_ID}{Enter}`);
    await screen.findByTestId('recovery-send-fence');
    expect(screen.getByTestId<HTMLButtonElement>('recovery-send-confirm').disabled).toBe(true);
    expect(screen.getByTestId('recovery-send-settled').textContent).toContain('already recorded as delivered');
  });

  it('will not offer a decision on a send that is still being reconciled', async () => {
    // The server refuses `/outbound/resolve` for anything but `unknown_terminal`
    // (`fence_not_ready`), so the form does not invite the press that would fail.
    install({ 'diagnostics.sendStatus': async () => ({ fence: fence({ state: 'dispatching' }) }) });
    render(<RecoveryControls />);
    await userEvent.type(screen.getByTestId('recovery-send-id'), `${SEND_ID}{Enter}`);
    await screen.findByTestId('recovery-send-fence');
    expect(screen.getByTestId('recovery-send-state').textContent).toContain('still reconciling');
    expect(screen.getByTestId<HTMLButtonElement>('recovery-send-confirm').disabled).toBe(true);
    expect(screen.getByTestId('recovery-send-settled').textContent).toContain('never learned');
  });

  it('takes the preview away when the id is edited, so nothing resolves a send nobody looked at', async () => {
    const resolveSend = vi.fn(async () => ({ outboundMessageId: SEND_ID, resolution: 'delivered' as const }));
    install({ 'diagnostics.sendStatus': async () => ({ fence: fence() }), 'diagnostics.resolveSend': resolveSend });
    render(<RecoveryControls />);

    await userEvent.type(screen.getByTestId('recovery-send-id'), `${SEND_ID}{Enter}`);
    await screen.findByTestId('recovery-send-fence');

    await userEvent.type(screen.getByTestId('recovery-send-id'), '9');
    await waitFor(() => {
      expect(screen.queryByTestId('recovery-send-fence')).toBeNull();
    });
    expect(screen.queryByTestId('recovery-send-confirm')).toBeNull();
    expect(resolveSend).not.toHaveBeenCalled();
  });

  it('shows a refusal where the answer would have been', async () => {
    install({
      'diagnostics.sendStatus': async () => {
        throw new Error('admin_only');
      },
    });
    render(<RecoveryControls />);
    await userEvent.type(screen.getByTestId('recovery-send-id'), `${SEND_ID}{Enter}`);
    expect((await screen.findByTestId('recovery-send-notice')).textContent).toBe('admin_only');
  });

  it('requeues a dead job only with a reason, and shows the plain answer', async () => {
    const requeue = vi.fn(async () => ({ requeued: true as const, jobId: JOB_ID, kind: 'send_email' }));
    const { calls } = install({
      'diagnostics.deadJobs': async () => ({ deadJobs: [deadJob()] }),
      'diagnostics.requeueJob': requeue,
    });
    render(<RecoveryControls />);

    await userEvent.click(screen.getByTestId('recovery-jobs-load'));
    await screen.findByTestId('recovery-jobs-list');
    expect(screen.getByTestId<HTMLInputElement>(`recovery-job-${JOB_ID}`).checked).toBe(true);

    // No reason: refused here, and nothing is sent.
    await userEvent.click(screen.getByTestId('recovery-job-confirm'));
    await screen.findByTestId('recovery-job-invalid');
    expect(requeue).not.toHaveBeenCalled();

    await userEvent.type(screen.getByTestId('recovery-job-reason'), 'Gmail was down; the mailbox is reconnected.');
    await userEvent.click(screen.getByTestId('recovery-job-confirm'));
    await screen.findByTestId('recovery-job-answer');
    expect(requeue).toHaveBeenCalledWith({ jobId: JOB_ID, reason: 'Gmail was down; the mailbox is reconnected.' });
    expect(screen.getByTestId('recovery-job-answer').textContent).toContain('send_email');
    // The job that went back in the queue is off the list.
    expect(screen.queryByTestId(`recovery-job-${JOB_ID}`)).toBeNull();
    expect(calls.map(([operation]) => operation)).toEqual(['diagnostics.deadJobs', 'diagnostics.requeueJob']);
  });

  it('Enter in the reason requeues nothing: there is no form around it', async () => {
    const requeue = vi.fn(async () => ({ requeued: true as const, jobId: JOB_ID, kind: 'send_email' }));
    install({ 'diagnostics.deadJobs': async () => ({ deadJobs: [deadJob()] }), 'diagnostics.requeueJob': requeue });
    const { container } = render(<RecoveryControls />);

    await userEvent.click(screen.getByTestId('recovery-jobs-load'));
    await screen.findByTestId('recovery-jobs-list');
    await userEvent.type(screen.getByTestId('recovery-job-reason'), 'because{Enter}');
    expect(requeue).not.toHaveBeenCalled();
    expect(screen.getByTestId('recovery-job-confirm')).toHaveProperty('type', 'button');
    // The only form on the page is the send look-up, which is a read.
    expect(container.querySelectorAll('form')).toHaveLength(1);
  });

  it('says when no job has given up', async () => {
    install({ 'diagnostics.deadJobs': async () => ({ deadJobs: [] }) });
    render(<RecoveryControls />);
    await userEvent.click(screen.getByTestId('recovery-jobs-load'));
    await screen.findByTestId('recovery-jobs-none');
    await waitFor(() => {
      expect(screen.queryByTestId('recovery-job-confirm')).toBeNull();
    });
  });
});
