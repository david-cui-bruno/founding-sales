import { createHash, randomUUID } from 'node:crypto';
import type { RecordingCandidate } from '@fss/contracts';
import type { ApiOutcome } from '../../src/main/apiClient.ts';
import type { AuthedClient } from '../../src/main/authedClient.ts';
import type { PutOutcome, RecordingFs, RecordingUploader, RootFolder } from '../../src/main/recordings/files.ts';
import { roleOf, type FolderFile } from '../../src/main/recordings/zoomFolder.ts';

/**
 * Fakes for the recording import's tests (lane M4): a folder tree in memory that counts every
 * path it was asked to list, hash or stat; a server that keeps (meeting, sha256) rows and
 * command receipts the way the API does; and an uploader that records each PUT. Synthetic
 * names only: no real recording, person or firm.
 */

export const sha = (content: string): string => createHash('sha256').update(content).digest('hex');

export interface FakeFile {
  readonly relPath: string;
  content: string;
  ino: number;
  mtimeMs: number;
  birthtimeMs: number;
}

export interface FakeFolder {
  readonly name: string;
  readonly path: string;
  readonly birthtimeMs: number;
  files: FakeFile[];
}

let inode = 1000;

export function fakeFile(relPath: string, content: string, birthtimeMs = 1): FakeFile {
  inode += 1;
  return { relPath, content, ino: inode, mtimeMs: 5_000, birthtimeMs };
}

export function fakeFs(root: string) {
  const folders = new Map<string, FakeFolder>();
  const listed: string[] = [];
  const hashed: string[] = [];
  const statted: string[] = [];
  const sniffed: string[] = [];
  let rootMissing = false;
  const fileAt = (path: string): FakeFile | undefined => {
    for (const folder of folders.values()) {
      if (!path.startsWith(`${folder.path}/`)) continue;
      return folder.files.find(entry => `${folder.path}/${entry.relPath}` === path);
    }
    return undefined;
  };
  const toFolderFile = (entry: FakeFile): FolderFile => {
    const name = entry.relPath.split('/').at(-1) ?? entry.relPath;
    return {
      relPath: entry.relPath,
      name,
      role: roleOf(name, entry.relPath.includes('/') ? 'participants' : 'folder'),
      sizeBytes: Buffer.byteLength(entry.content),
      ino: entry.ino,
      mtimeMs: entry.mtimeMs,
      birthtimeMs: entry.birthtimeMs,
    };
  };
  const fs: RecordingFs = {
    listRoot: async path => {
      if (rootMissing || path !== root) throw new Error('ENOENT');
      return await Promise.resolve(
        [...folders.values()].filter(folder => folder.path.startsWith(`${root}/`)).map((folder): RootFolder => ({ name: folder.name, path: folder.path, birthtimeMs: folder.birthtimeMs })),
      );
    },
    statFolder: async path => {
      const folder = folders.get(path);
      return await Promise.resolve(folder === undefined ? null : { name: folder.name, path: folder.path, birthtimeMs: folder.birthtimeMs });
    },
    listFolder: async path => {
      listed.push(path);
      const folder = folders.get(path);
      if (folder === undefined) throw new Error('ENOENT');
      return await Promise.resolve(folder.files.map(toFolderFile));
    },
    statFile: async path => {
      statted.push(path);
      const entry = fileAt(path);
      return await Promise.resolve(entry === undefined ? null : { sizeBytes: Buffer.byteLength(entry.content), ino: entry.ino, mtimeMs: entry.mtimeMs });
    },
    sha256: async path => {
      hashed.push(path);
      const entry = fileAt(path);
      if (entry === undefined) throw new Error('ENOENT');
      return await Promise.resolve(sha(entry.content));
    },
    // A synthetic file whose content begins `video:` is a container with a video track.
    sniff: async path => {
      sniffed.push(path);
      const entry = fileAt(path);
      return await Promise.resolve(entry === undefined ? 'unreadable' : entry.content.startsWith('video:') ? 'not_audio' : 'audio');
    },
    watch: () => null,
  };
  return {
    fs,
    listed,
    hashed,
    statted,
    sniffed,
    /** Every path this fake was asked about inside a folder (listed, statted, sniffed, hashed). */
    touched: (): string[] => [...listed, ...statted, ...sniffed, ...hashed],
    add(name: string, files: FakeFile[], birthtimeMs = 1, parent = root): FakeFolder {
      const folder = { name, path: `${parent}/${name}`, birthtimeMs, files };
      folders.set(folder.path, folder);
      return folder;
    },
    contentOf: (path: string): string | undefined => fileAt(path)?.content,
    remove: (path: string) => folders.delete(path),
    setRootMissing: (value: boolean) => {
      rootMissing = value;
    },
  };
}

