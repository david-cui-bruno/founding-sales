import { createHash } from 'node:crypto';
import { createReadStream, watch as watchPath, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { request } from 'node:https';
import { join } from 'node:path';
import { open } from 'node:fs/promises';
import { sniffAudio, type SniffVerdict } from './audioSniff.ts';
import { PARTICIPANT_FOLDER_NAMES, roleOf, type FolderFile } from './zoomFolder.ts';

/**
 * The file system and the upload, as the importer reaches them (lane M4). Ports, so the tests
 * can count every path the importer touched: the privacy rule is that a folder overlapping no
 * Callie meeting is never listed (`listFolder`), never hashed and never uploaded — only its
 * name and its own `stat` from the root's listing (`listRoot`, `statFolder`) are ever read.
 */

export interface RootFolder {
  readonly name: string;
  readonly path: string;
  /** The folder's own creation time: the start time when its name does not parse. */
  readonly birthtimeMs: number;
}

export interface RecordingFs {
  /** The session folders directly under the root: names and their own stat, nothing inside. */
  listRoot(root: string): Promise<readonly RootFolder[]>;
  /** One folder's own stat (a manually chosen one), or null when it is not a folder. */
  statFolder(path: string): Promise<RootFolder | null>;
  /** Everything inside a CANDIDATE folder and its per-participant sub-folder: names and stats. */
  listFolder(path: string): Promise<readonly FolderFile[]>;
  /** One audio file's identity now, to check it did not change since it was listed. */
  statFile(path: string): Promise<{ readonly sizeBytes: number; readonly ino: number; readonly mtimeMs: number } | null>;
  /** Whether the file is an audio-only MP4/M4A, from its box headers (`audioSniff.ts`). */
  sniff(path: string): Promise<SniffVerdict>;
  /** The SHA-256 of one audio file, streamed. */
  sha256(path: string): Promise<string>;
  /** Watch the root (recursively, on macOS); `onChange` is debounced by the caller. */
  watch(root: string, onChange: () => void): (() => void) | null;
}

export type PutOutcome = { readonly ok: true } | { readonly ok: false; readonly status: number | null };

export interface RecordingUploader {
  /** One PUT of the whole file to the presigned URL, with exactly the signed headers. */
  /** `signal`: the import's turn was abandoned (a sign-out): the request is dropped at once. */
  put(url: string, headers: Readonly<Record<string, string>>, path: string, signal?: AbortSignal): Promise<PutOutcome>;
}

/** The longest a single file's PUT may take before it counts as interrupted. */
export const PUT_TIMEOUT_MS = 15 * 60 * 1000;

export const nodeRecordingFs: RecordingFs = {
  async listRoot(root) {
    const entries = await readdir(root, { withFileTypes: true });
    const folders: RootFolder[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const path = join(root, entry.name);
      try {
        const info = await stat(path);
        folders.push({ name: entry.name, path, birthtimeMs: info.birthtimeMs });
      } catch {
        // Gone between the listing and the stat: the next scan sees what is there.
      }
    }
    return folders;
  },
  async statFolder(path) {
    try {
      const info = await stat(path);
      return info.isDirectory() ? { name: path.split('/').at(-1) ?? path, path, birthtimeMs: info.birthtimeMs } : null;
    } catch {
      return null;
    }
  },
  async listFolder(path) {
    const files: FolderFile[] = [];
    const add = async (directory: string, prefix: string, where: 'folder' | 'participants'): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (where === 'folder' && PARTICIPANT_FOLDER_NAMES.includes(entry.name.toLowerCase())) {
            await add(full, `${prefix}${entry.name}/`, 'participants');
          }
          continue;
        }
        if (!entry.isFile()) continue;
        const info = await stat(full);
        files.push({
          relPath: `${prefix}${entry.name}`,
          name: entry.name,
          role: roleOf(entry.name, where),
          sizeBytes: info.size,
          ino: info.ino,
          mtimeMs: info.mtimeMs,
          birthtimeMs: info.birthtimeMs,
        });
      }
    };
    await add(path, '', 'folder');
    return files;
  },
  async statFile(path) {
    try {
      const info = await stat(path);
      return { sizeBytes: info.size, ino: info.ino, mtimeMs: info.mtimeMs };
    } catch {
      return null;
    }
  },
  async sniff(path) {
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(path, 'r');
      const opened = handle;
      const { size } = await opened.stat();
      return await sniffAudio({
        size,
        read: async (offset, length) => {
          const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
          const { bytesRead } = await opened.read(buffer, 0, buffer.length, offset);
          return buffer.subarray(0, bytesRead);
        },
      });
    } catch {
      return 'unreadable';
    } finally {
      await handle?.close().catch(() => undefined);
    }
  },
  async sha256(path) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest('hex');
  },
  watch(root, onChange) {
    let watcher: FSWatcher;
    try {
      watcher = watchPath(root, { recursive: true, persistent: false }, () => {
        onChange();
      });
    } catch {
      return null;
    }
    watcher.on('error', () => undefined);
    return () => {
      watcher.close();
    };
  },
};

/** The PUT over `node:https`, the file streamed with its exact length (S3 takes no chunked PUT). */
export const httpsRecordingUploader: RecordingUploader = {
  async put(url, headers, path, signal) {
    const target = new URL(url);
    if (target.protocol !== 'https:' || signal?.aborted === true) return { ok: false, status: null };
    return await new Promise<PutOutcome>(resolve => {
      const outgoing = request(target, { method: 'PUT', headers: { ...headers }, timeout: PUT_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) }, response => {
        response.resume();
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          resolve(status >= 200 && status < 300 ? { ok: true } : { ok: false, status });
        });
        response.on('error', () => {
          resolve({ ok: false, status: null });
        });
      });
      outgoing.on('timeout', () => {
        outgoing.destroy(new Error('timeout'));
      });
      outgoing.on('error', () => {
        resolve({ ok: false, status: null });
      });
      const body = createReadStream(path);
      body.on('error', () => {
        outgoing.destroy(new Error('read'));
      });
      body.pipe(outgoing);
    });
  },
};
