// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FirmMeetingDto, MeetingBriefResponse } from '@fss/contracts';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import { resetAttendanceMemory } from '../src/renderer/meetings/attendanceMemory.ts';
import { resetBriefMemory } from '../src/renderer/meetings/briefMemory.ts';
import { FirmMeetings, type FirmMeetingsPorts } from '../src/renderer/meetings/FirmMeetings.tsx';
import { FIRM_ID, OTHER_FIRM_ID } from './e2e/support/crmFixtures.ts';

/**
 * Lane M2: the meeting brief's "Brief" disclosure on the firm page's Meetings rows, with the
 * kept-state tests written first (K1, K3, K4, K7, `KEPT-STATE-RULES.md`):
 *
 *   * K1 — what the disclosure keeps (open or not, the brief it read) is keyed by session and
 *     meeting: a sign-out forgets it;
 *   * K3 — it is kept per meeting above the row: leaving the firm and coming back keeps a
 *     brief open, and two meetings keep their own;
 *   * K4 — navigation keys on the disclosure do nothing;
 *   * K7 — a read for one meeting never shows under another, and a read begun before a newer
 *     one never replaces it.
 *
 * Offered on a meeting whose start is within seven days, or past and unconfirmed. No real
 * business or person.
 */

const MEETING = '44444444-4444-4444-8444-444444444401';
const OTHER = '44444444-4444-4444-8444-444444444402';
const DAY = 86_400_000;
const inDays = (days: number): string => new Date(Date.now() + days * DAY).toISOString();

const row = (meetingId: string, state: string, startsAt: string, attendanceSource: string | null = null): FirmMeetingDto => ({
  meetingId,
  state,
  startsAt,
  endsAt: new Date(Date.parse(startsAt) + 30 * 60_000).toISOString(),
  attendanceSource,
});

const item = (text: string, source: MeetingBriefResponse['sections']['firm']['items'][number]['source'] = 'booking_notes') => ({
  label: null,
  text,
  source,
  provenance: 'stated' as const,
  at: '2026-10-01T12:00:00.000Z',
  sourceUrl: null,
});
const emptySection = { items: [], omitted: 0 };

function brief(meetingId: string, why: readonly string[], firmId = FIRM_ID): MeetingBriefResponse {
  return {
    meetingId,
    firmId,
    meeting: { title: 'Callie demo', attendeeName: 'Dana Example', state: 'booked', startsAt: inDays(2), endsAt: inDays(2), locationType: 'zoom_video' },
    sections: {
      whyThisDemo: { items: why.map(text => item(text)), omitted: 0 },
      firm: emptySection,
      conversations: emptySection,
      objections: emptySection,
      commitments: emptySection,
    },
    generatedAt: '2026-10-03T12:00:00.000Z',
  };
}

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

type BriefAnswer = { readonly brief: MeetingBriefResponse | null; readonly reason: string | null };

/** Ports whose brief reads are answered by hand, in any order. */
function harness(meetings: Readonly<Record<string, readonly FirmMeetingDto[]>>) {
  const reads: { meetingId: string; answer: Deferred<BriefAnswer> }[] = [];
  const ports: FirmMeetingsPorts = {
    forFirm: async firmId => await Promise.resolve({ meetings: meetings[firmId] ?? [], stageSuggestion: null }),
    brief: async meetingId => {
      const answer = deferred<BriefAnswer>();
      reads.push({ meetingId, answer });
      return await answer.promise;
    },
  };
  return { ports, reads };
}

function Session({ children }: { readonly children: ReactNode }): JSX.Element {
  return <DraftsProvider>{children}</DraftsProvider>;
}

const rowOf = async (meetingId: string): Promise<HTMLElement> =>
  (await screen.findAllByTestId('firm-meeting-row')).find(node => node.getAttribute('data-meeting-id') === meetingId) as HTMLElement;

beforeEach(() => {
  resetAttendanceMemory();
  resetBriefMemory();
});
afterEach(() => {
  cleanup();
});

