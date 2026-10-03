import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  MEETING_RECORDING_LIMITS,
  recordingCandidatesResponseSchema,
  recordingObjectMissingSchema,
  recordingUploadUrlSchema,
  recordingsRegisteredSchema,
  type RecordingCandidate,
} from '@fss/contracts';
import type { RecordingItem, RecordingsView } from '../../shared/recordings.ts';
import type { AuthedClient } from '../authedClient.ts';
import type { BridgeIdentity } from '../identityReset.ts';
import type { FileChoice } from '../importHandoff.ts';
import type { RecordingFs, RecordingUploader, RootFolder } from './files.ts';
import { CANDIDATE_LOOKAHEAD_MS, CANDIDATE_LOOKBACK_MS, MAX_FOLDER_AGE_MS, decideMatch, overlappingMeetings, type MatchDecision } from './matcher.ts';
import {
  clockKeyOf,
  emptyWorkspaceImport,
  personKeyOf,
  type Entry,
  type PersonIdentity,
  type RecordingStore,
  type RecordingsFile,
  type StoredFile,
  type WorkspaceImport,
} from './store.ts';
import { identityOf, parseFolderName, readinessOf, segmentsOf, signatureOf, type FolderFile } from './zoomFolder.ts';

/**
 * The demo recording import (lane M4; E4, E5; the M4 design reset, R1–R7): the folder watcher,
 * the matcher's decisions, the upload of each audio file and the register — held in the main
 * process, persisted in `recordings.json` per person and role class, and shown to the window as
 * `RecordingsView`.
 *
 * ## R1: one writer
 *
 * Every read-modify-write of the import's state is one TURN of a single queue (`serial`): the
 * store load, a scan, a command, one step of the upload worker, the sign-out reset. Turns never
 * overlap, so no write is ever derived from state another write has since replaced. The store is
 * loaded once per session, as the session's first turn; a later load is a no-op. Entry versions
 * come from the person's persisted monotonic clock, so a version is never reused — not even by
 * an entry removed and recreated under the same item id.
 *
 * A turn that is under way when the session ends (`forget`) is abandoned at its next await (the
 * generation moved, and its abort signal fires, which also drops an upload in flight); it writes
 * nothing after that, and the reset runs as the next turn. Reading the view is not a write: it
 * never waits for a turn once the session is loaded.
 *
 * ## R2: no cached authority to touch a file
 *
 * Hashing, sniffing, uploading or registering any file of a folder needs, in the same turn, a
 * candidates answer for that folder that is complete (not truncated), at most 60 seconds old and
 * read in this session, under which the folder still overlaps a meeting and its meeting still
 * holds (David's choice still overlapping; an automatic match still the matcher's answer).
 * Otherwise the turn reads the folder's own window again, and with no such answer nothing inside
 * the folder is touched. `validated` (the folders a scan in this session revalidated) is cleared
 * at the start of every scan and whenever a candidates read fails.
 *
 * ## One scan (one turn)
 *
 *   1. List the root's session folders (names and each folder's own stat), the folders this
 *      person already has entries for, and a folder chosen by hand (memory only until it
 *      overlaps a meeting). Nothing inside any folder is read yet.
 *   2. Each folder's start: its Zoom name, else its creation time. Older than 30 days: never.
 *   3. The meetings around those starts (`GET /meetings/recordings/candidates`). A truncated
 *      answer decides nothing: each folder's own window is read, and one still truncated waits.
 *   4. **A folder that overlaps no meeting is dropped here**: never listed, hashed, uploaded or
 *      shown, and an entry it had is removed; only a salted digest of its path is kept.
 *   5. Only an overlapping folder is listed; then `decideMatch` and `readinessOf`.
 *
 * ## The upload (worker steps, each a turn)
 *
 * One step per turn, so a command waits at most one step: (a) one file's identity checked, its
 * box tree checked to be audio-only MP4 (R3), its SHA-256; (b) one file's `upload-url` and PUT;
 * (c) the `register`, under a command id saved before it is sent. Every step re-establishes R2
 * first. R7: each file's PUTs and the folder's registers are counted in the store, across scans
 * and restarts; a fourth of either fails the folder, with Retry, which resets the counts.
 *
 * ## R4: what is shown
 *
 * Only what is not registered yet: waiting, uploading, needs matching, failed. A registered
 * folder is kept (so it is not sent again) but never shown; the firm page reads registered
 * recordings from the server, which follows folds.
 */

export const RESCAN_INTERVAL_MS = 60_000;
export const WATCH_DEBOUNCE_MS = 3_000;
/** How old a candidates answer may be and still authorise touching a folder's files (R2). */
export const AUTHORITY_MAX_AGE_MS = 60_000;
/** PUTs per file, and registers per folder, before the folder fails with Retry (R7). */
export const MAX_ATTEMPTS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export type RecordingIdentity = PersonIdentity;

