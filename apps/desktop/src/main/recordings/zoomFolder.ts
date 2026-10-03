/**
 * What a Zoom local recording folder looks like, as tables (lane M4).
 *
 * Zoom writes one folder per recording session under the recordings root. The shapes below
 * are ASSUMPTIONS until Codex's listing of a real test recording confirms them, which is why
 * they are data rather than code: a correction is a row, and `zoomFolder.test.ts` holds each
 * row to the listing it was written from.
 *
 *   A1. The folder is named `YYYY-MM-DD HH.MM.SS <topic>[ <meeting number>]`, in the Mac's
 *       local time, at the moment recording started. The meeting number, when present, is
 *       9–11 digits at the end. A name that does not parse falls back to the folder's own
 *       creation time (its `birthtime`, read from the root's listing, never from inside it).
 *   A2. Before conversion the folder holds `*.zoom` files (`double_click_to_convert_01.zoom`).
 *       Conversion removes them and writes `*.mp4` (video) and `audio*.m4a` (the mixed audio).
 *   A3. With "Record a separate audio file of each participant" on, an `Audio Record/`
 *       sub-folder holds one `*.m4a` per participant, named from the participant's display
 *       name (`audioJohnSmith11234567890.m4a`).
 *   A4. A pause/resume, or stop/start, adds files (further `audio*.m4a`, further per-participant
 *       files) to the same folder, or a new folder. Each folder is processed on its own; inside
 *       one, a participant's files are its segments in time order.
 *   A5. Anything else (`playback.m3u`, `chat.txt`, `recording.conf`, `.DS_Store`) is ignored and
 *       never read. Video is never read or uploaded.
 *   A6. A file still being written has a temporary name (`*.tmp`, `*.part`) or a size that moves
 *       between two scans.
 */

/** A role is what the importer does with a file; only `participant_audio` and `mixed_audio` are ever read. */
export type FileRole = 'pending_conversion' | 'temporary' | 'participant_audio' | 'mixed_audio' | 'video' | 'other';

export interface FileRule {
  readonly pattern: RegExp;
  /** Where the rule applies: the session folder itself, or its per-participant sub-folder. */
  readonly where: 'folder' | 'participants' | 'anywhere';
  readonly role: FileRole;
}

/** The per-participant sub-folder (A3). Compared case-insensitively. */
export const PARTICIPANT_FOLDER_NAMES: readonly string[] = Object.freeze(['audio record']);

/** First match wins. Names are compared lower-cased. */
export const FILE_RULES: readonly FileRule[] = Object.freeze([
  { pattern: /^\.ds_store$/u, where: 'anywhere', role: 'other' },
  { pattern: /^\._/u, where: 'anywhere', role: 'other' },
  { pattern: /\.zoom$/u, where: 'anywhere', role: 'pending_conversion' },
  { pattern: /\.(tmp|temp|part|partial|download)$/u, where: 'anywhere', role: 'temporary' },
  { pattern: /\.(mp4|mov|m4v)$/u, where: 'anywhere', role: 'video' },
  { pattern: /\.m4a$/u, where: 'participants', role: 'participant_audio' },
  { pattern: /^audio.*\.m4a$/u, where: 'folder', role: 'mixed_audio' },
  { pattern: /.*/u, where: 'anywhere', role: 'other' },
]);

export function roleOf(name: string, where: 'folder' | 'participants'): FileRole {
  const lower = name.toLowerCase();
  for (const rule of FILE_RULES) {
    if (rule.where !== 'anywhere' && rule.where !== where) continue;
    if (rule.pattern.test(lower)) return rule.role;
  }
  return 'other';
}

const FOLDER_NAME = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})\.(\d{2})\.(\d{2})(?: (.*?))?$/u;
const MEETING_NUMBER = /^(.*?)\s*(\d{9,11})$/u;

export interface ParsedFolderName {
  /** The local wall-clock start, as an instant on this Mac. */
  readonly startedAt: Date;
  readonly topic: string | null;
}

/** A1. Null when the name is not Zoom's shape (the caller falls back to the folder's creation time). */
export function parseFolderName(name: string): ParsedFolderName | null {
  const match = FOLDER_NAME.exec(name);
  if (match === null) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const startedAt = new Date(year, month - 1, day, hour, minute, second);
  // A date that rolled over (2026-02-31) is not a Zoom name.
  if (
    Number.isNaN(startedAt.getTime()) ||
    startedAt.getFullYear() !== year ||
    startedAt.getMonth() !== month - 1 ||
    startedAt.getDate() !== day ||
    startedAt.getHours() !== hour ||
    startedAt.getMinutes() !== minute
  ) {
    return null;
  }
  const rest = (match[7] ?? '').trim();
  const withoutNumber = MEETING_NUMBER.exec(rest);
  const topic = (withoutNumber === null ? rest : (withoutNumber[1] ?? '')).trim();
  return { startedAt, topic: topic === '' ? null : topic };
}