describe('which meetings offer a brief', () => {
  it('a meeting within seven days, or past and unconfirmed; not a later one, a cancelled one or a confirmed one', async () => {
    const { ports } = harness({
      [FIRM_ID]: [
        row('44444444-4444-4444-8444-444444444411', 'booked', inDays(3)),
        row('44444444-4444-4444-8444-444444444412', 'booked', inDays(9)),
        row('44444444-4444-4444-8444-444444444413', 'ended', inDays(-2)),
        row('44444444-4444-4444-8444-444444444414', 'held', inDays(-3), 'manual'),
        row('44444444-4444-4444-8444-444444444415', 'cancelled', inDays(1)),
        row('44444444-4444-4444-8444-444444444416', 'no_show', inDays(-4), 'calcom_no_show'),
      ],
    });
    render(
      <Session>
        <FirmMeetings firmId={FIRM_ID} ports={ports} />
      </Session>,
    );
    const offered = async (suffix: string) => within(await rowOf(`44444444-4444-4444-8444-4444444444${suffix}`)).queryByTestId('meeting-brief-toggle') !== null;
    expect(await offered('11')).toBe(true);
    expect(await offered('12')).toBe(false);
    expect(await offered('13')).toBe(true);
    expect(await offered('14')).toBe(false);
    expect(await offered('15')).toBe(false);
    expect(await offered('16')).toBe(false);
  });
});

