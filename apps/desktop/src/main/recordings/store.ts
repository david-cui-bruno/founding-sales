import { randomUUID } from 'node:crypto';
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
 *   * `workspaces[<id>]` — each workspace's import, so a different workspace signed in on this
 *     Mac never sees another's folders or meetings:
 *       - `entries`, keyed by folder path, for the folders that overlapped a Callie meeting —
 *         their state, the meeting, and each audio file's identity (inode, size, mtime), digest
 *         and whether it has been uploaded. A folder whose files' identity changes is evaluated
 *         again (the brief: keyed by the path plus the files' identity);
 *       - `settled` — a digest of the path of each folder found to overlap no meeting once its
 *         start was old enough that no meeting can still appear for it. A digest, not the path:
 *         the store holds no name of a folder it never looked into;
 *       - `manualFolders` — folders chosen with "Import a recording folder…".
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
  putFailures: z.number().int().min(0),
  failure: z.string().max(80).nullable(),
  updatedAt: instant,
});
export type Entry = z.infer<typeof entrySchema>;

export const workspaceImportSchema = z.strictObject({
  entries: z.record(z.string(), entrySchema),
  settled: z.array(z.string().regex(/^[0-9a-f]{64}$/u)),
  manualFolders: z.array(z.string().max(4096)).max(100),
});
export type WorkspaceImport = z.infer<typeof workspaceImportSchema>;

export const recordingsFileSchema = z.strictObject({
  version: z.literal(1),
  folder: z.string().max(4096).nullable(),
  workspaces: z.record(uuid, workspaceImportSchema),
});
export type RecordingsFile = z.infer<typeof recordingsFileSchema>;

export const emptyWorkspaceImport = (): WorkspaceImport => ({ entries: {}, settled: [], manualFolders: [] });
const EMPTY: RecordingsFile = Object.freeze({ version: 1, folder: null, workspaces: {} }) as RecordingsFile;

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
