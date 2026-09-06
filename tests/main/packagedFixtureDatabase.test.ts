import { ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, openDatabase } from '../../src/main/db/database';
import * as migrations from '../../src/main/db/migrate';
import * as driver from '../../src/main/db/sqliteDriver';
import { OperationalSafetyRepository } from '../../src/main/domain/operations/operationalSafetyRepository';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { BackupService } from '../../src/main/backup/backupService';
import * as keys from '../../src/main/security/recoveryKey';
import { createTestWorkspaceKey } from '../fixtures/tempDatabase';
import type { allocatePackagedFixtureDatabase } from '../support/packagedFixtureDatabase';

vi.mock('node:fs', async original => ({ ...await original<typeof fs>() }));
type Fixture = ReturnType<typeof allocatePackagedFixtureDatabase>;
const ERROR = /^PACKAGED_FIXTURE_DATABASE_FAILED$/;
const TIME = '2026-09-06T12:00:00.000Z';
// Opaque unit-fixture bytes only. NOT a safeStorage or packaged-app envelope.
const OPAQUE_ENVELOPE = Buffer.from('opaque synthetic envelope, not usable by Electron');
const digest = (path: string) => createHash('sha256').update(fs.readFileSync(path)).digest('hex');
const materialFor = (byte = 0x2a) => {
  const key = createTestWorkspaceKey(byte);
  try { return keys.createRecoveryKeyMaterial(key); } finally { key.bytes.fill(0); }
};

