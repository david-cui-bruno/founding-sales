// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reasonSentence, type FirmIdentityDto, type UnmatchedMeetingDto } from '@fss/contracts';
import { FirmMeetings } from '../src/renderer/meetings/FirmMeetings.tsx';
import { BookingsToMatch, firmMatches, type BookingsToMatchPorts } from '../src/renderer/meetings/BookingsToMatch.tsx';

/**
 * The firm page's Meetings rows and the Pipeline screen's "Bookings to match" (slice
 * M1), with their ports faked: each meeting's state and time; a booking matched in two
 * clicks (the firm, then Match); a refusal shown as its sentence, never its code.
 * No real business, person or address.
 */

const FIRM_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_FIRM_ID = '33333333-3333-4333-8333-333333333333';
const MEETING_ID = '44444444-4444-4444-8444-444444444444';

afterEach(() => {
  cleanup();
});

const firm = (id: string, name: string): FirmIdentityDto =>
  ({ id, name, locality: null, regionCode: null, stageKey: null }) as unknown as FirmIdentityDto;

const unmatched = (extra: Partial<UnmatchedMeetingDto> = {}): UnmatchedMeetingDto => ({
  meetingId: MEETING_ID,
  state: 'booked',
  startsAt: '2026-10-14T15:00:00.000Z',
  endsAt: '2026-10-14T15:30:00.000Z',
  attendeeEmail: 'partner@example.test',
  reason: 'firm_unmatched',
  ...extra,
});

describe('the firm page s Meetings rows', () => {
  it('shows each meeting s state and time', async () => {
    render(
      <FirmMeetings
        firmId={FIRM_ID}
        ports={{
          forFirm: async () =>
            await Promise.resolve({
              meetings: [
                { meetingId: MEETING_ID, state: 'rescheduled', startsAt: '2026-10-16T18:00:00.000Z', endsAt: '2026-10-16T18:30:00.000Z' },
                { meetingId: '55555555-5555-4555-8555-555555555555', state: 'no_show', startsAt: '2026-10-01T15:00:00.000Z', endsAt: '2026-10-01T15:30:00.000Z' },
              ],
            }),
        }}
      />,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId('firm-meeting-row')).toHaveLength(2);
    });
    expect(screen.getAllByTestId('firm-meeting-state').map(node => node.textContent)).toEqual(['Rescheduled', 'No-show']);
    expect(screen.getAllByTestId('firm-meeting-row')[0]?.textContent).toContain('2026');
  });

  it('says "No meeting booked yet." once the read has answered and there is none', async () => {
    render(<FirmMeetings firmId={FIRM_ID} ports={{ forFirm: async () => await Promise.resolve({ meetings: [] }) }} />);
    expect((await screen.findByTestId('firm-meetings-empty')).textContent).toBe('No meeting booked yet.');
    expect(screen.queryByTestId('firm-meetings-unavailable')).toBeNull();
  });

  it('says nothing while the read is under way', async () => {
    let release: (value: { meetings: [] }) => void = () => undefined;
    const slow = new Promise<{ meetings: [] }>(resolve => {
      release = resolve;
    });
    const { container } = render(<FirmMeetings firmId={FIRM_ID} ports={{ forFirm: async () => await slow }} />);
    expect(container.textContent).toBe('');
    expect(screen.queryByTestId('firm-meetings-empty')).toBeNull();
    release({ meetings: [] });
    expect(await screen.findByTestId('firm-meetings-empty')).toBeTruthy();
  });

  it('says the read failed, and never "no meeting", when it did not answer or rejected', async () => {
    render(<FirmMeetings firmId={FIRM_ID} ports={{ forFirm: async () => await Promise.resolve({ meetings: null }) }} />);
    expect((await screen.findByTestId('firm-meetings-unavailable')).textContent).toContain('could not read');
    expect(screen.queryByTestId('firm-meetings-empty')).toBeNull();
    cleanup();
    render(<FirmMeetings firmId={FIRM_ID} ports={{ forFirm: async () => await Promise.reject(new Error('offline')) }} />);
    expect(await screen.findByTestId('firm-meetings-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('firm-meetings-empty')).toBeNull();
  });

  it('says nothing when there is no way to read meetings at all (the read is absent)', () => {
    const { container } = render(<FirmMeetings firmId={FIRM_ID} ports={null} />);
    expect(container.textContent).toBe('');
  });

  it('does not show the empty message for the previous firm while the next one is read', async () => {
    let release: (value: { meetings: [] }) => void = () => undefined;
    const slow = new Promise<{ meetings: [] }>(resolve => {
      release = resolve;
    });
    const OTHER = '66666666-6666-4666-8666-666666666666';
    const forFirm = (firmId: string) => (firmId === FIRM_ID ? Promise.resolve({ meetings: [] as [] }) : slow);
    const { rerender } = render(<FirmMeetings firmId={FIRM_ID} ports={{ forFirm: async id => await forFirm(id) }} />);
    await screen.findByTestId('firm-meetings-empty');
    rerender(<FirmMeetings firmId={OTHER} ports={{ forFirm: async id => await forFirm(id) }} />);
    await waitFor(() => {
      expect(screen.queryByTestId('firm-meetings-empty')).toBeNull();
    });
    release({ meetings: [] });
    expect(await screen.findByTestId('firm-meetings-empty')).toBeTruthy();
  });
});

