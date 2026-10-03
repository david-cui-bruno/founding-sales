import { useEffect, useRef, useState, type JSX } from 'react';
import type { FirmMeetingDto } from '@fss/contracts';
import { shortDayTime } from '../dates.ts';
import { Tag } from '../ui/layout.tsx';
import { MEETING_STATE_WORDS } from './meetingText.ts';

/**
 * The firm page's Meetings rows (slice M1): each Cal.com booking with the firm, its state
 * and its time, newest first. Its own read (`meetings.forFirm`), like the Calls rows
 * beside it, so the firm page read and its strict contract are unchanged. Renders
 * nothing until the firm has a meeting.
 */

export interface FirmMeetingsPorts {
  forFirm(firmId: string): Promise<{ readonly meetings: readonly FirmMeetingDto[] | null }>;
}

export function registryMeetingPorts(): FirmMeetingsPorts | null {
  const api = globalThis.callieApi;
  if (api === undefined) return null;
  return { forFirm: async firmId => await api.read('meetings.forFirm', { firmId }) };
}

export function FirmMeetings({
  firmId,
  ports = registryMeetingPorts(),
}: {
  readonly firmId: string;
  readonly ports?: FirmMeetingsPorts | null;
}): JSX.Element | null {
  const [meetings, setMeetings] = useState<readonly FirmMeetingDto[] | null | undefined>(undefined);
  const portsRef = useRef(ports);
  portsRef.current = ports;

  useEffect(() => {
    let current = true;
    setMeetings(undefined);
    void portsRef.current?.forFirm(firmId).then(
      answer => {
        if (current) setMeetings(answer.meetings);
      },
      () => {
        if (current) setMeetings(null);
      },
    );
    return () => {
      current = false;
    };
  }, [firmId]);

  if (ports === null || meetings === undefined) return null;
  if (meetings === null) {
    return (
      <p data-testid="firm-meetings-unavailable" className="text-xs text-muted-foreground">
        Callie could not read this firm’s meetings just now.
      </p>
    );
  }
  // Loaded, and there is none: said once, quietly. It is never shown while the read is under
  // way (above: undefined) or when it failed (null), so a read that did not answer cannot read
  // as "no meeting".
  if (meetings.length === 0) {
    return (
      <p data-testid="firm-meetings-empty" className="text-xs text-muted-foreground">
        No meeting booked yet.
      </p>
    );
  }
  return (
    <section data-testid="firm-meetings" className="flex flex-col">
      <h3 className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Meetings</h3>
      <ul className="flex flex-col border-t border-border">
        {meetings.map(meeting => (
          <li key={meeting.meetingId} data-testid="firm-meeting-row" className="flex items-center gap-3 border-b border-border py-1.5 text-sm">
            <span className="flex-1 truncate">{shortDayTime(meeting.startsAt)}</span>
            <Tag data-testid="firm-meeting-state" tone={meeting.state === 'cancelled' || meeting.state === 'no_show' ? 'warn' : 'none'}>
              {MEETING_STATE_WORDS[meeting.state]}
            </Tag>
          </li>
        ))}
      </ul>
    </section>
  );
}