// Genuine SQLCipher source fixtures, never packaged/native acceptance.
describe('bounded packaged fixture database preparation', () => {
  let f: Fixture;
  let material: string;
  beforeEach(async () => {
    const modulePath = '../support/packagedFixtureDatabase';
    const module = await import(/* @vite-ignore */ modulePath).catch(() => ({}));
    expect(module.allocatePackagedFixtureDatabase, 'owned fixture helper is required').toBeTypeOf('function');
    f = module.allocatePackagedFixtureDatabase();
    material = materialFor();
  });
  afterEach(async () => { vi.restoreAllMocks(); if (f) await f.cleanup(); });
  const dbPath = (profile: 'bootstrap' | 'current' | 'historical') => join(f.paths[profile], 'callie.sqlite3');
  const envelopePath = (profile: 'bootstrap' | 'current' | 'historical') => join(f.paths[profile], 'callie.key-envelope.json');
  async function seed(profile: 'bootstrap' | 'current', nonzero = false, byte = 0x2a) {
    const key = createTestWorkspaceKey(byte);
    fs.writeFileSync(dbPath(profile), '', { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(envelopePath(profile), OPAQUE_ENVELOPE, { flag: 'wx', mode: 0o600 });
    const database = openDatabase({ path: dbPath(profile), key });
    try {
      await migrations.migrateToLatest(database, { workspaceKey: key, backupDirectory: join(f.paths[profile], 'backups') });
      if (nonzero) {
        database.raw.prepare('INSERT INTO persons(id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('p1', 'SYNTHETIC PRIVATE NAME', TIME, TIME);
        database.raw.prepare('INSERT INTO source_events(id, person_id, channel, observed_at, source_record_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('s1', 'p1', 'custom', TIME, '{"synthetic":"body"}', TIME);
        database.raw.prepare('INSERT INTO prospects(id, person_id, original_source_event_id, segment, qualification_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('pr1', 'p1', 's1', 'warm', 'unreviewed', TIME, TIME);
      }
    } finally { closeDatabase(database); key.bytes.fill(0); }
  }
  const identity = (path: string) => {
    const stat = fs.lstatSync(path);
    return { ino: stat.ino, dev: stat.dev, size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode, hash: digest(path) };
  };
  const residue = () => fs.readdirSync(f.paths.inspection);
  function observeResources() {
    const parsed: Buffer[] = []; const opened: driver.RawDatabase[] = [];
    const parse = keys.parseRecoveryKeyMaterial; const open = driver.createRawDatabase;
    vi.spyOn(keys, 'parseRecoveryKeyMaterial').mockImplementation(value => {
      const key = parse(value); parsed.push(key.bytes); return key;
    });
    const openRecorded = (path: string, options?: driver.RawDatabaseOpenOptions) => {
      const raw = open(path, options); opened.push(raw); return raw;
    };
    vi.spyOn(driver, 'createRawDatabase').mockImplementation(openRecorded);
    return { parsed, opened, open: openRecorded, assertReleased() {
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed.every(bytes => bytes.equals(Buffer.alloc(32)))).toBe(true);
      expect(opened.every(raw => !raw.open)).toBe(true);
    } };
  }

  it('owns fresh private canonical fixed paths, never accepts a root override, and cleans only its own root', async () => {
    expect(fs.realpathSync(f.paths.root)).toBe(f.paths.root);
    expect(f.paths.root.startsWith(process.cwd() + sep)).toBe(false);
    expect(Object.isFrozen(f.paths)).toBe(true);
    for (const name of ['bootstrap', 'current', 'exports', 'inspection'] as const) {
      expect(relative(f.paths.root, f.paths[name]).startsWith('..')).toBe(false);
      expect(fs.lstatSync(f.paths[name]).mode & 0o777).toBe(0o700);
    }
    expect(fs.existsSync(f.paths.historical)).toBe(false);
    const modulePath = '../support/packagedFixtureDatabase';
    const module = await import(/* @vite-ignore */ modulePath);
    expect(() => module.allocatePackagedFixtureDatabase(f.paths.exports)).toThrow(ERROR);
    const other = module.allocatePackagedFixtureDatabase();
    try {
      expect(other.paths.root).not.toBe(f.paths.root);
      await f.cleanup(); await f.cleanup();
      expect(fs.existsSync(f.paths.root)).toBe(false);
      expect(fs.existsSync(other.paths.root)).toBe(true);
      await expect(f.inspectStoppedProfile('current', material, 16)).rejects.toThrow(ERROR);
    } finally { await other.cleanup(); }
  });

  it('inspects a normal closed WAL source only through a private encrypted readonly copy and removes copy-side WAL before return', async () => {
    await seed('current', true);
    const before = identity(dbPath('current')); const envelope = identity(envelopePath('current'));
    const resources = observeResources(); const open = resources.open;
    const seen: string[] = [];
    vi.spyOn(driver, 'createRawDatabase').mockImplementation((path, options) => {
      expect(path.startsWith(f.paths.inspection + sep)).toBe(true);
      expect(options).toEqual({ readonly: true, fileMustExist: true });
      expect(digest(path)).toBe(before.hash);
      expect(fs.lstatSync(path).mode & 0o777).toBe(0o600);
      expect(fs.lstatSync(join(path, '..')).mode & 0o777).toBe(0o700);
      seen.push(path);
      const raw = open(path, options);
      const pragma = raw.pragma.bind(raw);
      vi.spyOn(raw, 'pragma').mockImplementation((sql, options) => {
        expect(sql).not.toMatch(/checkpoint|journal_mode\s*=/i);
        return pragma(sql, options);
      });
      const close = raw.close.bind(raw);
      vi.spyOn(raw, 'close').mockImplementation(() => {
        expect(raw.readonly).toBe(true);
        expect(raw.pragma('query_only', { simple: true })).toBe(1);
        expect(() => raw.exec('DELETE FROM persons')).toThrow();
        return close();
      });
      return raw;
    });
    const result = await f.inspectStoppedProfile('current', material, 16);
    expect(result.aggregateCounts).toEqual({ people: 1, prospects: 1, sourceEvents: 1 });
    expect(result.schemaVersion).toBe(16);
    expect(result.ledger).toHaveLength(16);
    expect(result.ledger.at(-1)).toBe('0016ContactPresentationEvidence');
    expect(result.businessSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toMatch(/SYNTHETIC PRIVATE NAME|synthetic|CALLIE1-/);
    expect(seen).toHaveLength(1); expect(seen.every(path => !fs.existsSync(path))).toBe(true);
    expect(identity(dbPath('current'))).toEqual(before);
    expect(identity(envelopePath('current'))).toEqual(envelope);
    expect(['-wal', '-shm', '-journal'].some(suffix => fs.existsSync(dbPath('current') + suffix))).toBe(false);
    expect(residue()).toEqual([]); resources.assertReleased();
  });

  it.each(['wrong', 'malformed', 'checksum', 'version'])('rejects %s supplied material with no source mutation or inspection residue', async kind => {
    await seed('current', true); const before = identity(dbPath('current'));
    const resources = observeResources();
    const value = kind === 'wrong' ? materialFor(0x55) : kind === 'malformed' ? 'invalid' : kind === 'version' ? material.replace('CALLIE1', 'CALLIE2') : material.slice(0, -1) + (material.endsWith('0') ? '1' : '0');
    await expect(f.inspectStoppedProfile('current', value, 16)).rejects.toThrow(ERROR);
    expect(identity(dbPath('current'))).toEqual(before); expect(residue()).toEqual([]);
    if (kind === 'wrong') { expect(resources.opened).toHaveLength(1); resources.assertReleased(); }
    else expect(resources.opened).toHaveLength(0);
  });

  it.each(['-wal', '-shm', '-journal'])('rejects existing source %s before copying or opening SQLite', async suffix => {
    await seed('current'); fs.writeFileSync(dbPath('current') + suffix, 'stopped-source-conflict', { mode: 0o600 });
    const open = vi.spyOn(driver, 'createRawDatabase'); const copy = vi.spyOn(fs, 'mkdtempSync');
    await expect(f.inspectStoppedProfile('current', material, 16)).rejects.toThrow(ERROR);
    expect(open).not.toHaveBeenCalled(); expect(copy).not.toHaveBeenCalled(); expect(residue()).toEqual([]);
    expect(fs.readFileSync(dbPath('current') + suffix, 'utf8')).toBe('stopped-source-conflict');
  });

  it.each(['missing', 'symlink', 'hardlink', 'mode', 'oversize', 'ancestor'])('rejects %s input before creating inspection artifacts', async kind => {
    await seed('current');
    const path = dbPath('current');
    if (kind === 'missing') fs.unlinkSync(path);
    if (kind === 'symlink') { fs.renameSync(path, path + '.original'); fs.symlinkSync(path + '.original', path); }
    if (kind === 'hardlink') fs.linkSync(path, path + '.alias');
    if (kind === 'mode') fs.chmodSync(path, 0o644);
    if (kind === 'oversize') fs.truncateSync(path, 64 * 1024 * 1024 + 1);
    if (kind === 'ancestor') { fs.renameSync(f.paths.current, f.paths.current + '.original'); fs.symlinkSync(f.paths.current + '.original', f.paths.current); }
    const open = vi.spyOn(driver, 'createRawDatabase');
    await expect(f.inspectStoppedProfile('current', material, 16)).rejects.toThrow(ERROR);
    expect(open).not.toHaveBeenCalled(); expect(residue()).toEqual([]);
  });

  it('rejects escaped or unknown selectors without inspecting outside the captured root', async () => {
    const open = vi.spyOn(driver, 'createRawDatabase');
    await expect(f.inspectStoppedProfile('../current' as 'current', material, 16)).rejects.toThrow(ERROR);
    await expect(f.inspectStoppedBackup('current', '../callie.sqlite3', material, 16)).rejects.toThrow(ERROR);
    await expect(f.inspectStoppedBackup('current', dbPath('current'), material, 16)).rejects.toThrow(ERROR);
    expect(open).not.toHaveBeenCalled(); expect(residue()).toEqual([]);
  });

  it('refuses all offline operations and cleanup while the actual captured Node fixture child is alive, then permits observed exit', async () => {
    await seed('current'); await seed('bootstrap');
    // Tiny Node-only lifetime probe. No inherited env, real HOME, network or app.
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0));'], {
      cwd: f.paths.root, env: { HOME: f.paths.exports, TMPDIR: f.paths.exports }, stdio: ['pipe', 'ignore', 'ignore'],
    });
    const exited = once(child, 'exit'); f.captureChild(child);
    try {
      await expect(f.inspectStoppedProfile('current', material, 16)).rejects.toThrow(ERROR);
      await expect(f.createManualBackup(material)).rejects.toThrow(ERROR);
      await expect(f.captureBootstrapEnvelope()).rejects.toThrow(ERROR);
      await expect(f.createHistoricalProfile(material)).rejects.toThrow(ERROR);
      await expect(f.cleanup()).rejects.toThrow(ERROR);
      expect(fs.existsSync(f.paths.root)).toBe(true);
      expect(() => f.captureChild(child)).toThrow(ERROR);
    } finally { child.stdin!.end(); await exited; }
    expect((await f.inspectStoppedProfile('current', material, 16)).schemaVersion).toBe(16);
    expect(() => f.captureChild({ exitCode: 0 } as ChildProcess)).toThrow(ERROR);
    await f.cleanup(); expect(fs.existsSync(f.paths.root)).toBe(false);
  });

  it('creates a real manual nonzero encrypted backup and repository receipt without changing business data', async () => {
    await seed('current', true);
    const before = await f.inspectStoppedProfile('current', material, 16);
    const envelope = identity(envelopePath('current'));
    const resources = observeResources(); const create = vi.spyOn(BackupService.prototype, 'createBackup');
    const result = await f.createManualBackup(material);
    expect(create).toHaveBeenCalledWith('manual');
    expect(result.backup.kind).toBe('manual'); expect(result.backup.schemaVersion).toBe(16);
    expect(result.backup.sha256).toBe(digest(result.backup.path));
    expect(fs.readFileSync(result.backup.path).subarray(0, 16).equals(Buffer.from('SQLite format 3\0'))).toBe(false);
    expect(result.inspection.aggregateCounts).toEqual({ people: 1, prospects: 1, sourceEvents: 1 });
    expect(result.inspection.businessSha256).toBe(before.businessSha256);
    const after = await f.inspectStoppedProfile('current', material, 16);
    expect(after.businessSha256).toBe(before.businessSha256);
    expect(after.backupReceipts).toHaveLength(1);
    expect(after.backupReceipts[0]).toMatchObject({ backup_basename: result.backup.basename, sha256: result.backup.sha256, kind: 'manual', schema_version: 16, size_bytes: result.backup.sizeBytes });
    expect(identity(envelopePath('current'))).toEqual(envelope); resources.assertReleased();
    // Persisted drill metadata via the real repository, not fabricated receipt SQL.
    const key = createTestWorkspaceKey(); const database = openDatabase({ path: dbPath('current'), key });
    try {
      const unitOfWork = new DomainUnitOfWork(database);
      const repository = new OperationalSafetyRepository({ database, unitOfWork });
      unitOfWork.immediate(() => repository.recordRestoreDrill({ performedAt: TIME, backupSha256: result.backup.sha256 }));
      expect(() => database.raw.exec('DELETE FROM backup_receipts')).toThrow();
      expect(() => database.raw.exec('DELETE FROM restore_drill_receipts')).toThrow();
      database.raw.prepare('INSERT INTO persons(id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('p2', 'EXTRA SYNTHETIC', TIME, TIME);
    } finally { closeDatabase(database); key.bytes.fill(0); }
    const live = await f.inspectStoppedProfile('current', material, 16);
    const backup = await f.inspectStoppedBackup('current', result.backup.basename, material, 16);
    expect(live.drillReceipts).toEqual([{ performed_at: TIME, backup_receipt_id: after.backupReceipts[0].id, backup_sha256: result.backup.sha256 }]);
    expect(live.aggregateCounts.people).toBe(2); expect(backup.aggregateCounts.people).toBe(1);
    expect(live.businessSha256).not.toBe(backup.businessSha256);
  });

  it('creates only a new genuine through15 database with the explicitly captured opaque synthetic envelope', async () => {
    await seed('bootstrap'); await seed('current', true);
    const bootstrap = identity(dbPath('bootstrap')); const current = identity(dbPath('current')); const envelope = identity(envelopePath('bootstrap'));
    const resources = observeResources();
    await expect(f.createHistoricalProfile(material)).rejects.toThrow(ERROR);
    await f.captureBootstrapEnvelope();
    const result = await f.createHistoricalProfile(material);
    expect(result.schemaVersion).toBe(15); expect(result.ledger).toHaveLength(15);
    expect(result.ledger.at(-1)).toBe('0015RecoveryMetadata');
    expect(result.catalogSha256).toBe('d888ea664cf61ff8e5404f3542f1d615d1c9b08ecf77612690236fd192e535a8');
    expect(result.aggregateCounts).toEqual({ people: 0, prospects: 0, sourceEvents: 0 });
    expect(fs.readFileSync(envelopePath('historical')).equals(OPAQUE_ENVELOPE)).toBe(true);
    expect(identity(dbPath('bootstrap'))).toEqual(bootstrap); expect(identity(dbPath('current'))).toEqual(current);
    expect(identity(envelopePath('bootstrap'))).toEqual(envelope);
    await expect(f.createHistoricalProfile(material)).rejects.toThrow(ERROR);
    await expect(f.inspectStoppedProfile('historical', material, 16)).rejects.toThrow(ERROR);
    resources.assertReleased(); expect(residue()).toEqual([]);
  });

  it.each(['preexisting', 'symlink', 'changed-envelope', 'wrong-key'])('refuses historical %s input without overwriting an existing target or bootstrap', async kind => {
    await seed('bootstrap'); await f.captureBootstrapEnvelope();
    if (kind === 'preexisting') fs.mkdirSync(f.paths.historical, { mode: 0o700 });
    if (kind === 'symlink') fs.symlinkSync(f.paths.current, f.paths.historical);
    if (kind === 'changed-envelope') fs.writeFileSync(envelopePath('bootstrap'), 'changed synthetic envelope');
    const before = identity(dbPath('bootstrap'));
    await expect(f.createHistoricalProfile(kind === 'wrong-key' ? materialFor(0x55) : material)).rejects.toThrow(ERROR);
    expect(identity(dbPath('bootstrap'))).toEqual(before);
    if (kind === 'wrong-key' || kind === 'changed-envelope') expect(fs.existsSync(f.paths.historical)).toBe(false);
    expect(residue()).toEqual([]);
  });

  it.each(['catalog', 'ledger', 'version'])('rejects unsupported %s with fixed safe text and immutable original', async kind => {
    await seed('current');
    const key = createTestWorkspaceKey(); const database = openDatabase({ path: dbPath('current'), key });
    try {
      if (kind === 'catalog') database.raw.exec('CREATE TABLE unrecognized (value TEXT)');
      if (kind === 'ledger') database.raw.exec("DELETE FROM kysely_migration WHERE name = '0016ContactPresentationEvidence'");
      if (kind === 'version') database.raw.exec('UPDATE app_meta SET schema_version = 17');
    } finally { closeDatabase(database); key.bytes.fill(0); }
    const before = identity(dbPath('current')); const resources = observeResources();
    await expect(f.inspectStoppedProfile('current', material, 16)).rejects.toThrow(ERROR);
    await expect(f.createManualBackup(material)).rejects.toThrow(ERROR);
    expect(identity(dbPath('current'))).toEqual(before); expect(residue()).toEqual([]); resources.assertReleased();
  });

  it.each(['open', 'query', 'close', 'cleanup'])('surfaces %s failure safely and releases owned keys/connections without claiming successful inspection', async fault => {
    await seed('current'); const before = identity(dbPath('current')); const resources = observeResources();
    const open = resources.open;
    if (fault === 'cleanup') vi.spyOn(fs, 'rmSync').mockImplementationOnce(() => { throw new Error('private cleanup details'); });
    else vi.spyOn(driver, 'createRawDatabase').mockImplementation((path, options) => {
      if (fault === 'open') throw new Error('private path');
      const raw = open(path, options);
      if (fault === 'query') {
        const prepare = raw.prepare.bind(raw);
        vi.spyOn(raw, 'prepare').mockImplementation(sql => { if (sql.includes('AS people')) throw new Error('private row body'); return prepare(sql); });
      }
      if (fault === 'close') vi.spyOn(raw, 'close').mockImplementationOnce(() => { throw new Error('private close details'); });
      return raw;
    });
    await expect(f.inspectStoppedProfile('current', material, 16)).rejects.toThrow(ERROR);
    expect(identity(dbPath('current'))).toEqual(before); resources.assertReleased();
    if (fault !== 'cleanup') expect(residue()).toEqual([]);
  });

  it('bounds retained descriptor size before allocating or reading even if pathname metadata was smaller', async () => {
    await seed('current');
    const stat = fs.fstatSync;
    vi.spyOn(fs, 'fstatSync').mockImplementationOnce(fd => Object.assign(stat(fd), { size: 64 * 1024 * 1024 + 1 }));
    const read = vi.spyOn(fs, 'readSync');
    await expect(f.inspectStoppedProfile('current', material, 16)).rejects.toThrow(ERROR);
    expect(read).not.toHaveBeenCalled(); expect(residue()).toEqual([]);
  });

  it('uses only explicitly supplied nondefault fixture material and owned files, zeroing every driver key copy', async () => {
    await seed('current', true, 0x67); material = materialFor(0x67);
    const apply = driver.applyWorkspaceKey; const buffers: Buffer[] = [];
    vi.spyOn(driver, 'applyWorkspaceKey').mockImplementation((raw, bytes) => { buffers.push(bytes); return apply(raw, bytes); });
    const open = fs.openSync;
    vi.spyOn(fs, 'openSync').mockImplementation((path, flags, mode) => {
      expect(typeof path === 'string' && path.startsWith(f.paths.root + sep)).toBe(true);
      return open(path, flags, mode);
    });
    const parse = vi.spyOn(keys, 'parseRecoveryKeyMaterial');
    const result = await f.createManualBackup(material);
    expect(result.inspection.aggregateCounts.people).toBe(1);
    expect(parse.mock.calls.every(([value]) => value === material)).toBe(true);
    expect(buffers.length).toBeGreaterThan(1);
    expect(buffers.every(bytes => bytes.equals(Buffer.alloc(32)))).toBe(true);
  });

  it('detects business field changes even when aggregate counts are identical', async () => {
    await seed('current', true);
    const before = await f.inspectStoppedProfile('current', material, 16);
    const key = createTestWorkspaceKey(); const database = openDatabase({ path: dbPath('current'), key });
    try { database.raw.prepare('UPDATE persons SET display_name = ? WHERE id = ?').run('DIFFERENT SYNTHETIC', 'p1'); }
    finally { closeDatabase(database); key.bytes.fill(0); }
    const after = await f.inspectStoppedProfile('current', material, 16);
    expect(after.aggregateCounts).toEqual(before.aggregateCounts);
    expect(after.businessSha256).not.toBe(before.businessSha256);
  });

  it.each(['missing-envelope', 'symlink-envelope', 'copy-write', 'late-source-sidecar'])('fails closed on %s and leaves no successful inspection residue', async fault => {
    await seed('current'); const before = identity(dbPath('current'));
    if (fault === 'missing-envelope') fs.unlinkSync(envelopePath('current'));
    if (fault === 'symlink-envelope') {
      fs.renameSync(envelopePath('current'), envelopePath('current') + '.original');
      fs.symlinkSync(envelopePath('current') + '.original', envelopePath('current'));
    }
    if (fault === 'copy-write') vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => { throw new Error('private copy failure'); });
    if (fault === 'late-source-sidecar') {
      const open = driver.createRawDatabase;
      vi.spyOn(driver, 'createRawDatabase').mockImplementation((path, options) => {
        fs.writeFileSync(dbPath('current') + '-wal', 'late synthetic sidecar', { mode: 0o600 });
        return open(path, options);
      });
    }
    await expect(f.inspectStoppedProfile('current', material, 16)).rejects.toThrow(ERROR);
    expect(identity(dbPath('current'))).toEqual(before); expect(residue()).toEqual([]);
  });

  it('does not treat an empty current profile as a nonzero manual backup or overwrite a missing target', async () => {
    await seed('current'); const before = identity(dbPath('current'));
    await expect(f.createManualBackup(material)).rejects.toThrow(ERROR);
    await expect(f.inspectStoppedBackup('current', 'manual-20260906T120000000Z.sqlite3', material, 16)).rejects.toThrow(ERROR);
    expect(identity(dbPath('current'))).toEqual(before);
  });

  it('refuses cleanup of a replaced root and preserves unrelated roots through owned symlink removal', async () => {
    const modulePath = '../support/packagedFixtureDatabase';
    const other: Fixture = (await import(/* @vite-ignore */ modulePath)).allocatePackagedFixtureDatabase();
    const moved = f.paths.root + '.moved';
    try {
      fs.renameSync(f.paths.root, moved); fs.symlinkSync(other.paths.root, f.paths.root);
      await expect(f.cleanup()).rejects.toThrow(ERROR);
      expect(fs.existsSync(other.paths.root)).toBe(true);
      fs.unlinkSync(f.paths.root); fs.renameSync(moved, f.paths.root);
      fs.symlinkSync(other.paths.root, join(f.paths.exports, 'unrelated'));
      await f.cleanup(); expect(fs.existsSync(other.paths.root)).toBe(true);
    } finally { await other.cleanup(); }
  });

  it('sanitizes allocation metadata failure and removes only the newly allocated root', async () => {
    const modulePath = '../support/packagedFixtureDatabase';
    const module = await import(/* @vite-ignore */ modulePath);
    const allocation = vi.spyOn(fs, 'mkdtempSync');
    vi.spyOn(fs, 'lstatSync').mockImplementationOnce(() => { throw new Error('private allocation path'); });
    try {
      expect(() => module.allocatePackagedFixtureDatabase()).toThrow(ERROR);
      expect(fs.existsSync(allocation.mock.results[0].value)).toBe(false);
      expect(fs.existsSync(f.paths.root)).toBe(true);
    } finally {
      const path = allocation.mock.results[0]?.value;
      if (typeof path === 'string') fs.rmSync(path, { recursive: true, force: true });
    }
  });
});