interface Receipt {
  readonly kind: string;
  readonly answer: ApiOutcome<unknown>;
}

/** The server: candidates, upload URLs and registers with receipts, as the API answers them. */
export function fakeServer(meetings: () => readonly RecordingCandidate[]) {
  const rows = new Map<string, Map<string, { segment: number; participantLabel: string; sizeBytes: number }>>();
  const objects = new Map<string, number>();
  const receipts = new Map<string, Receipt>();
  const calls: { path: string; body?: Readonly<Record<string, unknown>>; commandId?: string }[] = [];
  let offlineReads = 0;
  /** The server's candidate limit (100 in the API); more in the window answers `truncated`. */
  let maxCandidates = 100;
  /** Called for each command before it is answered: return an outcome to answer instead. */
  let intercept: ((path: string, commandId: string) => ApiOutcome<unknown> | 'lose_answer' | 'hang' | null) | null = null;

  const answerOf = (path: string, body: Readonly<Record<string, unknown>>): ApiOutcome<unknown> => {
    const meetingId = String(body['meetingId']);
    if (!meetings().some(meeting => meeting.meetingId === meetingId)) return { ok: false, reason: 'meeting_unknown', offline: false };
    const recorded = rows.get(meetingId) ?? new Map();
    if (path === '/meetings/recordings/upload-url') {
      const digest = String(body['fileSha256']);
      if (recorded.has(digest)) return { ok: true, value: { status: 'registered' } };
      const key = `meetings/${meetingId}/${digest}.m4a`;
      return {
        ok: true,
        value: {
          status: 'upload',
          key,
          url: `https://fss-test-call-audio-123456789012.s3.us-east-1.amazonaws.com/${key}?X-Amz-Signature=${String(calls.length)}`,
          headers: {
            'content-type': 'audio/mp4',
            'content-length': String(body['sizeBytes']),
            'x-amz-checksum-sha256': Buffer.from(digest, 'hex').toString('base64'),
            'x-amz-meta-callie-upload': randomUUID(),
          },
          expiresAt: '2026-10-05T20:00:00.000Z',
        },
      };
    }
    const files = body['files'] as { sha256: string; sizeBytes: number; participantLabel: string; segment: number }[];
    // Review M4R, finding 9: an object that is not there is `object_missing`, with no receipt.
    const missing = files.filter(file => !recorded.has(file.sha256) && !objects.has(`meetings/${meetingId}/${file.sha256}.m4a`)).map(file => file.sha256);
    if (missing.length > 0) return { ok: false, reason: 'object_missing', offline: false, refusal: { status: 'refused', replayed: false, reason: 'object_missing', missing } };
    for (const file of files) {
      if (recorded.has(file.sha256)) continue;
      if (objects.get(`meetings/${meetingId}/${file.sha256}.m4a`) !== file.sizeBytes) return { ok: false, reason: 'recording_size_mismatch', offline: false };
    }
    const answered = files.map(file => {
      const outcome = recorded.has(file.sha256) ? 'existing' : 'new';
      if (outcome === 'new') recorded.set(file.sha256, { segment: file.segment, participantLabel: file.participantLabel, sizeBytes: file.sizeBytes });
      return { recordingId: '99999999-9999-4999-8999-999999999999', sha256: file.sha256, state: 'uploaded', outcome };
    });
    rows.set(meetingId, recorded);
    return { ok: true, value: { meetingId, files: answered } };
  };

  const api: AuthedClient = {
    async read<T>(path: string, parse: (value: unknown) => T): Promise<ApiOutcome<T>> {
      calls.push({ path });
      if (offlineReads > 0) {
        offlineReads -= 1;
        return await Promise.resolve({ ok: false, reason: 'offline', offline: true });
      }
      const query = new URL(path, 'https://api.test').searchParams;
      const from = Date.parse(query.get('from') ?? '');
      const to = Date.parse(query.get('to') ?? '');
      const inWindow = meetings()
        .filter(meeting => Date.parse(meeting.startsAt) >= from && Date.parse(meeting.startsAt) <= to)
        .sort((left, right) => left.startsAt.localeCompare(right.startsAt));
      return await Promise.resolve({ ok: true, value: parse({ meetings: inWindow.slice(0, maxCandidates), truncated: inWindow.length > maxCandidates }) });
    },
    async command<T>(path: string, payload: Readonly<Record<string, unknown>>, parse: (value: unknown) => T, options?: { readonly commandId?: string }): Promise<ApiOutcome<T>> {
      const commandId = options?.commandId ?? `auto-${String(calls.length)}`;
      calls.push({ path, body: payload, commandId });
      const kept = receipts.get(commandId);
      // Review M4R, finding 8: a replayed upload URL is authorised again before it is signed.
      if (kept !== undefined && path === '/meetings/recordings/upload-url' && !meetings().some(meeting => meeting.meetingId === String(payload['meetingId']))) {
        return await Promise.resolve({ ok: false, reason: 'meeting_unknown', offline: false });
      }
      if (kept !== undefined) {
        const replay = kept.answer;
        return await Promise.resolve(replay.ok ? { ok: true, value: parse(replay.value) } : replay);
      }
      const intercepted = intercept?.(path, commandId) ?? null;
      if (intercepted !== null && intercepted !== 'lose_answer' && intercepted !== 'hang') return await Promise.resolve(intercepted as ApiOutcome<T>);
      const answer = answerOf(path, payload);
      if (answer.ok || answer.reason !== 'object_missing') receipts.set(commandId, { kind: path, answer });
      if (intercepted === 'lose_answer') return await Promise.resolve({ ok: false, reason: 'offline', offline: true });
      // The app quit while the request was on the wire: the server recorded it, no answer ever comes.
      if (intercepted === 'hang') return await new Promise<ApiOutcome<T>>(() => undefined);
      return await Promise.resolve(answer.ok ? { ok: true, value: parse(answer.value) } : (answer as ApiOutcome<T>));
    },
  };

  return {
    api,
    calls,
    rows,
    putObject: (key: string, size: number) => objects.set(key, size),
    /** The bucket's lifecycle: every staged object expires. */
    expireObjects: () => {
      objects.clear();
    },
    setMaxCandidates: (value: number) => {
      maxCandidates = value;
    },
    commandsTo: (path: string) => calls.filter(call => call.path === path),
    setOfflineReads: (count: number) => {
      offlineReads = count;
    },
    setIntercept: (next: typeof intercept) => {
      intercept = next;
    },
  };
}

