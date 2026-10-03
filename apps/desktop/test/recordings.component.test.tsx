// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FirmMeetingDto } from '@fss/contracts';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import { resetAttendanceMemory } from '../src/renderer/meetings/attendanceMemory.ts';
import { FirmMeetings, type FirmMeetingsPorts } from '../src/renderer/meetings/FirmMeetings.tsx';
import { RecordingsToSort } from '../src/renderer/recordings/RecordingsToSort.tsx';
import { RecordingsFolderSection } from '../src/renderer/recordings/RecordingsFolderSection.tsx';
import { resetRecordingsMemory, type RecordingsPorts } from '../src/renderer/recordings/recordingsMemory.ts';
import type { RecordingItem, RecordingsView } from '../src/shared/recordings.ts';
import { useShortcuts } from '../src/renderer/v2/shortcuts.ts';

/**
 * Lane M4: the recording states on Today, the firm page and Settings, with the kept-state
 * tests written first (K1–K7, `KEPT-STATE-RULES.md`):
 *
 *   * K1 — a picker, a pick, a pending command and a note never outlive the session;
 *   * K3 — a command is kept by item, survives a remount, and its late answer lands only as
 *     that item's feedback, never reopening a picker David closed;
 *   * K4 — J/K then Enter while a command button had focus sends nothing;
 *   * K5 — a refused choice keeps the picker open with its reason; only success closes it;
 *   * K6 — the success answer clears the pending command;
 *   * K7 — a read that began before a command's answer never puts the old state back.
 *
 * Synthetic folders, firms and people only.
 */

const ITEM = 'a'.repeat(32);
const OTHER_ITEM = 'b'.repeat(32);
const MEETING_ONE = '00000000-0000-4000-8000-000000000001';
const MEETING_TWO = '00000000-0000-4000-8000-000000000002';

const item = (overrides: Partial<RecordingItem> = {}): RecordingItem => ({
  itemId: ITEM,
  folderName: '2026-10-05 14.05.00 Callie demo between David Cui and Jordan Placeholder 81234567890',
  startedAt: '2026-10-05T18:05:00.000Z',
  state: 'needs_matching',
  meetingId: null,
  uploaded: 0,
  total: 2,
  failure: null,
  choices: [
    { meetingId: MEETING_ONE, startsAt: '2026-10-05T18:00:00.000Z', firmId: null, firmName: 'Example Rentals', attendee: 'Jordan Placeholder' },
    { meetingId: MEETING_TWO, startsAt: '2026-10-05T18:15:00.000Z', firmId: null, firmName: 'Sample Homes', attendee: 'Riley Example' },
  ],
  ...overrides,
});

const viewOf = (items: RecordingItem[], notice: string | null = null): RecordingsView => ({
  folder: { path: '/Users/test/Movies/Callie Demos', isDefault: true, available: true },
  items,
  notice,
});

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

function harness(initial: RecordingsView) {
  const sent: { kind: string; input: unknown }[] = [];
  const answers: Deferred<RecordingsView>[] = [];
  const reads: Deferred<RecordingsView>[] = [];
  let readImmediately = true;
  let current = initial;
  const command = (kind: string) => async (input: unknown) => {
    sent.push({ kind, input });
    const answer = deferred<RecordingsView>();
    answers.push(answer);
    return await answer.promise;
  };
  const ports: RecordingsPorts = {
    state: async () => {
      if (readImmediately) return await Promise.resolve(current);
      const read = deferred<RecordingsView>();
      reads.push(read);
      return await read.promise;
    },
    chooseMeeting: command('choose'),
    ignore: command('ignore'),
    retry: command('retry'),
    chooseFolder: async () => await Promise.resolve(current),
    importFolder: command('import') as unknown as () => Promise<RecordingsView>,
  };
  return {
    ports,
    sent,
    answers,
    reads,
    setCurrent: (next: RecordingsView) => {
      current = next;
    },
    holdReads: () => {
      readImmediately = false;
    },
  };
}

