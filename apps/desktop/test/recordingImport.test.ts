import { describe, expect, it, vi } from 'vitest';
import { recoverMeetingRecording } from '../src/main/recordings/recovery.ts';
import { createAuthedClient } from '../src/main/authedClient.ts';
import type { RecordingCandidate } from '@fss/contracts';
import { guardIdentity } from '../src/main/identityReset.ts';
import { applyAnswered } from '../src/renderer/recordings/recordingsMemory.ts';
import { createRecordingImporter, itemIdOf, type RecordingImportHost } from '../src/main/recordings/importer.ts';
import { STABLE_AFTER_MS } from '../src/main/recordings/zoomFolder.ts';
import { memoryRecordingStore, type RecordingStore, type RecordingsFile } from '../src/main/recordings/store.ts';
import { sniffAudio } from '../src/main/recordings/audioSniff.ts';
import { cmovPlusAudio } from './support/cmovFixture.ts';
import { fakeFile, fakeFs, fakeServer, fakeUploader, sha } from './support/recordingFakes.ts';

/**
 * The demo recording import, end to end against fakes (lane M4): contract check CC3 (a restart
 * in the middle of an upload resumes exactly once) and the acceptance list — correct matching,
 * incomplete conversion, duplicate processing, restart recovery, several speakers and
 * segments under one meeting, ambiguity → needs matching, and unrelated folders never read or
 * uploaded. Synthetic folders and people only.
 */

