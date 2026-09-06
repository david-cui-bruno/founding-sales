import { createHash } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdtempSync,
  openSync, readSync, rmSync, writeFileSync, type Stats,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';

import type { WorkspaceKey } from '../security/workspaceKeyTypes';
import { applyWorkspaceKey, createRawDatabase, type RawDatabase } from './sqliteDriver';

// Operational contract, NOT the moving application schema. A future schema16
// merge must not silently authorize a new audit target or weaken this catalog.
const EXPECTED_CURRENT_SCHEMA = 15;
const SCHEMA15_CATALOG_SHA256 = 'd888ea664cf61ff8e5404f3542f1d615d1c9b08ecf77612690236fd192e535a8';
const SCHEMA15_LEDGER = Object.freeze([
  '0001Foundation', '0002DomainFoundation', '0003Transcripts', '0004Learnings',
  '0005SourcingChannels', '0006SourcingState', '0007SourcingOutbox',
  '0008DedupeCloudPersons', '0009SourcingFileLedger', '0010NoDueDates',
  '0011ContactDncFlags', '0012UpstreamRequestState', '0013ContactComplianceEvidence',
  '0014OutboundJurisdictionClearance', '0015RecoveryMetadata',
]);

export type ReadOnlyAuditInput = {
  beforeDatabasePath: string;
  currentDatabasePath: string;
  key: WorkspaceKey;
  temporaryParent: string;
};
export type RetainedPrivateInput = {
  path: string;
  descriptor: number;
  bytes: Buffer;
  sha256: string;
  assertUnchanged(): void;
  close(): void;
};

export const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const fail = (): never => { throw new Error('Identity audit input is not a private immutable snapshot.'); };
const sameFile = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
const owned = (stat: Stats) => stat.uid === process.getuid?.();

/** Require explicit canonical absolute paths and no symlink in any component. */
export function assertPrivateDirectory(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || path.trim() !== path) fail();
  let cursor = parse(path).root;
  for (const component of path.slice(cursor.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    const stat = lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
    // System-owned sticky temp roots are safe ancestors, never the private parent.
    if ((stat.mode & 0o022) !== 0 && !((stat.mode & 0o1000) !== 0 && stat.uid === 0)) fail();
  }
  const stat = lstatSync(path);
  if (!owned(stat) || (stat.mode & 0o777) !== 0o700) fail();
}

function validatePrivateFile(path: string): Stats {
  if (!isAbsolute(path) || resolve(path) !== path || path.trim() !== path) fail();
  assertPrivateDirectory(dirname(path));
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || !owned(stat)
    || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) fail();
  return stat;
}

function readDescriptor(descriptor: number): Buffer {
  const bytes = Buffer.alloc(fstatSync(descriptor).size);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (count === 0) { bytes.fill(0); fail(); }
    offset += count;
  }
  return bytes;
}

export function openPrivateInput(path: string): RetainedPrivateInput {
  const original = validatePrivateFile(path);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer | undefined;
  try {
    const identity = fstatSync(descriptor);
    if (!sameFile(original, identity)) fail();
    bytes = readDescriptor(descriptor);
    const digest = sha256(bytes);
    let closed = false;
    const input: RetainedPrivateInput = {
      path, descriptor, bytes, sha256: digest,
      assertUnchanged() {
        const current = validatePrivateFile(path);
        const retained = fstatSync(descriptor);
        if (!sameFile(identity, current) || !sameFile(identity, retained)
          || current.size !== identity.size || current.mtimeMs !== identity.mtimeMs
          || current.ctimeMs !== identity.ctimeMs) fail();
        const now = readDescriptor(descriptor);
        try { if (sha256(now) !== digest) fail(); } finally { now.fill(0); }
      },
      close() { if (!closed) { closed = true; bytes?.fill(0); closeSync(descriptor); } },
    };
    input.assertUnchanged();
    return input;
  } catch (error) { bytes?.fill(0); closeSync(descriptor); throw error; }
}

function assertNoSidecars(path: string): void {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { lstatSync(path + suffix); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    fail();
  }
}

function openReadOnly(path: string, bytes: Buffer, key: WorkspaceKey): RawDatabase {
  if (bytes.subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))) fail();
  const raw = createRawDatabase(path, { readonly: true, fileMustExist: true });
  try {
    raw.pragma('query_only = ON');
    raw.pragma('temp_store = MEMORY');
    raw.pragma('foreign_keys = ON');
    raw.pragma('recursive_triggers = ON');
    raw.pragma('busy_timeout = 5000');
    applyWorkspaceKey(raw, key.bytes);
    if (!raw.readonly || raw.inTransaction || raw.pragma('query_only', { simple: true }) !== 1
      || raw.pragma('cipher', { simple: true }) !== 'sqlcipher'
      || String(raw.pragma('legacy', { simple: true })) !== '4'
      || raw.pragma('integrity_check', { simple: true }) !== 'ok'
      || (raw.pragma('foreign_key_check') as unknown[]).length !== 0
      || raw.pragma('foreign_keys', { simple: true }) !== 1
      || raw.pragma('recursive_triggers', { simple: true }) !== 1
      || raw.pragma('busy_timeout', { simple: true }) !== 5000) fail();
    const version = raw.prepare('SELECT sqlite3mc_version() AS version').get() as { version: unknown };
    if (typeof version.version !== 'string' || !version.version) fail();
    return raw;
  } catch (error) { raw.close(); throw error; }
}

function schemaVersion(raw: RawDatabase): number {
  const rows = raw.prepare('SELECT singleton, schema_version FROM app_meta').all() as Array<{ singleton: number; schema_version: number }>;
  if (rows.length !== 1 || rows[0].singleton !== 1 || !Number.isInteger(rows[0].schema_version)) fail();
  return rows[0].schema_version;
}

