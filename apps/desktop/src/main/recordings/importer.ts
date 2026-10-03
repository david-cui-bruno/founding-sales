import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  MEETING_RECORDING_LIMITS,
  recordingCandidatesResponseSchema,
  recordingUploadUrlSchema,
  recordingsRegisteredSchema,
  type RecordingCandidate,
} from '@fss/contracts';
import type { RecordingItem, RecordingsView } from '../../shared/recordings.ts';
import type { AuthedClient } from '../authedClient.ts';
import type { BridgeIdentity } from '../identityReset.ts';
import type { FileChoice } from '../importHandoff.ts';
import type { RecordingFs, RecordingUploader, RootFolder } from './files.ts';
import { CANDIDATE_LOOKAHEAD_MS, CANDIDATE_LOOKBACK_MS, MAX_FOLDER_AGE_MS, decideMatch, overlappingMeetings } from './matcher.ts';
import { emptyWorkspaceImport, type Entry, type RecordingStore, type RecordingsFile, type StoredFile, type WorkspaceImport } from './store.ts';
import { identityOf, parseFolderName, readinessOf, segmentsOf, signatureOf, type FolderFile } from './zoomFolder.ts';

/**
 * The demo recording import (lane M4; E4, E5): the folder watcher, the matcher's decisions,
 * the upload of each per-participant audio file, and the register — held in the main process,
 * persisted in `recordings.json`, and shown to the window as `RecordingsView`.
 *
 * ## One scan
 *
 *   1. List the root's session folders (names and each folder's own stat), plus the folders
 *      chosen by hand. Nothing inside any folder is read yet.
 *   2. Each folder's start: its Zoom name, else its creation time. A folder older than 30 days
 *      is never considered.
 *   3. One read of the meetings around those starts (`GET /meetings/recordings/candidates`).
 *      No answer, no decision: every folder stays as it was until a read answers.
 *   4. **A folder that overlaps no meeting is dropped here**: never listed, hashed, uploaded or
 *      shown (`overlappingMeetings`). Its path's digest is remembered once its start is more
 *      than two days old, so it is not looked at again.
 *   5. Only an overlapping folder is listed; then `decideMatch` and `readinessOf`:
 *      not converted yet → waiting; ready and matched → queued; otherwise needs matching.
 *
 * ## The upload, one folder at a time
 *
 * Each audio file: its identity checked again, its SHA-256, `upload-url` (a fresh command and
 * a fresh URL every attempt), the PUT, `uploaded` saved. Then `register`, under a command id
 * saved BEFORE it is sent: a restart in the middle replays that id, so the server answers its
 * receipt and records nothing twice (CC3). A file the server already has answers `registered`
 * and is not sent. A folder whose files changed starts again; a definite refusal is `failed`
 * with its reason, and Retry starts again with fresh commands.
 *
 * ## Identity
 *
 * Kept per workspace. `forget()` (any session transition) advances this host's generation and
 * drops what it holds in memory; a scan or an upload that began under an older generation
 * writes nothing after its next `await` (`guardIdentity` and `forgetIfCurrent`, as the brief
 * import does). The next scan loads the signed-in workspace's own entries.
 */

export const RESCAN_INTERVAL_MS = 60_000;
export const WATCH_DEBOUNCE_MS = 3_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PUT_ATTEMPTS = 3;