describe('Bookings to match', () => {
  const firms = [firm(FIRM_ID, 'Lakeside Test Law'), firm(OTHER_FIRM_ID, 'Harbor Test Law')];

  function ports(answer: Awaited<ReturnType<BookingsToMatchPorts['match']>>, list: readonly UnmatchedMeetingDto[] = [unmatched()]) {
    let remaining = list;
    const match = vi.fn(async (_input: { meetingId: string; firmId: string }) => {
      if (answer.matched !== null) remaining = [];
      return await Promise.resolve(answer);
    });
    return { match, unmatched: async () => await Promise.resolve({ meetings: remaining }) };
  }

  it('finds the firm by name like the board s search', () => {
    expect(firmMatches(firms, 'harb').map(entry => entry.id)).toEqual([OTHER_FIRM_ID]);
    expect(firmMatches(firms, '  ')).toEqual([]);
  });

  it('matches a booking in two clicks and reads the board again', async () => {
    const fake = ports({
      matched: { meetingId: MEETING_ID, firmId: OTHER_FIRM_ID, contactId: null, state: 'booked', stage: 'moved' },
      reason: null,
    });
    const onMatched = vi.fn();
    render(<BookingsToMatch firms={firms} actionsEnabled ports={fake} onMatched={onMatched} />);
    await waitFor(() => {
      expect(screen.getByTestId('booking-to-match').textContent).toContain('partner@example.test');
    });
    expect((screen.getByTestId('booking-match') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('booking-firm-search'), { target: { value: 'Harbor' } });
    fireEvent.click(screen.getByTestId('booking-firm-option'));
    expect(screen.getByTestId('booking-picked-firm').textContent).toContain('Harbor Test Law');
    fireEvent.click(screen.getByTestId('booking-match'));
    await waitFor(() => {
      expect(onMatched).toHaveBeenCalledTimes(1);
    });
    expect(fake.match).toHaveBeenCalledWith({ meetingId: MEETING_ID, firmId: OTHER_FIRM_ID });
    await waitFor(() => {
      expect(screen.queryByTestId('bookings-to-match')).toBeNull();
    });
  });

  it('shows a refusal as its sentence, not its code', async () => {
    const fake = ports({ matched: null, reason: 'not_assigned' });
    render(<BookingsToMatch firms={firms} actionsEnabled ports={fake} />);
    await waitFor(() => {
      expect(screen.getByTestId('booking-firm-search')).toBeTruthy();
    });
    fireEvent.change(screen.getByTestId('booking-firm-search'), { target: { value: 'Lakeside' } });
    fireEvent.click(screen.getByTestId('booking-firm-option'));
    fireEvent.click(screen.getByTestId('booking-match'));
    await waitFor(() => {
      expect(screen.getByTestId('booking-match-problem').textContent).toBe(reasonSentence('not_assigned'));
    });
    expect(screen.getByTestId('booking-match-problem').textContent).not.toContain('not_assigned');
    // The booking is still there to match.
    expect(screen.getByTestId('booking-to-match')).toBeTruthy();
  });

  it('renders nothing when there is nothing to match', async () => {
    const { container } = render(<BookingsToMatch firms={firms} actionsEnabled ports={ports({ matched: null, reason: null }, [])} />);
    await waitFor(() => {
      expect(container.textContent).toBe('');
    });
  });

  it('offers no Match while actions are disabled', async () => {
    render(<BookingsToMatch firms={firms} actionsEnabled={false} ports={ports({ matched: null, reason: null })} />);
    await waitFor(() => {
      expect((screen.getByTestId('booking-firm-search') as HTMLInputElement).disabled).toBe(true);
    });
    expect((screen.getByTestId('booking-match') as HTMLButtonElement).disabled).toBe(true);
  });
});
