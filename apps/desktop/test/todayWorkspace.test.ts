import { describe, expect, it } from 'vitest';
import type { CallSessionDto } from '@fss/contracts';
import { callProgress, latestCall, RECORDING_GRACE_MS, TRANSCRIPT_GRACE_MS } from '../src/renderer/today/callProgress.ts';
import { blockerLine, nextToCall, queueGroups, queueLine, queueOrder, stepFrom } from '../src/renderer/today/queueView.ts';
import type { TodayCard } from '../src/renderer/todayContract.ts';

/**
 * Slice S2's two pure views: the queue's order and grouping, and what a call's steps say
 * as the history answers arrive. No real firm; ids are fixed placeholders.
 */

const card = (id: string, lane: TodayCard['lane'], blockers?: TodayCard['blockers']): TodayCard => ({
  firmId: `00000000-0000-4000-8000-${id.padStart(12, '0')}`,
  firmName: `Firm ${id}`,
  lane,
  dueAt: '2026-10-01T13:00:00.000Z',
  counts: { replies: lane === 'reply' ? 1 : 0, emailsDue: 0, callsDue: lane === 'due_work' ? 1 : 0 },
  ...(blockers === undefined ? {} : { blockers }),
});

// The server's order: replies, callbacks, due work, new firms.
const cards = [
  card('1', 'reply', ['no_phone']),
  card('2', 'callback'),
  card('3', 'due_work'),
  card('4', 'new_firm', ['no_location']),
  card('5', 'new_firm'),
  card('6', 'new_firm', []),
];

describe('the queue', () => {
  it('puts callbacks first, then replies, due work and new prospects, and the blocked firms last, each in the server’s order', () => {
    expect(queueGroups(cards).map(group => [group.id, group.cards.map(entry => entry.firmName)])).toEqual([
      ['callbacks', ['Firm 2']],
      ['replies', ['Firm 1']],
      ['due', ['Firm 3']],
      ['prospects', ['Firm 5', 'Firm 6']],
      ['blocked', ['Firm 4']],
    ]);
  });

  it('keeps a reply with the replies whatever it is missing, and says why a blocked firm cannot be called', () => {
    expect(queueLine(cards[0] as TodayCard)).toBe('Replied');
    expect(queueLine(cards[3] as TodayCard)).toBe('No location or time zone');
    expect(blockerLine(card('9', 'new_firm', ['no_phone', 'no_location']))).toBe('No phone number · No location or time zone');
    // A list from an API before slice S2 has no blockers at all: nothing is blocked.
    expect(queueGroups([card('7', 'new_firm')])[0]?.id).toBe('prospects');
  });

  it('walks the queue’s own order with J and K, and stops at either end', () => {
    const order = queueOrder(cards).map(entry => entry.firmName);
    expect(order).toEqual(['Firm 2', 'Firm 1', 'Firm 3', 'Firm 5', 'Firm 6', 'Firm 4']);
    const id = (name: string): string => cards.find(entry => entry.firmName === name)?.firmId ?? '';
    expect(stepFrom(cards, null, 1)).toBe(id('Firm 2'));
    expect(stepFrom(cards, id('Firm 2'), 1)).toBe(id('Firm 1'));
    expect(stepFrom(cards, id('Firm 2'), -1)).toBeNull();
    expect(stepFrom(cards, id('Firm 4'), 1)).toBeNull();
  });

  it('Next firm skips replies, blocked firms and what was called this sitting, and wraps round', () => {
    const id = (name: string): string => cards.find(entry => entry.firmName === name)?.firmId ?? '';
    expect(nextToCall(cards, id('Firm 2'), new Set())).toBe(id('Firm 3'));
    expect(nextToCall(cards, id('Firm 3'), new Set([id('Firm 5')]))).toBe(id('Firm 6'));
    expect(nextToCall(cards, id('Firm 6'), new Set())).toBe(id('Firm 2'));
    expect(nextToCall(cards, id('Firm 6'), new Set([id('Firm 2'), id('Firm 3'), id('Firm 5')]))).toBeNull();
  });
});

const NOW = Date.parse('2026-10-01T15:00:00.000Z');
const call = (overrides: Partial<CallSessionDto> = {}): CallSessionDto => ({
  sessionId: '11111111-1111-4111-8111-111111111111',
  firmId: '22222222-2222-4222-8222-222222222222',
  status: 'completed',
  startedAt: new Date(NOW - 300_000).toISOString(),
  answeredAt: new Date(NOW - 290_000).toISOString(),
  endedAt: new Date(NOW - 60_000).toISOString(),
  durationSeconds: 230,
  hasRecording: false,
  callLogId: null,
  hasTranscript: false,
  ...overrides,
});

describe('a call’s steps', () => {
  it('is live while ringing or connected, and keeps reading', () => {
    expect(callProgress(call({ status: 'in_progress', endedAt: null }), NOW)).toMatchObject({ call: { word: 'connected' }, polling: true });
  });

  it('waits for the recording, then the transcript, then the summary, reading again until each arrives', () => {
    expect(callProgress(call(), NOW)).toMatchObject({ recording: { state: 'pending' }, transcription: { state: 'waiting' }, polling: true });
    expect(callProgress(call({ hasRecording: true }), NOW)).toMatchObject({ transcription: { state: 'pending' }, analysis: { state: 'waiting' }, polling: true });
    expect(callProgress(call({ hasRecording: true, hasTranscript: true }), NOW)).toMatchObject({ analysis: { state: 'pending' }, polling: true });
    const done = callProgress(
      call({
        hasRecording: true,
        hasTranscript: true,
        summary: { summary: 'Spoke.', nextSteps: [], commitments: [], model: 'm', createdAt: new Date(NOW).toISOString() },
      }),
      NOW,
    );
    expect(done).toMatchObject({ analysis: { state: 'done' }, sentence: 'Summary saved to the firm.', polling: false });
  });

  it('says plainly when a step did not come, instead of spinning, and stops reading', () => {
    expect(callProgress(call({ endedAt: new Date(NOW - RECORDING_GRACE_MS - 1).toISOString() }), NOW).recording.state).toBe('failed');
    const late = callProgress(call({ hasRecording: true, endedAt: new Date(NOW - TRANSCRIPT_GRACE_MS - 1).toISOString() }), NOW);
    expect(late).toMatchObject({ transcription: { state: 'failed' }, analysis: { state: 'skipped' } });
    expect(late.sentence).toContain('No transcript came back');
  });

  it('has nothing to wait for on an unanswered or too-short call', () => {
    expect(callProgress(call({ answeredAt: null }), NOW)).toMatchObject({ call: { word: 'not answered' }, recording: { state: 'skipped' }, polling: false });
    expect(callProgress(call({ hasRecording: true, durationSeconds: 12 }), NOW)).toMatchObject({
      transcription: { state: 'skipped', word: 'too short' },
      analysis: { state: 'skipped' },
      polling: false,
    });
  });

  it('reads the latest call by when it started', () => {
    const older = call({ sessionId: '33333333-3333-4333-8333-333333333333', startedAt: new Date(NOW - 86_400_000).toISOString() });
    expect(latestCall([older, call()])?.sessionId).toBe('11111111-1111-4111-8111-111111111111');
    expect(latestCall([])).toBeNull();
  });
});
