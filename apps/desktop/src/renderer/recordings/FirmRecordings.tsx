import { useRef, type JSX, type KeyboardEvent } from 'react';
import { reasonSentence } from '@fss/contracts';
import type { RecordingItem } from '../../shared/recordings.ts';
import { shortDayTime } from '../dates.ts';
import { Button } from '../ui/button.tsx';
import { Tag } from '../ui/layout.tsx';
import { RECORDING_NAVIGATION_KEYS, recordingStateWords, recordingTitle, type Recordings } from './recordingsMemory.ts';

/**
 * The firm page's recording states (lane M4): a small tag on each meeting row with that
 * meeting's recording state, and a "Recordings" list under the meetings with each folder
 * imported for one of them — Waiting for conversion, Uploading n/m, Uploaded — waiting for
 * transcription, Failed (with Retry / Not a Callie demo). Drawn from this Mac's import
 * (`recordingsMemory.ts`); a folder that needs matching is Today's, since it names no meeting
 * yet. J/K never leave focus on Retry or Not a Callie demo (K4, review M4R finding 13): the
 * list takes focus back on its own heading, so the Enter that follows presses nothing.
 */

/** The state a meeting row shows: the least finished of its folders, or none. */
export function meetingRecordingItem(items: readonly RecordingItem[], meetingId: string): RecordingItem | null {
  const order: Readonly<Record<RecordingItem['state'], number>> = { failed: 0, needs_matching: 1, waiting: 2, uploading: 3, uploaded: 4 };
  const mine = items.filter(entry => entry.meetingId === meetingId);
  return [...mine].sort((left, right) => order[left.state] - order[right.state])[0] ?? null;
}

export function MeetingRecordingTag({ item }: { readonly item: RecordingItem | null }): JSX.Element | null {
  if (item === null) return null;
  return (
    <Tag data-testid="meeting-recording-state" tone={item.state === 'failed' ? 'warn' : 'none'}>
      {recordingStateWords(item)}
    </Tag>
  );
}

export function FirmRecordings({
  recordings,
  meetingIds,
  actionsEnabled = true,
}: {
  readonly recordings: Recordings;
  readonly meetingIds: readonly string[];
  readonly actionsEnabled?: boolean;
}): JSX.Element | null {
  const heading = useRef<HTMLHeadingElement>(null);
  const items = (recordings.view?.items ?? []).filter(entry => entry.meetingId !== null && meetingIds.includes(entry.meetingId));
  if (items.length === 0) return null;
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