/** All schema15 load-bearing names AND SQL are covered by the frozen digest. */
function assertCurrentSchema15(raw: RawDatabase): void {
  if (schemaVersion(raw) !== EXPECTED_CURRENT_SCHEMA) fail();
  const ledger = raw.prepare('SELECT name FROM kysely_migration ORDER BY timestamp, name').all() as { name: string }[];
  if (JSON.stringify(ledger.map(row => row.name)) !== JSON.stringify(SCHEMA15_LEDGER)) fail();
  const catalog = raw.prepare(`SELECT name, type, sql FROM sqlite_master
    WHERE type IN ('table', 'index', 'trigger') AND (type <> 'index' OR sql IS NOT NULL)
    ORDER BY name COLLATE BINARY`).all() as { name: string; type: string; sql: string | null }[];
  const fingerprint = catalog.map(row => [row.type, row.name, (row.sql ?? '').replace(/\s+/g, ' ').trim()])
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
  if (sha256(JSON.stringify(fingerprint)) !== SCHEMA15_CATALOG_SHA256) fail();
  const fts = raw.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled").get() as { enabled: number };
  if (fts.enabled !== 1) fail();
}

/**
 * Owns and zeroes key bytes on every exit. No source pathname is passed to
 * SQLite. macOS retained-descriptor opens cannot create source sidecars.
 * This intentionally rejects WAL/active snapshots rather than checkpointing
 * them. Only closed self-contained encrypted snapshots are audit inputs.
 */
export function withReadOnlyEncryptedDatabases<T>(input: ReadOnlyAuditInput, read: (databases: {
  before: RawDatabase; current: RawDatabase;
  beforeDatabaseSha256: string; currentDatabaseSha256: string;
}) => T): T {
  const sources: RetainedPrivateInput[] = [];
  const opened: RawDatabase[] = [];
  let temporary: string | undefined;
  try {
    assertPrivateDirectory(input.temporaryParent);
    const parentIdentity = lstatSync(input.temporaryParent);
    for (const path of [input.currentDatabasePath, input.beforeDatabasePath]) {
      assertNoSidecars(path);
      sources.push(openPrivateInput(path));
    }
    const [currentSource, beforeSource] = sources;
    if (sameFile(fstatSync(currentSource.descriptor), fstatSync(beforeSource.descriptor))) fail();
    const currentGuard = openReadOnly(`/dev/fd/${currentSource.descriptor}`, currentSource.bytes, input.key);
    opened.push(currentGuard);
    assertCurrentSchema15(currentGuard);
    const beforeGuard = openReadOnly(`/dev/fd/${beforeSource.descriptor}`, beforeSource.bytes, input.key);
    opened.push(beforeGuard);
    const beforeVersion = schemaVersion(beforeGuard);
    if (beforeVersion < 1 || beforeVersion >= 8) fail();
    const ledger = beforeGuard.prepare('SELECT name FROM kysely_migration ORDER BY timestamp, name').all() as { name: string }[];
    if (JSON.stringify(ledger.map(row => row.name)) !== JSON.stringify(SCHEMA15_LEDGER.slice(0, beforeVersion))) fail();
    for (const source of sources) { source.assertUnchanged(); assertNoSidecars(source.path); }
    assertPrivateDirectory(input.temporaryParent);
    if (!sameFile(parentIdentity, lstatSync(input.temporaryParent))) fail();
    // This is the FIRST disk creation, after both immutable input guards.
    temporary = mkdtempSync(join(input.temporaryParent, '.identity-audit-'));
    const copies = [beforeSource, currentSource].map((source, index) => {
      const path = join(temporary as string, `${index}.db`);
      writeFileSync(path, source.bytes, { flag: 'wx', mode: 0o600 });
      const raw = openReadOnly(path, source.bytes, input.key);
      opened.push(raw);
      return raw;
    });
    assertCurrentSchema15(copies[1]);
    const result = read({ before: copies[0], current: copies[1],
      beforeDatabaseSha256: beforeSource.sha256, currentDatabaseSha256: currentSource.sha256 });
    for (const source of sources) { source.assertUnchanged(); assertNoSidecars(source.path); }
    return result;
  } finally {
    try {
      for (const raw of opened.reverse()) if (raw.open) raw.close();
      if (temporary !== undefined) rmSync(temporary, { recursive: true, force: true });
    } finally {
      input.key.bytes.fill(0);
      try { for (const source of sources) source.assertUnchanged(); }
      finally { for (const source of sources) source.close(); }
    }
  }
}

/** Exclusive publication, never overwrites an input or an existing manifest. */
export function writePrivateManifest(path: string, content: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || path.trim() !== path) fail();
  assertPrivateDirectory(dirname(path));
  const parent = lstatSync(dirname(path));
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const identity = fstatSync(descriptor);
  try {
    if (!sameFile(parent, lstatSync(dirname(path)))) fail();
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
    if (!sameFile(identity, validatePrivateFile(path))) fail();
  } catch (error) {
    if (sameFile(identity, lstatSync(path))) rmSync(path);
    throw error;
  } finally { closeSync(descriptor); }
}

export function parseExplicitPaths(argv: string[], flags: readonly string[]): Record<string, string> {
  if (argv.length !== flags.length * 2) fail();
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]; const value = argv[index + 1];
    if (!flags.includes(flag) || Object.hasOwn(values, flag) || !isAbsolute(value)
      || resolve(value) !== value || value.trim() !== value) fail();
    values[flag] = value;
  }
  return values;
}
