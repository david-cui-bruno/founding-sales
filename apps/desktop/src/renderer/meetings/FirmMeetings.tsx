import { MeetingOutcomes } from './MeetingOutcomes.tsx';
import { useEffect, useRef, useState, type JSX } from 'react';
import { reasonSentence, type FirmMeetingDto, type FirmRecording, type MeetingAttendanceChoice, type MeetingAttendanceSet, type StageSuggestion } from '@fss/contracts';
import { shortDayTime } from '../dates.ts';
import { noDefiniteAnswer } from '../today/afterCallModel.ts';
import { Button } from '../ui/button.tsx';
import { Tag } from '../ui/layout.tsx';
import { useAttendanceMemory, type AttendanceCommand } from './attendanceMemory.ts';
import { useBriefMemory } from './briefMemory.ts';
import { MeetingBrief, type BriefReader } from './MeetingBrief.tsx';
import { meetingRowWord, meetingStateWarns } from './meetingText.ts';
import { FirmRecordings, MeetingRecordingTag, meetingRecordingItem, meetingServerState } from '../recordings/FirmRecordings.tsx';
import { registryRecordingPorts, useRecordings, type RecordingsPorts } from '../recordings/recordingsMemory.ts';

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
 * command, made by the firm page (`onApplySuggestion`), for the firm it was read for. It is
 * offered only while the page shows the deal's stage the read began under (`refreshKey`): a
 * stage change hides it until the read that change caused lands.
 */

export interface FirmMeetingsPorts {
  forFirm(firmId: string): Promise<{ readonly meetings: readonly FirmMeetingDto[] | null; readonly stageSuggestion?: StageSuggestion | null }>;
  setAttendance?(input: {
    readonly meetingId: string;
    readonly attendance: MeetingAttendanceChoice;
    readonly commandId: string;
  }): Promise<{ readonly set: MeetingAttendanceSet | null; readonly reason: string | null }>;
  /** Lane M2: the meeting brief (`meetings.brief`); absent, no row offers one. */
  brief?: BriefReader;
}

export function registryMeetingPorts(): FirmMeetingsPorts | null {
  const api = globalThis.callieApi;
  if (api === undefined) return null;
  return {
    forFirm: async firmId => await api.read('meetings.forFirm', { firmId }),
    setAttendance: async input => await api.command('meetings.setAttendance', input),
    brief: async meetingId => await api.read('meetings.brief', { meetingId }),
  };
}

const LOST_ANSWER = 'The answer was lost. Retry sends the same request again.';

/** A brief is offered for the week ahead (lane M2). */
const BRIEF_HORIZON_MS = 7 * 86_400_000;

/**
 * Whether a row offers its brief: a meeting whose start is within seven days, or one in the
 * past that nobody has confirmed. Not a cancelled one, and not a confirmed one.
 */
