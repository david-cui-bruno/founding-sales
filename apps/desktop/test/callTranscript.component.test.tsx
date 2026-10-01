// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reasonSentence, type CallSessionDto, type CallTranscriptResponse } from '@fss/contracts';
import { CallHistory, transcriptTime } from '../src/renderer/calling/CallHistory.tsx';

/**
 * Slice C2 on the firm page: a "Transcript" disclosure under each call that has one; the
 * speakers numbered ("Speaker 1", "Speaker 2"), times in grey;
 * nothing at all when there is no transcript; a refusal as a sentence. Fictional data only.
 */

const FIRM_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '88888888-8888-4888-8888-888888888888';
const OTHER_ID = '99999999-9999-4999-8999-999999999999';

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

const transcript = (utterances: CallTranscriptResponse['utterances']): CallTranscriptResponse => ({
  callSessionId: SESSION_ID,
  provider: 'deepgram',
  model: 'nova-3',
  language: 'en',
  durationSeconds: 180,
  createdAt: '2026-09-21T14:05:00.000Z',
  utterances,
});

afterEach(cleanup);

describe('the Transcript disclosure', () => {
  it('is offered only for calls that have a transcript, and reads it when opened', async () => {
    const read = vi.fn(async (_id: string) =>
      await Promise.resolve({
        transcript: transcript([
          { speaker: 0, start: 0.4, end: 1.2, text: 'Hello, Example Law.' },
          { speaker: 1, start: 65.2, end: 67, text: 'Hi, it is David from Callie.' },
        ]),
        reason: null,
      }),
    );
    render(
      <CallHistory
        firmId={FIRM_ID}
        ports={{
          history: async () => await Promise.resolve({ calls: [call(), call({ sessionId: OTHER_ID, hasTranscript: false }), call({ sessionId: FIRM_ID, hasTranscript: undefined })] }),
          recording: async () => await Promise.resolve({ recording: null, reason: null }),
          transcript: read,
        }}
      />,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId('call-history-row')).toHaveLength(3);
    });
    expect(screen.getAllByTestId('call-transcript')).toHaveLength(1);
    expect(read).not.toHaveBeenCalled();
    const details = screen.getByTestId('call-transcript') as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    await waitFor(() => {
      expect(screen.getAllByTestId('call-transcript-line')).toHaveLength(2);
    });
    expect(read).toHaveBeenCalledWith(SESSION_ID);
    // Numbered, never "You" and "Them": diarization tells voices apart, not roles.
    expect(screen.getAllByTestId('call-transcript-speaker').map(node => node.textContent)).toEqual(['Speaker 1', 'Speaker 2']);
    expect(screen.getAllByTestId('call-transcript-time').map(node => node.textContent)).toEqual(['0:00', '1:05']);
    expect(screen.getAllByTestId('call-transcript-time')[0]?.className).toContain('text-muted-foreground');
    // Opening it again reads nothing more.
    fireEvent(details, new Event('toggle'));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('numbers three speakers too', async () => {
    render(
      <CallHistory
        firmId={FIRM_ID}
        ports={{
          history: async () => await Promise.resolve({ calls: [call()] }),
          recording: async () => await Promise.resolve({ recording: null, reason: null }),
          transcript: async () =>
            await Promise.resolve({
              transcript: transcript([
                { speaker: 0, start: 0, end: 1, text: 'One.' },
                { speaker: 1, start: 2, end: 3, text: 'Two.' },
                { speaker: 2, start: 4, end: 5, text: 'Three.' },
              ]),
              reason: null,
            }),
        }}
      />,
    );
    const details = (await screen.findByTestId('call-transcript')) as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    await waitFor(() => {
      expect(screen.getAllByTestId('call-transcript-speaker').map(node => node.textContent)).toEqual(['Speaker 1', 'Speaker 2', 'Speaker 3']);
    });
  });

  it('shows nothing when the call turns out to have no transcript, and a sentence when it cannot be read', async () => {
    const answers = [
      { transcript: null, reason: null },
      { transcript: null, reason: 'offline' },
      { transcript: null, reason: 'http_500' },
    ];
    for (const answer of answers) {
      render(
        <CallHistory
          firmId={FIRM_ID}
          ports={{
            history: async () => await Promise.resolve({ calls: [call()] }),
            recording: async () => await Promise.resolve({ recording: null, reason: null }),
            transcript: async () => await Promise.resolve(answer),
          }}
        />,
      );
      const details = (await screen.findByTestId('call-transcript')) as HTMLDetailsElement;
      details.open = true;
      fireEvent(details, new Event('toggle'));
      if (answer.reason === null) {
        await waitFor(() => {
          expect(screen.queryByTestId('call-transcript')).toBeNull();
        });
      } else {
        const problem = await screen.findByTestId('call-transcript-problem');
        expect(problem.textContent).toBe(reasonSentence(answer.reason === 'offline' ? 'offline' : 'transcript_unavailable'));
        expect(problem.textContent).not.toContain('_');
      }
      cleanup();
    }
  });

  it('writes times as minutes and seconds', () => {
    expect(transcriptTime(0)).toBe('0:00');
    expect(transcriptTime(65.9)).toBe('1:05');
    expect(transcriptTime(3_600)).toBe('60:00');
  });
});
