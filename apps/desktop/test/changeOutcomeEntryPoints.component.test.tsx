// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallLogRowDto, CallSessionDto, CorrectionPreviewResponse } from '@fss/contracts';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import { CallHistory, type CallHistoryPorts } from '../src/renderer/calling/CallHistory.tsx';
import type { CorrectionPorts } from '../src/renderer/calling/ChangeOutcome.tsx';
import { AfterCallAnalysis } from '../src/renderer/today/AfterCallAnalysis.tsx';
import { resetCorrectionMemory } from '../src/renderer/calling/correctionMemory.ts';
import { TodayBrief } from '../src/renderer/today/TodayBrief.tsx';
import { PROPOSALS, SESSION_ID, analysisAnswer } from './support/analysisAnswers.ts';

/**
 * The three places "Change outcome" is offered (S3X lane X2, DESIGN-S3X §3.6): the firm page's
 * call history — which reads every call log from the database (`calling.logs`) and gives each
 * log no session row shows a row of its own, newest first, even while the session read fails —
 * Today's previous interactions, and the after-call "Logged:" line. Fictional data only.
 */

const FIRM_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_LOG = '22222222-2222-4222-8222-222222222222';
const FORM_LOG = '33333333-3333-4333-8333-333333333333';
const INBOUND_LOG = '44444444-4444-4444-8444-444444444444';
const USER = '55555555-5555-4555-8555-555555555555';

const session = (over: Partial<CallSessionDto> = {}): CallSessionDto => ({
  sessionId: SESSION_ID,
  firmId: FIRM_ID,
  status: 'completed',
  startedAt: '2026-09-21T14:00:00.000Z',
  answeredAt: '2026-09-21T14:00:10.000Z',
  endedAt: '2026-09-21T14:03:10.000Z',
  durationSeconds: 180,
  hasRecording: false,
  callLogId: SESSION_LOG,
  hasTranscript: false,
  outcome: 'interested',
  ...over,
});

const log = (over: Partial<CallLogRowDto>): CallLogRowDto => ({
  id: FORM_LOG,
  firmId: FIRM_ID,
  contactId: null,
  outcome: 'no_answer',
  stepEffect: 'advance',
  occurredAt: '2026-09-20T10:00:00.000Z',
  actorUserId: USER,
  note: null,
  direction: 'outbound',
  durationSeconds: null,
  callSessionId: null,
  corrections: [],
  ...over,
});

const preview = (over: Partial<CorrectionPreviewResponse> = {}): CorrectionPreviewResponse => ({
  callLogId: SESSION_LOG,
  currentOutcome: 'interested',
  originalOutcome: 'no_answer',
  corrections: [],
  outcomeAppliedKey: null,
  effects: [],
  callbackTimeRequired: false,
  alsoHappens: [],
  ...over,
});

function correctionPorts(current: CorrectionPreviewResponse['currentOutcome'] = 'interested'): CorrectionPorts & { readonly corrected: unknown[] } {
  const corrected: unknown[] = [];
  return {
    corrected,
    preview: async input => await Promise.resolve({ preview: preview({ callLogId: input.callLogId, currentOutcome: current }), reason: null }),
    correct: async input => {
      corrected.push(input);
      return await Promise.resolve({
        corrected: {
          callLogId: input.callLogId,
          outcome: input.outcome,
          revision: 2,
          applied: { suppressionEventIds: [], retiredRouteId: null, callbackId: null, parkHoldId: null, reopenedTodayItemId: null },
          liftNext: [],
          suggestedStageKey: null,
        },
        reason: null,
      });
    },
    supersede: async () => await Promise.resolve({ lifted: true, reason: null }),
  };
}

beforeEach(() => {
  resetCorrectionMemory();
});
afterEach(() => {
  cleanup();
  globalThis.callieApi = undefined;
});