/** One file of a candidate folder, from its listing and `stat` (never its bytes). */
export interface FolderFile {
  /** Relative to the session folder: `audio123.m4a`, `Audio Record/audioJohnSmith1.m4a`. */
  readonly relPath: string;
  readonly name: string;
  readonly role: FileRole;
  readonly sizeBytes: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly birthtimeMs: number;
}

/** The files to upload (E5): the per-participant ones, or the mixed audio when there are none. */
export function audioFilesOf(files: readonly FolderFile[]): readonly FolderFile[] {
  const participants = files.filter(file => file.role === 'participant_audio');
  return participants.length > 0 ? participants : files.filter(file => file.role === 'mixed_audio');
}

/** A participant's key across segments: the name's letters, without Zoom's `audio` prefix and trailing number. */
export function participantKeyOf(file: Pick<FolderFile, 'name' | 'role'>): string {
  if (file.role === 'mixed_audio') return 'mixed';
  const stem = file.name.replace(/\.m4a$/iu, '').replace(/^audio/iu, '').replace(/\d+$/u, '');
  const letters = stem.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').toLowerCase().replace(/[^a-z0-9]+/gu, '');
  return letters === '' ? file.name.toLowerCase() : letters;
}

/** A4. Each participant's files in time order, numbered from 1: the segment the server records. */
export function segmentsOf(files: readonly FolderFile[]): ReadonlyMap<string, number> {
  const byParticipant = new Map<string, FolderFile[]>();
  for (const file of files) {
    const key = participantKeyOf(file);
    byParticipant.set(key, [...(byParticipant.get(key) ?? []), file]);
  }
  const segments = new Map<string, number>();
  for (const group of byParticipant.values()) {
    const ordered = [...group].sort((left, right) => left.birthtimeMs - right.birthtimeMs || left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
    ordered.forEach((file, index) => segments.set(file.relPath, index + 1));
  }
  return segments;
}

/** The identity the store keys a folder's state by: each audio file's path, inode, size and mtime. */
export function identityOf(files: readonly FolderFile[]): string {
  return audioFilesOf(files)
    .map(file => `${file.relPath}:${String(file.ino)}:${String(file.sizeBytes)}:${String(Math.trunc(file.mtimeMs))}`)
    .sort()
    .join('|');
}

/** The listing's signature for the stability check (A6): every file, not only the audio. */
export function signatureOf(files: readonly FolderFile[]): string {
  return files
    .map(file => `${file.relPath}:${String(file.sizeBytes)}:${String(Math.trunc(file.mtimeMs))}`)
    .sort()
    .join('|');
}

/** Two scans this far apart with the same signature are "stable" (A6). */
export const STABLE_AFTER_MS = 20_000;

export type Readiness =
  | { readonly ready: true; readonly audio: readonly FolderFile[] }
  | { readonly ready: false; readonly why: 'converting' | 'writing' | 'no_audio_yet' }
  | { readonly ready: false; readonly why: 'no_audio' };

/**
 * Whether a folder may be uploaded: no `.zoom` or temporary file, audio present (per
 * participant, or the mixed file when there are none) and non-empty, and the listing the
 * same as at a scan at least `STABLE_AFTER_MS` earlier. A converted, stable folder with no
 * audio at all is `no_audio`: video is never read to make some.
 */
export function readinessOf(
  files: readonly FolderFile[],
  previous: { readonly signature: string; readonly atMs: number } | null,
  nowMs: number,
): Readiness {
  if (files.some(file => file.role === 'pending_conversion')) return { ready: false, why: 'converting' };
  if (files.some(file => file.role === 'temporary')) return { ready: false, why: 'writing' };
  const stable = previous !== null && previous.signature === signatureOf(files) && nowMs - previous.atMs >= STABLE_AFTER_MS;
  const audio = audioFilesOf(files);
  if (audio.length === 0) return stable ? { ready: false, why: 'no_audio' } : { ready: false, why: 'no_audio_yet' };
  if (audio.some(file => file.sizeBytes === 0) || !stable) return { ready: false, why: 'writing' };
  return { ready: true, audio };
}
