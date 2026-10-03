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
  type Attempts,
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
 * store load, a scan, a command, one step of the upload worker, the commit of a PUT's result,
 * the sign-out reset. The PUT itself is not a turn (M4RR finding 5): a turn decides it, counts
 * it and claims a lease on it (the entry's version and a lease id), the transfer runs outside
 * the queue while commands and scans go on, and a later turn commits its result only if the
 * lease still holds — the same lease id, the entry at the same version — else drops it. Turns never
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
 * Immediately before EACH operation on a folder's files — its listing, a stat, the sniff, the
 * hash, the upload URL, the PUT, the register — a candidates answer for that folder must be
 * complete (not truncated), read in this session, and FETCHED at most 60 seconds before that
 * operation starts (an answer is stamped when its read is issued, and never re-stamped), and
 * the folder must still overlap a meeting under it with its meeting still holding (David's
 * choice still overlapping; an automatic match still the matcher's answer). An older answer
 * is replaced by a read of the folder's own window first; with no such answer, the operation
 * does not start. `validated` (the folders a scan in this session revalidated) is cleared at
 * the start of every scan and whenever a candidates read fails.
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
 * One step per turn: (a) one file's identity checked, its codecs checked to be audio only
 * (R3), its SHA-256; (b) one file's `upload-url`, then its PUT, leased and made outside the
 * queue; (c) the `register`, under a command id saved before it is sent. R7: each FILE's PUTs
 * and registers are counted in the store, keyed by the file's identity (its digest) and kept
 * apart from the entries, so a folder that loses and regains its overlap does not start them
 * again; a fourth of either fails the folder, with Retry — the only thing that resets them.
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
  /**
   * Each folder's last complete candidates answer in this session, stamped with when its read
   * was ISSUED (R2, after M4RR finding 2): never re-stamped, so its age is its real age.
   */
  let answers = new Map<string, { readonly fetchedAt: number; readonly meetings: readonly RecordingCandidate[] }>();
  /** The PUT each folder's upload holds a lease for: claimed in a turn, run outside the queue (M4RR finding 5). */
  let leases = new Map<string, string>();
  /** The PUTs in flight, aborted by a sign-out. */
  const inflight = new Set<AbortController>();
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

  type Read =
    | { readonly ok: true; readonly fetchedAt: number; readonly meetings: readonly RecordingCandidate[]; readonly truncated: boolean }
    | { readonly ok: false };

  async function readWindow(turn: Turn, window: { readonly from: string; readonly to: string }): Promise<Read> {
    // Stamped when it is issued: an answer is never younger than the question.
    const fetchedAt = now();
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
    return { ok: true, fetchedAt, meetings: answered.value.meetings, truncated: answered.value.truncated };
  }

  type Held = { readonly fetchedAt: number; readonly meetings: readonly RecordingCandidate[] };
  const isFresh = (held: Held | undefined): held is Held => held !== undefined && now() >= held.fetchedAt && now() - held.fetchedAt <= AUTHORITY_MAX_AGE_MS;

  /**
   * R2, immediately before ONE file operation: this folder's complete answer, fetched at most
   * 60 s before now — the one held, or one read now for the folder's own window. Null: none.
   */
  async function freshAnswer(turn: Turn, path: string, startedAt: Date): Promise<Held | null> {
    const held = answers.get(path);
    if (isFresh(held)) return held;
    answers.delete(path);
    const read = await readWindow(turn, ownWindow(startedAt));
    if (!read.ok || read.truncated) {
      validated.delete(path);
      return null;
    }
    const answer = { fetchedAt: read.fetchedAt, meetings: read.meetings };
    // A read slower than the limit is no authority either.
    if (!isFresh(answer)) {
      validated.delete(path);
      return null;
    }
    answers.set(path, answer);
    return answer;
  }

  /** Each folder's complete candidates, with their fetch time; a folder with none is absent. Null: no answer at all. */
  async function candidatesFor(turn: Turn, open: readonly { readonly path: string; readonly startedAt: Date }[]): Promise<Map<string, Held> | null> {
    const times = open.map(entry => entry.startedAt.getTime());
    const combined = await readWindow(turn, {
      from: new Date(Math.min(...times) - CANDIDATE_LOOKBACK_MS).toISOString(),
      to: new Date(Math.max(...times) + CANDIDATE_LOOKAHEAD_MS).toISOString(),
    });
    if (!combined.ok) return null;
    const found = new Map<string, Held>();
    if (!combined.truncated) {
      for (const entry of open) found.set(entry.path, { fetchedAt: combined.fetchedAt, meetings: combined.meetings });
      return found;
    }
    // Truncated decides nothing: each folder's own window; one still truncated waits.
    for (const entry of open) {
      const own = await readWindow(turn, ownWindow(entry.startedAt));
      if (!own.ok) return null;
      if (!own.truncated) found.set(entry.path, { fetchedAt: own.fetchedAt, meetings: own.meetings });
    }
    return found;
  }

  /**
   * R2, immediately before each file operation (stat, sniff, hash, upload URL, PUT, register):
   * a complete answer for this folder fetched at most 60 s before, under which it overlaps a
   * meeting and its meeting holds.
   */
  async function authority(turn: Turn, path: string, entry: Entry): Promise<'ok' | 'gone' | 'rematch' | 'unknown'> {
    const startedAt = new Date(entry.startedAt);
    const held = await freshAnswer(turn, path, startedAt);
    if (held === null) return 'unknown';
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
      // A different meeting (or none): nothing sent so far counts. The attempt counts stay (R7):
      // they are the files', kept apart from the entry.
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
        // Each folder's answer keeps its own fetch time: a slow listing of one folder never
        // makes the next folder's answer look younger than it is (M4RR finding 2).
        for (const [path, held] of found) answers.set(path, held);
        for (const entry of open) {
          if (!found.has(entry.path)) continue;
          await revalidate(turn, entry, at, settled);
        }
      }
    }
    current.settled = [...settled].slice(-10_000);
    await persist(turn);
  }

  async function revalidate(
    turn: Turn,
    entry: { readonly folder: RootFolder; readonly path: string; readonly startedAt: Date; readonly topic: string | null },
    at: number,
    settled: Set<string>,
  ): Promise<void> {
    // R2: the answer the listing is decided on was fetched at most 60 s before the listing
    // starts; an older one is read again for this folder's own window first.
    const held = await freshAnswer(turn, entry.path, entry.startedAt);
    if (held === null) return;
    const meetings = held.meetings;
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

  /** A PUT decided and leased in a turn, made outside the queue (M4RR finding 5). */
  interface PutPlan {
    readonly leaseId: string;
    readonly path: string;
    /** The entry's version when the lease was claimed: the result commits only if it is unchanged. */
    readonly version: number;
    readonly index: number;
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly filePath: string;
  }
  type Done = { readonly step: Step; readonly path: string | null; readonly put?: PutPlan };

  /** A file's identity for its attempt counts (R7): its digest, else its path (salted), size and mtime. */
  const fileKeyOf = (folderPath: string, stored: StoredFile): string =>
    stored.sha256 ?? `p:${digestOf(join(folderPath, stored.relPath))}:${String(stored.sizeBytes)}:${String(Math.max(0, Math.trunc(stored.mtimeMs)))}`;
  const attemptsOf = (key: string): Attempts => section()?.attempts[key] ?? { puts: 0, registers: 0 };
  const countAttempt = (key: string, kind: keyof Attempts): void => {
    const current = section();
    if (current === null) throw new Abandoned();
    const held = attemptsOf(key);
    current.attempts[key] = { ...held, [kind]: held[kind] + 1 };
  };

  /** One step of the next due folder's upload. */
  async function workTurn(turn: Turn, skipped: ReadonlySet<string>): Promise<Done> {
    if (!(await ensureSession(turn))) return { step: 'idle', path: null };
    const current = section();
    if (current === null) return { step: 'idle', path: null };
    const due = Object.entries(current.entries).filter(
      ([path, entry]) => (entry.state === 'uploading' || entry.state === 'queued') && validated.has(path) && !skipped.has(path),
    );
    const next = due.find(([, entry]) => entry.state === 'uploading') ?? due[0];
    if (next === undefined) return { step: 'idle', path: null };
    const [path] = next;
    return { ...(await uploadStep(turn, path)), path };
  }

  async function uploadStep(turn: Turn, path: string): Promise<{ readonly step: Step; readonly put?: PutPlan }> {
    const entryNow = (): Entry => {
      const found = section()?.entries[path];
      if (found === undefined) throw new Abandoned();
      return found;
    };
    const update = (patch: Partial<Draft>): void => {
      commit(path, { ...entryNow(), ...patch });
    };
    const fail = async (reason: string): Promise<{ readonly step: Step }> => {
      update({ state: 'failed', failure: reason.slice(0, 80), registerCommandId: null });
      await persist(turn);
      return { step: 'skip' };
    };
    /**
     * R2 immediately before each file operation: null to go on; otherwise the step ends, with
     * the folder removed (overlaps nothing), back to Needs matching, or simply not touched.
     */
    const authorised = async (): Promise<{ readonly step: Step } | null> => {
      const held = await authority(turn, path, entryNow());
      if (held === 'ok') return null;
      if (held === 'gone') commit(path, null);
      if (held === 'rematch') {
        update({ state: 'needs_matching', meetingId: null, matchedBy: null, registerCommandId: null, files: entryNow().files.map(stored => ({ ...stored, uploaded: false })) });
      }
      if (held !== 'unknown') await persist(turn);
      return { step: 'skip' };
    };
    const unchanged = (seen: { readonly sizeBytes: number; readonly ino: number; readonly mtimeMs: number } | null, stored: StoredFile): boolean =>
      seen !== null && seen.sizeBytes === stored.sizeBytes && seen.ino === stored.ino && Math.trunc(seen.mtimeMs) === Math.trunc(stored.mtimeMs);
    const changedUnderneath = async (): Promise<{ readonly step: Step }> => {
      // The folder changed under the upload: evaluated afresh at the next scan.
      update({ state: 'waiting', identity: null, files: [], stable: null, registerCommandId: null });
      validated.delete(path);
      await persist(turn);
      return { step: 'skip' };
    };

    const before = await authorised();
    if (before !== null) return before;
    const entry = entryNow();
    const meetingId = entry.meetingId;
    if (meetingId === null) return { step: 'skip' };
    if (entry.state !== 'uploading') update({ state: 'uploading' });

    const index = entry.files.findIndex(stored => !stored.uploaded);
    if (index !== -1) {
      const stored = entry.files[index] as StoredFile;
      const filePath = join(entry.folderPath, stored.relPath);
      const withFile = (patch: Partial<StoredFile>): StoredFile[] =>
        entryNow().files.map((entryFile, position) => (position === index ? { ...entryFile, ...patch } : entryFile));

      // Its identity (authorised just above).
      const seen = await turn.wait(deps.fs.statFile(filePath));
      if (seen === null) return await fail('file_unreadable');
      if (!unchanged(seen, stored)) return await changedUnderneath();

      if (stored.sha256 === null) {
        // (a) The box tree, then the digest: each authorised immediately before it starts.
        if (stored.sizeBytes > MEETING_RECORDING_LIMITS.maxFileBytes || stored.sizeBytes === 0) return await fail('file_too_large');
        const toSniff = await authorised();
        if (toSniff !== null) return toSniff;
        const sniffed = await turn.wait(deps.fs.sniff(filePath));
        if (sniffed !== 'audio') return await fail(sniffed === 'unreadable' ? 'file_unreadable' : 'not_audio');
        const toHash = await authorised();
        if (toHash !== null) return toHash;
        let digest: string;
        try {
          digest = await turn.wait(deps.fs.sha256(filePath));
        } catch (error) {
          if (error instanceof Abandoned) throw error;
          return await fail('file_unreadable');
        }
        update({ files: withFile({ sha256: digest }) });
        await persist(turn);
        return { step: 'progress' };
      }

      // (b) The upload URL, then the PUT — counted (R7), leased, and made outside the queue.
      const key = fileKeyOf(entry.folderPath, stored);
      if (attemptsOf(key).puts >= MAX_ATTEMPTS) return await fail('upload_failed');
      const toAsk = await authorised();
      if (toAsk !== null) return toAsk;
      const answered = await turn.wait(
        deps.api.command(
          '/meetings/recordings/upload-url',
          { meetingId, fileSha256: stored.sha256, sizeBytes: stored.sizeBytes, participantLabel: stored.participantLabel, segment: stored.segment },
          body => recordingUploadUrlSchema.parse(body),
        ),
      );
      if (!answered.ok) return await refused(turn, answered, path, fail);
      if (answered.value.status === 'registered') {
        update({ files: withFile({ uploaded: true }) });
        await persist(turn);
        return { step: 'progress' };
      }
      // The last check before the PUT starts: authority fetched within 60 s of now.
      const toPut = await authorised();
      if (toPut !== null) return toPut;
      countAttempt(key, 'puts');
      await persist(turn);
      const leaseId = randomUUID();
      leases.set(path, leaseId);
      return {
        step: 'progress',
        put: { leaseId, path, version: entryNow().version, index, url: answered.value.url, headers: answered.value.headers, filePath },
      };
    }

    // (c) Every file is there: the register, counted per file (R7), authorised, its command id
    // saved before it is sent.
    const keys = entry.files.map(stored => fileKeyOf(entry.folderPath, stored));
    if (keys.some(key => attemptsOf(key).registers >= MAX_ATTEMPTS)) return await fail('upload_failed');
    const toRegister = await authorised();
    if (toRegister !== null) return toRegister;
    const commandId = entry.registerCommandId ?? randomUUID();
    for (const key of keys) countAttempt(key, 'registers');
    update({ registerCommandId: commandId });
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
        return { step: 'stop' };
      }
      return await refused(turn, registered, path, fail);
    }
    update({ state: 'uploaded', registerCommandId: null, failure: null });
    await persist(turn);
    return { step: 'skip' };
  }

  /** A PUT's result, committed only while its lease holds: the entry unchanged since it was claimed. */
  async function commitPut(turn: Turn, plan: PutPlan, ok: boolean): Promise<Step> {
    if (leases.get(plan.path) !== plan.leaseId) return 'skip';
    leases.delete(plan.path);
    const entry = section()?.entries[plan.path];
    if (entry === undefined || entry.version !== plan.version) return 'skip';
    // Interrupted: sent again, whole, with a fresh URL at a later scan, while attempts remain.
    if (!ok) return 'stop';
    commit(plan.path, { ...entry, files: entry.files.map((stored, position) => (position === plan.index ? { ...stored, uploaded: true } : stored)) });
    await persist(turn);
    return 'progress';
  }

  /** The PUT, outside the queue: commands and scans go on meanwhile; a sign-out aborts it. */
  async function runPut(plan: PutPlan): Promise<boolean> {
    const controller = new AbortController();
    inflight.add(controller);
    try {
      const aborted = new Promise<{ readonly ok: false }>(resolve => {
        controller.signal.addEventListener(
          'abort',
          () => {
            resolve({ ok: false });
          },
          { once: true },
        );
      });
      const outcome = await Promise.race([deps.uploader.put(plan.url, plan.headers, plan.filePath, controller.signal), aborted]);
      return outcome.ok;
    } catch {
      return false;
    } finally {
      inflight.delete(controller);
    }
  }

  /** No definite answer: stop, a later scan resumes. The meeting gone: Needs matching. Else failed. */
  async function refused(
    turn: Turn,
    answered: { readonly reason: string; readonly offline: boolean },
    path: string,
    fail: (reason: string) => Promise<{ readonly step: Step }>,
  ): Promise<{ readonly step: Step }> {
    if (answered.offline || TRANSIENT.has(answered.reason)) return { step: 'stop' };
    if (MEETING_GONE.has(answered.reason)) {
      const entry = section()?.entries[path];
      if (entry === undefined) return { step: 'skip' };
      commit(path, { ...entry, state: 'needs_matching', meetingId: null, matchedBy: null, registerCommandId: null, files: entry.files.map(stored => ({ ...stored, uploaded: false })) });
      answers.delete(path);
      await persist(turn);
      return { step: 'skip' };
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
          const done = await serial(async turn => await workTurn(turn, skipped), { step: 'idle' as Step, path: null } as Done);
          let step = done.step;
          const plan = done.put;
          if (plan !== undefined) {
            const ok = await runPut(plan);
            if (mine !== generation) return;
            step = await serial(async turn => (turn.mine === mine ? await commitPut(turn, plan, ok) : 'idle'), 'idle' as Step);
          }
          if (step === 'idle' || step === 'stop') break;
          if (step === 'skip' && done.path !== null) skipped.add(done.path);
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
    for (const controller of inflight) controller.abort();
    await serial(async () => {
      file = null;
      who = null;
      personKey = null;
      loadedFor = -1;
      candidates = new Map();
      answers = new Map();
      leases = new Map();
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
      const done = await onItem(input.itemId, entry => {
        if (entry.state !== 'failed') return 'stale';
        // Retry is the one thing that resets its files' attempt counts (R7), whichever identity
        // they are kept under.
        const current = section();
        if (current !== null) {
          for (const stored of entry.files) {
            delete current.attempts[fileKeyOf(entry.folderPath, stored)];
            delete current.attempts[fileKeyOf(entry.folderPath, { ...stored, sha256: null })];
          }
        }
        return {
          // Evaluated afresh: listed again, every file sent again under new commands.
          ...entry,
          state: 'waiting',
          failure: null,
          identity: null,
          files: [],
          stable: null,
          registerCommandId: null,
        };
      });
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
