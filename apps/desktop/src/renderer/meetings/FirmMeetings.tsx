import { useEffect, useRef, useState, type JSX } from 'react';
import { reasonSentence, type FirmMeetingDto, type MeetingAttendanceChoice, type MeetingAttendanceSet, type StageSuggestion } from '@fss/contracts';
import { shortDayTime } from '../dates.ts';
import { noDefiniteAnswer } from '../today/afterCallModel.ts';
import { Button } from '../ui/button.tsx';
import { Tag } from '../ui/layout.tsx';
import { useAttendanceMemory, type AttendanceCommand } from './attendanceMemory.ts';
import { meetingRowWord, meetingStateWarns } from './meetingText.ts';

/**
 * The firm page's Meetings rows (slice M1; attendance, lane M1): each Cal.com booking with the
 * firm, its state and its time, newest first. Its own read (`meetings.forFirm`), like the Calls
 * rows beside it, so the firm page read and its strict contract are unchanged. Renders nothing
 * until the firm has a meeting.
 *
 * **Attendance.** Cal.com's end is the scheduled end, so a meeting past it reads "Ended ·
 * attendance not confirmed", with two quiet actions on hover or focus: Attended and No-show. A
 * person's own confirmation reads "Held" or "No-show" with a small Undo; Cal.com's no-show has
 * no Undo here (the server refuses it). The command and its answer are kept above the row
 * (`attendanceMemory.ts`): leaving the firm and coming back keeps a pending command, its Retry
 * and its answer (K3), an answer clears it (K6), and a read that began before an answer never
 * shows the old state (K7).
 *
 * **The stage suggestion.** A live booking no longer moves the deal (lane M1). When the read
 * says a move to Demo booked is due, one quiet line offers it; the click is the ordinary stage
 * command, made by the firm page (`onApplySuggestion`).
 */

export interface FirmMeetingsPorts {
  forFirm(firmId: string): Promise<{ readonly meetings: readonly FirmMeetingDto[] | null; readonly stageSuggestion?: StageSuggestion | null }>;
  setAttendance?(input: {
    readonly meetingId: string;
    readonly attendance: MeetingAttendanceChoice;
    readonly commandId: string;
  }): Promise<{ readonly set: MeetingAttendanceSet | null; readonly reason: string | null }>;
}

export function registryMeetingPorts(): FirmMeetingsPorts | null {
  const api = globalThis.callieApi;
  if (api === undefined) return null;
  return {
    forFirm: async firmId => await api.read('meetings.forFirm', { firmId }),
    setAttendance: async input => await api.command('meetings.setAttendance', input),
  };
}

const LOST_ANSWER = 'The answer was lost. Retry sends the same request again.';

interface Shown {
  readonly meetingId: string;
  readonly state: string;
  readonly attendanceSource: string | null;
  readonly startsAt: string;
}