function Session({ children }: { readonly children: ReactNode }): JSX.Element {
  return <DraftsProvider>{children}</DraftsProvider>;
}

beforeEach(() => {
  resetRecordingsMemory();
  resetAttendanceMemory();
});

afterEach(() => {
  cleanup();
});

describe('K1: nothing about recordings outlives the session', () => {
  it('a new session starts with no picker, no pick, no pending command and no note', async () => {
    const h = harness(viewOf([item()]));
    const first = render(
      <Session key="one">
        <RecordingsToSort ports={h.ports} />
      </Session>,
    );
    await userEvent.click(await screen.findByTestId('recording-choose'));
    await userEvent.click(screen.getAllByTestId('recording-choice')[1]!);
    await userEvent.click(screen.getByTestId('recording-ignore'));
    expect(h.sent).toHaveLength(1);
    first.unmount();

    // Sign-out and back in: a new drafts provider is a new epoch.
    render(
      <Session key="two">
        <RecordingsToSort ports={h.ports} />
      </Session>,
    );
    await screen.findByTestId('recording-to-sort');
    expect(screen.queryByTestId('recording-picker')).toBeNull();
    expect((screen.getByTestId('recording-ignore') as HTMLButtonElement).disabled).toBe(false);
    // The first session's late answer lands nowhere in this one.
    await act(async () => {
      h.answers[0]!.resolve(viewOf([], 'recording_choice_stale'));
      await Promise.resolve();
    });
    expect(screen.queryByTestId('recording-note')).toBeNull();
    expect(screen.getByTestId('recording-to-sort')).toBeTruthy();
  });
});

describe('K3: a command and its answer belong to their item', () => {
  it('a picker, its pick and a pending command survive a remount; the answer lands on its own item only', async () => {
    const h = harness(viewOf([item(), item({ itemId: OTHER_ITEM, folderName: '2026-10-05 14.20.00 Zoom Meeting' })]));
    const first = render(
      <Session>
        <RecordingsToSort ports={h.ports} />
      </Session>,
    );
    const rows = await screen.findAllByTestId('recording-to-sort');
    await userEvent.click(within(rows[0]!).getByTestId('recording-choose'));
    await userEvent.click(within(rows[0]!).getAllByTestId('recording-choice')[1]!);
    await userEvent.click(within(rows[0]!).getByTestId('recording-attach'));
    expect(h.sent).toEqual([{ kind: 'choose', input: { itemId: ITEM, meetingId: MEETING_TWO } }]);
    // The view goes away (David opens another screen) and comes back, in the same session.
    first.rerender(
      <Session>
        <p>Elsewhere</p>
      </Session>,
    );
    expect(screen.queryByTestId('recording-to-sort')).toBeNull();
    first.rerender(
      <Session>
        <RecordingsToSort ports={h.ports} />
      </Session>,
    );
    const again = await screen.findAllByTestId('recording-to-sort');
    // Still open, still picked, still on the wire: Attach is disabled while it is.
    expect(within(again[0]!).getByTestId('recording-picker')).toBeTruthy();
    expect(within(again[0]!).getAllByTestId('recording-choice')[1]?.getAttribute('aria-pressed')).toBe('true');
    expect((within(again[0]!).getByTestId('recording-attach') as HTMLButtonElement).disabled).toBe(true);
    expect(within(again[1]!).queryByTestId('recording-picker')).toBeNull();

    await act(async () => {
      h.answers[0]!.resolve(viewOf([item(), item({ itemId: OTHER_ITEM, folderName: '2026-10-05 14.20.00 Zoom Meeting' })], 'recording_choice_stale'));
      await Promise.resolve();
    });
    const after = await screen.findAllByTestId('recording-to-sort');
    expect(within(after[0]!).getByTestId('recording-note').textContent).toMatch(/changed since/u);
    expect(within(after[1]!).queryByTestId('recording-note')).toBeNull();
  });

  it('a late refusal never reopens a picker David closed', async () => {
    const h = harness(viewOf([item()]));
    render(
      <Session>
        <RecordingsToSort ports={h.ports} />
      </Session>,
    );
    await userEvent.click(await screen.findByTestId('recording-choose'));
    await userEvent.click(screen.getAllByTestId('recording-choice')[0]!);
    await userEvent.click(screen.getByTestId('recording-attach'));
    await userEvent.click(screen.getByTestId('recording-cancel'));
    expect(screen.queryByTestId('recording-picker')).toBeNull();
    await act(async () => {
      h.answers[0]!.resolve(viewOf([item()], 'recording_choice_stale'));
      await Promise.resolve();
    });
    expect(screen.queryByTestId('recording-picker')).toBeNull();
    expect(screen.getByTestId('recording-note')).toBeTruthy();
  });
});

