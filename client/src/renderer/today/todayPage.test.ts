import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { todayViewSchema, type TodayCard, type TodayView } from '../../../../src/shared/contracts/v1Contract';
import { TodayList } from './TodayPage';
import { copyNumberText, countsLine, dialSentence, freshness, laneSections, nextStepSentence, postureWarning, staleSentence, TODAY_REFRESH_MS, TODAY_STALE_MS } from './todayModel';

/**
 * The Today page's model and its rendering, in node through react-dom/server: the four lanes in order from a
 * contract-valid view, the posture warning, the counts row, the as-of stamp and the stale banner. The
 * Playwright spec against the stub worker follows once the client shell and the stub exist (S0 client).
 */
const card = (over: Partial<TodayCard> & Pick<TodayCard, 'firmId' | 'lane' | 'reason' | 'name'>): TodayCard => ({
  phone: { number: '+14015550201', verification: 'listed' }, website: 'firm.example', city: 'Providence', state: 'RI', timeZone: 'America/New_York',
  localTime: '09:30', openNow: true, dialAllowed: true, holdReason: null, holdCode: null, offer: 'A short introductory call.', lastOutcome: null,
  nextStep: { kind: 'first_call' }, ...over,
});
const view: TodayView = todayViewSchema.parse({
  asOf: '2026-09-18T13:30:00.000Z',
  list: {
    header: { date: '2026-09-18', builtAt: '2026-09-18T09:05:00.000Z', poolSize: 2, counts: { replies: 1, callbacks: 0, due: 1, new: 2 },
      holds: [{ reason: 'state_not_cleared', code: 'no_posture', count: 3 }], excluded: { no_posture: 3 },
      lastTick: { at: '2026-09-18T13:25:00.000Z', status: 'completed', durationMs: 1200 },
      postures: [{ state: 'RI', posture: 'calling', decidedAt: '2026-09-10T12:00:00.000Z', decidedBy: 'David MacBook', reviewAt: '2027-09-10T12:00:00.000Z', reviewOverdue: false }],
      statesWithoutPosture: ['MA', 'TX'] },
    lanes: {
      replies: [card({ firmId: 'account-reply', lane: 'replies', reason: 'reply_waiting', name: 'Replied Firm', nextStep: { kind: 'reply' } })],
      callbacks: [],
      due: [card({ firmId: 'account-tx', lane: 'due', reason: 'step_due', name: 'Lone Star Living', city: 'Austin', state: 'TX', timeZone: 'America/Chicago', localTime: '06:00', openNow: false,
        dialAllowed: false, holdReason: 'outside_hours', holdCode: 'outside_hours', lastOutcome: { outcome: 'voicemail', at: '2026-09-15T14:00:00.000Z', note: null },
        nextStep: { kind: 'call', stepIndex: 1, stepCount: 5, dueAt: '2026-09-18T13:00:00.000Z' } })],
      new: [card({ firmId: 'account-ri-1', lane: 'new', reason: 'new_firm', name: 'Rhode Island Firm 1' }),
        card({ firmId: 'account-ri-2', lane: 'new', reason: 'new_firm', name: 'Rhode Island Firm 2', phone: null })],
    },
  },
});
const list = view.list!;

describe('the Today model', () => {
  it('orders the four lanes replies, callbacks, due, new and shows every lane, empty or not', () => {
    expect(laneSections(list).map(section => [section.lane, section.title, section.cards.length])).toEqual([
      ['replies', 'Replies', 1], ['callbacks', 'Callbacks due', 0], ['due', 'Sequence calls due', 1], ['new', 'New firms', 2]]);
  });

  it('is fresh under two minutes, stale from two minutes, when served from the last good file, or after a failed read', () => {
    const fetchedAt = '2026-09-18T13:30:00.000Z'; const at = Date.parse(fetchedAt);
    expect(TODAY_REFRESH_MS).toBe(60_000); expect(TODAY_STALE_MS).toBe(120_000);
    expect(freshness({ fetchedAt, now: at + 119_999 })).toEqual({ stale: false, reason: null, ageSeconds: 119 });
    expect(freshness({ fetchedAt, now: at + 120_000 })).toEqual({ stale: true, reason: 'older_than_two_minutes', ageSeconds: 120 });
    expect(freshness({ fetchedAt, now: at + 5_000, source: 'last_good' })).toEqual({ stale: true, reason: 'last_good', ageSeconds: 5 });
    expect(freshness({ fetchedAt, now: at + 5_000, unavailable: true })).toEqual({ stale: true, reason: 'worker_unavailable', ageSeconds: 5 });
    expect(staleSentence(freshness({ fetchedAt, now: at + 5_000 }))).toBeNull();
    expect(staleSentence(freshness({ fetchedAt, now: at + 125_000 }))).toBe('This list is 2 min 5 s old. It refreshes every minute; a dial from a stale list is refused.');
    expect(staleSentence(freshness({ fetchedAt, now: at + 65_000, source: 'last_good' }))).toBe('Showing the last good list saved on this Mac, 1 min 5 s old. The worker has not answered.');
    expect(staleSentence(freshness({ fetchedAt, now: at + 65_000, unavailable: true }), 'The worker could not be reached.')).toBe('Showing the list fetched 1 min 5 s ago. The worker could not be reached.');
  });

  it('names the states without posture, the counts, the dial verdict, the next step and the number to copy', () => {
    expect(postureWarning(view)).toBe('No calling posture is recorded for MA and TX. Firms in these states are held until you record one.');
    expect(postureWarning({ ...view, list: { ...list, header: { ...list.header, statesWithoutPosture: ['MA'] } } })).toBe('No calling posture is recorded for MA. Firms in this state are held until you record one.');
    expect(postureWarning({ ...view, list: { ...list, header: { ...list.header, statesWithoutPosture: [] } } })).toBeNull();
    expect(postureWarning({ asOf: view.asOf, list: null, reason: 'no_posture', postures: [], statesWithoutPosture: ['RI'] })).toContain('RI');
    expect(countsLine(list)).toBe('1 replies · 0 callbacks · 1 due · 2 new · pool 2');
    expect(dialSentence(list.lanes.new[0]!)).toBe('Dial allowed (09:30 local)');
    expect(dialSentence(list.lanes.due[0]!)).toBe('Held: outside_hours at 06:00 local');
    expect(nextStepSentence(list.lanes.due[0]!)).toBe('Call 2 of 5, due 2026-09-18');
    expect(nextStepSentence(list.lanes.new[0]!)).toBe('First call');
    expect(copyNumberText(list.lanes.new[0]!)).toBe('+14015550201');
    expect(copyNumberText(list.lanes.new[1]!)).toBeNull();
  });
});

