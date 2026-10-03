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
import { emptyWorkspaceImport, personKeyOf, type Entry, type RecordingStore, type RecordingsFile, type StoredFile, type WorkspaceImport } from './store.ts';
import { identityOf, parseFolderName, readinessOf, segmentsOf, signatureOf, type FolderFile } from './zoomFolder.ts';

/**
 * The demo recording import (lane M4; E4, E5): the folder watcher, the matcher's decisions,
 * the upload of each audio file, and the register — held in the main process, persisted in
 * `recordings.json` per signed-in person, and shown to the window as `RecordingsView`.
 *
 * ## One scan
 *
 *   1. List the root's session folders (names and each folder's own stat), the folders this
 *      person already has entries for, and a folder chosen by hand (held in memory only until
 *      it passes the overlap: review M4R, finding 5). Nothing inside any folder is read yet.
 *   2. Each folder's start: its Zoom name, else its creation time. A folder older than 30 days
 *      is never considered.
 *   3. The meetings around those starts (`GET /meetings/recordings/candidates`), only the ones
 *      this person may attach a recording to. A truncated answer decides nothing: the window is
 *      narrowed to each folder's own, and a folder whose own window is still truncated waits
 *      (finding 10). No answer, no decision.
 *   4. **A folder that overlaps no meeting is dropped here**: never listed, hashed, uploaded or
 *      shown, and an entry it had is removed. Only a salted digest of its path is kept, once no
 *      meeting can still appear for it.
 *   5. Only an overlapping folder is listed; then `decideMatch` and `readinessOf`. EVERY entry
 *      is revalidated this way, including one that was queued or half uploaded before a restart
 *      (finding 2): a meeting chosen by David must still be one the folder overlaps, and an
 *      automatic match must still be the matcher's answer, or the item is Needs matching again
 *      (finding 11: a folded, deleted or rescheduled meeting).
 *
 * ## Compare-and-set (finding 1)
 *
 * Entries are never changed in place: every change replaces the entry with a new object of the
 * next version, and only if the entry is still the one the change was derived from. A scan, an
 * upload step or a command that awaited anything finds out that something else (a "Not a
 * Callie demo", a newer scan, a choice) changed the entry meanwhile, and drops its own change.
 * `ignored` is terminal: nothing but nothing derives anything from it.
 *
 * ## The upload, one folder at a time
 *
 * Only a folder a scan in THIS session has revalidated is uploaded (`validated`). Each audio
 * file: its identity checked again, its first bytes checked to be audio-only MP4/M4A, its
 * SHA-256, `upload-url` (a fresh command and a fresh URL every attempt), the PUT, `uploaded`
 * saved. Then `register`, under a command id saved BEFORE it is sent: a restart in the middle
 * replays that id. `object_missing` (an object that expired or never arrived) clears those
 * files and uploads them again, three times at most (finding 9). `meeting_unknown` or a
 * cancelled meeting puts the folder back to Needs matching.
 *
 * ## Identity
 *
 * Keyed by (workspace, user). `forget()` (any session transition) advances this host's
 * generation and drops what it holds in memory; anything that began under an older generation
 * writes nothing after its next `await` — `state()` included (finding 6).
 */

export const RESCAN_INTERVAL_MS = 60_000;
export const WATCH_DEBOUNCE_MS = 3_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PUT_ATTEMPTS = 3;
const MISSING_ATTEMPTS = 3;

export interface RecordingIdentity {
  readonly workspaceId: string;
  readonly userId: string;
}