export interface RecordingImportDeps {
  readonly api: AuthedClient;
  readonly fs: RecordingFs;
  readonly uploader: RecordingUploader;
  readonly store: RecordingStore;
  /** The signed-in person who may act, with their role class, or null. */
  identity(): Promise<RecordingIdentity | null>;
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
  /** One scan and the uploads it makes due. A scan asked for while one waits to run joins it. */
  scan(): Promise<RecordingsView>;
  chooseFolder(): Promise<RecordingsView>;
  importFolder(): Promise<RecordingsView>;
  chooseMeeting(input: { readonly itemId: string; readonly meetingId: string }): Promise<RecordingsView>;
  ignore(input: { readonly itemId: string }): Promise<RecordingsView>;
  retry(input: { readonly itemId: string }): Promise<RecordingsView>;
  forget(): Promise<RecordingsView>;
  readonly identity: BridgeIdentity;
  /** Tests: wait for the scan and the upload worker to go idle. */
  idle(): Promise<void>;
}

const sha256Of = (text: string): string => createHash('sha256').update(text).digest('hex');

export function itemIdOf(personKey: string, folderPath: string): string {
  return sha256Of(`${personKey}\n${folderPath}`).slice(0, 32);
}

/** The states the window is shown (R4): never uploaded, never ignored. */
const SHOWN: ReadonlySet<Entry['state']> = new Set(['waiting', 'needs_matching', 'queued', 'uploading', 'failed']);

/** The fields a change compares, so a scan that derived nothing new writes nothing. */
const material = (entry: Omit<Entry, 'version' | 'updatedAt'>): string => JSON.stringify({ ...entry, version: 0, updatedAt: '' });

/** A folder's own window, when the combined one was truncated or an answer has gone stale. */
const ownWindow = (startedAt: Date): { readonly from: string; readonly to: string } => ({
  from: new Date(startedAt.getTime() - CANDIDATE_LOOKBACK_MS).toISOString(),
  to: new Date(startedAt.getTime() + CANDIDATE_LOOKAHEAD_MS).toISOString(),
});

const TRANSIENT = new Set(['storage_unavailable', 'database_busy', 'not_ready', 'internal_error', 'not_signed_in', 'unreadable_answer']);
/** The meeting is no longer one this person may attach a recording to: Needs matching again. */
const MEETING_GONE = new Set(['meeting_unknown', 'meeting_cancelled', 'firm_unknown', 'firm_merged', 'not_assigned']);

type Draft = Omit<Entry, 'version' | 'updatedAt'>;

