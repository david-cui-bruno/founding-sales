// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { JSX, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FirmMeetingDto, FirmRecording } from '@fss/contracts';
import { DraftsProvider } from '../src/renderer/app/drafts.tsx';
import { resetAttendanceMemory } from '../src/renderer/meetings/attendanceMemory.ts';
import { FirmMeetings, type FirmMeetingsPorts } from '../src/renderer/meetings/FirmMeetings.tsx';
import { RecordingsToSort } from '../src/renderer/recordings/RecordingsToSort.tsx';
import { RecordingsFolderSection } from '../src/renderer/recordings/RecordingsFolderSection.tsx';
import { applyAnswered, resetRecordingsMemory, type RecordingsPorts } from '../src/renderer/recordings/recordingsMemory.ts';
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
  version: 1,
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

const serverRow = (meetingId: string, participantLabel: string): FirmRecording => ({
  recordingId: crypto.randomUUID(),
  meetingId,
  segment: 1,
  participantLabel,
  state: 'uploaded',
  createdAt: '2026-10-05T19:00:00.000Z',
});

/** A command's answer: the whole view, and its own item at its version (review M4R, finding 12). */
const answerOf = (items: RecordingItem[], own: { itemId: string; version: number; item: RecordingItem | null }, notice: string | null = null): RecordingsView => ({
  ...viewOf(items, notice),
  answered: own,
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
      h.answers[0]!.resolve(
        answerOf([item(), item({ itemId: OTHER_ITEM, folderName: '2026-10-05 14.20.00 Zoom Meeting' })], { itemId: ITEM, version: 1, item: item() }, 'recording_choice_stale'),
      );
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
      h.answers[0]!.resolve(answerOf([item()], { itemId: ITEM, version: 1, item: item() }, 'recording_choice_stale'));
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

describe('K4 on the firm page (review M4R, finding 13)', () => {
  it('J then Enter while the firm page’s Retry had focus sends nothing (the reviewer’s repro)', async () => {
    const meetings: FirmMeetingDto[] = [
      { meetingId: MEETING_ONE, state: 'ended', startsAt: '2026-10-05T18:00:00.000Z', endsAt: '2026-10-05T18:20:00.000Z', attendanceSource: null },
    ];
    const meetingPorts: FirmMeetingsPorts = { forFirm: async () => await Promise.resolve({ meetings }) };
    const h = harness(viewOf([item({ state: 'failed', failure: 'upload_failed', meetingId: MEETING_ONE })]));
    let moved = 0;
    render(
      <Session>
        <WithShortcuts
          onNext={() => {
            moved += 1;
          }}
        >
          <FirmMeetings firmId="11111111-1111-4111-8111-111111111111" ports={meetingPorts} recordingPorts={h.ports} />
        </WithShortcuts>
      </Session>,
    );
    for (const testId of ['firm-recording-retry', 'firm-recording-ignore']) {
      const button = await screen.findByTestId(testId);
      button.focus();
      expect(document.activeElement).toBe(button);
      await userEvent.keyboard('j');
      expect(document.activeElement?.tagName).not.toBe('BUTTON');
      await userEvent.keyboard('{Enter}');
      await userEvent.keyboard('k{Enter}');
    }
    expect(moved).toBeGreaterThan(0);
    expect(h.sent).toEqual([]);
  });
});

describe('finding 12: a command’s answer changes its own item only, and never an older version over a newer one', () => {
  it('a late answer for B does not bring back A, which a newer answer removed (the reviewer’s repro)', async () => {
    const failedA = item({ state: 'failed', failure: 'upload_failed' });
    const failedB = item({ itemId: OTHER_ITEM, state: 'failed', failure: 'upload_failed', folderName: '2026-10-05 14.20.00 Zoom Meeting' });
    const h = harness(viewOf([failedA, failedB]));
    render(
      <Session>
        <RecordingsToSort ports={h.ports} />
      </Session>,
    );
    const rows = await screen.findAllByTestId('recording-to-sort');
    fireEvent.click(within(rows[1]!).getByTestId('recording-ignore'));
    fireEvent.click(within(rows[0]!).getByTestId('recording-ignore'));
    expect(h.sent.map(entry => entry.input)).toEqual([{ itemId: OTHER_ITEM }, { itemId: ITEM }]);
    // A's answer first: A gone, B still there as far as A's command knew.
    await act(async () => {
      h.answers[1]!.resolve(answerOf([failedB], { itemId: ITEM, version: 2, item: null }));
      await Promise.resolve();
    });
    expect(screen.getAllByTestId('recording-to-sort').map(row => row.getAttribute('data-state'))).toEqual(['failed']);
    // B's answer, taken before A was ignored: its whole view still has A. Only B changes.
    await act(async () => {
      h.answers[0]!.resolve(answerOf([failedA], { itemId: OTHER_ITEM, version: 2, item: null }));
      await Promise.resolve();
    });
    expect(screen.queryByTestId('recording-to-sort')).toBeNull();
  });

  it('an answer older than the item the window shows is not drawn', async () => {
    const h = harness(viewOf([item({ state: 'failed', failure: 'upload_failed' })]));
    render(
      <Session>
        <RecordingsToSort ports={h.ports} />
      </Session>,
    );
    fireEvent.click(await screen.findByTestId('recording-retry'));
    await act(async () => {
      h.answers[0]!.resolve(answerOf([], { itemId: ITEM, version: 2, item: item({ version: 2, state: 'failed', failure: 'file_unreadable' }) }));
      await Promise.resolve();
    });
    // Newer than the window's version 1: applied.
    expect(screen.getByTestId('recording-detail').textContent).toMatch(/read/u);
    // Older than what the window shows (a newer read drew version 3), or about an item it no
    // longer shows: nothing changes.
    const shown = viewOf([item({ version: 3, state: 'needs_matching' })]);
    expect(applyAnswered(shown, answerOf([], { itemId: ITEM, version: 2, item: null }))).toBe(shown);
    expect(applyAnswered(shown, answerOf([], { itemId: OTHER_ITEM, version: 9, item: item({ itemId: OTHER_ITEM }) }))).toBe(shown);
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
      h.answers[0]!.resolve(answerOf([item()], { itemId: ITEM, version: 1, item: item() }, 'recording_choice_stale'));
      await Promise.resolve();
    });
    expect(screen.getByTestId('recording-picker')).toBeTruthy();
    expect(screen.getAllByTestId('recording-choice')[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('recording-note').textContent).toMatch(/changed since/u);
    // K6: the refusal answered the command; Attach is a new command now.
    expect((screen.getByTestId('recording-attach') as HTMLButtonElement).disabled).toBe(false);

    await userEvent.click(screen.getByTestId('recording-attach'));
    await act(async () => {
      const uploading = item({ version: 2, state: 'uploading', meetingId: MEETING_ONE });
      h.answers[1]!.resolve(answerOf([uploading], { itemId: ITEM, version: 2, item: uploading }));
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
      const waiting = item({ version: 2, state: 'waiting' });
      h.answers[0]!.resolve(answerOf([waiting], { itemId: ITEM, version: 2, item: waiting }));
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
    const empty = harness(viewOf([item({ state: 'uploading', meetingId: MEETING_ONE })]));
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
    const h = harness(viewOf([item({ itemId: 'c'.repeat(32), state: 'uploading', meetingId: MEETING_ONE, uploaded: 1, total: 3 })]));
    // R4: what is registered comes from the server's rows, not this Mac's import.
    const asked: string[] = [];
    const ports: RecordingsPorts = {
      ...h.ports,
      forFirm: async firmId => {
        asked.push(firmId);
        return await Promise.resolve({ truncated: false, recordings: [serverRow(MEETING_TWO, 'audioDavidCui11234567890.m4a'), serverRow(MEETING_TWO, 'audioJordanPlaceholder21234567890.m4a')] });
      },
    };
    render(
      <Session>
        <FirmMeetings firmId="11111111-1111-4111-8111-111111111111" ports={meetingPorts} recordingPorts={ports} />
      </Session>,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId('meeting-recording-state').map(node => node.textContent)).toEqual(['Uploading 1/3', 'Uploaded — waiting for transcription']);
    });
    expect(screen.getAllByTestId('firm-recording').map(node => node.getAttribute('data-state'))).toEqual(['uploading']);
    expect(screen.getAllByTestId('firm-recording-registered').map(node => node.getAttribute('data-meeting-id'))).toEqual([MEETING_TWO]);
    expect(screen.getByTestId('firm-recording-registered').textContent).toMatch(/2 files · 2 speakers/u);
    expect(asked[0]).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('R4: a recording registered by another Mac, or moved to the surviving meeting by a fold, shows under the meeting the server says (M4F #7)', async () => {
    // The fold moved the rows to MEETING_TWO; this Mac's import has nothing for either meeting
    // (its folder was removed). The firm page follows the server.
    const meetings: FirmMeetingDto[] = [
      { meetingId: MEETING_TWO, state: 'ended', startsAt: '2026-10-04T18:00:00.000Z', endsAt: '2026-10-04T18:20:00.000Z', attendanceSource: null },
    ];
    const h = harness(viewOf([]));
    const ports: RecordingsPorts = { ...h.ports, forFirm: async () => await Promise.resolve({ truncated: false, recordings: [serverRow(MEETING_TWO, 'audioDavidCui11234567890.m4a')] }) };
    render(
      <Session>
        <FirmMeetings firmId="11111111-1111-4111-8111-111111111111" ports={{ forFirm: async () => await Promise.resolve({ meetings }) }} recordingPorts={ports} />
      </Session>,
    );
    await waitFor(() => {
      expect(screen.getAllByTestId('meeting-recording-state').map(node => node.textContent)).toEqual(['Uploaded — waiting for transcription']);
    });
    expect(screen.getByTestId('firm-recording-registered').getAttribute('data-meeting-id')).toBe(MEETING_TWO);
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