export interface RecordingImportDeps {
  readonly api: AuthedClient;
  readonly fs: RecordingFs;
  readonly uploader: RecordingUploader;
  readonly store: RecordingStore;
  /** The signed-in person who may act, or null (signed out, outdated, signing in). */
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

export function itemIdOf(personKey: string, folderPath: string): string {
  return sha256Of(`${personKey}\n${folderPath}`).slice(0, 32);
}

/** An entry's state read afresh (the compiler narrows it across the awaits that change it). */
const VISIBLE: ReadonlySet<Entry['state']> = new Set(['waiting', 'needs_matching', 'queued', 'uploading', 'uploaded', 'failed']);

/** The fields a change compares, so a scan that derived nothing new writes nothing. */
const material = (entry: Entry): string => JSON.stringify({ ...entry, version: 0, updatedAt: '' });

/** A folder's own window, when the combined one was truncated. */
const ownWindow = (startedAt: Date): { readonly from: string; readonly to: string } => ({
  from: new Date(startedAt.getTime() - CANDIDATE_LOOKBACK_MS).toISOString(),
  to: new Date(startedAt.getTime() + CANDIDATE_LOOKAHEAD_MS).toISOString(),
});

const TRANSIENT = new Set(['storage_unavailable', 'database_busy', 'not_ready', 'internal_error', 'not_signed_in', 'unreadable_answer']);
/**
 * The meeting is no longer one this person may attach a recording to: gone (folded, deleted),
 * cancelled, or its firm merged or given to someone else. Needs matching again (finding 11),
 * never a failure only Retry would revisit.
 */
const MEETING_GONE = new Set(['meeting_unknown', 'meeting_cancelled', 'firm_unknown', 'firm_merged', 'not_assigned']);

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
  /** The loaded file, or null until the first read; the person in use, or null. */
  let file: RecordingsFile | null = null;
  let personKey: string | null = null;
  /** Candidate meetings by id, from this session's reads: what "Choose meeting" offers. Memory only. */
  let candidates = new Map<string, RecordingCandidate>();
  /** The folders a scan in this session revalidated, and may therefore be uploaded (finding 2). */
  let validated = new Set<string>();
  /** Folders chosen by hand and not yet past the overlap: memory only (finding 5). */
  let pendingManual = new Set<string>();
  let rootAvailable = true;
  let notice: string | null = null;

  let scanning: Promise<void> | null = null;
  let rescanAsked = false;
  let working: Promise<void> | null = null;
  let interval: unknown = null;
  let debounce: unknown = null;
  let unwatch: (() => void) | null = null;
  let watchedRoot: string | null = null;

  const rootOf = (value: RecordingsFile | null): string => value?.folder ?? deps.defaultFolder;
  const section = (): WorkspaceImport | null => {
    if (file === null || personKey === null) return null;
    file.people[personKey] ??= emptyWorkspaceImport();
    return file.people[personKey] ?? null;
  };
  const digestOf = (path: string): string => sha256Of(`${section()?.salt ?? ''}\n${path}`);

  /** Load the file and become `who`, unless the session moved meanwhile. False: drop the continuation. */
  const adopt = async (mine: number, who: RecordingIdentity): Promise<boolean> => {
    const loaded = file ?? (await deps.store.load());
    if (mine !== generation) return false;
    file = loaded;
    const key = personKeyOf(who);
    if (personKey !== key) {
      personKey = key;
      candidates = new Map();
      validated = new Set();
      pendingManual = new Set();
    }
    return true;
  };

  const persist = async (mine: number): Promise<boolean> => {
    if (mine !== generation || file === null) return false;
    await deps.store.save(file);
    return mine === generation;
  };

  /**
   * Replace `path`'s entry with `next` (or remove it), only if it is still `before` (finding 1).
   * A `next` no different from `before` writes nothing and keeps its version.
   */
  const commit = (path: string, before: Entry | undefined, next: Omit<Entry, 'version' | 'updatedAt'> | null): boolean => {
    const current = section();
    if (current === null || current.entries[path] !== before) return false;
    if (next === null) {
      if (before !== undefined) {
        const { [path]: _gone, ...rest } = current.entries;
        current.entries = rest;
      }
      validated.delete(path);
      return true;
    }
    const candidate = { ...next, version: before?.version ?? 0, updatedAt: before?.updatedAt ?? '' } as Entry;
    if (before !== undefined && material(candidate) === material(before)) return true;
    current.entries[path] = { ...next, version: (before?.version ?? 0) + 1, updatedAt: new Date(now()).toISOString() } as Entry;
    return true;
  };

