import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { instant, uuid } from '@fss/contracts';



/**
 * What the recording import remembers across restarts (lane M4), in one JSON file beside
 * `device.json`, written atomically the way `deviceStore.ts` writes (a temporary file, then a
 * rename), mode 0600.
 *
 *   * `folder` — the demo recordings folder this Mac watches (a device setting); null is the
 *     default, `~/Movies/Callie Demos`.
 *   * `people["<workspace>:<user>:<admin|member>"]` — each signed-in person's own import, per
 *     role class (review M4R, finding 7; M4 reset, R5), so another person, another workspace,
 *     or the same person after a downgrade never sees folders, meetings or decisions derived
 *     under another authority:
 *       - `entries`, keyed by folder path, for the folders that overlapped a Callie meeting —
 *         their state, the meeting, and each audio file's identity (inode, size, mtime), digest,
 *         and whether it has been uploaded. A folder whose
 *         files' identity changes is evaluated again (the brief: keyed by the path plus the
 *         files' identity). Each entry carries a `version` taken from `clocks` (below), so a
 *         version is never reused, even by an entry removed and recreated (R1);
 *       - `attempts` — each file's PUTs and registers, by the file's identity, kept when an entry
 *         goes (R7);
 *       - `settled` — a SALTED digest (`salt`, random per person) of the path of each folder
 *         found to overlap no meeting, once no meeting can still appear for it. Never the path:
 *         the store holds no name of a folder it never looked into (finding 5). A folder chosen
 *         with "Import a recording folder…" is held in memory until it passes the overlap.
 *
 *   * `clocks["<workspace>:<user>"]` — the person's monotonic version counter (M4 reset, R1).
 *
 * Nothing here is audio, a transcript or a URL.
 */

export const RECORDINGS_FILE = 'recordings.json';

export const ENTRY_STATES = ['waiting', 'needs_matching', 'queued', 'uploading', 'uploaded', 'failed', 'ignored'] as const;
export type EntryState = (typeof ENTRY_STATES)[number];

export const storedFileSchema = z.strictObject({
  relPath: z.string().max(1024),
  participantLabel: z.string().max(255),
  segment: z.number().int().min(1),
  sizeBytes: z.number().int().min(0),
  ino: z.number(),
  mtimeMs: z.number(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u).nullable(),
  uploaded: z.boolean(),
});
export type StoredFile = z.infer<typeof storedFileSchema>;

export const entrySchema = z.strictObject({
  /** From the person's clock at every change: never reused, never smaller (R1). */
  version: z.number().int().min(1),
  folderPath: z.string().max(4096),
  folderName: z.string().max(1024),
  startedAt: instant,
  topic: z.string().max(1024).nullable(),
  state: z.enum(ENTRY_STATES),
  meetingId: uuid.nullable(),
  /** `auto` when the matcher decided, `person` when David chose. */
  matchedBy: z.enum(['auto', 'person']).nullable(),
  candidateIds: z.array(uuid).max(20),
  /** The listing's signature and when it was first seen unchanged (the stability check). */
  stable: z.strictObject({ signature: z.string(), atMs: z.number() }).nullable(),
  /** The audio files' identity the `files` below were taken from. */
  identity: z.string().nullable(),
  files: z.array(storedFileSchema).max(200),
  /** The register command's id, minted before it is sent, so a restart replays it. */
  registerCommandId: uuid.nullable(),
  failure: z.string().max(80).nullable(),
  updatedAt: instant,
});
export type Entry = z.infer<typeof entrySchema>;

/**
 * R7 (repaired after M4RR finding 4): each FILE's PUTs and registers, keyed by the file's
 * identity — its SHA-256 when known, else a salted digest of its path with its size and mtime —
 * and kept apart from the entries: an entry removed (its folder lost its overlap) and found
 * again starts from the same counts. Only Retry resets them.
 */
export const attemptsSchema = z.strictObject({ puts: z.number().int().min(0), registers: z.number().int().min(0) });
export type Attempts = z.infer<typeof attemptsSchema>;

export const workspaceImportSchema = z.strictObject({
  salt: z.string().regex(/^[0-9a-f]{64}$/u),
  entries: z.record(z.string(), entrySchema),
  attempts: z.record(z.string().regex(/^(?:[0-9a-f]{64}|p:[0-9a-f]{64}:[0-9]+:[0-9]+)$/u), attemptsSchema),
  settled: z.array(z.string().regex(/^[0-9a-f]{64}$/u)).max(10_000),
});
export type WorkspaceImport = z.infer<typeof workspaceImportSchema>;

/** `<workspace id>:<user id>:<admin|member>`: one person's import under one role class. */
export const PERSON_KEY = /^[0-9a-f-]{36}:[0-9a-f-]{36}:(?:admin|member)$/u;
export const CLOCK_KEY = /^[0-9a-f-]{36}:[0-9a-f-]{36}$/u;
export interface PersonIdentity {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: 'admin' | 'member';
}
export const personKeyOf = (identity: PersonIdentity): string => `${identity.workspaceId}:${identity.userId}:${identity.role}`;
export const clockKeyOf = (identity: Pick<PersonIdentity, 'workspaceId' | 'userId'>): string => `${identity.workspaceId}:${identity.userId}`;

export const recordingsFileSchema = z.strictObject({
  version: z.literal(3),
  folder: z.string().max(4096).nullable(),
  people: z.record(z.string().regex(PERSON_KEY), workspaceImportSchema),
  clocks: z.record(z.string().regex(CLOCK_KEY), z.number().int().min(0)),
});
export type RecordingsFile = z.infer<typeof recordingsFileSchema>;

export const emptyWorkspaceImport = (): WorkspaceImport => ({ salt: randomBytes(32).toString('hex'), entries: {}, attempts: {}, settled: [] });
const EMPTY: RecordingsFile = Object.freeze({ version: 3, folder: null, people: {}, clocks: {} }) as RecordingsFile;

export interface RecordingStore {
  load(): Promise<RecordingsFile>;
  save(value: RecordingsFile): Promise<void>;
}

export function createRecordingStore(options: { readonly directory: string }): RecordingStore {
  const path = join(options.directory, RECORDINGS_FILE);
  // Writes are chained so two saves never interleave their renames.
  let chain: Promise<void> = Promise.resolve();
  return {
    async load() {
      try {
        return recordingsFileSchema.parse(JSON.parse(await readFile(path, 'utf8')));
      } catch {
        // Absent or unreadable: nothing remembered. Every folder is evaluated afresh, and the
        // server's (meeting, sha256) uniqueness keeps a re-upload from recording anything twice.
        return structuredClone(EMPTY);
      }
    },
    async save(value) {
      const parsed = recordingsFileSchema.parse(value);
      const write = async (): Promise<void> => {
        await mkdir(options.directory, { recursive: true, mode: 0o700 });
        const temporary = `${path}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, `${JSON.stringify(parsed)}\n`, { mode: 0o600, flag: 'wx' });
          await rename(temporary, path);
        } catch (error) {
          await rm(temporary, { force: true }).catch(() => undefined);
          throw error;
        }
      };
      chain = chain.then(write, write);
      await chain;
    },
  };
}

/** A store in memory, for tests and for a Mac whose user directory cannot be written. */
export function memoryRecordingStore(initial: RecordingsFile = structuredClone(EMPTY)): RecordingStore & { readonly saved: () => RecordingsFile } {
  let value = structuredClone(initial);
  return {
    load: async () => await Promise.resolve(structuredClone(value)),
    save: async next => {
      value = structuredClone(recordingsFileSchema.parse(next));
      await Promise.resolve();
    },
    saved: () => structuredClone(value),
  };
}