/** The uploader: each PUT puts the file's size under its key on the server, unless told to fail or hang. */
export function fakeUploader(server: ReturnType<typeof fakeServer>, files: ReturnType<typeof fakeFs>) {
  const puts: string[] = [];
  let behaviour: (path: string) => 'ok' | 'fail' | 'hang' = () => 'ok';
  const uploader: RecordingUploader = {
    async put(url, headers, path): Promise<PutOutcome> {
      puts.push(path);
      const what = behaviour(path);
      if (what === 'hang') return await new Promise<PutOutcome>(() => undefined);
      if (what === 'fail') return { ok: false, status: null };
      const key = new URL(url).pathname.slice(1);
      expectHeaders(headers, files.contentOf(path));
      server.putObject(key, Number(headers['content-length']));
      return await Promise.resolve({ ok: true });
    },
  };
  return {
    uploader,
    puts,
    setBehaviour: (next: typeof behaviour) => {
      behaviour = next;
    },
  };
}

function expectHeaders(headers: Readonly<Record<string, string>>, content: string | undefined): void {
  if (content === undefined) throw new Error('a PUT of a file that is not there');
  if (headers['content-length'] !== String(Buffer.byteLength(content))) throw new Error('a PUT whose length is not the file’s');
  if (headers['x-amz-checksum-sha256'] !== Buffer.from(sha(content), 'hex').toString('base64')) throw new Error('a PUT whose digest is not the file’s');
}