describe('kept state (K1, K3, K4, K7)', () => {
  it('K3: a brief left open survives leaving the firm and coming back, and each meeting keeps its own', async () => {
    const { ports, reads } = harness({ [FIRM_ID]: [row(MEETING, 'booked', inDays(2)), row(OTHER, 'booked', inDays(4))], [OTHER_FIRM_ID]: [] });
    const view = render(
      <Session>
        <FirmMeetings firmId={FIRM_ID} ports={ports} />
      </Session>,
    );
    await userEvent.click(within(await rowOf(MEETING)).getByTestId('meeting-brief-toggle'));
    await act(async () => {
      reads[0]?.answer.resolve({ brief: brief(MEETING, ['Requests come in by text.']), reason: null });
      await Promise.resolve();
    });
    expect(within(await rowOf(MEETING)).getByTestId('meeting-brief').textContent).toContain('Requests come in by text.');
    expect(within(await rowOf(OTHER)).queryByTestId('meeting-brief')).toBeNull();
    // Away to another firm, then off the page entirely, and back — in the same session (one
    // drafts provider): still open, its brief shown.
    view.rerender(
      <Session>
        <FirmMeetings firmId={OTHER_FIRM_ID} ports={ports} />
      </Session>,
    );
    view.rerender(<Session>{null}</Session>);
    expect(screen.queryByTestId('firm-meeting-row')).toBeNull();
    view.rerender(
      <Session>
        <FirmMeetings firmId={FIRM_ID} ports={ports} />
      </Session>,
    );
    expect(within(await rowOf(MEETING)).getByTestId('meeting-brief').textContent).toContain('Requests come in by text.');
    expect(within(await rowOf(OTHER)).queryByTestId('meeting-brief')).toBeNull();
  });

  it('K1: a sign-out forgets the open brief and what it read', async () => {
    const { ports, reads } = harness({ [FIRM_ID]: [row(MEETING, 'booked', inDays(2))] });
    const first = render(
      <Session>
        <FirmMeetings firmId={FIRM_ID} ports={ports} />
      </Session>,
    );
    await userEvent.click(within(await rowOf(MEETING)).getByTestId('meeting-brief-toggle'));
    await act(async () => {
      reads[0]?.answer.resolve({ brief: brief(MEETING, ['Kept only for this session.']), reason: null });
      await Promise.resolve();
    });
    first.unmount();
    // A new session: a new drafts provider is a new epoch.
    render(
      <Session>
        <FirmMeetings firmId={FIRM_ID} ports={ports} />
      </Session>,
    );
    const shown = await rowOf(MEETING);
    expect(within(shown).queryByTestId('meeting-brief')).toBeNull();
    expect(screen.queryByText('Kept only for this session.')).toBeNull();
    expect(within(shown).getByTestId('meeting-brief-toggle').getAttribute('aria-expanded')).toBe('false');
  });

  it('K7: an answer for one meeting never shows under another, and a late, older read never replaces a newer one', async () => {
    const { ports, reads } = harness({ [FIRM_ID]: [row(MEETING, 'booked', inDays(2)), row(OTHER, 'booked', inDays(3))] });
    render(
      <Session>
        <FirmMeetings firmId={FIRM_ID} ports={ports} />
      </Session>,
    );
    const toggle = within(await rowOf(MEETING)).getByTestId('meeting-brief-toggle');
    await userEvent.click(toggle);
    // Closed and opened again: a second read begins while the first is on the wire.
    await userEvent.click(toggle);
    await userEvent.click(toggle);
    await userEvent.click(within(await rowOf(OTHER)).getByTestId('meeting-brief-toggle'));
    expect(reads.map(read => read.meetingId)).toEqual([MEETING, MEETING, OTHER]);
    await act(async () => {
      reads[1]?.answer.resolve({ brief: brief(MEETING, ['The newer read.']), reason: null });
      reads[2]?.answer.resolve({ brief: brief(OTHER, ['The other meeting.']), reason: null });
      await Promise.resolve();
    });
    await act(async () => {
      reads[0]?.answer.resolve({ brief: brief(MEETING, ['The older read.']), reason: null });
      await Promise.resolve();
    });
    const mine = within(await rowOf(MEETING)).getByTestId('meeting-brief').textContent ?? '';
    expect(mine).toContain('The newer read.');
    expect(mine).not.toContain('The older read.');
    expect(mine).not.toContain('The other meeting.');
    expect(within(await rowOf(OTHER)).getByTestId('meeting-brief').textContent).toContain('The other meeting.');
  });

  it('K7: an answer naming another meeting than the one asked is dropped', async () => {
    const { ports, reads } = harness({ [FIRM_ID]: [row(MEETING, 'booked', inDays(2))] });
    render(
      <Session>
        <FirmMeetings firmId={FIRM_ID} ports={ports} />
      </Session>,
    );
    await userEvent.click(within(await rowOf(MEETING)).getByTestId('meeting-brief-toggle'));
    await act(async () => {
      reads[0]?.answer.resolve({ brief: brief(OTHER, ['Not this meeting.']), reason: null });
      await Promise.resolve();
    });
    expect(screen.queryByText('Not this meeting.')).toBeNull();
  });

  it('K4: J and K on the disclosure do nothing; only a click or Enter toggles it', async () => {
    const { ports, reads } = harness({ [FIRM_ID]: [row(MEETING, 'booked', inDays(2))] });
    render(
      <Session>
        <FirmMeetings firmId={FIRM_ID} ports={ports} />
      </Session>,
    );
    const toggle = within(await rowOf(MEETING)).getByTestId('meeting-brief-toggle');
    toggle.focus();
    await userEvent.keyboard('j');
    await userEvent.keyboard('k');
    expect(reads).toHaveLength(0);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('the brief, shown', () => {
  it('says unknown when nothing explains the demo, says where each line came from, and shows more on request', async () => {
    const { ports, reads } = harness({ [FIRM_ID]: [row(MEETING, 'booked', inDays(2))] });
    render(
      <Session>
        <FirmMeetings firmId={FIRM_ID} ports={ports} />
      </Session>,
    );
    await userEvent.click(within(await rowOf(MEETING)).getByTestId('meeting-brief-toggle'));
    const full = brief(MEETING, []);
    const answer: MeetingBriefResponse = {
      ...full,
      sections: {
        ...full.sections,
        firm: {
          items: [
            { ...item('Ask for Dana.', 'prepared_brief'), label: 'Prepared research', provenance: 'unverified', at: '2026-09-20' },
            { ...item('Pay rent through AppFolio', 'research_fact'), label: 'Software', provenance: 'observed' },
            { ...item('Submit a request by text', 'research_fact'), label: 'Maintenance workflow', provenance: 'observed' },
            { ...item('240 doors.', 'prepared_brief'), label: 'Prepared research', provenance: 'unverified', at: '2026-09-20' },
          ],
          omitted: 0,
        },
      },
    };
    await act(async () => {
      reads[0]?.answer.resolve({ brief: answer, reason: null });
      await Promise.resolve();
    });
    const panel = within(await rowOf(MEETING)).getByTestId('meeting-brief');
    expect(within(panel).getByTestId('brief-section-whyThisDemo').textContent).toContain('Unknown');
    const firm = within(panel).getByTestId('brief-section-firm');
    expect(firm.textContent).toContain('not verified by Callie');
    expect(firm.textContent).not.toContain('240 doors.');
    await userEvent.click(within(firm).getByTestId('brief-show-more'));
    expect(firm.textContent).toContain('240 doors.');
  });

  it('a read that did not answer says so, and is not a brief with nothing in it', async () => {
    const { ports, reads } = harness({ [FIRM_ID]: [row(MEETING, 'booked', inDays(2))] });
    render(
      <Session>
        <FirmMeetings firmId={FIRM_ID} ports={ports} />
      </Session>,
    );
    await userEvent.click(within(await rowOf(MEETING)).getByTestId('meeting-brief-toggle'));
    await act(async () => {
      reads[0]?.answer.resolve({ brief: null, reason: 'offline' });
      await Promise.resolve();
    });
    expect(within(await rowOf(MEETING)).getByTestId('meeting-brief-unavailable')).toBeTruthy();
  });
});
