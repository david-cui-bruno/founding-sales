import { CalendarDays } from 'lucide-react';
import type { DailyMeeting } from '../../../shared/contracts/dailyContract';
export const meetingKey = (m: DailyMeeting) => `meeting:${m.accountId}:${m.id}`;
export function UpcomingMeetings({
  items,
  selected,
  name,
  onSelect,
  unavailable = false,
}: {
  items: DailyMeeting[];
  selected: string | null;
  name(id: string): string;
  onSelect(key: string): void;
  unavailable?: boolean;
}) {
  return (
    <section className="native-desk__lane" aria-labelledby="daily-meetings" tabIndex={0}>
      <h2 id="daily-meetings">
        <span className="native-desk__lane-label"><CalendarDays size={14} aria-hidden="true" />Upcoming meetings</span> <span className="native-desk__count">{unavailable ? 'Unavailable' : items.length}</span>
      </h2>
      {!items.length ? (
        null
      ) : (
        items.map((m) => (
          <button
            className="native-desk__row"
            key={meetingKey(m)}
            data-row-key={meetingKey(m)}
            aria-current={selected === meetingKey(m) ? 'true' : undefined}
            aria-label={`Meeting · ${name(m.accountId)} · ${m.payload.outcome.status}`}
            onClick={() => onSelect(meetingKey(m))}
          >
            <strong>{name(m.accountId)}</strong>
            <small>{m.payload.outcome.status}</small>
            <span>
              {m.payload.outcome.event?.start
                ? new Date(m.payload.outcome.event.start).toLocaleString()
                : 'Time unconfirmed'}
            </span>
          </button>
        ))
      )}
    </section>
  );
}
export function MeetingDetail({ item }: { item: DailyMeeting }) {
  const { outcome, observedAt } = item.payload;
  return (
    <section>
      <h3>Calendar meeting</h3>
      <p>Calendar outcome: {outcome.status}</p>
      {outcome.reason && <p>{outcome.reason}</p>}
      {outcome.event && (
        <>
          <p>Provider event: {outcome.event.status}</p>
          {outcome.event.start && (
            <p>
              <time dateTime={outcome.event.start}>
                {new Date(outcome.event.start).toLocaleString()}
              </time>
              {outcome.event.end && (
                <>
                  {' '}
                  to{' '}
                  <time dateTime={outcome.event.end}>
                    {new Date(outcome.event.end).toLocaleString()}
                  </time>
                </>
              )}
            </p>
          )}
          <h4>Invitation responses</h4>
          {outcome.event.attendees.map((a) => (
            <p key={a.email}>
              {a.email} · {a.responseStatus}
            </p>
          ))}
        </>
      )}
      <p>Attendance not recorded by this calendar outcome.</p>
      <p className="native-desk__hold">
        Calendar changes are not available here. Review this event in your
        calendar provider before making changes.
      </p>
      <details>
        <summary>Calendar evidence</summary>
        <p>Meeting: {item.id}</p>
        <p>Calendar: {outcome.calendarId}</p>
        <p>Provider event: {outcome.providerEventId}</p>
        <p>Observed: {observedAt}</p>
        <p>Command: {item.payload.commandId}</p>
      </details>
    </section>
  );
}