function WithShortcuts({ children, onNext }: { readonly children: ReactNode; onNext(): void }): JSX.Element {
  useShortcuts({ next: onNext, previous: onNext });
  return <>{children}</>;
}

describe('K4: navigation keys never run a recording command', () => {
  it('J then Enter while "Not a Callie demo" had focus sends nothing', async () => {
    const h = harness(viewOf([item({ state: 'failed', failure: 'upload_failed' })]));
    let moved = 0;
    render(
      <Session>
        <WithShortcuts
          onNext={() => {
            moved += 1;
          }}
        >
          <RecordingsToSort ports={h.ports} />
        </WithShortcuts>
      </Session>,
    );
    const ignore = await screen.findByTestId('recording-ignore');
    ignore.focus();
    expect(document.activeElement).toBe(ignore);
    await userEvent.keyboard('j');
    expect(moved).toBe(1);
    expect(document.activeElement?.tagName).not.toBe('BUTTON');
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('k{Enter}');
    expect(h.sent).toEqual([]);
  });
});

describe('K5 and K6: only a success answer closes the picker and clears the command', () => {
  it('a refusal keeps the picker and the pick with the reason; success removes the item', async () => {
    const h = harness(viewOf([item()]));
    render(
      <Session>
        <RecordingsToSort ports={h.ports} />
      </Session>,
    );
    await userEvent.click(await screen.findByTestId('recording-choose'));
    await userEvent.click(screen.getAllByTestId('recording-choice')[0]!);
    await userEvent.click(screen.getByTestId('recording-attach'));
    await act(async () => {
      h.answers[0]!.resolve(viewOf([item()], 'recording_choice_stale'));
      await Promise.resolve();
    });
    expect(screen.getByTestId('recording-picker')).toBeTruthy();
    expect(screen.getAllByTestId('recording-choice')[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('recording-note').textContent).toMatch(/changed since/u);
    // K6: the refusal answered the command; Attach is a new command now.
    expect((screen.getByTestId('recording-attach') as HTMLButtonElement).disabled).toBe(false);

    await userEvent.click(screen.getByTestId('recording-attach'));
    await act(async () => {
      h.answers[1]!.resolve(viewOf([item({ state: 'uploading', meetingId: MEETING_ONE })]));
      await Promise.resolve();
    });
    expect(screen.queryByTestId('recording-to-sort')).toBeNull();
  });
});

describe('K7: a stale read never replaces a newer answer', () => {
  it('drops a read that began before a command answered, even when it lands last', async () => {
    const h = harness(viewOf([item({ state: 'failed', failure: 'upload_failed' })]));
    const view = render(
      <Session>
        <RecordingsToSort ports={h.ports} />
      </Session>,
    );
    await screen.findByTestId('recording-retry');
    // A second view of the same import mounts in the same session and starts a read, which is
    // held: the folder still failed as far as that read knows.
    h.holdReads();
    view.rerender(
      <Session>
        <RecordingsToSort ports={h.ports} />
        <RecordingsToSort ports={h.ports} />
      </Session>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(h.reads).toHaveLength(1);
    view.rerender(
      <Session>
        <RecordingsToSort ports={h.ports} />
      </Session>,
    );
    fireEvent.click(screen.getByTestId('recording-retry'));
    await act(async () => {
      h.answers[0]!.resolve(viewOf([item({ state: 'waiting' })]));
      await Promise.resolve();
    });
    expect(screen.queryByTestId('recording-to-sort')).toBeNull();
    expect(h.reads).toHaveLength(1);
    await act(async () => {
      h.reads[0]!.resolve(viewOf([item({ state: 'failed', failure: 'upload_failed' })]));
      await Promise.resolve();
    });
    expect(screen.queryByTestId('recording-to-sort')).toBeNull();
  });
});

describe('the states where David sees them', () => {
  it('Today shows only needs matching and failed, quietly; nothing at all when there are none', async () => {
    const h = harness(
      viewOf([
        item({ itemId: 'c'.repeat(32), state: 'uploading', meetingId: MEETING_ONE, uploaded: 1 }),
        item({ itemId: 'd'.repeat(32), state: 'failed', failure: 'no_audio', meetingId: MEETING_ONE }),
        item(),
      ]),
    );
    render(
      <Session>
        <RecordingsToSort ports={h.ports} />
      </Session>,
    );
    const rows = await screen.findAllByTestId('recording-to-sort');
    expect(rows.map(row => row.getAttribute('data-state'))).toEqual(['failed', 'needs_matching']);
    expect(within(rows[0]!).getByTestId('recording-detail').textContent).toMatch(/only video/u);
    cleanup();
    resetRecordingsMemory();
    const empty = harness(viewOf([item({ state: 'uploaded', meetingId: MEETING_ONE })]));
    const { container } = render(
      <Session>
        <RecordingsToSort ports={empty.ports} />
      </Session>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.textContent).toBe('');
  });

  it('the firm page says each meeting’s recording state and lists its recordings', async () => {
    const meetings: FirmMeetingDto[] = [
      { meetingId: MEETING_ONE, state: 'ended', startsAt: '2026-10-05T18:00:00.000Z', endsAt: '2026-10-05T18:20:00.000Z', attendanceSource: null },
      { meetingId: MEETING_TWO, state: 'ended', startsAt: '2026-10-04T18:00:00.000Z', endsAt: '2026-10-04T18:20:00.000Z', attendanceSource: null },
    ];
    const meetingPorts: FirmMeetingsPorts = { forFirm: async () => await Promise.resolve({ meetings }) };
    const h = harness(
      viewOf([
        item({ itemId: 'c'.repeat(32), state: 'uploading', meetingId: MEETING_ONE, uploaded: 1, total: 3 }),
        item({ itemId: 'e'.repeat(32), state: 'uploaded', meetingId: MEETING_TWO, uploaded: 2, total: 2, folderName: '2026-10-04 14.01.00 Callie demo 81234567890' }),
      ]),
    );
    render(
      <Session>
        <FirmMeetings firmId="11111111-1111-4111-8111-111111111111" ports={meetingPorts} recordingPorts={h.ports} />
      </Session>,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId('meeting-recording-state').map(node => node.textContent)).toEqual(['Uploading 1/3', 'Uploaded — waiting for transcription']);
    });
    expect(screen.getAllByTestId('firm-recording').map(node => node.getAttribute('data-state'))).toEqual(['uploading', 'uploaded']);
  });

  it('Settings shows the folder and offers Choose… and Import a recording folder…', async () => {
    const h = harness(viewOf([]));
    render(
      <Session>
        <RecordingsFolderSection ports={h.ports} />
      </Session>,
    );
    expect((await screen.findByTestId('recordings-folder-path')).textContent).toBe('/Users/test/Movies/Callie Demos');
    await userEvent.click(screen.getByTestId('recordings-folder-import'));
    expect(h.sent).toEqual([{ kind: 'import', input: undefined }]);
  });
});