describe('the Today page rendering (react-dom/server)', () => {
  const render = (props: Parameters<typeof TodayList>[0]) => renderToStaticMarkup(createElement(TodayList, props));

  it('renders the four lane sections in order with their cards, the counts row, the as-of stamp and the posture warning', () => {
    const html = render({ view, fetchedAt: view.asOf, freshness: freshness({ fetchedAt: view.asOf, now: Date.parse(view.asOf) + 1000 }) });
    const lanes = [...html.matchAll(/data-lane="([a-z]+)"/g)].map(match => match[1]);
    expect(lanes).toEqual(['replies', 'callbacks', 'due', 'new']);
    expect(html).toContain('Replies (1)'); expect(html).toContain('Callbacks due (0)'); expect(html).toContain('Sequence calls due (1)'); expect(html).toContain('New firms (2)');
    expect(html).toContain('Nothing in this lane.');
    expect(html).toContain('data-firm-id="account-tx"'); expect(html).toContain('Held: outside_hours at 06:00 local');
    expect(html).toContain('Copy number'); expect(html).toContain('aria-label="Copy number for Rhode Island Firm 1"');
    // A firm without a phone route offers no Copy number button.
    expect((html.match(/Copy number</g) ?? []).length).toBe(3);
    expect(html).toContain('1 replies · 0 callbacks · 1 due · 2 new · pool 2');
    expect(html).toContain('<time dateTime="2026-09-18T13:30:00.000Z">2026-09-18T13:30:00.000Z</time>');
    expect(html).toContain('role="alert"'); expect(html).toContain('No calling posture is recorded for MA and TX.');
    expect(html).not.toContain('role="status"');
    // Nothing the worker did not send: no address, no excerpt, no authority word.
    expect(html).not.toMatch(/Hope St|formattedAddress|authority/i);
  });

  it('shows the stale banner when the view is older than two minutes, when it is the last good file, and after a failed read', () => {
    const at = Date.parse(view.asOf);
    const old = render({ view, fetchedAt: view.asOf, freshness: freshness({ fetchedAt: view.asOf, now: at + 121_000 }) });
    expect(old).toContain('role="status"'); expect(old).toContain('data-stale-reason="older_than_two_minutes"'); expect(old).toContain('This list is 2 min 1 s old.');
    const lastGood = render({ view, fetchedAt: view.asOf, freshness: freshness({ fetchedAt: view.asOf, now: at + 10_000, source: 'last_good' }) });
    expect(lastGood).toContain('data-stale-reason="last_good"'); expect(lastGood).toContain('Showing the last good list saved on this Mac');
    const failed = render({ view, fetchedAt: view.asOf, freshness: freshness({ fetchedAt: view.asOf, now: at + 10_000, unavailable: true }), unavailableSentence: 'The worker could not be reached.' });
    expect(failed).toContain('data-stale-reason="worker_unavailable"'); expect(failed).toContain('The worker could not be reached.');
    // The lanes are still there under the banner: a morning survives an outage.
    expect([...failed.matchAll(/data-lane="([a-z]+)"/g)]).toHaveLength(4);
  });

  it('renders the empty answers with their sentence and still warns about posture', () => {
    const empty: TodayView = { asOf: view.asOf, list: null, reason: 'not_built_yet', postures: [], statesWithoutPosture: ['RI'] };
    const html = render({ view: empty, fetchedAt: view.asOf, freshness: freshness({ fetchedAt: view.asOf, now: Date.parse(view.asOf) }) });
    expect(html).toContain('data-empty-reason="not_built_yet"'); expect(html).toContain('built at 05:00 Eastern');
    expect(html).toContain('No calling posture is recorded for RI.');
    expect(html).not.toContain('data-lane=');
    const noPosture = render({ view: { ...empty, reason: 'no_posture' }, fetchedAt: view.asOf, freshness: freshness({ fetchedAt: view.asOf, now: Date.parse(view.asOf) }) });
    expect(noPosture).toContain('No state has a calling posture yet.');
  });
});