export function briefOffered(row: { readonly state: string; readonly startsAt: string }, now: number = Date.now()): boolean {
  if (row.state === 'cancelled' || row.state === 'held' || row.state === 'no_show') return false;
  const start = Date.parse(row.startsAt);
  return Number.isFinite(start) && start <= now + BRIEF_HORIZON_MS;
}

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
  recordingPorts = registryRecordingPorts(),
}: {
  readonly firmId: string;
  readonly ports?: FirmMeetingsPorts | null;
  /** Commands are offered only while the session may change things. */
  readonly actionsEnabled?: boolean;
  /** Anything that should read the meetings again when it changes: the deal's stage, say. */
  readonly refreshKey?: string;
  /**
   * The ordinary stage command for "Move to Demo booked"; absent, the line is not offered. It
   * is told the firm the suggestion was read for (review M1R, finding 2), never the page's.
   */
  onApplySuggestion?(suggestion: StageSuggestion, firmId: string): void;
  readonly suggestionBusy?: boolean;
  /** Lane M4: this Mac's demo recording import, for each meeting's recording state. */
  readonly recordingPorts?: RecordingsPorts | null;
}): JSX.Element | null {
  const [meetings, setMeetings] = useState<readonly FirmMeetingDto[] | null | undefined>(undefined);
  // The suggestion, with the firm and the `refreshKey` its read began under: offered only while
  // both are still this row's, so a stage change hides it until the read it caused lands
  // (review M1R, finding 6).
  const [suggested, setSuggested] = useState<{ readonly firmId: string; readonly refreshKey: string; readonly suggestion: StageSuggestion } | null>(null);
  const portsRef = useRef(ports);
  portsRef.current = ports;
  const { memory, touch } = useAttendanceMemory();
  const briefs = useBriefMemory();
  const recordings = useRecordings(recordingPorts);
  const successes = memory.successes.get(firmId) ?? 0;
  // R4: the firm's registered recordings, from the server, with the firm they were read for.
  const [server, setServer] = useState<{ readonly firmId: string; readonly rows: readonly FirmRecording[] | null } | null>(null);
  const recordingPortsRef = useRef(recordingPorts);
  recordingPortsRef.current = recordingPorts;
  // Read again whenever this Mac's import moves (an item registered leaves the local list).
  const localKey = (recordings.view?.items ?? []).map(item => `${item.itemId}:${String(item.version)}`).join(',');
  useEffect(() => {
    let current = true;
    const read = recordingPortsRef.current?.forFirm;
    if (read === undefined) return undefined;
    void read(firmId).then(
      answer => {
        if (current) setServer({ firmId, rows: answer.recordings });
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [firmId, refreshKey, localKey]);
  const serverRows = server !== null && server.firmId === firmId ? server.rows : null;

  useEffect(() => {
    let current = true;
    // A read that begins before an answer is dropped when it lands after it (K7): the answer
    // moves this firm's count, so this effect runs again — `current` drops the older read —
    // and the answer is shown meanwhile. One that lands before this effect runs again (the same
    // turn as the answer) clears only the answers it began after (review M1R, finding 5).
    const issued = memory.clock.now;
    const readKey = refreshKey;
    void portsRef.current?.forFirm(firmId).then(
      answer => {
        if (!current) return;
        for (const meeting of answer.meetings ?? []) {
          const kept = memory.answered.get(meeting.meetingId);
          if (kept !== undefined && kept.at <= issued) memory.answered.delete(meeting.meetingId);
        }
        setMeetings(answer.meetings);
        const offered = answer.stageSuggestion ?? null;
        setSuggested(offered === null ? null : { firmId, refreshKey: readKey, suggestion: offered });
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
    if (suggested !== null) setSuggested(null);
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
        memory.clock.now += 1;
        memory.answered.set(meetingId, { set: answer.set, at: memory.clock.now });
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
  // Read for this firm under the stage the page shows now, or not offered.
  const suggestion = suggested !== null && suggested.firmId === firmId && suggested.refreshKey === refreshKey ? suggested : null;
  const shown = (meeting: FirmMeetingDto): Shown => {
    const answered = memory.answered.get(meeting.meetingId)?.set;
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
              onApplySuggestion(suggestion.suggestion, suggestion.firmId);
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
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="min-w-36 flex-1">{shortDayTime(row.startsAt)}</span>
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
                {ports.brief !== undefined && briefOffered(row) ? (
                  <Button
                    size="sm"
                    variant="quiet"
                    data-testid="meeting-brief-toggle"
                    aria-expanded={briefs.memory.open.has(row.meetingId)}
                    onClick={() => {
                      if (briefs.memory.open.has(row.meetingId)) briefs.memory.open.delete(row.meetingId);
                      else briefs.memory.open.add(row.meetingId);
                      briefs.touch();
                    }}
                  >
                    Brief
                  </Button>
                ) : null}
                <MeetingRecordingTag item={meetingRecordingItem(recordings.view?.items ?? [], row.meetingId)} server={meetingServerState(serverRows, row.meetingId)} />
                <Tag data-testid="firm-meeting-state" tone={meetingStateWarns(row.state) ? 'warn' : 'none'}>
                  {meetingRowWord(row.state)}
                </Tag>
              </div>
              {ports.brief !== undefined && briefOffered(row) && briefs.memory.open.has(row.meetingId) ? (
                <MeetingBrief meetingId={row.meetingId} read={ports.brief} />
              ) : null}
              <MeetingOutcomes key={row.meetingId} meetingId={row.meetingId} actionsEnabled={actionsEnabled} />
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
      <FirmRecordings recordings={recordings} meetings={meetings} server={serverRows} actionsEnabled={actionsEnabled} />
    </section>
  );
}