export interface RecordingImportDeps {
  readonly api: AuthedClient;
  readonly fs: RecordingFs;
  readonly uploader: RecordingUploader;
  readonly store: RecordingStore;
  /** The signed-in workspace that may act, or null (signed out, outdated, signing in). */
  identity(): Promise<{ readonly workspaceId: string } | null>;
  readonly defaultFolder: string;
  openFolderDialog(purpose: 'watch' | 'import'): Promise<FileChoice>;
  readonly now?: () => number;
  readonly timers?: {
    setInterval(callback: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}

export interface RecordingImportHost {
  state(): Promise<RecordingsView>;
  /** Watch the folder, rescan every minute, and scan now. Idempotent. */
  start(): Promise<void>;
  stop(): void;
  /** One scan and the uploads it makes due. Single-flight: a scan asked for during one runs after it. */
  scan(): Promise<RecordingsView>;
  chooseFolder(): Promise<RecordingsView>;
  importFolder(): Promise<RecordingsView>;
  chooseMeeting(input: { readonly itemId: string; readonly meetingId: string }): Promise<RecordingsView>;
  ignore(input: { readonly itemId: string }): Promise<RecordingsView>;
  retry(input: { readonly itemId: string }): Promise<RecordingsView>;
  forget(): Promise<RecordingsView>;
  readonly identity: BridgeIdentity;
  /** Tests: wait for the upload worker to go idle. */
  idle(): Promise<void>;
}

const sha256Of = (text: string): string => createHash('sha256').update(text).digest('hex');

export function itemIdOf(workspaceId: string, folderPath: string): string {
  return sha256Of(`${workspaceId}\n${folderPath}`).slice(0, 32);
}

/** An entry's state read afresh (the compiler narrows it across the awaits that change it). */
const stateOf = (entry: Entry): Entry['state'] => entry.state;

const VISIBLE: ReadonlySet<Entry['state']> = new Set(['waiting', 'needs_matching', 'queued', 'uploading', 'uploaded', 'failed']);

export function createRecordingImporter(deps: RecordingImportDeps): RecordingImportHost {
  const now = deps.now ?? (() => Date.now());
  const timers = deps.timers ?? {
    setInterval: (callback: () => void, ms: number) => setInterval(callback, ms),
    clearInterval: (handle: unknown) => {
      clearInterval(handle as NodeJS.Timeout);
    },
    setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clearTimeout: (handle: unknown) => {
      clearTimeout(handle as NodeJS.Timeout);
    },
  };

  let generation = 0;
  /** The loaded file, or null until the first read; the workspace in use, or null. */
  let file: RecordingsFile | null = null;
  let workspaceId: string | null = null;
  /** Candidate meetings by id, from the last read: what "Choose meeting" offers. Memory only. */
  let candidates = new Map<string, RecordingCandidate>();
  let rootAvailable = true;
  let notice: string | null = null;

  let scanning: Promise<void> | null = null;
  let rescanAsked = false;
  let working: Promise<void> | null = null;
  let interval: unknown = null;
  let debounce: unknown = null;
  let unwatch: (() => void) | null = null;
  let watchedRoot: string | null = null;

  const loaded = async (): Promise<RecordingsFile> => {
    file ??= await deps.store.load();
    return file;
  };
  const rootOf = (value: RecordingsFile | null): string => value?.folder ?? deps.defaultFolder;
  const section = (): WorkspaceImport | null => {
    if (file === null || workspaceId === null) return null;
    file.workspaces[workspaceId] ??= emptyWorkspaceImport();
    return file.workspaces[workspaceId] ?? null;
  };
  const persist = async (mine: number): Promise<boolean> => {
    if (mine !== generation || file === null) return false;
    await deps.store.save(file);
    return mine === generation;
  };

  const view = (): RecordingsView => {
    const current = section();
    const items: RecordingItem[] = [];
    for (const entry of Object.values(current?.entries ?? {})) {
      if (!VISIBLE.has(entry.state) || workspaceId === null) continue;
      const total = entry.files.length;
      items.push({
        itemId: itemIdOf(workspaceId, entry.folderPath),
        folderName: entry.folderName.slice(0, 300),
        startedAt: entry.startedAt,
        state: entry.state === 'queued' ? 'uploading' : entry.state === 'ignored' ? 'failed' : entry.state,
        meetingId: entry.meetingId,
        uploaded: entry.files.filter(entryFile => entryFile.uploaded).length,
        total,
        failure: entry.failure,
        choices: entry.candidateIds.flatMap(id => {
          const meeting = candidates.get(id);
          if (meeting === undefined) return [];
          return [
            {
              meetingId: meeting.meetingId,
              startsAt: meeting.startsAt,
              firmId: meeting.firmId,
              firmName: meeting.firmName,
              attendee: (meeting.attendeeName ?? meeting.attendeeEmail)?.slice(0, 320) ?? null,
            },
          ];
        }),
      });
    }
    items.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    const root = rootOf(file);
    return { folder: { path: root.slice(0, 1024), isDefault: file?.folder == null, available: rootAvailable }, items: items.slice(0, 200), notice };
  };

  const entryByItem = (itemId: string): Entry | null => {
    const current = section();
    if (current === null || workspaceId === null) return null;
    const id = workspaceId;
    return Object.values(current.entries).find(entry => itemIdOf(id, entry.folderPath) === itemId) ?? null;
  };

  const touch = (entry: Entry): void => {
    (entry as { updatedAt: string }).updatedAt = new Date(now()).toISOString();
  };

  // ---------------------------------------------------------------- the scan

  async function scanOnce(): Promise<void> {
    const mine = generation;
    const who = await deps.identity();
    if (mine !== generation) return;
    if (who === null) return;
    const value = await loaded();
    if (mine !== generation) return;
    if (workspaceId !== who.workspaceId) {
      workspaceId = who.workspaceId;
      candidates = new Map();
    }
    const current = section();
    if (current === null) return;
    const root = rootOf(value);
    ensureWatching(root);

    let folders: RootFolder[] = [];
    try {
      folders = [...(await deps.fs.listRoot(root))];
      rootAvailable = true;
    } catch {
      rootAvailable = false;
    }
    for (const manual of current.manualFolders) {
      const folder = await deps.fs.statFolder(manual);
      if (folder !== null && !folders.some(entry => entry.path === folder.path)) folders.push(folder);
    }
    if (mine !== generation) return;

    const at = now();
    const settled = new Set(current.settled);
    const open: { folder: RootFolder; startedAt: Date; topic: string | null }[] = [];
    for (const folder of folders) {
      const entry = current.entries[folder.path];
      // Decided for good: never looked at again (an upload in flight is the worker's).
      if (entry !== undefined && (entry.state === 'ignored' || entry.state === 'queued' || entry.state === 'uploading' || entry.state === 'failed')) continue;
      if (entry === undefined && settled.has(sha256Of(folder.path))) continue;
      const parsed = parseFolderName(folder.name);
      const startedAt = parsed?.startedAt ?? new Date(folder.birthtimeMs);
      if (Number.isNaN(startedAt.getTime()) || at - startedAt.getTime() > MAX_FOLDER_AGE_MS || startedAt.getTime() - at > DAY_MS) {
        if (entry === undefined) settled.add(sha256Of(folder.path));
        continue;
      }
      open.push({ folder, startedAt, topic: parsed?.topic ?? null });
    }
    if (open.length === 0) {
      current.settled = [...settled];
      await persist(mine);
      return;
    }

    const times = open.map(entry => entry.startedAt.getTime());
    const from = new Date(Math.min(...times) - CANDIDATE_LOOKBACK_MS).toISOString();
    const to = new Date(Math.max(...times) + CANDIDATE_LOOKAHEAD_MS).toISOString();
    const answer = await deps.api.read(`/meetings/recordings/candidates?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, body =>
      recordingCandidatesResponseSchema.parse(body),
    );
    if (mine !== generation) return;
    // No answer, no decision: nothing is settled, listed or shown on a guess.
    if (!answer.ok) return;
    const meetings = answer.value.meetings;
    for (const meeting of meetings) candidates.set(meeting.meetingId, meeting);

    for (const { folder, startedAt, topic } of open) {
      const existing = current.entries[folder.path];
      if (overlappingMeetings(startedAt, meetings).length === 0) {
        // The privacy rule: dropped from its name alone. A folder an earlier read placed (its
        // meeting since cancelled) goes too, unless David already chose a meeting for it.
        if (existing !== undefined && existing.matchedBy !== 'person' && existing.state !== 'uploaded') {
          delete current.entries[folder.path];
        }
        if (existing === undefined && at - startedAt.getTime() > 2 * DAY_MS) settled.add(sha256Of(folder.path));
        continue;
      }
      let listed: readonly FolderFile[];
      try {
        listed = await deps.fs.listFolder(folder.path);
      } catch {
        continue;
      }
      if (mine !== generation) return;
      const decision = decideMatch(
        { startedAt, topic, participantLabels: listed.filter(entry => entry.role === 'participant_audio').map(entry => entry.name) },
        meetings,
      );
      const entry: Entry = existing ?? {
        folderPath: folder.path,
        folderName: folder.name,
        startedAt: startedAt.toISOString(),
        topic,
        state: 'waiting',
        meetingId: null,
        matchedBy: null,
        candidateIds: [],
        stable: null,
        identity: null,
        files: [],
        registerCommandId: null,
        putFailures: 0,
        failure: null,
        updatedAt: new Date(at).toISOString(),
      };
      const signature = signatureOf(listed);
      const readiness = readinessOf(listed, entry.stable, at);
      if (entry.stable?.signature !== signature) entry.stable = { signature, atMs: at };
      if (decision.kind !== 'outside') entry.candidateIds = decision.candidates.map(meeting => meeting.meetingId).slice(0, 20);
      const person = entry.matchedBy === 'person' && entry.meetingId !== null;
      if (!person) {
        entry.meetingId = decision.kind === 'matched' ? decision.meetingId : null;
        entry.matchedBy = decision.kind === 'matched' ? 'auto' : null;
      }
      const identity = readiness.ready ? identityOf(listed) : null;
      if (entry.state === 'uploaded') {
        // Uploaded, and the files are what was uploaded: nothing to do.
        if (identity === null || identity === entry.identity) {
          current.entries[folder.path] = entry;
          continue;
        }
      }
      if (!readiness.ready) {
        entry.state = readiness.why === 'no_audio' ? 'failed' : entry.meetingId === null ? 'needs_matching' : 'waiting';
        entry.failure = readiness.why === 'no_audio' ? 'no_audio' : null;
      } else {
        if (identity !== entry.identity) {
          entry.identity = identity;
          entry.files = filesOf(readiness.audio);
          entry.registerCommandId = null;
          entry.putFailures = 0;
        }
        entry.failure = null;
        entry.state = entry.meetingId === null ? 'needs_matching' : 'queued';
      }
      touch(entry);
      current.entries[folder.path] = entry;
    }
    current.settled = [...settled];
    await persist(mine);
  }

  function filesOf(audio: readonly FolderFile[]): StoredFile[] {
    const segments = segmentsOf(audio);
    return audio.map(entry => ({
      relPath: entry.relPath,
      participantLabel: entry.name,
      segment: segments.get(entry.relPath) ?? 1,
      sizeBytes: entry.sizeBytes,
      ino: entry.ino,
      mtimeMs: entry.mtimeMs,
      sha256: null,
      uploaded: false,
    }));
  }

  // ---------------------------------------------------------------- the upload

  type Step = 'continue' | 'stop';

  const fail = (entry: Entry, reason: string): void => {
    entry.state = 'failed';
    entry.failure = reason.slice(0, 80);
    entry.registerCommandId = null;
    touch(entry);
  };

  async function uploadOne(entry: Entry, mine: number): Promise<Step> {
    const meetingId = entry.meetingId;
    if (meetingId === null) {
      entry.state = 'needs_matching';
      return 'continue';
    }
    if (entry.state !== 'uploading') {
      entry.state = 'uploading';
      touch(entry);
      if (!(await persist(mine))) return 'stop';
    }
    for (const stored of entry.files) {
      if (stored.uploaded) continue;
      const path = join(entry.folderPath, stored.relPath);
      const seen = await deps.fs.statFile(path);
      if (mine !== generation) return 'stop';
      if (seen === null) {
        fail(entry, 'file_unreadable');
        await persist(mine);
        return 'continue';
      }
      if (seen.sizeBytes !== stored.sizeBytes || seen.ino !== stored.ino || Math.trunc(seen.mtimeMs) !== Math.trunc(stored.mtimeMs)) {
        // The folder changed under the upload (a further segment, a re-conversion): it is
        // evaluated afresh at the next scan, as a new identity. The server keeps what arrived.
        entry.state = 'waiting';
        entry.identity = null;
        entry.files = [];
        entry.stable = null;
        entry.registerCommandId = null;
        touch(entry);
        await persist(mine);
        return 'continue';
      }
      if (stored.sizeBytes > MEETING_RECORDING_LIMITS.maxFileBytes || stored.sizeBytes === 0) {
        fail(entry, 'file_too_large');
        await persist(mine);
        return 'continue';
      }
      if (stored.sha256 === null) {
        let digest: string;
        try {
          digest = await deps.fs.sha256(path);
        } catch {
          if (mine !== generation) return 'stop';
          fail(entry, 'file_unreadable');
          await persist(mine);
          return 'continue';
        }
        if (mine !== generation) return 'stop';
        stored.sha256 = digest;
        if (!(await persist(mine))) return 'stop';
      }
      const answer = await deps.api.command(
        '/meetings/recordings/upload-url',
        { meetingId, fileSha256: stored.sha256, sizeBytes: stored.sizeBytes, participantLabel: stored.participantLabel, segment: stored.segment },
        body => recordingUploadUrlSchema.parse(body),
      );
      if (mine !== generation) return 'stop';
      if (!answer.ok) return await refused(entry, answer, mine);
      if (answer.value.status === 'upload') {
        const put = await deps.uploader.put(answer.value.url, answer.value.headers, path);
        if (mine !== generation) return 'stop';
        if (!put.ok) {
          // Interrupted: the whole file again with a fresh URL on the next run, a few times.
          entry.putFailures += 1;
          if (entry.putFailures >= PUT_ATTEMPTS) fail(entry, 'upload_failed');
          touch(entry);
          await persist(mine);
          return stateOf(entry) === 'failed' ? 'continue' : 'stop';
        }
      }
      stored.uploaded = true;
      entry.putFailures = 0;
      touch(entry);
      if (!(await persist(mine))) return 'stop';
    }

    // Every file is there. The command id is saved before it is sent (CC3).
    if (entry.registerCommandId === null) {
      entry.registerCommandId = randomUUID();
      if (!(await persist(mine))) return 'stop';
    }
    const registered = await deps.api.command(
      '/meetings/recordings/register',
      {
        meetingId,
        files: entry.files.map(stored => ({ sha256: stored.sha256, sizeBytes: stored.sizeBytes, participantLabel: stored.participantLabel, segment: stored.segment })),
      },
      body => recordingsRegisteredSchema.parse(body),
      { commandId: entry.registerCommandId },
    );
    if (mine !== generation) return 'stop';
    if (!registered.ok) {
      const step = await refused(entry, registered, mine);
      // A definite refusal of the register: the next attempt sends every file again.
      if (stateOf(entry) === 'failed') for (const stored of entry.files) stored.uploaded = false;
      await persist(mine);
      return step;
    }
    entry.state = 'uploaded';
    entry.registerCommandId = null;
    entry.failure = null;
    touch(entry);
    await persist(mine);
    return 'continue';
  }

  /** No definite answer: stop, the next scan resumes. A definite refusal: failed with its code. */
  async function refused(entry: Entry, answer: { readonly reason: string; readonly offline: boolean }, mine: number): Promise<Step> {
    if (answer.offline || answer.reason === 'storage_unavailable' || answer.reason === 'database_busy' || answer.reason === 'not_ready' || answer.reason === 'internal_error' || answer.reason === 'not_signed_in' || answer.reason === 'unreadable_answer') {
      return 'stop';
    }
    fail(entry, answer.reason === 'not_found' ? 'recordings_unsupported' : answer.reason);
    await persist(mine);
    return 'continue';
  }

  async function work(): Promise<void> {
    const mine = generation;
    for (;;) {
      if (mine !== generation) return;
      const current = section();
      if (current === null) return;
      const next = Object.values(current.entries).find(entry => entry.state === 'uploading') ?? Object.values(current.entries).find(entry => entry.state === 'queued');
      if (next === undefined) return;
      const step = await uploadOne(next, mine);
      if (step === 'stop') return;
    }
  }

  const kick = (): void => {
    if (working !== null) return;
    working = work()
      .catch(() => undefined)
      .finally(() => {
        working = null;
      });
  };

  async function scan(): Promise<RecordingsView> {
    if (scanning !== null) {
      rescanAsked = true;
      await scanning;
      return view();
    }
    scanning = (async () => {
      do {
        rescanAsked = false;
        try {
          await scanOnce();
        } catch {
          // A scan that failed half way decided nothing it did not save; the next one tries again.
        }
      } while (rescanAsked);
    })();
    try {
      await scanning;
    } finally {
      scanning = null;
    }
    kick();
    return view();
  }

  // ---------------------------------------------------------------- watching

  function ensureWatching(root: string): void {
    if (watchedRoot === root && unwatch !== null) return;
    unwatch?.();
    unwatch = null;
    watchedRoot = root;
    if (interval === null) return; // not started: tests and a scan asked for by hand
    unwatch = deps.fs.watch(root, () => {
      if (debounce !== null) timers.clearTimeout(debounce);
      debounce = timers.setTimeout(() => {
        debounce = null;
        void scan();
      }, WATCH_DEBOUNCE_MS);
    });
  }

  const forget = async (): Promise<RecordingsView> => {
    generation += 1;
    workspaceId = null;
    file = null;
    candidates = new Map();
    notice = null;
    return await Promise.resolve(view());
  };

  return {
    identity: {
      current: () => generation,
      async forgetIfCurrent(since: number) {
        if (since === generation) return await forget();
        return view();
      },
    },
    async state() {
      // The first read after a launch or a sign-in loads the signed-in workspace's entries.
      if (workspaceId === null) {
        const who = await deps.identity();
        if (who !== null) {
          await loaded();
          workspaceId = who.workspaceId;
        }
      }
      return view();
    },
    async start() {
      if (interval === null) {
        interval = timers.setInterval(() => {
          void scan();
        }, RESCAN_INTERVAL_MS);
      }
      watchedRoot = null;
      await scan();
    },
    stop() {
      if (interval !== null) timers.clearInterval(interval);
      interval = null;
      if (debounce !== null) timers.clearTimeout(debounce);
      debounce = null;
      unwatch?.();
      unwatch = null;
      watchedRoot = null;
    },
    scan,
    async chooseFolder() {
      const mine = generation;
      const chosen = await deps.openFolderDialog('watch');
      const path = chosen.canceled ? undefined : chosen.filePaths[0];
      if (path === undefined || mine !== generation) return view();
      const value = await loaded();
      if (mine !== generation) return view();
      value.folder = path === deps.defaultFolder ? null : path;
      await deps.store.save(value);
      return await scan();
    },
    async importFolder() {
      const mine = generation;
      const chosen = await deps.openFolderDialog('import');
      const path = chosen.canceled ? undefined : chosen.filePaths[0];
      if (path === undefined || mine !== generation) return view();
      await loaded();
      const who = await deps.identity();
      if (who === null || mine !== generation) return view();
      workspaceId = who.workspaceId;
      const current = section();
      if (current === null) return view();
      if (!current.manualFolders.includes(path)) current.manualFolders = [...current.manualFolders, path].slice(-100);
      // A folder chosen by hand is looked at again even if an earlier scan settled it.
      current.settled = current.settled.filter(digest => digest !== sha256Of(path));
      await persist(mine);
      return await scan();
    },
    async chooseMeeting(input) {
      notice = null;
      const entry = entryByItem(input.itemId);
      if (entry === null || !(entry.state === 'needs_matching' || entry.state === 'waiting' || entry.state === 'failed') || !entry.candidateIds.includes(input.meetingId)) {
        notice = 'recording_choice_stale';
        return view();
      }
      const mine = generation;
      entry.meetingId = input.meetingId;
      entry.matchedBy = 'person';
      entry.failure = null;
      entry.registerCommandId = null;
      entry.putFailures = 0;
      for (const stored of entry.files) stored.uploaded = false;
      entry.state = entry.identity !== null && entry.files.length > 0 ? 'queued' : 'waiting';
      touch(entry);
      if (!(await persist(mine))) return view();
      kick();
      return view();
    },
    async ignore(input) {
      notice = null;
      const entry = entryByItem(input.itemId);
      if (entry === null || entry.state === 'uploading' || entry.state === 'uploaded' || entry.state === 'ignored') {
        notice = 'recording_choice_stale';
        return view();
      }
      const mine = generation;
      // "Not a Callie demo": ignored for good, its meeting and files forgotten.
      entry.state = 'ignored';
      entry.meetingId = null;
      entry.matchedBy = null;
      entry.files = [];
      entry.identity = null;
      entry.candidateIds = [];
      entry.failure = null;
      touch(entry);
      await persist(mine);
      return view();
    },
    async retry(input) {
      notice = null;
      const entry = entryByItem(input.itemId);
      if (entry === null || entry.state !== 'failed') {
        notice = 'recording_choice_stale';
        return view();
      }
      const mine = generation;
      // Evaluated afresh: listed again, every file sent again under new commands.
      entry.state = 'waiting';
      entry.failure = null;
      entry.identity = null;
      entry.files = [];
      entry.stable = null;
      entry.registerCommandId = null;
      entry.putFailures = 0;
      touch(entry);
      if (!(await persist(mine))) return view();
      return await scan();
    },
    forget,
    async idle() {
      while (scanning !== null || working !== null) {
        await (scanning ?? working);
        await Promise.resolve();
      }
    },
  };
}