/** The turn was abandoned: the session moved, or its signal fired. Nothing is written after it. */
class Abandoned extends Error {}

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

  // ---------------------------------------------------------------- state (written only in turns)

  let generation = 0;
  /** The generation the loaded file belongs to; the view is drawn only for the current one. */
  let loadedFor = -1;
  let file: RecordingsFile | null = null;
  let who: RecordingIdentity | null = null;
  let personKey: string | null = null;
  /** Candidate meetings by id, from this session's reads: what "Choose meeting" offers. */
  let candidates = new Map<string, RecordingCandidate>();
  /** Each folder's last complete candidates answer in this session, and when it was read (R2). */
  let answers = new Map<string, { readonly atMs: number; readonly meetings: readonly RecordingCandidate[] }>();
  /** The folders the last scan revalidated: the worker's to-do list, never its authority (R2). */
  let validated = new Set<string>();
  /** Folders chosen by hand and not yet past the overlap: memory only. */
  let pendingManual = new Set<string>();
  let rootAvailable = true;
  let notice: string | null = null;

  // ---------------------------------------------------------------- R1: the queue

  let tail: Promise<unknown> = Promise.resolve();
  let running: AbortController | null = null;

  interface Turn {
    readonly mine: number;
    readonly signal: AbortSignal;
    /** Await something outside the import; abandoned if the session moved or the signal fired. */
    wait<T>(promise: Promise<T>): Promise<T>;
  }

  function serial<T>(work: (turn: Turn) => Promise<T>, fallback: T): Promise<T> {
    const run = tail.then(async () => {
      const controller = new AbortController();
      running = controller;
      const mine = generation;
      const turn: Turn = {
        mine,
        signal: controller.signal,
        wait: async <V>(promise: Promise<V>): Promise<V> => {
          let onAbort: (() => void) | null = null;
          const aborted = new Promise<never>((_, reject) => {
            onAbort = () => {
              reject(new Abandoned());
            };
            if (controller.signal.aborted) onAbort();
            else controller.signal.addEventListener('abort', onAbort, { once: true });
          });
          try {
            const value = await Promise.race([promise, aborted]);
            if (mine !== generation) throw new Abandoned();
            return value;
          } finally {
            if (onAbort !== null) controller.signal.removeEventListener('abort', onAbort);
          }
        },
      };
      try {
        return await work(turn);
      } catch (error) {
        if (error instanceof Abandoned) return fallback;
        throw error;
      } finally {
        if (running === controller) running = null;
      }
    });
    tail = run.catch(() => undefined);
    return run;
  }

  // ---------------------------------------------------------------- helpers (inside turns)

  const rootOf = (value: RecordingsFile | null): string => value?.folder ?? deps.defaultFolder;
  const section = (): WorkspaceImport | null => (file === null || personKey === null ? null : (file.people[personKey] ?? null));
  const digestOf = (path: string): string => sha256Of(`${section()?.salt ?? ''}\n${path}`);

  /** The session's first turn loads the store; every turn follows the signed-in person. */
  async function ensureSession(turn: Turn): Promise<boolean> {
    const identity = await turn.wait(deps.identity());
    if (identity === null) return false;
    if (file === null || loadedFor !== generation) {
      file = await turn.wait(deps.store.load());
      loadedFor = generation;
    }
    const key = personKeyOf(identity);
    if (personKey !== key) {
      personKey = key;
      who = identity;
      candidates = new Map();
      answers = new Map();
      validated = new Set();
      pendingManual = new Set();
    }
    file.people[key] ??= emptyWorkspaceImport();
    return true;
  }

  async function persist(turn: Turn): Promise<void> {
    if (file === null || turn.mine !== generation) throw new Abandoned();
    await turn.wait(deps.store.save(file));
  }

  /** The person's next version: their clock, persisted with the file (R1). */
  function tick(): number {
    if (file === null || who === null) throw new Abandoned();
    const key = clockKeyOf(who);
    const next = (file.clocks[key] ?? 0) + 1;
    file.clocks[key] = next;
    return next;
  }

  /** Replace `path`'s entry with `next`, or remove it. Unchanged: nothing written, no version. */
  function commit(path: string, next: Draft | null): void {
    const current = section();
    if (current === null) throw new Abandoned();
    const before = current.entries[path];
    if (next === null) {
      if (before !== undefined) {
        const { [path]: _gone, ...rest } = current.entries;
        current.entries = rest;
      }
      validated.delete(path);
      answers.delete(path);
      return;
    }
    if (before !== undefined && material(next) === material(before)) return;
    current.entries[path] = { ...next, version: tick(), updatedAt: new Date(now()).toISOString() };
  }

  const itemOf = (entry: Entry): RecordingItem | null => {
    if (!SHOWN.has(entry.state) || personKey === null) return null;
    return {
      itemId: itemIdOf(personKey, entry.folderPath),
      version: entry.version,
      folderName: entry.folderName.slice(0, 300),
      startedAt: entry.startedAt,
      state: entry.state === 'queued' ? 'uploading' : (entry.state as RecordingItem['state']),
      meetingId: entry.meetingId,
      uploaded: entry.files.filter(entryFile => entryFile.uploaded).length,
      total: entry.files.length,
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
            attendee: (meeting.attendeeName ?? meeting.attendeeLocalPart)?.slice(0, 320) ?? null,
          },
        ];
      }),
    };
  };

  /** A pure read of memory: never waits for a turn, never writes. */
  const view = (): RecordingsView => {
    const current = loadedFor === generation ? section() : null;
    const items = Object.values(current?.entries ?? {})
      .map(itemOf)
      .filter((item): item is RecordingItem => item !== null)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    const shownFile = loadedFor === generation ? file : null;
    return {
      folder: { path: rootOf(shownFile).slice(0, 1024), isDefault: shownFile?.folder == null, available: rootAvailable },
      items: items.slice(0, 200),
      notice,
    };
  };

  /** The view, with the commanded item's own answer at its version (finding 12). */
  const answer = (itemId: string, path: string | null): RecordingsView => {
    const entry = path === null ? undefined : section()?.entries[path];
    return { ...view(), answered: { itemId, version: entry?.version ?? 0, item: entry === undefined ? null : itemOf(entry) } };
  };

  const pathByItem = (itemId: string): string | null => {
    const current = section();
    if (current === null || personKey === null) return null;
    const key = personKey;
    return Object.keys(current.entries).find(path => itemIdOf(key, path) === itemId) ?? null;
  };

  // ---------------------------------------------------------------- the candidates

  type Read = { readonly ok: true; readonly meetings: readonly RecordingCandidate[]; readonly truncated: boolean } | { readonly ok: false };

  async function readWindow(turn: Turn, window: { readonly from: string; readonly to: string }): Promise<Read> {
    const answered = await turn.wait(
      deps.api.read(`/meetings/recordings/candidates?from=${encodeURIComponent(window.from)}&to=${encodeURIComponent(window.to)}`, body =>
        recordingCandidatesResponseSchema.parse(body),
      ),
    );
    if (!answered.ok) {
      // R2: a failed read leaves no authority behind.
      validated = new Set();
      answers = new Map();
      return { ok: false };
    }
    for (const meeting of answered.value.meetings) candidates.set(meeting.meetingId, meeting);
    return { ok: true, meetings: answered.value.meetings, truncated: answered.value.truncated };
  }

  /** Each folder's complete candidates; a folder with none is absent. Null: no answer at all. */
  async function candidatesFor(turn: Turn, open: readonly { readonly path: string; readonly startedAt: Date }[]): Promise<Map<string, readonly RecordingCandidate[]> | null> {
    const times = open.map(entry => entry.startedAt.getTime());
    const combined = await readWindow(turn, {
      from: new Date(Math.min(...times) - CANDIDATE_LOOKBACK_MS).toISOString(),
      to: new Date(Math.max(...times) + CANDIDATE_LOOKAHEAD_MS).toISOString(),
    });
    if (!combined.ok) return null;
    const found = new Map<string, readonly RecordingCandidate[]>();
    if (!combined.truncated) {
      for (const entry of open) found.set(entry.path, combined.meetings);
      return found;
    }
    // Truncated decides nothing: each folder's own window; one still truncated waits.
    for (const entry of open) {
      const own = await readWindow(turn, ownWindow(entry.startedAt));
      if (!own.ok) return null;
      if (!own.truncated) found.set(entry.path, own.meetings);
    }
    return found;
  }

  /**
   * R2, at every file access: a complete answer for this folder at most 60 s old (read again
   * now otherwise), under which it overlaps a meeting and its meeting holds.
   */
  async function authority(turn: Turn, path: string, entry: Entry): Promise<'ok' | 'gone' | 'rematch' | 'unknown'> {
    const startedAt = new Date(entry.startedAt);
    let held = answers.get(path);
    if (held === undefined || now() - held.atMs > AUTHORITY_MAX_AGE_MS || now() < held.atMs) {
      answers.delete(path);
      const read = await readWindow(turn, ownWindow(startedAt));
      if (!read.ok || read.truncated) {
        validated.delete(path);
        return 'unknown';
      }
      held = { atMs: now(), meetings: read.meetings };
      answers.set(path, held);
    }
    const overlapping = overlappingMeetings(startedAt, held.meetings);
    if (overlapping.length === 0) return 'gone';
    if (entry.meetingId === null || !overlapping.some(meeting => meeting.meetingId === entry.meetingId)) return 'rematch';
    if (entry.matchedBy === 'auto') {
      const decision = decideMatch({ startedAt, topic: entry.topic, participantLabels: entry.files.map(stored => stored.participantLabel) }, held.meetings);
      if (decision.kind !== 'matched' || decision.meetingId !== entry.meetingId) return 'rematch';
    }
    return 'ok';
  }

  // ---------------------------------------------------------------- the scan

  const fresh = (folder: RootFolder, startedAt: Date, topic: string | null): Draft => ({
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
    registerAttempts: 0,
    failure: null,
  });

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
      attempts: 0,
    }));
  }

  /** What a scan makes of an overlapping folder, from the entry it had (never an ignored one). */
  function derive(before: Entry | undefined, base: Draft, decision: Exclude<MatchDecision, { kind: 'outside' }>, listed: readonly FolderFile[], at: number): Draft {
    const overlapping = decision.candidates.map(meeting => meeting.meetingId);
    const next: { -readonly [K in keyof Draft]: Draft[K] } = { ...base, candidateIds: overlapping.slice(0, 20) };
    const signature = signatureOf(listed);
    const readiness = readinessOf(listed, base.stable, at);
    if (base.stable?.signature !== signature) next.stable = { signature, atMs: at };
    const identity = readiness.ready ? identityOf(listed) : null;
    // Registered and unchanged: done. Its recordings are the server's now (R4).
    if (before?.state === 'uploaded' && (identity === null || identity === before.identity)) return next;

    // The meeting: David's choice while it still overlaps; the matcher's otherwise.
    const chosen = base.matchedBy === 'person' && base.meetingId !== null && overlapping.includes(base.meetingId);
    if (!chosen) {
      next.meetingId = decision.kind === 'matched' ? decision.meetingId : null;
      next.matchedBy = decision.kind === 'matched' ? 'auto' : null;
    }
    const meetingChanged = next.meetingId !== base.meetingId;
    if (before !== undefined && !meetingChanged && (base.state === 'queued' || base.state === 'uploading' || base.state === 'failed')) return next;
    if (meetingChanged) {
      // A different meeting (or none): nothing sent so far counts. The attempt counts stay (R7).
      next.files = base.files.map(stored => ({ ...stored, uploaded: false }));
      next.registerCommandId = null;
    }
    if (!readiness.ready) {
      next.state = readiness.why === 'no_audio' ? 'failed' : next.meetingId === null ? 'needs_matching' : 'waiting';
      next.failure = readiness.why === 'no_audio' ? 'no_audio' : null;
      return next;
    }
    if (identity !== base.identity) {
      next.identity = identity;
      next.files = filesOf(readiness.audio);
      next.registerCommandId = null;
      next.registerAttempts = 0;
    }
    next.failure = null;
    next.state = next.meetingId === null ? 'needs_matching' : 'queued';
    return next;
  }

  async function scanTurn(turn: Turn): Promise<void> {
    if (!(await ensureSession(turn))) return;
    const current = section();
    if (current === null || file === null) return;
    // R2: a scan starts with no authority; only this scan's complete answers give any.
    validated = new Set();
    answers = new Map();
    const root = rootOf(file);
    ensureWatching(root);

    let folders: RootFolder[] = [];
    try {
      folders = [...(await turn.wait(deps.fs.listRoot(root)))];
      rootAvailable = true;
    } catch (error) {
      if (error instanceof Abandoned) throw error;
      rootAvailable = false;
    }
    for (const path of new Set([...Object.keys(current.entries), ...pendingManual])) {
      if (folders.some(entry => entry.path === path)) continue;
      const folder = await turn.wait(deps.fs.statFolder(path));
      if (folder !== null) folders.push(folder);
    }

    const at = now();
    const settled = new Set(current.settled);
    const open: { folder: RootFolder; path: string; startedAt: Date; topic: string | null }[] = [];
    for (const folder of folders) {
      const before = current.entries[folder.path];
      // "Not a Callie demo" is final: never looked at again.
      if (before?.state === 'ignored') continue;
      if (before === undefined && !pendingManual.has(folder.path) && settled.has(digestOf(folder.path))) continue;
      const parsed = parseFolderName(folder.name);
      const startedAt = before !== undefined ? new Date(before.startedAt) : (parsed?.startedAt ?? new Date(folder.birthtimeMs));
      if (Number.isNaN(startedAt.getTime()) || at - startedAt.getTime() > MAX_FOLDER_AGE_MS || startedAt.getTime() - at > DAY_MS) {
        if (before === undefined) {
          settled.add(digestOf(folder.path));
          pendingManual.delete(folder.path);
        }
        continue;
      }
      open.push({ folder, path: folder.path, startedAt, topic: before?.topic ?? parsed?.topic ?? null });
    }
    if (open.length > 0) {
      const found = await candidatesFor(turn, open);
      // No answer, no decision: nothing is settled, listed, shown or uploaded on a guess.
      if (found !== null) {
        for (const entry of open) {
          const meetings = found.get(entry.path);
          if (meetings === undefined) continue;
          answers.set(entry.path, { atMs: now(), meetings });
          await revalidate(turn, entry, meetings, at, settled);
        }
      }
    }
    current.settled = [...settled].slice(-10_000);
    await persist(turn);
  }

  async function revalidate(
    turn: Turn,
    entry: { readonly folder: RootFolder; readonly path: string; readonly startedAt: Date; readonly topic: string | null },
    meetings: readonly RecordingCandidate[],
    at: number,
    settled: Set<string>,
  ): Promise<void> {
    const before = section()?.entries[entry.path];
    if (overlappingMeetings(entry.startedAt, meetings).length === 0) {
      // The privacy rule, from the start time alone: an entry it had goes; only a salted digest
      // is kept, once no meeting can still appear for it (a folder chosen by hand at once).
      commit(entry.path, null);
      const manual = pendingManual.delete(entry.path);
      if (before === undefined && (manual || at - entry.startedAt.getTime() > 2 * DAY_MS)) settled.add(digestOf(entry.path));
      return;
    }
    let listed: readonly FolderFile[];
    try {
      listed = await turn.wait(deps.fs.listFolder(entry.path));
    } catch (error) {
      if (error instanceof Abandoned) throw error;
      return;
    }
    const decision = decideMatch(
      { startedAt: entry.startedAt, topic: entry.topic, participantLabels: listed.filter(item => item.role === 'participant_audio').map(item => item.name) },
      meetings,
    );
    if (decision.kind === 'outside') return;
    commit(entry.path, derive(before, before ?? fresh(entry.folder, entry.startedAt, entry.topic), decision, listed, at));
    pendingManual.delete(entry.path);
    validated.add(entry.path);
  }

  // ---------------------------------------------------------------- the upload, one step per turn

  type Step = 'progress' | 'skip' | 'stop' | 'idle';

  /** One step of the next due folder's upload. */
  async function workTurn(turn: Turn, skipped: ReadonlySet<string>): Promise<{ readonly step: Step; readonly path: string | null }> {
    if (!(await ensureSession(turn))) return { step: 'idle', path: null };
    const current = section();
    if (current === null) return { step: 'idle', path: null };
    const due = Object.entries(current.entries).filter(
      ([path, entry]) => (entry.state === 'uploading' || entry.state === 'queued') && validated.has(path) && !skipped.has(path),
    );
    const next = due.find(([, entry]) => entry.state === 'uploading') ?? due[0];
    if (next === undefined) return { step: 'idle', path: null };
    const [path] = next;
    return { step: await uploadStep(turn, path), path };
  }

  async function uploadStep(turn: Turn, path: string): Promise<Step> {
    const entryNow = (): Entry => {
      const found = section()?.entries[path];
      if (found === undefined) throw new Abandoned();
      return found;
    };
    const update = (patch: Partial<Draft>): void => {
      commit(path, { ...entryNow(), ...patch });
    };
    const fail = async (reason: string): Promise<Step> => {
      update({ state: 'failed', failure: reason.slice(0, 80), registerCommandId: null });
      await persist(turn);
      return 'skip';
    };

    // R2 first: nothing inside the folder is touched without a fresh, complete, overlapping answer.
    const held = await authority(turn, path, entryNow());
    if (held === 'unknown') return 'skip';
    if (held === 'gone') {
      commit(path, null);
      await persist(turn);
      return 'skip';
    }
    if (held === 'rematch') {
      update({ state: 'needs_matching', meetingId: null, matchedBy: null, registerCommandId: null, files: entryNow().files.map(stored => ({ ...stored, uploaded: false })) });
      await persist(turn);
      return 'skip';
    }
    const entry = entryNow();
    const meetingId = entry.meetingId;
    if (meetingId === null) return 'skip';
    if (entry.state !== 'uploading') update({ state: 'uploading' });

    const index = entry.files.findIndex(stored => !stored.uploaded);
    if (index !== -1) {
      const stored = entry.files[index] as StoredFile;
      const filePath = join(entry.folderPath, stored.relPath);
      const withFile = (patch: Partial<StoredFile>): StoredFile[] =>
        entryNow().files.map((entryFile, position) => (position === index ? { ...entryFile, ...patch } : entryFile));

      if (stored.sha256 === null) {
        // (a) Identity, box tree, digest.
        const seen = await turn.wait(deps.fs.statFile(filePath));
        if (seen === null) return await fail('file_unreadable');
        if (seen.sizeBytes !== stored.sizeBytes || seen.ino !== stored.ino || Math.trunc(seen.mtimeMs) !== Math.trunc(stored.mtimeMs)) {
          // The folder changed under the upload: evaluated afresh at the next scan.
          update({ state: 'waiting', identity: null, files: [], stable: null, registerCommandId: null });
          validated.delete(path);
          await persist(turn);
          return 'skip';
        }
        if (stored.sizeBytes > MEETING_RECORDING_LIMITS.maxFileBytes || stored.sizeBytes === 0) return await fail('file_too_large');
        const sniffed = await turn.wait(deps.fs.sniff(filePath));
        if (sniffed !== 'audio') return await fail(sniffed === 'unreadable' ? 'file_unreadable' : 'not_audio');
        let digest: string;
        try {
          digest = await turn.wait(deps.fs.sha256(filePath));
        } catch (error) {
          if (error instanceof Abandoned) throw error;
          return await fail('file_unreadable');
        }
        update({ files: withFile({ sha256: digest }) });
        await persist(turn);
        return 'progress';
      }

      // (b) One PUT, counted before it is made (R7).
      const seen = await turn.wait(deps.fs.statFile(filePath));
      if (seen === null || seen.sizeBytes !== stored.sizeBytes || seen.ino !== stored.ino || Math.trunc(seen.mtimeMs) !== Math.trunc(stored.mtimeMs)) {
        update({ state: 'waiting', identity: null, files: [], stable: null, registerCommandId: null });
        validated.delete(path);
        await persist(turn);
        return 'skip';
      }
      if (stored.attempts >= MAX_ATTEMPTS) return await fail('upload_failed');
      update({ files: withFile({ attempts: stored.attempts + 1 }) });
      await persist(turn);
      const answered = await turn.wait(
        deps.api.command(
          '/meetings/recordings/upload-url',
          { meetingId, fileSha256: stored.sha256, sizeBytes: stored.sizeBytes, participantLabel: stored.participantLabel, segment: stored.segment },
          body => recordingUploadUrlSchema.parse(body),
        ),
      );
      if (!answered.ok) return await refused(turn, answered, path, fail);
      if (answered.value.status === 'upload') {
        const put = await turn.wait(deps.uploader.put(answered.value.url, answered.value.headers, filePath, turn.signal));
        // Interrupted: sent again, whole, with a fresh URL at a later scan, while attempts remain.
        if (!put.ok) return 'stop';
      }
      update({ files: withFile({ uploaded: true }) });
      await persist(turn);
      return 'progress';
    }

    // (c) Every file is there: the register, counted (R7), its command id saved before it is sent.
    if (entry.registerAttempts >= MAX_ATTEMPTS) return await fail('upload_failed');
    const commandId = entry.registerCommandId ?? randomUUID();
    update({ registerCommandId: commandId, registerAttempts: entry.registerAttempts + 1 });
    await persist(turn);
    const sent = entryNow();
    const registered = await turn.wait(
      deps.api.command(
        '/meetings/recordings/register',
        {
          meetingId,
          files: sent.files.map(stored => ({ sha256: stored.sha256, sizeBytes: stored.sizeBytes, participantLabel: stored.participantLabel, segment: stored.segment })),
        },
        body => recordingsRegisteredSchema.parse(body),
        { commandId },
      ),
    );
    if (!registered.ok) {
      if (!registered.offline && registered.reason === 'object_missing') {
        // Those objects are not there (expired, or never arrived): sent again, under fresh URLs,
        // while their attempts last (R7).
        const parsed = recordingObjectMissingSchema.safeParse(registered.refusal);
        const missing = new Set(parsed.success ? parsed.data.missing : sent.files.map(stored => stored.sha256 ?? ''));
        update({ registerCommandId: null, files: sent.files.map(stored => (stored.sha256 !== null && missing.has(stored.sha256) ? { ...stored, uploaded: false } : stored)) });
        await persist(turn);
        return 'stop';
      }
      return await refused(turn, registered, path, fail);
    }
    update({ state: 'uploaded', registerCommandId: null, failure: null });
    await persist(turn);
    return 'skip';
  }

  /** No definite answer: stop, a later scan resumes. The meeting gone: Needs matching. Else failed. */
  async function refused(
    turn: Turn,
    answered: { readonly reason: string; readonly offline: boolean },
    path: string,
    fail: (reason: string) => Promise<Step>,
  ): Promise<Step> {
    if (answered.offline || TRANSIENT.has(answered.reason)) return 'stop';
    if (MEETING_GONE.has(answered.reason)) {
      const entry = section()?.entries[path];
      if (entry === undefined) return 'skip';
      commit(path, { ...entry, state: 'needs_matching', meetingId: null, matchedBy: null, registerCommandId: null, files: entry.files.map(stored => ({ ...stored, uploaded: false })) });
      answers.delete(path);
      await persist(turn);
      return 'skip';
    }
    return await fail(answered.reason === 'not_found' ? 'recordings_unsupported' : answered.reason);
  }

  let working: Promise<void> | null = null;
  let workAgain = false;

  const kick = (): void => {
    if (working !== null) {
      workAgain = true;
      return;
    }
    working = (async () => {
      do {
        workAgain = false;
        const mine = generation;
        const skipped = new Set<string>();
        for (;;) {
          if (mine !== generation) return;
          const done = await serial(async turn => await workTurn(turn, skipped), { step: 'idle' as Step, path: null });
          if (done.step === 'idle' || done.step === 'stop') break;
          if (done.step === 'skip' && done.path !== null) skipped.add(done.path);
        }
      } while (workAgain);
    })()
      .catch(() => undefined)
      .finally(() => {
        working = null;
      });
  };

  let queuedScan: Promise<void> | null = null;

  async function scan(): Promise<RecordingsView> {
    // A scan asked for while one is waiting to run joins it.
    queuedScan ??= serial(async turn => {
      queuedScan = null;
      try {
        await scanTurn(turn);
      } catch (error) {
        // A scan that failed half way decided nothing it did not save; the next one tries again.
        if (error instanceof Abandoned) throw error;
      }
    }, undefined);
    await queuedScan;
    kick();
    return view();
  }

  // ---------------------------------------------------------------- watching

  let interval: unknown = null;
  let debounce: unknown = null;
  let unwatch: (() => void) | null = null;
  let watchedRoot: string | null = null;

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

  const empty = (): RecordingsView => ({ ...view(), items: [] });

  /** The sign-out reset: the generation moves at once (abandoning the turn under way), then the reset is a turn. */
  const forget = async (): Promise<RecordingsView> => {
    generation += 1;
    running?.abort();
    await serial(async () => {
      file = null;
      who = null;
      personKey = null;
      loadedFor = -1;
      candidates = new Map();
      answers = new Map();
      validated = new Set();
      pendingManual = new Set();
      notice = null;
      await Promise.resolve();
    }, undefined);
    return empty();
  };

  /** A command on one item, as one turn on the entry as it is now. */
  const onItem = async (itemId: string, change: (entry: Entry) => Draft | 'stale'): Promise<{ readonly view: RecordingsView; readonly path: string | null; readonly changed: boolean }> =>
    await serial(
      async turn => {
        if (!(await ensureSession(turn))) return { view: view(), path: null, changed: false };
        notice = null;
        const path = pathByItem(itemId);
        const before = path === null ? undefined : section()?.entries[path];
        if (path === null || before === undefined) {
          notice = 'recording_choice_stale';
          return { view: answer(itemId, null), path: null, changed: false };
        }
        const next = change(before);
        if (next === 'stale') {
          notice = 'recording_choice_stale';
          return { view: answer(itemId, path), path, changed: false };
        }
        commit(path, next);
        await persist(turn);
        return { view: answer(itemId, path), path, changed: true };
      },
      { view: empty(), path: null, changed: false },
    );

  return {
    identity: {
      current: () => generation,
      async forgetIfCurrent(since: number) {
        if (since === generation) return await forget();
        return view();
      },
    },
    async state() {
      // Loaded for this session: a pure read. Otherwise the session's first turn loads it.
      if (loadedFor === generation && personKey !== null) return view();
      const mine = generation;
      await serial(async turn => {
        await ensureSession(turn);
      }, undefined);
      return mine === generation ? view() : empty();
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
      await serial(async turn => {
        if (!(await ensureSession(turn)) || file === null) return;
        file.folder = path === deps.defaultFolder ? null : path;
        await persist(turn);
      }, undefined);
      if (mine !== generation) return empty();
      return await scan();
    },
    async importFolder() {
      const mine = generation;
      const chosen = await deps.openFolderDialog('import');
      const path = chosen.canceled ? undefined : chosen.filePaths[0];
      if (path === undefined || mine !== generation) return view();
      // Held in memory only until the scan finds it overlaps a meeting.
      await serial(async turn => {
        if (await ensureSession(turn)) pendingManual.add(path);
      }, undefined);
      if (mine !== generation) return empty();
      return await scan();
    },
    async chooseMeeting(input) {
      const done = await onItem(input.itemId, entry =>
        !(entry.state === 'needs_matching' || entry.state === 'waiting' || entry.state === 'failed') || !entry.candidateIds.includes(input.meetingId)
          ? 'stale'
          : {
              ...entry,
              meetingId: input.meetingId,
              matchedBy: 'person',
              failure: null,
              registerCommandId: null,
              files: entry.files.map(stored => ({ ...stored, uploaded: false })),
              state: entry.identity !== null && entry.files.length > 0 ? 'queued' : 'waiting',
            },
      );
      if (!done.changed) return done.view;
      // Uploaded after a scan establishes its authority (R2), never on the strength of an old one.
      const mine = generation;
      await scan();
      // The item's own answer as it is after the scan (a pure read).
      return mine === generation ? answer(input.itemId, done.path) : empty();
    },
    async ignore(input) {
      const done = await onItem(input.itemId, entry =>
        entry.state === 'uploading' || entry.state === 'uploaded' || entry.state === 'ignored'
          ? 'stale'
          : {
              // "Not a Callie demo": ignored for good, its meeting and files forgotten.
              ...entry,
              state: 'ignored',
              meetingId: null,
              matchedBy: null,
              files: [],
              identity: null,
              candidateIds: [],
              failure: null,
              topic: null,
            },
      );
      return done.view;
    },
    async retry(input) {
      const done = await onItem(input.itemId, entry =>
        entry.state !== 'failed'
          ? 'stale'
          : {
              // Evaluated afresh: listed again, every file sent again under new commands, and
              // the attempt counts start again (R7).
              ...entry,
              state: 'waiting',
              failure: null,
              identity: null,
              files: [],
              stable: null,
              registerCommandId: null,
              registerAttempts: 0,
            },
      );
      if (!done.changed) return done.view;
      const mine = generation;
      await scan();
      // The item's own answer as it is after the scan (a pure read).
      return mine === generation ? answer(input.itemId, done.path) : empty();
    },
    forget,
    async idle() {
      while (queuedScan !== null || working !== null) {
        await (queuedScan ?? working);
        await Promise.resolve();
      }
    },
  };
}
