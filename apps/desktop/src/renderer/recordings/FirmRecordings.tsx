import { MeetingTranscript } from '../meetings/MeetingTranscript.tsx';
import { useRef, type JSX, type KeyboardEvent } from 'react';
import { reasonSentence, type FirmRecording } from '@fss/contracts';
import type { RecordingItem } from '../../shared/recordings.ts';
import { shortDayTime } from '../dates.ts';
import { Button } from '../ui/button.tsx';
import { Tag } from '../ui/layout.tsx';
import { RECORDING_NAVIGATION_KEYS, recordingStateWords, recordingTitle, serverRecordingWords, type Recordings } from './recordingsMemory.ts';

/**
 * The firm page's recording states (lane M4; M4 reset, R4): a small tag on each meeting row
 * with that meeting's recording state, and a "Recordings" list under the meetings.
 *
 *   * Registered recordings come from the server (`recordings.forFirm`): its rows follow a
 *     fold to the surviving meeting, and another Mac's uploads show too. One line per meeting:
 *     its files and their state (Uploaded — waiting for transcription, …).
 *   * What is not registered yet comes from this Mac's import: Waiting for conversion,
 *     Uploading n/m, Failed (with Retry / Not a Callie demo). A folder that needs matching is
 *     Today's, since it names no meeting yet.
 *
 * J/K never leave focus on Retry or Not a Callie demo (K4, review M4R finding 13): the
 * list takes focus back on its own heading, so the Enter that follows presses nothing.
 */

/** The state a meeting row shows from this Mac's import: the least finished of its folders, or none. */
export function meetingRecordingItem(items: readonly RecordingItem[], meetingId: string): RecordingItem | null {
  const order: Readonly<Record<RecordingItem['state'], number>> = { failed: 0, needs_matching: 1, waiting: 2, uploading: 3 };
  const mine = items.filter(entry => entry.meetingId === meetingId);
  return [...mine].sort((left, right) => order[left.state] - order[right.state])[0] ?? null;
}

/** The server's state for a meeting's registered recordings: the least finished of its rows. */
export function meetingServerState(rows: readonly FirmRecording[] | null, meetingId: string): FirmRecording['state'] | null {
  const order: Readonly<Record<FirmRecording['state'], number>> = { failed: 0, uploaded: 1, transcribing: 2, transcribed: 3 };
  const mine = (rows ?? []).filter(row => row.meetingId === meetingId);
  return [...mine].sort((left, right) => order[left.state] - order[right.state])[0]?.state ?? null;
}

/** This Mac's unfinished import first (it is what needs David); else what the server holds. */
export function MeetingRecordingTag({ item, server }: { readonly item: RecordingItem | null; readonly server?: FirmRecording['state'] | null }): JSX.Element | null {
  if (item !== null) {
    return (
      <Tag data-testid="meeting-recording-state" tone={item.state === 'failed' ? 'warn' : 'none'}>
        {recordingStateWords(item)}
      </Tag>
    );
  }
  if (server === null || server === undefined) return null;
  return (
    <Tag data-testid="meeting-recording-state" tone={server === 'failed' ? 'warn' : 'none'}>
      {serverRecordingWords(server)}
    </Tag>
  );
}

export function FirmRecordings({
  recordings,
  meetings,
  server = null,
  actionsEnabled = true,
}: {
  readonly recordings: Recordings;
  readonly meetings: readonly { readonly meetingId: string; readonly startsAt: string }[];
  /** The firm's registered recordings from the server, or null when not (yet) read. */
  readonly server?: readonly FirmRecording[] | null;
  readonly actionsEnabled?: boolean;
}): JSX.Element | null {
  const heading = useRef<HTMLHeadingElement>(null);
  const meetingIds = meetings.map(meeting => meeting.meetingId);
  const items = (recordings.view?.items ?? []).filter(entry => entry.meetingId !== null && meetingIds.includes(entry.meetingId));
  const registered = meetings
    .map(meeting => ({ meeting, rows: (server ?? []).filter(row => row.meetingId === meeting.meetingId) }))
    .filter(group => group.rows.length > 0);
  if (items.length === 0 && registered.length === 0) return null;
  // K4: a navigation key on one of these buttons moves focus to the heading first; the page's
  // own shortcut still runs.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (!RECORDING_NAVIGATION_KEYS.has(event.key) || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target instanceof HTMLButtonElement) heading.current?.focus();
  };
  return (
    <section data-testid="firm-recordings" className="mt-2 flex flex-col" onKeyDown={onKeyDown}>
      <h3 ref={heading} tabIndex={-1} className="mb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase outline-none">
        Recordings
      </h3>
      <ul className="flex flex-col border-t border-border">
        {registered.map(({ meeting, rows }) => {
          const state = meetingServerState(rows, meeting.meetingId) ?? 'uploaded';

          return (
            <li key={`server-${meeting.meetingId}`} data-testid="firm-recording-registered" data-meeting-id={meeting.meetingId} data-state={state} className="flex min-w-0 flex-col gap-1 border-b border-border py-2 text-sm">
              <span className="flex-1 truncate">
                Demo · {shortDayTime(meeting.startsAt)} · {rows.length === 1 ? '1 file' : `${String(rows.length)} files`}

              </span>
              <MeetingTranscript meetingId={meeting.meetingId} actionsEnabled={actionsEnabled} />
            </li>
          );
        })}
        {items.map(entry => {
          const busy = recordings.memory.pending.has(entry.itemId);
          const note = recordings.memory.notes.get(entry.itemId);
          return (
            <li key={entry.itemId} data-testid="firm-recording" data-state={entry.state} className="group flex flex-col border-b border-border py-1.5 text-sm">
              <span className="flex items-center gap-3">
                <span className="flex-1 truncate">
                  {recordingTitle(entry.folderName)} · {shortDayTime(entry.startedAt)}
                </span>
                {entry.state === 'failed' && actionsEnabled ? (
                  <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    <Button
                      size="sm"
                      variant="quiet"
                      data-testid="firm-recording-retry"
                      disabled={busy}
                      onClick={() => {
                        recordings.send(entry.itemId, 'retry');
                      }}
                    >
                      Retry
                    </Button>
                    <Button
                      size="sm"
                      variant="quiet"
                      data-testid="firm-recording-ignore"
                      disabled={busy}
                      onClick={() => {
                        recordings.send(entry.itemId, 'ignore');
                      }}
                    >
                      Not a Callie demo
                    </Button>
                  </span>
                ) : null}
                <Tag tone={entry.state === 'failed' ? 'warn' : 'none'}>{recordingStateWords(entry)}</Tag>
              </span>
              {entry.state === 'failed' ? <span className="text-xs text-muted-foreground">{reasonSentence(entry.failure ?? 'upload_failed')}</span> : null}
              {note === undefined ? null : (
                <span data-testid="firm-recording-note" role="alert" className="text-xs text-destructive">
                  {note}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
