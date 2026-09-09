// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { DailyMeeting } from '../../../shared/contracts/dailyContract';
import { MeetingDetail } from './UpcomingMeetings';
afterEach(cleanup);
it.each(['booked', 'held', 'unknown', 'cancelled'] as const)(
  'preserves genuine C5 %s and distinguishes invitation from attendance',
  (status) => {
    const identity = {
      meetingId: 'meeting',
      calendarId: 'calendar',
      providerEventId: 'aaaaa',
    };
    const item: DailyMeeting = {
      id: 'meeting',
      accountId: 'a',
      revision: 1,
      payload: {
        commandId: 'command',
        observedAt: '2026-09-09T12:00:00.000Z',
        outcome: {
          ...identity,
          status,
          reason: null,
          event:
            status === 'booked' || status === 'cancelled'
              ? {
                  ...identity,
                  status: status === 'booked' ? 'confirmed' : 'cancelled',
                  etag: 'etag',
                  start: '2026-09-10T12:00:00.000Z',
                  end: '2026-09-10T12:30:00.000Z',
                  attendees: [
                    { email: 'a@fixture.invalid', responseStatus: 'accepted' },
                  ],
                  meetUrl: null,
                }
              : null,
        },
      },
    };
    render(<MeetingDetail item={item} />);
    expect(screen.getByText(`Calendar outcome: ${status}`)).toBeTruthy();
    expect(screen.getByText(/Attendance not recorded/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reschedule' })).toBeNull();
    if (status === 'booked')
      expect(screen.getByText('a@fixture.invalid · accepted')).toBeTruthy();
  },
);
