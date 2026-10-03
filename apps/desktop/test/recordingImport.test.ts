import { describe, expect, it } from 'vitest';
import type { RecordingCandidate } from '@fss/contracts';
import { createRecordingImporter, itemIdOf, type RecordingImportHost } from '../src/main/recordings/importer.ts';
import { STABLE_AFTER_MS } from '../src/main/recordings/zoomFolder.ts';
import { memoryRecordingStore, type RecordingStore } from '../src/main/recordings/store.ts';
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
const T0 = new Date(2026, 9, 5, 14, 40, 0).getTime();

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
    attendeeEmail: 'jordan.placeholder@example.test',
  };
}

function harness(options: { meetings?: RecordingCandidate[]; store?: RecordingStore & { saved(): unknown } } = {}) {
  let clock = T0;
  let meetings = options.meetings ?? [meeting('1', local(14, 0))];
  const files = fakeFs(ROOT);
  const server = fakeServer(() => meetings);
  const upload = fakeUploader(server, files);
  const store = options.store ?? memoryRecordingStore();
  let signedIn: string | null = WORKSPACE;
  const build = (s: RecordingStore = store): RecordingImportHost =>
    createRecordingImporter({
      api: server.api,
      fs: files.fs,
      uploader: upload.uploader,
      store: s,
      identity: async () => await Promise.resolve(signedIn === null ? null : { workspaceId: signedIn }),
      defaultFolder: ROOT,
      openFolderDialog: async () => await Promise.resolve({ canceled: true, filePaths: [] }),
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
    signIn: (workspace: string | null) => {
      signedIn = workspace;
    },
  };
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
    const saved = h.store.saved() as { workspaces: Record<string, { entries: Record<string, { state: string; files: { uploaded: boolean }[] }> }> };
    const entry = saved.workspaces[WORKSPACE]!.entries[folder.path]!;
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
    expect((await restarted.state()).items.map(item => item.state)).toEqual(['uploaded']);
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
    expect((await restarted.state()).items[0]?.state).toBe('uploaded');
    // Nothing was uploaded twice: the files were marked sent before the register.
    expect(h.upload.puts).toHaveLength(2);
  });
});

describe('the demo recording import (acceptance)', () => {
  it('matches a corroborated folder to its meeting and uploads each participant’s audio, never the video or the mixed file', async () => {
    const h = harness();
    const folder = h.files.add(folderName(local(14, 1), 'Callie demo between David Cui and Jordan Placeholder'), demoFiles());
    await settle(h);
    const view = await h.importer.state();
    expect(view.items).toEqual([
      expect.objectContaining({ itemId: itemIdOf(WORKSPACE, folder.path), state: 'uploaded', meetingId: meeting('1', local(14, 0)).meetingId, uploaded: 2, total: 2 }),
    ]);
    expect(h.upload.puts.map(path => path.slice(folder.path.length + 1))).toEqual([
      'Audio Record/audioDavidCui11234567890.m4a',
      'Audio Record/audioJordanPlaceholder21234567890.m4a',
    ]);
    expect(h.files.hashed.some(path => path.endsWith('.mp4'))).toBe(false);
    expect(h.files.hashed.some(path => path.endsWith('audio1234567890.m4a'))).toBe(false);
    const register = h.server.commandsTo('/meetings/recordings/register')[0]?.body;
    expect(register?.['files']).toEqual([
      { sha256: sha('david segment one'), sizeBytes: 17, participantLabel: 'audioDavidCui11234567890.m4a', segment: 1 },
      { sha256: sha('jordan segment one'), sizeBytes: 18, participantLabel: 'audioJordanPlaceholder21234567890.m4a', segment: 1 },
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
    expect((await h.importer.state()).items[0]?.state).toBe('uploaded');
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
    const states = (await h.importer.state()).items.map(item => item.state);
    expect(states).toEqual(['uploaded', 'uploaded']);
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
    const second = (await h.importer.state()).items.find(item => item.itemId === itemIdOf(WORKSPACE, other.path))!;
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
    const view = await h.importer.state();
    expect(view.items.map(item => item.folderName)).toEqual([expect.stringContaining('Jordan Placeholder')]);
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
    h.advance(1000);
    await h.importer.scan();
    await h.importer.idle();
    await h.importer.scan();
    await h.importer.idle();
    const failed = (await h.importer.state()).items[0]!;
    expect(failed).toMatchObject({ state: 'failed', failure: 'upload_failed' });
    h.upload.setBehaviour(() => 'ok');
    await h.importer.retry({ itemId: failed.itemId });
    h.advance(STABLE_AFTER_MS + 1000);
    await h.importer.scan();
    await h.importer.idle();
    expect((await h.importer.state()).items[0]?.state).toBe('uploaded');
    expect(h.server.rows.get(meeting('1', local(14, 0)).meetingId)?.size).toBe(2);
  });

  it('another workspace on this Mac sees none of the first one’s folders, and a forgotten import writes nothing late', async () => {
    const h = harness();
    h.files.add(folderName(local(14, 1), 'Callie demo between David Cui and Jordan Placeholder'), demoFiles());
    await settle(h);
    expect((await h.importer.state()).items).toHaveLength(1);
    await h.importer.forget();
    h.signIn('33333333-3333-4333-8333-333333333333');
    h.setMeetings([]);
    expect((await h.importer.state()).items).toEqual([]);
    await settle(h);
    expect((await h.importer.state()).items).toEqual([]);
  });
});