  const itemOf = (entry: Entry): RecordingItem | null => {
    if (!VISIBLE.has(entry.state) || personKey === null) return null;
    return {
      itemId: itemIdOf(personKey, entry.folderPath),
      version: entry.version,
      folderName: entry.folderName.slice(0, 300),
      startedAt: entry.startedAt,
      state: entry.state === 'queued' ? 'uploading' : entry.state === 'ignored' ? 'failed' : entry.state,
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

  const view = (): RecordingsView => {
    const items = Object.values(section()?.entries ?? {})
      .map(itemOf)
      .filter((item): item is RecordingItem => item !== null)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    const root = rootOf(file);
    return { folder: { path: root.slice(0, 1024), isDefault: file?.folder == null, available: rootAvailable }, items: items.slice(0, 200), notice };
  };

  /** The view, with the commanded item's own answer (finding 12). */
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

  const readWindow = async (window: { readonly from: string; readonly to: string }): Promise<Read> => {
    const answered = await deps.api.read(
      `/meetings/recordings/candidates?from=${encodeURIComponent(window.from)}&to=${encodeURIComponent(window.to)}`,
      body => recordingCandidatesResponseSchema.parse(body),
    );
    if (!answered.ok) return { ok: false };
    for (const meeting of answered.value.meetings) candidates.set(meeting.meetingId, meeting);
    return { ok: true, meetings: answered.value.meetings, truncated: answered.value.truncated };
  };

  /** Each folder's complete candidates, or null for a folder nothing complete was read for. */
  const candidatesFor = async (open: readonly { readonly path: string; readonly startedAt: Date }[]): Promise<Map<string, readonly RecordingCandidate[]> | null> => {
    const times = open.map(entry => entry.startedAt.getTime());
    const combined = await readWindow({
      from: new Date(Math.min(...times) - CANDIDATE_LOOKBACK_MS).toISOString(),
      to: new Date(Math.max(...times) + CANDIDATE_LOOKAHEAD_MS).toISOString(),
    });
    if (!combined.ok) return null;
    const answers = new Map<string, readonly RecordingCandidate[]>();
    if (!combined.truncated) {
      for (const entry of open) answers.set(entry.path, combined.meetings);
      return answers;
    }
    // Finding 10: truncated decides nothing. Each folder's own window, and a folder whose own
    // window is still truncated (or not answered) is left for a later scan.
    for (const entry of open) {
      const own = await readWindow(ownWindow(entry.startedAt));
      if (own.ok && !own.truncated) answers.set(entry.path, own.meetings);
    }
    return answers;
  };

  // ---------------------------------------------------------------- the scan

  const fresh = (folder: RootFolder, startedAt: Date, topic: string | null): Omit<Entry, 'version' | 'updatedAt'> => ({
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
    missingRetries: 0,
    failure: null,
  });

  /** What a scan makes of an overlapping folder: from the entry it had (or none), never from `ignored`. */
  function derive(
    before: Entry | undefined,
    base: Omit<Entry, 'version' | 'updatedAt'>,
    decision: Exclude<MatchDecision, { kind: 'outside' }>,
    listed: readonly FolderFile[],
    at: number,
  ): Omit<Entry, 'version' | 'updatedAt'> {
    const overlapping = decision.candidates.map(meeting => meeting.meetingId);
    const next: { -readonly [K in keyof Omit<Entry, 'version' | 'updatedAt'>]: Omit<Entry, 'version' | 'updatedAt'>[K] } = {
      ...base,
      candidateIds: overlapping.slice(0, 20),
    };
    // The meeting: David's choice while it still overlaps; the matcher's otherwise (finding 11:
    // a chosen or matched meeting that was folded, deleted or moved is not kept).
    const chosen = base.matchedBy === 'person' && base.meetingId !== null && overlapping.includes(base.meetingId);
    // An upload already registered keeps its meeting while that meeting is still offered. One
    // folded into another follows the matcher (its recordings already moved: the server answers
    // `registered` and nothing is sent again), else asks.
    const keptUpload = base.state === 'uploaded' && base.meetingId !== null && overlapping.includes(base.meetingId);
    if (chosen || keptUpload) {
      next.meetingId = base.meetingId;
    } else {
      next.meetingId = decision.kind === 'matched' ? decision.meetingId : null;
      next.matchedBy = decision.kind === 'matched' ? 'auto' : null;
    }
    const meetingChanged = next.meetingId !== base.meetingId;

    const signature = signatureOf(listed);
    const readiness = readinessOf(listed, base.stable, at);
    if (base.stable?.signature !== signature) next.stable = { signature, atMs: at };
    const identity = readiness.ready ? identityOf(listed) : null;

    if (before !== undefined && !meetingChanged) {
      // Nothing to re-derive for work that is under way, done, or failed and waiting for Retry.
      if (base.state === 'queued' || base.state === 'uploading' || base.state === 'failed') return next;
      if (base.state === 'uploaded' && (identity === null || identity === base.identity)) return next;
    }
    if (meetingChanged) {
      // A different meeting (or none): nothing sent so far counts.
      next.files = base.files.map(stored => ({ ...stored, uploaded: false }));
      next.registerCommandId = null;
      next.putFailures = 0;
      next.missingRetries = 0;
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
      next.putFailures = 0;
      next.missingRetries = 0;
    }
    next.failure = null;
    next.state = next.meetingId === null ? 'needs_matching' : 'queued';
    return next;
  }

  async function scanOnce(): Promise<void> {
    const mine = generation;
    const who = await deps.identity();
    if (mine !== generation || who === null) return;
    if (!(await adopt(mine, who))) return;
    const current = section();
    if (current === null || file === null) return;
    const root = rootOf(file);
    ensureWatching(root);

    let folders: RootFolder[] = [];
    try {
      folders = [...(await deps.fs.listRoot(root))];
      rootAvailable = true;
    } catch {
      rootAvailable = false;
    }
    // This person's entries outside the root (a folder imported by hand), and a pending one.
    for (const path of new Set([...Object.keys(current.entries), ...pendingManual])) {
      if (folders.some(entry => entry.path === path)) continue;
      const folder = await deps.fs.statFolder(path);
      if (folder !== null) folders.push(folder);
    }
    if (mine !== generation) return;

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
      const answers = await candidatesFor(open);
      if (mine !== generation) return;
      // No answer, no decision: nothing is settled, listed, shown or uploaded on a guess.
      if (answers !== null) {
        for (const entry of open) {
          const meetings = answers.get(entry.path);
          if (meetings === undefined) continue;
          await revalidate(mine, entry, meetings, at, settled);
          if (mine !== generation) return;
        }
      }
    }
    current.settled = [...settled].slice(-10_000);
    await persist(mine);
  }

  async function revalidate(
    mine: number,
    entry: { readonly folder: RootFolder; readonly path: string; readonly startedAt: Date; readonly topic: string | null },
    meetings: readonly RecordingCandidate[],
    at: number,
    settled: Set<string>,
  ): Promise<void> {
    // The entry as it is now (the worker may have moved it since the scan began). An entry that
    // moves again while its folder is listed is read again, a few times, so a busy upload is
    // never left unrevalidated.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = section();
      if (current === null) return;
      const before = current.entries[entry.path];
      if (before?.state === 'ignored') return;
      if (overlappingMeetings(entry.startedAt, meetings).length === 0) {
        // The privacy rule, decided from the start time alone: an entry it had goes (an upload
        // under way stops before its next request), and only a salted digest is kept once no
        // meeting can still appear for it (a folder chosen by hand at once: it was asked about,
        // and the answer is no).
        commit(entry.path, before, null);
        const manual = pendingManual.delete(entry.path);
        if (before === undefined && (manual || at - entry.startedAt.getTime() > 2 * DAY_MS)) settled.add(digestOf(entry.path));
        return;
      }
      let listed: readonly FolderFile[];
      try {
        listed = await deps.fs.listFolder(entry.path);
      } catch {
        return;
      }
      if (mine !== generation) return;
      if (section()?.entries[entry.path] !== before) continue;
      const decision = decideMatch(
        { startedAt: entry.startedAt, topic: entry.topic, participantLabels: listed.filter(item => item.role === 'participant_audio').map(item => item.name) },
        meetings,
      );
      if (decision.kind === 'outside') return;
      const next = derive(before, before ?? fresh(entry.folder, entry.startedAt, entry.topic), decision, listed, at);
      if (commit(entry.path, before, next)) {
        pendingManual.delete(entry.path);
        validated.add(entry.path);
      }
      return;
    }
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

  /**
   * One folder's upload, every change a compare-and-set on the entry it read. Something else
   * changed the entry meanwhile (an ignore, a scan's revalidation): this upload stops at once.
   */
  async function uploadOne(path: string, mine: number): Promise<Step> {
    let cur = section()?.entries[path];
    if (cur === undefined) return 'continue';
    /** Apply `patch` to the entry this upload last saw; false when it moved (abandon). */
    const update = (patch: Partial<Omit<Entry, 'version' | 'updatedAt'>>): boolean => {
      const base = cur;
      if (base === undefined || !commit(path, base, { ...base, ...patch })) return false;
      cur = section()?.entries[path];
      return true;
    };
    /** After an await: still this session, and still the entry this upload last saw. */
    const still = (): boolean => mine === generation && section()?.entries[path] === cur;
    const fail = (reason: string): boolean => update({ state: 'failed', failure: reason.slice(0, 80), registerCommandId: null });
    const backToMatching = (): boolean =>
      update({
        state: 'needs_matching',
        meetingId: null,
        matchedBy: null,
        registerCommandId: null,
        files: (cur?.files ?? []).map(stored => ({ ...stored, uploaded: false })),
      });

    const meetingId = cur.meetingId;
    if (meetingId === null) return update({ state: 'needs_matching' }) && (await persist(mine)) ? 'continue' : 'stop';
    if (cur.state !== 'uploading') {
      if (!update({ state: 'uploading' })) return 'continue';
      if (!(await persist(mine))) return 'stop';
    }
    for (let index = 0; index < (cur?.files.length ?? 0); index += 1) {
      const stored = cur?.files[index];
      if (stored === undefined || cur === undefined) return 'continue';
      if (stored.uploaded) continue;
      const filePath = join(cur.folderPath, stored.relPath);
      const withFile = (patch: Partial<StoredFile>): StoredFile[] =>
        (cur?.files ?? []).map((entryFile, position) => (position === index ? { ...entryFile, ...patch } : entryFile));

      const seen = await deps.fs.statFile(filePath);
      if (!still()) return mine === generation ? 'continue' : 'stop';
      if (seen === null) return fail('file_unreadable') && (await persist(mine)) ? 'continue' : 'stop';
      if (seen.sizeBytes !== stored.sizeBytes || seen.ino !== stored.ino || Math.trunc(seen.mtimeMs) !== Math.trunc(stored.mtimeMs)) {
        // The folder changed under the upload (a further segment, a re-conversion): it is
        // evaluated afresh at the next scan, as a new identity. The server keeps what arrived.
        update({ state: 'waiting', identity: null, files: [], stable: null, registerCommandId: null });
        validated.delete(path);
        await persist(mine);
        return 'continue';
      }
      if (stored.sizeBytes > MEETING_RECORDING_LIMITS.maxFileBytes || stored.sizeBytes === 0) return fail('file_too_large') && (await persist(mine)) ? 'continue' : 'stop';
      if (stored.sha256 === null) {
        // Audio only, by its boxes, before a byte of it is hashed or sent (review M4R, minor).
        const sniffed = await deps.fs.sniff(filePath);
        if (!still()) return mine === generation ? 'continue' : 'stop';
        if (sniffed !== 'audio') return fail(sniffed === 'unreadable' ? 'file_unreadable' : 'not_audio') && (await persist(mine)) ? 'continue' : 'stop';
        let digest: string;
        try {
          digest = await deps.fs.sha256(filePath);
        } catch {
          if (!still()) return mine === generation ? 'continue' : 'stop';
          return fail('file_unreadable') && (await persist(mine)) ? 'continue' : 'stop';
        }
        if (!still()) return mine === generation ? 'continue' : 'stop';
        if (!update({ files: withFile({ sha256: digest }) })) return 'continue';
        if (!(await persist(mine))) return 'stop';
      }
      const digest = cur.files[index]?.sha256 ?? '';
      const answered = await deps.api.command(
        '/meetings/recordings/upload-url',
        { meetingId, fileSha256: digest, sizeBytes: stored.sizeBytes, participantLabel: stored.participantLabel, segment: stored.segment },
        body => recordingUploadUrlSchema.parse(body),
      );
      if (!still()) return mine === generation ? 'continue' : 'stop';
      if (!answered.ok) return await refused(answered, mine, fail, backToMatching);
      if (answered.value.status === 'upload') {
        const put = await deps.uploader.put(answered.value.url, answered.value.headers, filePath);
        if (!still()) return mine === generation ? 'continue' : 'stop';
        if (!put.ok) {
          // Interrupted: the whole file again with a fresh URL on the next run, a few times.
          const failures = (cur?.putFailures ?? 0) + 1;
          const done = failures >= PUT_ATTEMPTS ? fail('upload_failed') : update({ putFailures: failures });
          if (done) await persist(mine);
          return failures >= PUT_ATTEMPTS ? 'continue' : 'stop';
        }
      }
      if (!update({ files: withFile({ uploaded: true }), putFailures: 0 })) return 'continue';
      if (!(await persist(mine))) return 'stop';
    }
    if (cur === undefined) return 'continue';

    // Every file is there. The command id is saved before it is sent (CC3).
    if (cur.registerCommandId === null) {
      if (!update({ registerCommandId: randomUUID() })) return 'continue';
      if (!(await persist(mine))) return 'stop';
    }
    const sent = cur;
    const registered = await deps.api.command(
      '/meetings/recordings/register',
      {
        meetingId,
        files: sent.files.map(stored => ({ sha256: stored.sha256, sizeBytes: stored.sizeBytes, participantLabel: stored.participantLabel, segment: stored.segment })),
      },
      body => recordingsRegisteredSchema.parse(body),
      { commandId: sent.registerCommandId ?? randomUUID() },
    );
    if (!still()) return mine === generation ? 'continue' : 'stop';
    if (!registered.ok) {
      if (!registered.offline && registered.reason === 'object_missing') {
        // Finding 9: those objects are not there (expired, or never arrived). They are sent
        // again under fresh URLs, three times at most; then the folder fails, with Retry.
        const parsed = recordingObjectMissingSchema.safeParse(registered.refusal);
        const missing = new Set(parsed.success ? parsed.data.missing : sent.files.map(stored => stored.sha256 ?? ''));
        const retries = sent.missingRetries + 1;
        const done =
          retries >= MISSING_ATTEMPTS
            ? fail('upload_failed')
            : update({
                missingRetries: retries,
                registerCommandId: null,
                files: sent.files.map(stored => (stored.sha256 !== null && missing.has(stored.sha256) ? { ...stored, uploaded: false } : stored)),
              });
        if (done) await persist(mine);
        return retries >= MISSING_ATTEMPTS ? 'continue' : 'stop';
      }
      return await refused(registered, mine, fail, backToMatching);
    }
    if (!update({ state: 'uploaded', registerCommandId: null, failure: null, missingRetries: 0 })) return 'continue';
    await persist(mine);
    return 'continue';
  }

  /** No definite answer: stop, the next scan resumes. The meeting gone: Needs matching. Else failed. */
  async function refused(
    answered: { readonly reason: string; readonly offline: boolean },
    mine: number,
    fail: (reason: string) => boolean,
    backToMatching: () => boolean,
  ): Promise<Step> {
    if (answered.offline || TRANSIENT.has(answered.reason)) return 'stop';
    const changed = MEETING_GONE.has(answered.reason) ? backToMatching() : fail(answered.reason === 'not_found' ? 'recordings_unsupported' : answered.reason);
    if (changed) await persist(mine);
    return 'continue';
  }

  async function work(): Promise<void> {
    const mine = generation;
    const attempted = new Set<string>();
    for (;;) {
      if (mine !== generation) return;
      const current = section();
      if (current === null) return;
      const due = Object.entries(current.entries).filter(
        ([path, entry]) => (entry.state === 'uploading' || entry.state === 'queued') && validated.has(path) && !attempted.has(path),
      );
      const next = due.find(([, entry]) => entry.state === 'uploading') ?? due[0];
      if (next === undefined) return;
      attempted.add(next[0]);
      const step = await uploadOne(next[0], mine);
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
    personKey = null;
    file = null;
    candidates = new Map();
    validated = new Set();
    pendingManual = new Set();
    notice = null;
    return await Promise.resolve(view());
  };

  /** A command on one item, applied to the entry as it is now. */
  const onItem = async (
    itemId: string,
    change: (entry: Entry) => Omit<Entry, 'version' | 'updatedAt'> | 'stale',
    after: (path: string) => Promise<unknown> | undefined,
  ): Promise<RecordingsView> => {
    notice = null;
    const path = pathByItem(itemId);
    const before = path === null ? undefined : section()?.entries[path];
    if (path === null || before === undefined) {
      notice = 'recording_choice_stale';
      return answer(itemId, null);
    }
    const next = change(before);
    if (next === 'stale' || !commit(path, before, next)) {
      notice = 'recording_choice_stale';
      return answer(itemId, path);
    }
    const mine = generation;
    await persist(mine);
    if (mine !== generation) return view();
    await after(path);
    if (mine !== generation) return view();
    return answer(itemId, path);
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
      // The first read after a launch or a sign-in loads the signed-in person's entries; a
      // sign-out meanwhile drops this continuation (finding 6).
      if (personKey === null) {
        const mine = generation;
        const who = await deps.identity();
        if (mine !== generation) return view();
        if (who !== null && !(await adopt(mine, who))) return view();
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
      const loaded = file ?? (await deps.store.load());
      if (mine !== generation) return view();
      file = loaded;
      loaded.folder = path === deps.defaultFolder ? null : path;
      await deps.store.save(loaded);
      if (mine !== generation) return view();
      return await scan();
    },
    async importFolder() {
      const mine = generation;
      const chosen = await deps.openFolderDialog('import');
      const path = chosen.canceled ? undefined : chosen.filePaths[0];
      if (path === undefined || mine !== generation) return view();
      const who = await deps.identity();
      if (who === null || mine !== generation) return view();
      if (!(await adopt(mine, who))) return view();
      // Held in memory only until the scan finds it overlaps a meeting (finding 5).
      pendingManual.add(path);
      return await scan();
    },
    async chooseMeeting(input) {
      return await onItem(
        input.itemId,
        entry =>
          !(entry.state === 'needs_matching' || entry.state === 'waiting' || entry.state === 'failed') || !entry.candidateIds.includes(input.meetingId)
            ? 'stale'
            : {
                ...entry,
                meetingId: input.meetingId,
                matchedBy: 'person',
                failure: null,
                registerCommandId: null,
                putFailures: 0,
                missingRetries: 0,
                files: entry.files.map(stored => ({ ...stored, uploaded: false })),
                state: entry.identity !== null && entry.files.length > 0 ? 'queued' : 'waiting',
              },
        path => {
          // Uploaded at once if this session's scan validated it; otherwise after a scan now.
          if (!validated.has(path)) return scan();
          kick();
          return undefined;
        },
      );
    },
    async ignore(input) {
      return await onItem(
        input.itemId,
        entry =>
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
        path => {
          validated.delete(path);
          return undefined;
        },
      );
    },
    async retry(input) {
      return await onItem(
        input.itemId,
        entry =>
          entry.state !== 'failed'
            ? 'stale'
            : {
                // Evaluated afresh: listed again, every file sent again under new commands.
                ...entry,
                state: 'waiting',
                failure: null,
                identity: null,
                files: [],
                stable: null,
                registerCommandId: null,
                putFailures: 0,
                missingRetries: 0,
              },
        async () => await scan(),
      );
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
