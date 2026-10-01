// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CallSessionDto, CallSummaryDto } from '@fss/contracts';
import { CallHistory } from '../src/renderer/calling/CallHistory.tsx';
import { LatestCallSummary } from '../src/renderer/calling/LatestCallSummary.tsx';

/**
 * Slice C3b on the Mac: a call's summary under its row on the firm page, and the firm's most
 * recent summarized call on the Today card. Text only — no button sends or schedules
 * anything. Fictional data only.
 */

const FIRM_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '88888888-8888-4888-8888-888888888888';
const OTHER_ID = '99999999-9999-4999-8999-999999999999';

const SUMMARY: CallSummaryDto = {
  summary: 'You reached Marisol at Example Property. She runs about three hundred doors. You agreed to send a proposal.',
  nextSteps: [
    { action: 'Send the proposal', owner: 'you', due: 'by Friday' },
    { action: 'Hold the demo', owner: null, due: null },
  ],
  commitments: [{ speaker: 'them', quote: 'Put it on the calendar.' }],
  model: 'claude-haiku-4-5-20251001',
  createdAt: '2026-09-21T14:06:00.000Z',
};

const call = (overrides: Partial<CallSessionDto> = {}): CallSessionDto => ({
  sessionId: SESSION_ID,
  firmId: FIRM_ID,
  status: 'completed',
  startedAt: '2026-09-21T14:00:00.000Z',
  answeredAt: '2026-09-21T14:00:10.000Z',
  endedAt: '2026-09-21T14:03:10.000Z',
  durationSeconds: 180,
  hasRecording: true,
  callLogId: null,
  hasTranscript: true,
  ...overrides,
});

afterEach(cleanup);

describe('the call summary', () => {
  it('shows under the call that has one, with its steps and what was heard, and offers no action', async () => {
    render(
      <CallHistory
        firmId={FIRM_ID}
        ports={{
          history: async () => await Promise.resolve({ calls: [call({ summary: SUMMARY }), call({ sessionId: OTHER_ID })] }),
          recording: async () => await Promise.resolve({ recording: null, reason: null }),
        }}
      />,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId('call-history-row')).toHaveLength(2);
    });
    expect(screen.getAllByTestId('call-summary')).toHaveLength(1);
    expect(screen.getByTestId('call-summary-text').textContent).toBe(SUMMARY.summary);
    expect(screen.getAllByTestId('call-summary-step').map(node => node.textContent)).toEqual(['·Send the proposal — by FridayYou', '·Hold the demo']);
    expect(screen.getAllByTestId('call-summary-commitment').map(node => node.textContent)).toEqual(['Them“Put it on the calendar.”']);
    expect(screen.getByTestId('call-summary').querySelector('button')).toBeNull();
  });

  it('puts the firm’s latest summarized call on the Today card, and nothing when there is none', async () => {
    const older = call({ sessionId: OTHER_ID, startedAt: '2026-09-20T14:00:00.000Z', summary: { ...SUMMARY, summary: 'Older. Call. Here.' } });
    const { unmount } = render(
      <LatestCallSummary firmId={FIRM_ID} ports={{ history: async () => await Promise.resolve({ calls: [call(), older] }) }} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId('today-last-call')).toBeTruthy();
    });
    expect(screen.getByTestId('call-summary-text').textContent).toBe('Older. Call. Here.');
    unmount();
    render(<LatestCallSummary firmId={FIRM_ID} ports={{ history: async () => await Promise.resolve({ calls: [call()] }) }} />);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(screen.queryByTestId('today-last-call')).toBeNull();
    cleanup();
    render(<LatestCallSummary firmId={FIRM_ID} ports={{ history: async () => await Promise.resolve({ calls: null }) }} />);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(screen.queryByTestId('today-last-call')).toBeNull();
  });
});
