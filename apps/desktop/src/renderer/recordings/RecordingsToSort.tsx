import { useRef, type JSX, type KeyboardEvent } from 'react';
import { reasonSentence } from '@fss/contracts';
import type { RecordingItem } from '../../shared/recordings.ts';
import { shortDayTime } from '../dates.ts';
import { Button } from '../ui/button.tsx';
import { recordingTitle, registryRecordingPorts, useRecordings, type Recordings, type RecordingsPorts } from './recordingsMemory.ts';

/**
 * Today's quiet item for demo recordings (lane M4): only the folders that need David — a
 * recording that overlapped a Callie meeting but could not be matched by itself ("Needs
 * matching", with Choose meeting), and one that failed (Retry, or Not a Callie demo). Nothing
 * at all when there is neither. Everything else (waiting, uploading, uploaded) is on the firm
 * page, beside its meeting.
 *
 * Choose meeting opens the meetings the folder overlapped, as quiet rows; one is picked, then
 * Attach. "Not a Callie demo" drops the folder for good: never uploaded, never shown again.
 * Kept state is `recordingsMemory.ts`'s (K1–K7). J/K never leave focus on one of these buttons
 * (K4): the group takes focus back on its own heading.
 */

const NAVIGATION_KEYS = new Set(['j', 'k', 'ArrowDown', 'ArrowUp']);

function choiceLabel(choice: RecordingItem['choices'][number]): string {
  return [shortDayTime(choice.startsAt), choice.firmName, choice.attendee].filter((part): part is string => part !== null && part !== '').join(' · ');
}

function Item({ item, recordings, enabled }: { readonly item: RecordingItem; readonly recordings: Recordings; readonly enabled: boolean }): JSX.Element {
  const { memory } = recordings;
  const picking = memory.picking.get(item.itemId);
  const pending = memory.pending.get(item.itemId);
  const note = memory.notes.get(item.itemId);
  const busy = pending !== undefined;
  const picked = picking?.meetingId ?? null;
  // A pick the current choices no longer offer is dropped rather than sent (K2).
  const pickedStillOffered = picked !== null && item.choices.some(choice => choice.meetingId === picked);
  const detail = item.state === 'failed' ? reasonSentence(item.failure ?? 'upload_failed') : 'Which meeting was this?';
  return (
    <li data-testid="recording-to-sort" data-state={item.state} className="flex flex-col gap-1 border-b border-border py-1.5 last:border-b-0">
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm">
            {recordingTitle(item.folderName)} · {shortDayTime(item.startedAt)}
          </span>
          <span data-testid="recording-detail" className="text-xs text-muted-foreground">
            {detail}
          </span>
        </span>
        <span className="-ml-2 flex flex-wrap items-center gap-0.5">
          {item.state === 'needs_matching' && picking === undefined ? (
            <Button
              size="sm"
              variant="quiet"
              data-testid="recording-choose"
              disabled={!enabled || busy || item.choices.length === 0}
              onClick={() => {
                recordings.openPicker(item.itemId);
              }}
            >
              Choose meeting
            </Button>
          ) : null}
          {item.state === 'failed' ? (
            <Button
              size="sm"
              variant="quiet"
              data-testid="recording-retry"
              disabled={!enabled || busy}
              onClick={() => {
                recordings.send(item.itemId, 'retry');
              }}
            >
              Retry
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="quiet"
            data-testid="recording-ignore"
            disabled={!enabled || busy}
            onClick={() => {
              recordings.send(item.itemId, 'ignore');
            }}
          >
            Not a Callie demo
          </Button>
        </span>
      </span>
      {picking === undefined || item.state !== 'needs_matching' ? null : (
        <div data-testid="recording-picker" className="flex flex-col gap-0.5 pl-2">
          {item.choices.map(choice => (
            <button
              key={choice.meetingId}
              type="button"
              data-testid="recording-choice"
              aria-pressed={choice.meetingId === picked}
              disabled={busy}
              className="truncate rounded px-1.5 py-0.5 text-left text-xs hover:bg-muted aria-pressed:bg-muted aria-pressed:font-medium"
              onClick={() => {
                recordings.pick(item.itemId, choice.meetingId);
              }}
            >
              {choiceLabel(choice)}
            </button>
          ))}
          <span className="flex items-center gap-1 pt-0.5">
            <Button
              size="sm"
              data-testid="recording-attach"
              disabled={!enabled || busy || !pickedStillOffered}
              {...(busy ? { 'aria-busy': true } : {})}
              onClick={() => {
                if (picked !== null && pickedStillOffered) recordings.send(item.itemId, 'choose', picked);
              }}
            >
              Attach
            </Button>
            <Button
              size="sm"
              variant="quiet"
              data-testid="recording-cancel"
              onClick={() => {
                recordings.closePicker(item.itemId);
              }}
            >
              Cancel
            </Button>
          </span>
        </div>
      )}
      {note === undefined ? null : (
        <p data-testid="recording-note" role="alert" className="text-xs text-destructive">
          {note}
        </p>
      )}
    </li>
  );
}

export function RecordingsToSort({
  ports = registryRecordingPorts(),
  actionsEnabled = true,
}: {
  readonly ports?: RecordingsPorts | null;
  readonly actionsEnabled?: boolean;
}): JSX.Element | null {
  const recordings = useRecordings(ports);
  const heading = useRef<HTMLHeadingElement>(null);
  const items = (recordings.view?.items ?? []).filter(entry => entry.state === 'needs_matching' || entry.state === 'failed');
  if (ports === null || items.length === 0) return null;

  // K4: a navigation key pressed on one of these buttons moves focus to the heading first,
  // so the Enter that follows presses nothing. The page's own shortcut still runs.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (!NAVIGATION_KEYS.has(event.key) || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target instanceof HTMLButtonElement) heading.current?.focus();
  };

  return (
    <section data-testid="recordings-to-sort" className="mb-3 px-2" onKeyDown={onKeyDown}>
      <h2 ref={heading} tabIndex={-1} className="mb-1 flex items-baseline gap-1.5 text-xs font-medium text-muted-foreground outline-none">
        <span>Recordings</span>
        <small className="text-[11px] font-normal">{items.length}</small>
      </h2>
      <ul className="flex flex-col border-t border-border">
        {items.map(entry => (
          <Item key={entry.itemId} item={entry} recordings={recordings} enabled={actionsEnabled} />
        ))}
      </ul>
    </section>
  );
}