export function FirmMeetings({
  firmId,
  ports = registryMeetingPorts(),
  actionsEnabled = true,
  refreshKey = '',
  onApplySuggestion,
  suggestionBusy = false,
}: {
  readonly firmId: string;
  readonly ports?: FirmMeetingsPorts | null;
  /** Commands are offered only while the session may change things. */
  readonly actionsEnabled?: boolean;
  /** Anything that should read the meetings again when it changes: the deal's stage, say. */
  readonly refreshKey?: string;
  /** The ordinary stage command for "Move to Demo booked"; absent, the line is not offered. */
  onApplySuggestion?(suggestion: StageSuggestion): void;
  readonly suggestionBusy?: boolean;
}): JSX.Element | null {
  const [meetings, setMeetings] = useState<readonly FirmMeetingDto[] | null | undefined>(undefined);
  const [suggestion, setSuggestion] = useState<StageSuggestion | null>(null);
  const portsRef = useRef(ports);
  portsRef.current = ports;
  const { memory, touch } = useAttendanceMemory();
  const successes = memory.successes.get(firmId) ?? 0;

  useEffect(() => {
    let current = true;
    // A read that begins before an answer is dropped when it lands after it (K7): the answer
    // moves this firm's count, so this effect runs again — `current` drops the older read —
    // and the answer is shown meanwhile.
    void portsRef.current?.forFirm(firmId).then(
      answer => {
        if (!current) return;
        for (const meeting of answer.meetings ?? []) memory.answered.delete(meeting.meetingId);
        setMeetings(answer.meetings);
        setSuggestion(answer.stageSuggestion ?? null);
      },
      () => {
        if (current) setMeetings(null);
      },
    );
    return () => {
      current = false;
    };
    // `memory` is the session's: a new session remounts the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firmId, refreshKey, successes]);

  // A different firm starts from nothing: never another firm's rows (K7).
  const shownFirm = useRef(firmId);
  if (shownFirm.current !== firmId) {
    shownFirm.current = firmId;
    if (meetings !== undefined) setMeetings(undefined);
    if (suggestion !== null) setSuggestion(null);
  }

  const send = (meetingId: string, attendance: MeetingAttendanceChoice, retry = false): void => {
    const setAttendance = ports?.setAttendance;
    if (setAttendance === undefined || memory.inFlight.has(meetingId)) return;
    const kept = memory.commands.get(meetingId);
    const command: AttendanceCommand =
      retry && kept !== undefined ? kept : { id: crypto.randomUUID(), firmId, attendance };
    memory.commands.set(meetingId, command);
    memory.inFlight.add(meetingId);
    memory.notes.delete(meetingId);
    touch();
    const settle = (answer: { readonly set: MeetingAttendanceSet | null; readonly reason: string | null } | null): void => {
      memory.inFlight.delete(meetingId);
      // A newer command for this meeting replaced this one: its answer is the one that counts.
      if (memory.commands.get(meetingId) !== command) {
        touch();
        return;
      }
      const reason = answer?.reason ?? 'offline';
      if (answer === null || (answer.set === null && noDefiniteAnswer(reason))) {
        memory.notes.set(meetingId, { text: LOST_ANSWER, alert: true });
        touch();
        return;
      }
      memory.commands.delete(meetingId);
      if (answer.set !== null) {
        memory.answered.set(meetingId, answer.set);
        memory.successes.set(command.firmId, (memory.successes.get(command.firmId) ?? 0) + 1);
      } else {
        memory.notes.set(meetingId, { text: reasonSentence(reason), alert: true });
      }
      touch();
    };
    void setAttendance({ meetingId, attendance: command.attendance, commandId: command.id }).then(settle, () => {
      settle(null);
    });
  };

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
  const canCommand = actionsEnabled && ports.setAttendance !== undefined;
  const shown = (meeting: FirmMeetingDto): Shown => {
    const answered = memory.answered.get(meeting.meetingId);
    return {
      meetingId: meeting.meetingId,
      startsAt: meeting.startsAt,
      state: answered?.state ?? meeting.state,
      attendanceSource: answered === undefined ? (meeting.attendanceSource ?? null) : answered.attendanceSource,
    };
  };
  return (
    <section data-testid="firm-meetings" className="flex flex-col">
      <h3 className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">Meetings</h3>
      {suggestion !== null && onApplySuggestion !== undefined ? (
        <p data-testid="stage-suggestion" className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
          <span>A demo is booked.</span>
          <Button
            size="sm"
            variant="quiet"
            data-testid="stage-suggestion-apply"
            disabled={!actionsEnabled || suggestionBusy}
            {...(suggestionBusy ? { 'aria-busy': true } : {})}
            onClick={() => {
              onApplySuggestion(suggestion);
            }}
          >
            Move to Demo booked
          </Button>
        </p>
      ) : null}
      <ul className="flex flex-col border-t border-border">
        {meetings.map(meeting => {
          const row = shown(meeting);
          const busy = memory.inFlight.has(row.meetingId);
          const note = memory.notes.get(row.meetingId);
          const unanswered = memory.commands.get(row.meetingId);
          const manual = row.attendanceSource === 'manual';
          const action = (attendance: MeetingAttendanceChoice, label: string, testId: string): JSX.Element => (
            <Button
              size="sm"
              variant="quiet"
              data-testid={testId}
              disabled={!canCommand || busy}
              {...(busy ? { 'aria-busy': true } : {})}
              onClick={() => {
                send(row.meetingId, attendance);
              }}
            >
              {label}
            </Button>
          );
          return (
            <li
              key={row.meetingId}
              data-testid="firm-meeting-row"
              data-meeting-id={row.meetingId}
              className="group flex flex-col border-b border-border py-1.5 text-sm"
            >
              <div className="flex items-center gap-3">
                <span className="flex-1 truncate">{shortDayTime(row.startsAt)}</span>
                {canCommand ? (
                  <span
                    data-testid="attendance-actions"
                    className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                  >
                    {row.state === 'ended' ? (
                      <>
                        {action('attended', 'Attended', 'attendance-attended')}
                        {action('no_show', 'No-show', 'attendance-no-show')}
                      </>
                    ) : null}
                    {(row.state === 'held' || row.state === 'no_show') && manual ? action('unconfirmed', 'Undo', 'attendance-undo') : null}
                  </span>
                ) : null}
                <Tag data-testid="firm-meeting-state" tone={meetingStateWarns(row.state) ? 'warn' : 'none'}>
                  {meetingRowWord(row.state)}
                </Tag>
              </div>
              {note === undefined ? null : (
                <p data-testid="attendance-note" role={note.alert ? 'alert' : 'status'} className="mt-0.5 flex items-center gap-2 text-xs text-destructive">
                  <span>{note.text}</span>
                  {unanswered !== undefined && !busy && canCommand ? (
                    <Button
                      size="sm"
                      variant="quiet"
                      data-testid="attendance-retry"
                      onClick={() => {
                        send(row.meetingId, unanswered.attendance, true);
                      }}
                    >
                      Retry
                    </Button>
                  ) : null}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