describe('the firm page’s call history', () => {
  it('shows each log with its corrections, and every log no session row shows at its time, newest first', async () => {
    const logs = [
      log({ id: INBOUND_LOG, outcome: 'interested', occurredAt: '2026-09-22T09:00:00.000Z', direction: 'inbound', durationSeconds: 95 }),
      log({ id: SESSION_LOG, outcome: 'interested', occurredAt: '2026-09-21T14:00:00.000Z', callSessionId: SESSION_ID, corrections: [{ from: 'no_answer', to: 'interested', at: '2026-10-02T12:00:00.000Z', byUserId: USER, reason: null }] }),
      log({ id: FORM_LOG }),
    ];
    const ports: CallHistoryPorts = {
      history: async () => await Promise.resolve({ calls: [session()] }),
      recording: async () => await Promise.resolve({ recording: null, reason: null }),
      logs: async () => await Promise.resolve({ calls: logs }),
      correction: correctionPorts(),
    };
    render(<DraftsProvider><CallHistory firmId={FIRM_ID} ports={ports} /></DraftsProvider>);
    await waitFor(() => expect(screen.getAllByTestId('change-outcome')).toHaveLength(3));
    expect(screen.getAllByTestId('change-outcome').map(control => control.getAttribute('data-log'))).toEqual([INBOUND_LOG, SESSION_LOG, FORM_LOG]);
    expect(screen.getAllByTestId('call-history-log-row')).toHaveLength(2);
    expect(within(screen.getByTestId('call-history-row')).getByTestId('change-outcome-current').textContent).toMatch(/^Conversation · corrected from No answer, /u);
  });

  it('lists the logs when the session read did not answer (Twilio not the provider), and corrects one by its log id', async () => {
    let reads = 0;
    const correction = correctionPorts('no_answer');
    const ports: CallHistoryPorts = {
      history: async () => await Promise.resolve({ calls: null }),
      recording: async () => await Promise.resolve({ recording: null, reason: null }),
      logs: async () => {
        reads += 1;
        return await Promise.resolve({ calls: [log({ id: FORM_LOG, outcome: reads > 1 ? 'voicemail_left' : 'no_answer' })] });
      },
      correction,
    };
    render(<DraftsProvider><CallHistory firmId={FIRM_ID} ports={ports} /></DraftsProvider>);
    await screen.findByTestId('call-history-log-row');
    expect(screen.queryByTestId('call-history-unavailable')).toBeNull();
    fireEvent.click(screen.getByTestId('change-outcome-toggle'));
    fireEvent.change(screen.getByTestId('change-outcome-select'), { target: { value: 'voicemail_left' } });
    await waitFor(() => expect((screen.getByTestId('change-outcome-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('change-outcome-save'));
    await waitFor(() => expect(correction.corrected).toEqual([expect.objectContaining({ callLogId: FORM_LOG, outcome: 'voicemail_left', expectedOutcome: 'no_answer' })]));
    // The history re-fetches itself and shows the current outcome.
    await waitFor(() => expect(screen.getByTestId('change-outcome-current').textContent).toBe('Voicemail left'));
  });
});

describe('the call history across firms (review of X2, finding 1)', () => {
  const OTHER_FIRM = '66666666-6666-4666-8666-666666666666';
  const OTHER_LOG = '77777777-7777-4777-8777-777777777777';
  interface Pending {
    readonly firmId: string;
    resolve(answer: { readonly calls: readonly CallLogRowDto[] | null }): void;
  }

  it('switching firms never leaves the previous firm’s calls actionable, even when the sessions answer first', async () => {
    const pending: Pending[] = [];
    const ports: CallHistoryPorts = {
      history: async () => await Promise.resolve({ calls: [] }),
      recording: async () => await Promise.resolve({ recording: null, reason: null }),
      logs: async firmId =>
        firmId === FIRM_ID
          ? await Promise.resolve({ calls: [log({ id: FORM_LOG })] })
          : await new Promise(resolve => {
              pending.push({ firmId, resolve });
            }),
      correction: correctionPorts('no_answer'),
    };
    const { rerender } = render(<DraftsProvider><CallHistory firmId={FIRM_ID} ports={ports} /></DraftsProvider>);
    await screen.findByTestId('call-history-log-row');
    await act(async () => {
      rerender(<DraftsProvider><CallHistory firmId={OTHER_FIRM} ports={ports} /></DraftsProvider>);
      await Promise.resolve();
    });
    // B's sessions answered; its logs have not. Nothing of A is on screen.
    expect(screen.queryByTestId('call-history-log-row')).toBeNull();
    expect(screen.queryByTestId('change-outcome')).toBeNull();
    // B's answer: only B's rows show, and a row of another firm in it never does.
    await act(async () => {
      pending[0]?.resolve({ calls: [log({ id: OTHER_LOG, firmId: OTHER_FIRM }), log({ id: FORM_LOG })] });
      await Promise.resolve();
    });
    expect(screen.getAllByTestId('change-outcome').map(control => control.getAttribute('data-log'))).toEqual([OTHER_LOG]);
  });

  it('a late log answer for a firm no longer shown is dropped', async () => {
    const pending: Pending[] = [];
    const ports: CallHistoryPorts = {
      history: async () => await Promise.resolve({ calls: [] }),
      recording: async () => await Promise.resolve({ recording: null, reason: null }),
      logs: async firmId =>
        await new Promise(resolve => {
          pending.push({ firmId, resolve });
        }),
      correction: correctionPorts('no_answer'),
    };
    const { rerender } = render(<DraftsProvider><CallHistory firmId={FIRM_ID} ports={ports} /></DraftsProvider>);
    await act(async () => {
      rerender(<DraftsProvider><CallHistory firmId={OTHER_FIRM} ports={ports} /></DraftsProvider>);
      await Promise.resolve();
    });
    await act(async () => {
      pending.find(entry => entry.firmId === FIRM_ID)?.resolve({ calls: [log({ id: FORM_LOG })] });
      await Promise.resolve();
    });
    expect(screen.queryByTestId('change-outcome')).toBeNull();
  });

  it('Change is disabled while the shown firm’s log read is pending', async () => {
    let reads = 0;
    let release: () => void = () => undefined;
    const ports: CallHistoryPorts = {
      history: async () => await Promise.resolve({ calls: [] }),
      recording: async () => await Promise.resolve({ recording: null, reason: null }),
      logs: async () => {
        reads += 1;
        if (reads === 1) return await Promise.resolve({ calls: [log({ id: FORM_LOG })] });
        return await new Promise(resolve => {
          release = () => resolve({ calls: [log({ id: FORM_LOG, outcome: 'voicemail_left' })] });
        });
      },
      correction: correctionPorts('no_answer'),
    };
    render(<DraftsProvider><CallHistory firmId={FIRM_ID} ports={ports} /></DraftsProvider>);
    await screen.findByTestId('call-history-log-row');
    expect((screen.getByTestId('change-outcome-toggle') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('change-outcome-toggle'));
    fireEvent.change(screen.getByTestId('change-outcome-select'), { target: { value: 'voicemail_left' } });
    await waitFor(() => expect((screen.getByTestId('change-outcome-save') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('change-outcome-save'));
    // The correction re-reads the logs; until the read answers, Change is disabled.
    await waitFor(() => expect(reads).toBe(2));
    expect((screen.getByTestId('change-outcome-toggle') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await waitFor(() => expect((screen.getByTestId('change-outcome-toggle') as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByTestId('change-outcome-current').textContent).toBe('Voicemail left');
  });
});

describe('Today', () => {
  it('previous interactions offer Change on a logged call', () => {
    const corrected = vi.fn();
    render(
      <DraftsProvider>
        <TodayBrief brief={null} calls={[session()]} researching={false} enabled onResearchAgain={() => undefined} timeZone="America/New_York" onCorrected={corrected} />
      </DraftsProvider>,
    );
    const control = within(screen.getByTestId('brief-calls')).getByTestId('change-outcome');
    expect(control.getAttribute('data-log')).toBe(SESSION_LOG);
    expect(within(control).getByTestId('change-outcome-current').textContent).toBe('Conversation');
  });

  it('the after-call "Logged:" line shows the current outcome with Change', () => {
    // The registry's ports: the control is offered only where the operations exist.
    globalThis.callieApi = { read: async () => await Promise.resolve({ preview: null, reason: 'offline' }), command: async () => await Promise.resolve({}) } as never;
    render(
      <DraftsProvider>
        <AfterCallAnalysis
          view={{ analysis: analysisAnswer({ proposals: [PROPOSALS.outcome, PROPOSALS.callback] }), reason: null }}
          sessionId={SESSION_ID}
          waiting={false}
          logged
          loggedOutcome="voicemail_left"
          loggedCallLogId={SESSION_LOG}
          timeZone="America/New_York"
          onCorrected={() => undefined}
          templates={[]}
          onReload={() => undefined}
          onChanged={() => undefined}
          onEnterManually={() => undefined}
        />
      </DraftsProvider>,
    );
    expect(screen.getByTestId('change-outcome-current').textContent).toBe('Logged: Voicemail left');
    expect(screen.getByTestId('change-outcome-toggle')).toBeTruthy();
  });
});