const ROOT = '/Users/test/Movies/Callie Demos';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const USER = '55555555-5555-4555-8555-555555555555';
const PERSON = `${WORKSPACE}:${USER}:member`;
type Who = { workspaceId: string; userId: string; role: 'admin' | 'member' };
const ME: Who = { workspaceId: WORKSPACE, userId: USER, role: 'member' };
const T0 = new Date(2026, 9, 5, 14, 40, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

const local = (hour: number, minute: number): Date => new Date(2026, 9, 5, hour, minute, 0);
const folderName = (start: Date, topic: string): string => {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(start.getFullYear())}-${pad(start.getMonth() + 1)}-${pad(start.getDate())} ${pad(start.getHours())}.${pad(start.getMinutes())}.${pad(start.getSeconds())} ${topic} 81234567890`;
};

function meeting(id: string, start: Date, attendeeName: string | null = 'Jordan Placeholder'): RecordingCandidate {
  return {
    meetingId: `00000000-0000-4000-8000-${id.padStart(12, '0')}`,
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + 20 * 60 * 1000).toISOString(),
    firmId: '11111111-1111-4111-8111-111111111111',
    firmName: 'Example Rentals',
    attendeeName,
    attendeeLocalPart: 'jordan.placeholder',
    bookingAttendeeName: null,
    eventTitle: null,
  };
}

function harness(options: { meetings?: RecordingCandidate[]; store?: RecordingStore & { saved(): RecordingsFile } } = {}) {
  let clock = T0;
  let meetings = options.meetings ?? [meeting('1', local(14, 0))];
  const files = fakeFs(ROOT);
  const server = fakeServer(() => meetings);
  const upload = fakeUploader(server, files);
  const store = options.store ?? memoryRecordingStore();
  let chosen: string | null = null;
  let signedIn: Who | null = ME;
  const build = (s: RecordingStore = store): RecordingImportHost =>
    createRecordingImporter({
      api: server.api,
      fs: files.fs,
      uploader: upload.uploader,
      store: s,
      identity: async () => await Promise.resolve(signedIn),
      defaultFolder: ROOT,
      openFolderDialog: async () => await Promise.resolve(chosen === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [chosen] }),
      now: () => clock,
    });
  return {
    files,
    server,
    upload,
    store,
    build,
    importer: build(),
    advance: (ms: number) => {
      clock += ms;
    },
    setMeetings: (next: RecordingCandidate[]) => {
      meetings = next;
    },
    signIn: (who: Who | null) => {
      signedIn = who;
    },
    choose: (path: string | null) => {
      chosen = path;
    },
  };
}

/**
 * The states of this person's entries as stored, newest first — `uploaded` included, which the
 * window is never shown (R4: a registered recording is the server's).
 */
function stored(h: { store: { saved(): RecordingsFile } }, person = PERSON): string[] {
  return Object.values(h.store.saved().people[person]?.entries ?? {})
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .map(entry => entry.state);
}

/** Two scans far enough apart for the listing to count as stable, and the uploads they start. */
async function settle(h: ReturnType<typeof harness>, importer: RecordingImportHost = h.importer): Promise<void> {
  await importer.scan();
  h.advance(STABLE_AFTER_MS + 1000);
  await importer.scan();
  await importer.idle();
}

const demoFiles = () => [
  fakeFile('audio1234567890.m4a', 'mixed audio bytes'),
  fakeFile('video1234567890.mp4', 'video bytes never read'),
  fakeFile('Audio Record/audioDavidCui11234567890.m4a', 'david segment one', 1),
  fakeFile('Audio Record/audioJordanPlaceholder21234567890.m4a', 'jordan segment one', 1),
];

describe('CC3: a restart in the middle of an upload resumes exactly once', () => {
  it('the files already sent are not sent again, the rest are, and one register records them', async () => {
    const h = harness();
    const folder = h.files.add(folderName(local(14, 1), 'Callie demo between David Cui and Jordan Placeholder'), demoFiles());
    // The second file's PUT never finishes: the app is quit in the middle of it.
    h.upload.setBehaviour(path => (path.endsWith('audioJordanPlaceholder21234567890.m4a') ? 'hang' : 'ok'));
    await h.importer.scan();
    h.advance(STABLE_AFTER_MS + 1000);
    void h.importer.scan();
    await new Promise(resolve => setTimeout(resolve, 20));
    const entry = h.store.saved().people[PERSON]!.entries[folder.path]!;
    expect(entry.state).toBe('uploading');
    expect(entry.files.map(file => file.uploaded)).toEqual([true, false]);
    expect(h.server.commandsTo('/meetings/recordings/register')).toHaveLength(0);

    // A new process on the same store.
    h.upload.setBehaviour(() => 'ok');
    const restarted = h.build();
    await restarted.scan();
    await restarted.idle();

    const urls = h.server.commandsTo('/meetings/recordings/upload-url').map(call => call.body?.['participantLabel']);
    expect(urls).toEqual(['audioDavidCui11234567890.m4a', 'audioJordanPlaceholder21234567890.m4a', 'audioJordanPlaceholder21234567890.m4a']);
    expect(h.upload.puts.filter(path => path.endsWith('audioDavidCui11234567890.m4a'))).toHaveLength(1);
    expect(h.server.commandsTo('/meetings/recordings/register')).toHaveLength(1);
    expect(h.server.rows.get(meeting('1', local(14, 0)).meetingId)?.size).toBe(2);
    expect(stored(h)).toEqual(['uploaded']);
    expect((await restarted.state()).items).toEqual([]);
  });

  it('a register on the wire when the app quits is replayed under the same command id after a restart, and records nothing twice', async () => {
    const h = harness();
    h.files.add(folderName(local(14, 1), 'Callie demo between David Cui and Jordan Placeholder'), demoFiles());
    // The server records the register, and the app quits before the answer arrives.
    h.server.setIntercept((path, _id) => (path === '/meetings/recordings/register' ? 'hang' : null));
    await h.importer.scan();
    h.advance(STABLE_AFTER_MS + 1000);
    void h.importer.scan();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(h.server.commandsTo('/meetings/recordings/register')).toHaveLength(1);
    h.server.setIntercept(null);

    const restarted = h.build();
    await restarted.scan();
    await restarted.idle();
    const registers = h.server.commandsTo('/meetings/recordings/register');
    expect(registers).toHaveLength(2);
    expect(registers[0]?.commandId).toBe(registers[1]?.commandId);
    expect(h.server.rows.get(meeting('1', local(14, 0)).meetingId)?.size).toBe(2);
    expect(stored(h)).toEqual(['uploaded']);
    // Nothing was uploaded twice: the files were marked sent before the register.
    expect(h.upload.puts).toHaveLength(2);
  });
});

describe('the demo recording import (acceptance)', () => {
  it('matches a corroborated folder to its meeting and uploads each participant’s audio, never the video or the mixed file', async () => {
    const h = harness();
    const folder = h.files.add(folderName(local(14, 1), 'Callie demo between David Cui and Jordan Placeholder'), demoFiles());
    await settle(h);
    // Registered: the server's now (R4), so this Mac shows nothing of it.
    expect((await h.importer.state()).items).toEqual([]);
    expect(h.store.saved().people[PERSON]!.entries[folder.path]).toMatchObject({ state: 'uploaded', meetingId: meeting('1', local(14, 0)).meetingId });
    expect(h.upload.puts.map(path => path.slice(folder.path.length + 1))).toEqual([
      'Audio Record/audioDavidCui11234567890.m4a',
      'Audio Record/audioJordanPlaceholder21234567890.m4a',
    ]);
    expect(h.files.hashed.some(path => path.endsWith('.mp4'))).toBe(false);
    expect(h.files.hashed.some(path => path.endsWith('audio1234567890.m4a'))).toBe(false);
    expect(h.store.saved().people[PERSON]!.entries[folder.path]!.files.every(file => file.recordingId !== undefined)).toBe(true);
    const register = h.server.commandsTo('/meetings/recordings/register')[0]?.body;
    expect(register?.['files']).toEqual([
      { sha256: sha('david segment one'), sizeBytes: 17, participantLabel: 'audioDavidCui11234567890.m4a', segment: 1, sourceKind: 'participant' },
      { sha256: sha('jordan segment one'), sizeBytes: 18, participantLabel: 'audioJordanPlaceholder21234567890.m4a', segment: 1, sourceKind: 'participant' },
    ]);
  });

  it('waits while Zoom is converting, and until the files stop changing, before reading or sending anything', async () => {
    const h = harness();
    const folder = h.files.add(folderName(local(14, 1), 'Callie demo between David Cui and Jordan Placeholder'), [fakeFile('double_click_to_convert_01.zoom', 'pending')]);
    await settle(h);
    expect((await h.importer.state()).items.map(item => item.state)).toEqual(['waiting']);
    expect(h.server.commandsTo('/meetings/recordings/upload-url')).toHaveLength(0);
    expect(h.files.hashed).toEqual([]);

    // Converted: the audio is there, but still growing between two scans.
    folder.files = demoFiles();
    await h.importer.scan();
    folder.files[2]!.content += ' more';
    folder.files[2]!.mtimeMs += 1;
    h.advance(STABLE_AFTER_MS + 1000);
    await h.importer.scan();
    await h.importer.idle();
    expect((await h.importer.state()).items[0]?.state).toBe('waiting');
    expect(h.upload.puts).toEqual([]);

    h.advance(STABLE_AFTER_MS + 1000);
    await h.importer.scan();
    await h.importer.idle();
    expect(stored(h)).toEqual(['uploaded']);
  });

  it('uploads several speakers and several segments under one meeting, each numbered', async () => {
    const h = harness();
    h.files.add(folderName(local(14, 1), 'Callie demo between David Cui and Jordan Placeholder'), [
      fakeFile('Audio Record/audioDavidCui11234567890.m4a', 'david one', 1),
      fakeFile('Audio Record/audioDavidCui11234567891.m4a', 'david two', 2),
      fakeFile('Audio Record/audioJordanPlaceholder21234567890.m4a', 'jordan one', 1),
      fakeFile('Audio Record/audioJordanPlaceholder21234567891.m4a', 'jordan two', 2),
      fakeFile('Audio Record/audioRileyExample31234567890.m4a', 'riley one', 1),
    ]);
    await settle(h);
    const rows = h.server.rows.get(meeting('1', local(14, 0)).meetingId);
    expect([...(rows?.values() ?? [])].map(row => `${row.participantLabel}#${String(row.segment)}`).sort()).toEqual([
      'audioDavidCui11234567890.m4a#1',
      'audioDavidCui11234567891.m4a#2',
      'audioJordanPlaceholder21234567890.m4a#1',
      'audioJordanPlaceholder21234567891.m4a#2',
      'audioRileyExample31234567890.m4a#1',
    ]);
  });

  it('processes a duplicate once: rescans, a restart and a copied folder upload and record nothing twice', async () => {
    const h = harness();
    const start = local(14, 1);
    h.files.add(folderName(start, 'Callie demo between David Cui and Jordan Placeholder'), demoFiles());
    await settle(h);
    await settle(h);
    await settle(h, h.build());
    // A copy of the same folder (same start, same files) beside it.
    h.files.add(`${folderName(start, 'Callie demo between David Cui and Jordan Placeholder')} copy`, demoFiles());
    await settle(h);
    expect(h.upload.puts).toHaveLength(2);
    expect(h.server.rows.get(meeting('1', local(14, 0)).meetingId)?.size).toBe(2);
    expect(stored(h)).toEqual(['uploaded', 'uploaded']);
  });

  it('asks when two meetings are near, uploads only after David chooses one, and “Not a Callie demo” drops it for good', async () => {
    const h = harness({ meetings: [meeting('1', local(14, 0)), meeting('2', local(14, 15), 'Riley Example')] });
    h.files.add(folderName(local(14, 5), 'Callie demo between David Cui and Jordan Placeholder'), demoFiles());
    const other = h.files.add(folderName(local(14, 20), 'Zoom Meeting'), [fakeFile('audio1.m4a', 'unknown mixed')]);
    await settle(h);
    const view = await h.importer.state();
    expect(view.items.map(item => item.state)).toEqual(['needs_matching', 'needs_matching']);
    expect(h.upload.puts).toEqual([]);
    const first = view.items.find(item => item.folderName.includes('Jordan'))!;
    expect(first.choices.map(choice => choice.meetingId)).toEqual([meeting('1', local(14, 0)).meetingId, meeting('2', local(14, 15)).meetingId]);

    await h.importer.chooseMeeting({ itemId: first.itemId, meetingId: meeting('2', local(14, 15)).meetingId });
    await h.importer.idle();
    expect(h.server.rows.get(meeting('2', local(14, 15)).meetingId)?.size).toBe(2);
    expect(h.server.rows.get(meeting('1', local(14, 0)).meetingId)).toBeUndefined();

    // A meeting it did not overlap is refused, and nothing moves.
    const second = (await h.importer.state()).items.find(item => item.itemId === itemIdOf(PERSON, other.path))!;
    expect((await h.importer.chooseMeeting({ itemId: second.itemId, meetingId: '00000000-0000-4000-8000-000000000777' })).notice).toBe('recording_choice_stale');
    await h.importer.ignore({ itemId: second.itemId });
    await settle(h);
    expect((await h.importer.state()).items.some(item => item.itemId === second.itemId)).toBe(false);
    expect(h.upload.puts.some(path => path.startsWith(other.path))).toBe(false);
  });

  it('never lists, hashes, uploads or shows a folder that overlaps no Callie meeting (a class, a call at another time)', async () => {
    const h = harness();
    const lecture = h.files.add(folderName(local(18, 30), 'Organic Chemistry Lecture'), [fakeFile('audio1.m4a', 'lecture'), fakeFile('Audio Record/audioProfessor1.m4a', 'prof')]);
    const unnamed = h.files.add('Some other recording', [fakeFile('audio1.m4a', 'other')], local(9, 0).getTime());
    h.files.add(folderName(local(14, 1), 'Callie demo between David Cui and Jordan Placeholder'), demoFiles());
    await settle(h);
    await settle(h);
    for (const path of [lecture.path, unnamed.path]) {
      expect(h.files.listed).not.toContain(path);
      expect(h.files.hashed.some(entry => entry.startsWith(path))).toBe(false);
      expect(h.files.statted.some(entry => entry.startsWith(path))).toBe(false);
      expect(h.upload.puts.some(entry => entry.startsWith(path))).toBe(false);
    }
    expect(Object.values(h.store.saved().people[PERSON]!.entries).map(entry => entry.folderName)).toEqual([expect.stringContaining('Jordan Placeholder')]);
    // Nothing of them is stored either: not the name, only a digest of the path once it is old.
    expect(JSON.stringify(h.store.saved())).not.toContain('Chemistry');
  });

  it('with no meeting read, decides nothing: no folder is listed until the server answers', async () => {
    const h = harness();
    const demo = h.files.add(folderName(local(14, 1), 'Callie demo between David Cui and Jordan Placeholder'), demoFiles());
    h.server.setOfflineReads(5);
    await settle(h);
    expect(h.files.listed).toEqual([]);
    expect((await h.importer.state()).items).toEqual([]);
    await settle(h);
    await settle(h);
    expect(h.files.listed).toContain(demo.path);
  });

  it('a folder with no audio at all fails as no_audio and never reads the video', async () => {
    const h = harness();
    h.files.add(folderName(local(14, 1), 'Callie demo between David Cui and Jordan Placeholder'), [fakeFile('video1.mp4', 'video')]);
    await settle(h);
    expect((await h.importer.state()).items).toEqual([expect.objectContaining({ state: 'failed', failure: 'no_audio' })]);
    expect(h.files.hashed).toEqual([]);
  });

  it('a refused register fails with its reason, and Retry sends every file again under new commands', async () => {
    const h = harness();
    h.files.add(folderName(local(14, 1), 'Callie demo between David Cui and Jordan Placeholder'), demoFiles());
    h.upload.setBehaviour(path => (path.includes('Jordan') ? 'fail' : 'ok'));
    await settle(h);
    // Three PUTs of the file across three scans (R7), and the fourth scan fails the folder.
    for (let round = 0; round < 3; round += 1) {
      h.advance(1000);
      await h.importer.scan();
      await h.importer.idle();
    }
    expect(h.upload.puts.filter(path => path.includes('Jordan'))).toHaveLength(3);
    const failed = (await h.importer.state()).items[0]!;
    expect(failed).toMatchObject({ state: 'failed', failure: 'upload_failed' });
    h.upload.setBehaviour(() => 'ok');
    await h.importer.retry({ itemId: failed.itemId });
    h.advance(STABLE_AFTER_MS + 1000);
    await h.importer.scan();
    await h.importer.idle();
    expect(stored(h)).toEqual(['uploaded']);
    expect(h.server.rows.get(meeting('1', local(14, 0)).meetingId)?.size).toBe(2);
  });

  it('another workspace on this Mac sees none of the first one’s folders, and a forgotten import writes nothing late', async () => {
    const h = harness();
    h.files.add(folderName(local(14, 1), 'Callie demo between David Cui and Jordan Placeholder'), demoFiles());
    await settle(h);
    expect(stored(h)).toHaveLength(1);
    await h.importer.forget();
    h.signIn({ workspaceId: '33333333-3333-4333-8333-333333333333', userId: USER, role: 'member' });
    h.setMeetings([]);
    expect((await h.importer.state()).items).toEqual([]);
    await settle(h);
    expect((await h.importer.state()).items).toEqual([]);
  });
});

/** A port call held until released: the reviewer's way of landing a command inside a scan. */
function latch() {
  let started!: () => void;
  let release!: () => void;
  const began = new Promise<void>(resolve => {
    started = resolve;
  });
  const released = new Promise<void>(resolve => {
    release = resolve;
  });
  return { began, released, started: () => started(), release: () => release() };
}

/** Interrupt every upload-url (offline): the folder is left `uploading`, its digests saved, nothing sent. */
async function interruptedUpload(h: ReturnType<typeof harness>): Promise<void> {
  h.server.setIntercept(path => (path === '/meetings/recordings/upload-url' ? { ok: false, reason: 'offline', offline: true } : null));
  await settle(h);
  h.server.setIntercept(null);
  expect(Object.values(h.store.saved().people[PERSON]!.entries).map(entry => entry.state)).toEqual(['uploading']);
}

describe('review M4R: the importer', () => {
  it('finding 1: “Not a Callie demo” during a scan stays final — the scan does not overwrite it, and nothing is sent', async () => {
    const two = [meeting('1', local(14, 0)), meeting('2', local(14, 15), 'Riley Example')];
    const h = harness({ meetings: two });
    h.files.add(folderName(local(14, 5), 'Callie demo between David Cui and Jordan Placeholder'), demoFiles());
    await settle(h);
    const item = (await h.importer.state()).items[0]!;
    expect(item.state).toBe('needs_matching');
    // Now the matcher would place it (one meeting left) — but David says it is not a demo while the scan lists the folder.
    h.setMeetings([two[0]!]);
    const list = h.files.fs.listFolder;
    const gate = latch();
    h.files.fs.listFolder = async path => {
      gate.started();
      await gate.released;
      return await list(path);
    };
    const pending = h.importer.scan();
    await gate.began;
    // R1: the command is a turn of its own, after the scan's; it is applied to what the scan left.
    let answeredEarly = false;
    const ignoring = h.importer.ignore({ itemId: item.itemId }).then(view => {
      answeredEarly = true;
      return view;
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(answeredEarly).toBe(false);
    gate.release();
    await pending;
    const ignored = await ignoring;
    expect(ignored.answered).toMatchObject({ itemId: item.itemId, item: null });
    expect(ignored.answered!.version).toBeGreaterThan(item.version);
    await h.importer.idle();
    h.files.fs.listFolder = list;
    await settle(h);
    expect((await h.importer.state()).items).toEqual([]);
    expect(h.upload.puts).toEqual([]);
    expect(h.store.saved().people[PERSON]!.entries[Object.keys(h.store.saved().people[PERSON]!.entries)[0]!]?.state).toBe('ignored');
  });

  it('finding 1: a choice made during a scan is kept; the scan’s older derivation is dropped', async () => {
    const two = [meeting('1', local(14, 0)), meeting('2', local(14, 15), 'Riley Example')];
    const h = harness({ meetings: two });
    h.files.add(folderName(local(14, 5), 'Callie demo between David Cui and Jordan Placeholder'), demoFiles());
    await settle(h);
    const item = (await h.importer.state()).items[0]!;
    const list = h.files.fs.listFolder;
    const gate = latch();
    h.files.fs.listFolder = async path => {
      gate.started();
      await gate.released;
      return await list(path);
    };
    const pending = h.importer.scan();
    await gate.began;
    h.files.fs.listFolder = list;
    const chose = h.importer.chooseMeeting({ itemId: item.itemId, meetingId: two[1]!.meetingId });
    gate.release();
    await Promise.all([pending, chose]);
    await h.importer.idle();
    expect(h.server.rows.get(two[1]!.meetingId)?.size).toBe(2);
    expect(h.server.rows.get(two[0]!.meetingId)).toBeUndefined();
  });

  it('finding 2: after a restart, a folder whose meeting moved out of its window is revalidated first — no stat, hash or PUT, and it is gone', async () => {
    const h = harness();
    const folder = h.files.add(folderName(local(14, 1), 'Callie demo between David Cui and Jordan Placeholder'), demoFiles());
    await interruptedUpload(h);
    const reads = h.server.calls.filter(call => call.path.includes('candidates')).length;
    // Rescheduled three hours later.
    h.setMeetings([meeting('1', local(17, 0))]);
    const touchedBefore = h.files.touched().length;
    const restarted = h.build();
    await restarted.scan();
    await restarted.idle();
    expect(h.server.calls.filter(call => call.path.includes('candidates')).length).toBeGreaterThan(reads);
    expect(h.files.touched().slice(touchedBefore).filter(path => path.startsWith(folder.path))).toEqual([]);
    expect(h.upload.puts).toEqual([]);
    expect((await restarted.state()).items).toEqual([]);
    expect(h.store.saved().people[PERSON]!.entries).toEqual({});
  });

  it('finding 2: after a restart with no candidates answer, nothing of the folder is touched and nothing is sent', async () => {
    const h = harness();
    const folder = h.files.add(folderName(local(14, 1), 'Callie demo between David Cui and Jordan Placeholder'), demoFiles());
    await interruptedUpload(h);
    const touchedBefore = h.files.touched().length;
    h.server.setOfflineReads(10);
    const restarted = h.build();
    await settle(h, restarted);
    expect(h.files.touched().slice(touchedBefore).filter(path => path.startsWith(folder.path))).toEqual([]);
    expect(h.upload.puts).toEqual([]);
    // Only the interrupted attempt before the restart; none after it.
    expect(h.server.commandsTo('/meetings/recordings/upload-url')).toHaveLength(1);
    // Answered again: revalidated, then resumed.
    h.server.setOfflineReads(0);
    await settle(h, restarted);
    expect(stored(h)).toEqual(['uploaded']);
  });

  it('findings 2 and 11: a meeting David chose that was folded into another is not kept — needs matching, the survivor offered, nothing sent to the old id', async () => {
    const two = [meeting('1', local(14, 0)), meeting('2', local(14, 15), 'Riley Example')];
    const h = harness({ meetings: two });
    h.files.add(folderName(local(14, 5), 'Callie demo between David Cui and Jordan Placeholder'), demoFiles());
    await settle(h);
    const item = (await h.importer.state()).items[0]!;
    h.server.setIntercept(path => (path === '/meetings/recordings/upload-url' ? { ok: false, reason: 'offline', offline: true } : null));
    await h.importer.chooseMeeting({ itemId: item.itemId, meetingId: two[0]!.meetingId });
    await h.importer.idle();
    h.server.setIntercept(null);
    // Meeting 1 folded into meeting 2 (the survivor), and the app restarted.
    h.setMeetings([two[1]!]);
    const restarted = h.build();
    await restarted.scan();
    await restarted.idle();
    const after = (await restarted.state()).items;
    expect(after).toEqual([expect.objectContaining({ state: 'needs_matching', meetingId: null })]);
    expect(after[0]?.choices.map(choice => choice.meetingId)).toEqual([two[1]!.meetingId]);
    expect(h.upload.puts).toEqual([]);
    expect(h.server.commandsTo('/meetings/recordings/upload-url').filter(call => call.body?.['meetingId'] === two[0]!.meetingId)).toHaveLength(1);
    expect(h.server.commandsTo('/meetings/recordings/upload-url')).toHaveLength(1);
  });

  it('finding 11: an upload refused meeting_unknown (deleted between the read and the command) goes back to Needs matching, not failed', async () => {
    const h = harness();
    h.files.add(folderName(local(14, 1), 'Callie demo between David Cui and Jordan Placeholder'), demoFiles());
    h.server.setIntercept(path => (path === '/meetings/recordings/upload-url' ? { ok: false, reason: 'meeting_unknown', offline: false } : null));
    await settle(h);
    expect((await h.importer.state()).items).toEqual([expect.objectContaining({ state: 'needs_matching', meetingId: null, failure: null })]);
    expect(h.upload.puts).toEqual([]);
  });

  it('finding 5: a folder imported by hand that overlaps no meeting is never stored — not its path, not its name', async () => {
    const h = harness();
    const chemistry = h.files.add('2026-10-05 19.00.00 Chemistry class', [fakeFile('Audio Record/audioProfessorExample1.m4a', 'lecture')], 1, '/Users/test/Elsewhere');
    h.choose(chemistry.path);
    await h.importer.importFolder();
    await h.importer.idle();
    expect((await h.importer.state()).items).toEqual([]);
    expect(h.files.touched().filter(path => path.startsWith(chemistry.path))).toEqual([]);
    const saved = JSON.stringify(h.store.saved());
    expect(saved).not.toContain('Chemistry');
    expect(saved).not.toContain('Elsewhere');
  });

  it('finding 5: a folder imported by hand that overlaps a meeting is kept and uploaded', async () => {
    const h = harness();
    const demo = h.files.add(folderName(local(14, 1), 'Callie demo between David Cui and Jordan Placeholder'), demoFiles(), 1, '/Users/test/Elsewhere');
    h.choose(demo.path);
    await h.importer.importFolder();
    h.advance(STABLE_AFTER_MS + 1000);
    await h.importer.scan();
    await h.importer.idle();
    expect(stored(h)).toEqual(['uploaded']);
  });

  it('finding 6: a sign-out while state() loads the store drops the late answer; the next read shows nothing', async () => {
    const h = harness();
    h.files.add(folderName(local(14, 1), 'Callie demo between David Cui and Jordan Placeholder'), demoFiles());
    await settle(h);
    const gate = latch();
    const slow: RecordingStore = {
      load: async () => {
        gate.started();
        await gate.released;
        return await h.store.load();
      },
      save: async value => {
        await h.store.save(value);
      },
    };
    const raw = h.build(slow);
    let epoch = 0;
    const guarded = guardIdentity(raw, () => epoch);
    const pending = guarded.state();
    await gate.began;
    epoch += 1;
    h.signIn(null);
    await raw.forget();
    gate.release();
    expect((await pending).items).toEqual([]);
    expect((await guarded.state()).items).toEqual([]);
    expect((await raw.state()).items).toEqual([]);
  });

  it('finding 7: another person in the same workspace sees none of the first one’s folders; the first sees theirs again', async () => {
    const h = harness();
    h.files.add(folderName(local(14, 1), 'Callie demo between David Cui and Jordan Placeholder'), demoFiles());
    await settle(h);
    await h.importer.forget();
    h.signIn({ workspaceId: WORKSPACE, userId: '66666666-6666-4666-8666-666666666666', role: 'member' });
    h.setMeetings([]);
    const other = h.build();
    expect((await other.state()).items).toEqual([]);
    await settle(h, other);
    expect((await other.state()).items).toEqual([]);
    await other.forget();
    h.signIn(ME);
    expect(stored(h)).toEqual(['uploaded']);
  });

  it('finding 9: a staged object that expired before the register is sent again, and registered', async () => {
    const h = harness();
    h.files.add(folderName(local(14, 1), 'Callie demo between David Cui and Jordan Placeholder'), demoFiles());
    h.server.setIntercept(path => (path === '/meetings/recordings/register' ? { ok: false, reason: 'offline', offline: true } : null));
    await settle(h);
    expect(h.upload.puts).toHaveLength(2);
    h.server.setIntercept(null);
    h.server.expireObjects();
    const restarted = h.build();
    for (let round = 0; round < 3; round += 1) await settle(h, restarted);
    expect(stored(h)).toEqual(['uploaded']);
    expect(h.upload.puts).toHaveLength(4);
    expect(h.server.rows.get(meeting('1', local(14, 0)).meetingId)?.size).toBe(2);
  });

  it('finding 9: objects that never stay fail the folder after three registers, with Retry', async () => {
    const h = harness();
    h.files.add(folderName(local(14, 1), 'Callie demo between David Cui and Jordan Placeholder'), demoFiles());
    h.server.setIntercept(path => {
      if (path === '/meetings/recordings/register') h.server.expireObjects();
      return null;
    });
    for (let round = 0; round < 5; round += 1) await settle(h);
    expect(h.server.commandsTo('/meetings/recordings/register')).toHaveLength(3);
    expect(h.upload.puts).toHaveLength(6);
    const failed = (await h.importer.state()).items[0]!;
    expect(failed).toMatchObject({ state: 'failed', failure: 'upload_failed' });
    h.server.setIntercept(null);
    await h.importer.retry({ itemId: failed.itemId });
    await settle(h);
    expect(stored(h)).toEqual(['uploaded']);
  });

  it('finding 10: a truncated answer decides nothing — each folder is read on its own window, and one still truncated waits', async () => {
    const h = harness({ meetings: [meeting('1', local(14, 0)), meeting('2', new Date(2026, 9, 1, 10, 0)), meeting('3', new Date(2026, 9, 1, 10, 20))] });
    h.server.setMaxCandidates(1);
    const demo = h.files.add(folderName(local(14, 1), 'Callie demo between David Cui and Jordan Placeholder'), demoFiles());
    // Four days earlier, beside two meetings: its own window holds two, more than the limit.
    const crowded = h.files.add(folderName(new Date(2026, 9, 1, 10, 5), 'Callie demo with Jordan Placeholder'), demoFiles());
    await settle(h);
    expect(h.files.listed).toContain(demo.path);
    expect(h.files.listed).not.toContain(crowded.path);
    expect(stored(h)).toEqual(['uploaded']);
    // Nothing was settled for the crowded folder: once the answer is complete, it is decided.
    h.server.setMaxCandidates(100);
    await settle(h);
    expect(h.files.listed).toContain(crowded.path);
    expect(stored(h)).toEqual(['uploaded', 'needs_matching']);
  });

  it('a file named .m4a that is not audio-only MP4 fails as not_audio: never hashed, never sent', async () => {
    const h = harness();
    h.files.add(folderName(local(14, 1), 'Callie demo between David Cui and Jordan Placeholder'), [
      fakeFile('Audio Record/audioDavidCui11234567890.m4a', 'video: a renamed screen recording', 1),
    ]);
    await settle(h);
    expect((await h.importer.state()).items).toEqual([expect.objectContaining({ state: 'failed', failure: 'not_audio' })]);
    expect(h.files.hashed).toEqual([]);
    expect(h.upload.puts).toEqual([]);
    expect(h.server.commandsTo('/meetings/recordings/upload-url')).toHaveLength(0);
  });

  it('M4 verification finding A: a file with a compressed movie header, judged by the real audio check, is not_audio and nothing is committed', async () => {
    const h = harness();
    const bytes = cmovPlusAudio();
    h.files.fs.sniff = async path => {
      h.files.sniffed.push(path);
      return await sniffAudio({ size: bytes.length, read: async (offset, length) => await Promise.resolve(bytes.subarray(offset, offset + length)) });
    };
    h.files.add(folderName(local(14, 1), 'Callie demo between David Cui and Jordan Placeholder'), [
      fakeFile('Audio Record/audioJordanPlaceholder21234567890.m4a', 'stands for the compressed-movie bytes above', 1),
    ]);
    await settle(h);
    expect(h.files.sniffed).toHaveLength(1);
    expect((await h.importer.state()).items).toEqual([expect.objectContaining({ state: 'failed', failure: 'not_audio' })]);
    expect(h.files.hashed).toEqual([]);
    expect(h.upload.puts).toEqual([]);
    expect(h.server.commandsTo('/meetings/recordings/upload-url')).toHaveLength(0);
    expect(h.server.commandsTo('/meetings/recordings')).toHaveLength(0);
  });

  it('finding 12: a command answers its own item with that item’s version', async () => {
    const two = [meeting('1', local(14, 0)), meeting('2', local(14, 15), 'Riley Example')];
    const h = harness({ meetings: two });
    h.files.add(folderName(local(14, 5), 'Callie demo between David Cui and Jordan Placeholder'), demoFiles());
    await settle(h);
    const item = (await h.importer.state()).items[0]!;
    h.server.setIntercept(path => (path === '/meetings/recordings/upload-url' ? { ok: false, reason: 'offline', offline: true } : null));
    const chose = await h.importer.chooseMeeting({ itemId: item.itemId, meetingId: two[0]!.meetingId });
    expect(chose.answered?.itemId).toBe(item.itemId);
    expect(chose.answered?.version).toBeGreaterThan(item.version);
    expect(chose.answered?.item).toMatchObject({ itemId: item.itemId, meetingId: two[0]!.meetingId });
    const stale = await h.importer.retry({ itemId: item.itemId });
    expect(stale.notice).toBe('recording_choice_stale');
    expect(stale.answered?.itemId).toBe(item.itemId);
  });
});

describe('the M4 design reset (review M4F repros)', () => {
  const two = (): RecordingCandidate[] => [meeting('1', local(14, 0)), meeting('2', local(14, 15), 'Riley Example')];

  it('R1: a store load still under way when a scan and an ignore are asked for comes first; the ignore stays final, one load, nothing sent (M4F #1)', async () => {
    const h = harness({ meetings: two() });
    h.files.add(folderName(local(14, 5), 'Callie demo between David Cui and Jordan Placeholder'), demoFiles());
    await settle(h);
    const item = (await h.importer.state()).items[0]!;
    expect(item.state).toBe('needs_matching');
    const gate = latch();
    let loads = 0;
    const slow: RecordingStore = {
      load: async () => {
        loads += 1;
        const saved = await h.store.load();
        if (loads === 1) {
          gate.started();
          await gate.released;
        }
        return saved;
      },
      save: async value => {
        await h.store.save(value);
      },
    };
    const raw = h.build(slow);
    const delayed = raw.state();
    await gate.began;
    // The reviewer's order: the scan and the ignore are asked for, and given every chance to
    // finish, while the first load is still out. They wait for it (one writer).
    let finished = 0;
    const scanned = raw.scan().then(view => {
      finished += 1;
      return view;
    });
    const ignoring = raw.ignore({ itemId: item.itemId }).then(view => {
      finished += 1;
      return view;
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(finished).toBe(0);
    gate.release();
    await delayed;
    await scanned;
    expect((await ignoring).items).toEqual([]);
    // Now the matcher would place it on its own: the ignore holds, and nothing is sent.
    h.setMeetings([two()[0]!]);
    h.advance(STABLE_AFTER_MS + 1000);
    await raw.scan();
    await raw.idle();
    expect(loads).toBe(1);
    expect(h.upload.puts).toEqual([]);
    expect(stored(h)).toEqual(['ignored']);
    expect((await raw.state()).items).toEqual([]);
  });

  it('R2: an interrupted upload whose meeting moved away is not resumed on the strength of the last scan when the reread is truncated (M4F #2)', async () => {
    const h = harness();
    const folder = h.files.add(folderName(local(14, 1), 'Callie demo between David Cui and Jordan Placeholder'), [
      ...demoFiles(),
      fakeFile('Audio Record/audioRileyExample31234567890.m4a', 'previously unread second speaker', 1),
    ]);
    h.upload.setBehaviour(() => 'fail');
    await settle(h);
    expect(stored(h)).toEqual(['uploading']);
    const moved = meeting('1', local(17, 0));
    const crowded = Array.from({ length: 101 }, (_, index) => meeting(String(500 + index), new Date(local(14, 0).getTime() - DAY + index * 60_000)));
    h.setMeetings([...crowded, moved]);
    h.upload.setBehaviour(() => 'ok');
    const touched = h.files.touched().length;
    const puts = h.upload.puts.length;
    await h.importer.scan();
    await h.importer.idle();
    expect(h.files.touched().slice(touched).filter(path => path.startsWith(folder.path))).toEqual([]);
    expect(h.upload.puts.length).toBe(puts);
    expect(h.server.commandsTo('/meetings/recordings/register')).toHaveLength(0);
  });

  it('R2: a step more than 60 s after the scan reads the folder’s window again; the meeting moved meanwhile, so nothing is sent', async () => {
    const h = harness();
    const folder = h.files.add(folderName(local(14, 1), 'Callie demo between David Cui and Jordan Placeholder'), demoFiles());
    await h.importer.scan();
    h.advance(STABLE_AFTER_MS + 1000);
    // Hashing the first file takes 61 seconds, and the meeting is moved meanwhile.
    const hash = h.files.fs.sha256;
    h.files.fs.sha256 = async path => {
      h.advance(61_000);
      h.setMeetings([meeting('1', local(17, 0))]);
      return await hash(path);
    };
    const reads = h.server.calls.filter(call => call.path.includes('candidates')).length;
    await h.importer.scan();
    await h.importer.idle();
    expect(h.server.calls.filter(call => call.path.includes('candidates')).length).toBe(reads + 2);
    expect(h.upload.puts).toEqual([]);
    expect(h.server.commandsTo('/meetings/recordings/upload-url')).toHaveLength(0);
    expect(h.store.saved().people[PERSON]!.entries[folder.path]).toBeUndefined();
  });

  it('R5: the same person downgraded starts empty, with no candidates read, and stays empty when the read fails (M4F #4)', async () => {
    const h = harness({ meetings: two() });
    h.signIn({ ...ME, role: 'admin' });
    h.files.add(folderName(local(14, 5), 'Callie demo between David Cui and Jordan Placeholder'), demoFiles());
    await settle(h);
    expect((await h.importer.state()).items.map(item => item.state)).toEqual(['needs_matching']);
    await h.importer.forget();
    h.signIn(ME);
    h.setMeetings([]);
    const calls = h.server.calls.length;
    expect((await h.importer.state()).items).toEqual([]);
    expect(h.server.calls).toHaveLength(calls);
    h.server.setOfflineReads(1);
    await h.importer.scan();
    expect((await h.importer.state()).items).toEqual([]);
    // The admin's entries are still the admin's.
    expect(stored(h, `${WORKSPACE}:${USER}:admin`)).toEqual(['needs_matching']);
  });

  it('R1: an entry removed and recreated takes a newer version, so an older answer about it is not drawn (M4F #8)', async () => {
    const h = harness({ meetings: two() });
    h.files.add(folderName(local(14, 5), 'Callie demo between David Cui and Jordan Placeholder'), demoFiles());
    await settle(h);
    const before = (await h.importer.state()).items[0]!;
    h.server.setIntercept(path => (path === '/meetings/recordings/upload-url' ? { ok: false, reason: 'offline', offline: true } : null));
    const oldAnswer = await h.importer.chooseMeeting({ itemId: before.itemId, meetingId: two()[0]!.meetingId });
    await h.importer.idle();
    h.setMeetings([]);
    await h.importer.scan();
    await h.importer.idle();
    expect((await h.importer.state()).items).toEqual([]);
    h.setMeetings(two());
    await h.importer.scan();
    await h.importer.idle();
    const latest = await h.importer.state();
    expect(latest.items[0]).toMatchObject({ itemId: before.itemId, state: 'needs_matching' });
    expect(latest.items[0]!.version).toBeGreaterThan(oldAnswer.answered!.version);
    const merged = applyAnswered(latest, oldAnswer);
    expect(merged?.items[0]).toMatchObject({ state: 'needs_matching', meetingId: null });
  });

  it('R7: a meeting the server keeps refusing while the candidates keep offering it is sent at most three times, then fails with Retry (M4F loop)', async () => {
    const h = harness();
    h.files.add(folderName(local(14, 1), 'Callie demo between David Cui and Jordan Placeholder'), [fakeFile('Audio Record/audioJordanPlaceholder21234567890.m4a', 'jordan', 1)]);
    h.server.setIntercept(path => (path === '/meetings/recordings/register' ? { ok: false, reason: 'meeting_unknown', offline: false } : null));
    await settle(h);
    for (let round = 0; round < 6; round += 1) {
      await h.importer.scan();
      await h.importer.idle();
    }
    expect(h.upload.puts).toHaveLength(3);
    const failed = (await h.importer.state()).items[0]!;
    expect(failed).toMatchObject({ state: 'failed', failure: 'upload_failed' });
    // Retry resets the count.
    h.server.setIntercept(null);
    await h.importer.retry({ itemId: failed.itemId });
    await settle(h);
    expect(stored(h)).toEqual(['uploaded']);
    expect(h.upload.puts).toHaveLength(4);
  });

  it('R4: a registered folder is not shown by this Mac at all, its folder removed or not; the firm page reads the server', async () => {
    const h = harness({ meetings: two() });
    const folder = h.files.add(folderName(local(14, 5), 'Callie demo between David Cui and Jordan Placeholder'), demoFiles());
    await settle(h);
    const item = (await h.importer.state()).items[0]!;
    await h.importer.chooseMeeting({ itemId: item.itemId, meetingId: two()[0]!.meetingId });
    await h.importer.idle();
    expect(stored(h)).toEqual(['uploaded']);
    expect((await h.importer.state()).items).toEqual([]);
    h.files.remove(folder.path);
    h.setMeetings([two()[1]!]);
    await h.importer.scan();
    await h.importer.idle();
    expect((await h.importer.state()).items).toEqual([]);
    expect(h.upload.puts).toHaveLength(2);
  });
});

describe('the M4RR repair (the reviewer’s probes)', () => {
  const moved = (): RecordingCandidate => meeting('1', local(17, 0));
  const demo = (h: ReturnType<typeof harness>) => h.files.add(folderName(local(14, 1), 'Callie demo between David Cui and Jordan Placeholder'), demoFiles());
  const candidateReads = (h: ReturnType<typeof harness>): number => h.server.calls.filter(call => call.path.includes('candidates')).length;

  it('finding 2: a sniff that takes 61 s while the meeting moves away — the hash is not started (slow sniff)', async () => {
    const h = harness();
    demo(h);
    const sniff = h.files.fs.sniff;
    h.files.fs.sniff = async path => {
      const verdict = await sniff(path);
      h.advance(61_000);
      h.setMeetings([moved()]);
      return verdict;
    };
    await settle(h);
    expect(h.files.sniffed).toHaveLength(1);
    expect(h.files.hashed).toEqual([]);
    expect(h.upload.puts).toEqual([]);
  });

  it('finding 2: an upload URL that takes 61 s while the meeting moves away — the PUT is not started (delayed URL)', async () => {
    const h = harness();
    demo(h);
    const command = h.server.api.command.bind(h.server.api);
    h.server.api.command = async (path, payload, parse, options) => {
      const answered = await command(path, payload, parse, options);
      if (path === '/meetings/recordings/upload-url') {
        h.advance(61_000);
        h.setMeetings([moved()]);
      }
      return answered;
    };
    await settle(h);
    expect(h.server.commandsTo('/meetings/recordings/upload-url')).toHaveLength(1);
    expect(h.upload.puts).toEqual([]);
    expect(h.server.commandsTo('/meetings/recordings/register')).toHaveLength(0);
  });

  it('finding 2: a 61 s listing of one folder never lends the scan’s answer to the next folder (slow earlier listing)', async () => {
    const h = harness();
    const first = demo(h);
    const later = h.files.add(folderName(local(14, 2), 'Callie demo between David Cui and Jordan Placeholder'), [
      fakeFile('Audio Record/audioJordanPlaceholder21234567899.m4a', 'other jordan', 1),
    ]);
    await h.importer.scan();
    h.advance(STABLE_AFTER_MS + 1000);
    const list = h.files.fs.listFolder;
    h.files.fs.listFolder = async path => {
      if (path === first.path) {
        h.advance(61_000);
        h.setMeetings([moved()]);
      }
      return await list(path);
    };
    const reads = candidateReads(h);
    await h.importer.scan();
    await h.importer.idle();
    // The next folder's answer was read again before its listing, and it no longer overlaps.
    expect(candidateReads(h)).toBeGreaterThan(reads + 1);
    expect(h.files.listed.filter(path => path === later.path)).toHaveLength(1);
    expect(h.upload.puts.filter(path => path.startsWith(later.path))).toEqual([]);
    expect(h.server.commandsTo('/meetings/recordings/register')).toHaveLength(0);
    expect(h.store.saved().people[PERSON]!.entries[later.path]).toBeUndefined();
  });

  it('finding 4: a file failed after three PUTs stays failed when its folder loses and regains its overlap — no fourth PUT without Retry', async () => {
    const h = harness();
    h.files.add(folderName(local(14, 1), 'Callie demo between David Cui and Jordan Placeholder'), [fakeFile('Audio Record/audioJordanPlaceholder21234567890.m4a', 'jordan', 1)]);
    h.upload.setBehaviour(() => 'fail');
    await settle(h);
    for (let round = 0; round < 3; round += 1) {
      await h.importer.scan();
      await h.importer.idle();
    }
    expect(stored(h)).toEqual(['failed']);
    expect(h.upload.puts).toHaveLength(3);
    for (let round = 0; round < 3; round += 1) {
      h.setMeetings([]);
      await h.importer.scan();
      await h.importer.idle();
      expect(stored(h)).toEqual([]);
      h.setMeetings([meeting('1', local(14, 0))]);
      await settle(h);
    }
    expect(h.upload.puts).toHaveLength(3);
    expect(stored(h)).toEqual(['failed']);
    // Retry, and only Retry, starts the count again.
    h.upload.setBehaviour(() => 'ok');
    await h.importer.retry({ itemId: (await h.importer.state()).items[0]!.itemId });
    await settle(h);
    expect(stored(h)).toEqual(['uploaded']);
    expect(h.upload.puts).toHaveLength(4);
  });

  it('finding 4: the meeting-gone loop with the overlap lost and regained in between is still bounded at three PUTs', async () => {
    const h = harness();
    h.files.add(folderName(local(14, 1), 'Callie demo between David Cui and Jordan Placeholder'), [fakeFile('Audio Record/audioJordanPlaceholder21234567890.m4a', 'jordan', 1)]);
    h.server.setIntercept(path => (path === '/meetings/recordings/register' ? { ok: false, reason: 'meeting_unknown', offline: false } : null));
    await settle(h);
    for (let round = 0; round < 5; round += 1) {
      h.setMeetings([]);
      await h.importer.scan();
      await h.importer.idle();
      h.setMeetings([meeting('1', local(14, 0))]);
      await settle(h);
    }
    expect(h.upload.puts).toHaveLength(3);
    expect(h.server.commandsTo('/meetings/recordings/register')).toHaveLength(3);
  });

  it('finding 5: an ignore of an unrelated item answers while a PUT is held; the PUT then commits under its lease', async () => {
    const h = harness({ meetings: [meeting('1', local(14, 0)), meeting('2', local(15, 10), 'Riley Example'), meeting('3', local(15, 20), 'Sam Example')] });
    demo(h);
    h.files.add(folderName(local(15, 15), 'Zoom Meeting'), [fakeFile('Audio Record/audioSomebody1.m4a', 'somebody', 1)]);
    const gate = latch();
    const put = h.upload.uploader.put.bind(h.upload.uploader);
    let held = 0;
    h.upload.uploader.put = async (url, headers, path, signal) => {
      held += 1;
      if (held === 1) {
        gate.started();
        await gate.released;
      }
      return await put(url, headers, path, signal);
    };
    await h.importer.scan();
    h.advance(STABLE_AFTER_MS + 1000);
    const scanned = h.importer.scan();
    await gate.began;
    await scanned;
    const other = (await h.importer.state()).items.find(item => item.state === 'needs_matching')!;
    let answered = false;
    const ignoring = h.importer.ignore({ itemId: other.itemId }).then(view => {
      answered = true;
      return view;
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(answered).toBe(true);
    expect((await ignoring).answered).toMatchObject({ itemId: other.itemId, item: null });
    // A scan runs during the transfer too.
    await h.importer.scan();
    gate.release();
    await h.importer.idle();
    expect(stored(h)).toEqual(['ignored', 'uploaded']);
    expect(h.upload.puts).toHaveLength(2);
  });

  it('finding 5: a PUT whose lease was lost meanwhile (the folder no longer overlaps) commits nothing, and nothing is registered', async () => {
    const h = harness();
    demo(h);
    const gate = latch();
    const put = h.upload.uploader.put.bind(h.upload.uploader);
    h.upload.uploader.put = async (url, headers, path, signal) => {
      gate.started();
      await gate.released;
      return await put(url, headers, path, signal);
    };
    await h.importer.scan();
    h.advance(STABLE_AFTER_MS + 1000);
    void h.importer.scan();
    await gate.began;
    h.setMeetings([moved()]);
    await h.importer.scan();
    expect(stored(h)).toEqual([]);
    gate.release();
    await h.importer.idle();
    expect(stored(h)).toEqual([]);
    expect(h.server.commandsTo('/meetings/recordings/register')).toHaveLength(0);
  });

  it('finding 5: a PUT whose entry changed meanwhile (now ambiguous, Needs matching) is dropped — never marked sent under the new state', async () => {
    const h = harness();
    demo(h);
    const gate = latch();
    const put = h.upload.uploader.put.bind(h.upload.uploader);
    h.upload.uploader.put = async (url, headers, path, signal) => {
      gate.started();
      await gate.released;
      return await put(url, headers, path, signal);
    };
    await h.importer.scan();
    h.advance(STABLE_AFTER_MS + 1000);
    void h.importer.scan();
    await gate.began;
    // A second meeting appears beside the first: the folder needs David now.
    h.setMeetings([meeting('1', local(14, 0)), meeting('2', local(14, 10), 'Riley Example')]);
    await h.importer.scan();
    expect(stored(h)).toEqual(['needs_matching']);
    gate.release();
    await h.importer.idle();
    const entry = Object.values(h.store.saved().people[PERSON]!.entries)[0]!;
    expect(entry.state).toBe('needs_matching');
    expect(entry.files.map(stored => stored.uploaded)).toEqual([false, false]);
    expect(h.server.commandsTo('/meetings/recordings/register')).toHaveLength(0);
  });

  it('finding 5: a sign-out aborts the PUT in flight and the import drains', async () => {
    const h = harness();
    demo(h);
    let aborted = false;
    const began = latch();
    h.upload.uploader.put = async (_url, _headers, _path, signal) => {
      signal?.addEventListener('abort', () => {
        aborted = true;
      });
      began.started();
      return await new Promise(() => undefined);
    };
    await h.importer.scan();
    h.advance(STABLE_AFTER_MS + 1000);
    void h.importer.scan();
    await began.began;
    h.signIn(null);
    await h.importer.forget();
    await h.importer.idle();
    expect(aborted).toBe(true);
    expect((await h.importer.state()).items).toEqual([]);
  });
});

describe('meeting source recovery', () => {
  function recoveryHarness() {
    let permitted = true, ready = false, identity: string | null = PERSON;
    const recordingId = '11111111-1111-4111-8111-111111111111';
    const file = `${ROOT}/demo/audio.m4a`;
    const fs = { realPath: vi.fn(async (p: string) => p), statFile: vi.fn(async () => ({ sizeBytes: 100, ino: 1, mtimeMs: 1 })), sniff: vi.fn(async () => 'audio' as const), sha256: vi.fn(async () => sha('same bytes')) };
    const uploader = { put: vi.fn(async () => ({ ok: true as const })) };
    const api = createAuthedClient({ baseUrl: 'https://api.example.test', clientVersion: '1.0.39', accessToken: async () => identity === null ? null : { token: 'fixture', generation: 0 }, send: async url => {
      if (!permitted) return { status: 409, body: { reason: 'recording_recovery_unavailable' } };
      const result = url.endsWith('recovery-complete') ? { status: 'resumed' } : ready ? { status: 'ready' } : { status: 'upload', recordingId, meetingId: WORKSPACE, sizeBytes: 100, sha256: sha('same bytes'), upload: { status: 'upload', key: `meetings/${WORKSPACE}/${sha('same bytes')}.m4a`, url: 'https://audio.example.test/put', expiresAt: new Date(Date.now()+900000).toISOString(), headers: { 'content-type': 'audio/mp4', 'content-length': '100', 'x-amz-checksum-sha256': 'a'.repeat(43)+'=', 'x-amz-meta-callie-upload': USER } } };
      return { status: 200, body: { status: 'accepted', replayed: false, result } };
    } });
    const controller = new AbortController();
    const run = (chooseFile?: () => Promise<string | null>) => recoverMeetingRecording({ api, fs, uploader, recordingId, identity: async () => identity, expectedIdentity: PERSON, signal: controller.signal, root: ROOT, sources: [{ path: file, sha256: sha('same bytes') }], ...(chooseFile === undefined ? {} : { chooseFile }) });
    return { fs, uploader, run, controller, revoke: () => { permitted = false; }, ready: () => { ready = true; }, logout: () => { identity = null; controller.abort(); } };
  }
  it('wrong_file_does_not_upload', async () => {
    const h = recoveryHarness(); h.fs.sha256.mockResolvedValue(sha('different bytes'));
    expect(await h.run()).toEqual({ status: 'wrong_file' }); expect(h.uploader.put).not.toHaveBeenCalled();
  });
  it('revoked_authority_precedes_local_read', async () => {
    const h = recoveryHarness(); h.revoke(); expect(await h.run()).toEqual({ status: 'unavailable' });
    expect(h.fs.statFile).not.toHaveBeenCalled(); expect(h.fs.sha256).not.toHaveBeenCalled();
  });
  it('registered_success_does_not_reupload', async () => {
    const h = recoveryHarness(); h.ready(); expect(await h.run()).toEqual({ status: 'already_ready' }); expect(h.fs.statFile).not.toHaveBeenCalled();
  });
  it('reauthorizes after hashing, so reassignment cannot start the PUT', async () => {
    const h = recoveryHarness(); h.fs.sha256.mockImplementation(async () => { h.revoke(); return sha('same bytes'); });
    expect(await h.run()).toEqual({ status: 'unavailable' }); expect(h.uploader.put).not.toHaveBeenCalled();
  });
  it('requires a picker for a path resolving outside the demo folder', async () => {
    const h = recoveryHarness(); h.fs.realPath.mockImplementation(async p => p.endsWith('.m4a') ? '/outside/audio.m4a' : p);
    expect(await h.run()).toEqual({ status: 'choose_file' }); expect(h.fs.sha256).not.toHaveBeenCalled();
    expect(await h.run(async () => '/chosen/audio.m4a')).toEqual({ status: 'resumed' }); expect(h.uploader.put).toHaveBeenCalledTimes(1);
  });
  it('logout during local work does not upload or complete', async () => {
    const h = recoveryHarness(); h.fs.sha256.mockImplementation(async () => { h.logout(); return sha('same bytes'); });
    expect(await h.run()).toEqual({ status: 'unavailable' }); expect(h.uploader.put).not.toHaveBeenCalled();
  });
});
