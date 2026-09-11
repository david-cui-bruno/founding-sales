import * as fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRestoreDrill } from '../../src/main/recovery/restoreDrill';
import * as keys from '../../src/main/security/recoveryKey';
import * as migrations from '../../src/main/db/migrate';
import * as driver from '../../src/main/db/sqliteDriver';
import { recoveryFixture } from '../fixtures/recovery';
import { createTestWorkspaceKey } from '../fixtures/tempDatabase';

vi.mock('node:fs', async (original) => ({ ...await original<typeof fs>() }));

describe('real temporary-copy SQLCipher restore drill', () => {
  let f: Awaited<ReturnType<typeof recoveryFixture>>;
  beforeEach(async () => { f = await recoveryFixture(); });
  afterEach(async () => { vi.restoreAllMocks(); await f.cleanup(); });
  async function input() {
    const backup = await f.backups.createBackup('manual');
    return { backup, liveDatabasePath: f.database.path, material: f.material, clock: f.clock, temporaryRoot: f.root };
  }
  const temps = (root: string) => fs.readdirSync(root).filter((name) => name.startsWith('callie-restore-'));
  it('verifies only a private read-only temporary copy, zeroes key and cleans before returning aggregate receipt', async () => {
    const request = await input(); const original = fs.readFileSync(request.backup.path); const live = fs.readFileSync(f.database.path);
    const parsed: Buffer[] = []; const parse = keys.parseRecoveryKeyMaterial;
    vi.spyOn(keys, 'parseRecoveryKeyMaterial').mockImplementation((value) => { const key = parse(value); parsed.push(key.bytes); return key; });
    const open = driver.createRawDatabase;
    vi.spyOn(driver, 'createRawDatabase').mockImplementation((path, options) => {
      expect(path).not.toBe(request.backup.path); expect(path).not.toBe(f.database.path);
      expect(options).toEqual({ readonly: true, fileMustExist: true });
      expect(fs.statSync(path).mode & 0o777).toBe(0o600);
      expect(fs.statSync(join(path, '..')).mode & 0o777).toBe(0o700);
      return open(path, options);
    });
    const receipt = runRestoreDrill(request);
    expect(receipt).toEqual({ backupTimestamp: request.backup.createdAt, backupSha256: request.backup.sha256, schemaVersion: f.schemaVersion, verifiedAt: f.clock.now(), aggregateCounts: { people: 0, prospects: 0, sourceEvents: 0 } });
    expect(parsed).toHaveLength(1); expect(parsed[0]).toEqual(Buffer.alloc(32)); expect(temps(f.root)).toEqual([]);
    expect(fs.readFileSync(request.backup.path)).toEqual(original); expect(fs.readFileSync(f.database.path)).toEqual(live);
    expect(f.repository.getRecoveryReadiness().lastRestoreDrillAt).toBeNull();
  });
  it.each(['wrong-key', 'invalid', 'checksum', 'version'])('rejects %s without source/live mutations or temp residue', async (kind) => {
    const request = await input(); const before = fs.readFileSync(request.backup.path);
    request.material = kind === 'wrong-key' ? keys.createRecoveryKeyMaterial(createTestWorkspaceKey(0x55)) : kind === 'version' ? f.material.replace('CALLIE1', 'CALLIE2') : kind === 'checksum' ? f.material.slice(0, -1) + (f.material.endsWith('0') ? '1' : '0') : 'invalid';
    expect(() => runRestoreDrill(request)).toThrow(/^RECOVERY_FAILED$/);
    expect(fs.readFileSync(request.backup.path)).toEqual(before); expect(temps(f.root)).toEqual([]);
  });
  it.each(['hash', 'size', 'schema', 'future', 'sidecar', 'symlink', 'hardlink', 'plaintext'])('rejects %s artifact without modifying the selected file', async (kind) => {
    const request = await input();
    if (kind === 'hash') request.backup.sha256 = 'a'.repeat(64);
    if (kind === 'size') request.backup.sizeBytes++;
    if (kind === 'schema') request.backup.schemaVersion = 1;
    if (kind === 'future') request.backup.schemaVersion = 999;
    if (kind === 'sidecar') fs.writeFileSync(request.backup.path + '-wal', 'unrelated');
    if (kind === 'symlink') { const alias = join(f.root, 'alias'); fs.symlinkSync(request.backup.path, alias); request.backup.path = alias; }
    if (kind === 'hardlink') { const alias = join(f.root, 'alias'); fs.linkSync(f.database.path, alias); request.backup.path = alias; }
    if (kind === 'plaintext') { fs.writeFileSync(request.backup.path, 'SQLite format 3\0'); request.backup.sizeBytes = 16; request.backup.sha256 = createHash('sha256').update(fs.readFileSync(request.backup.path)).digest('hex'); }
    const before = fs.readFileSync(request.backup.path);
    expect(() => runRestoreDrill(request)).toThrow(/^RECOVERY_FAILED$/);
    expect(fs.readFileSync(request.backup.path)).toEqual(before); expect(temps(f.root)).toEqual([]);
  });
  it('reads real nonzero aggregates, not live data or row bodies', async () => {
    f.database.raw.prepare('INSERT INTO persons(id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('p1', 'PRIVATE FIXTURE NAME', f.clock.now(), f.clock.now());
    f.database.raw.prepare('INSERT INTO source_events(id, person_id, channel, observed_at, source_record_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('s1', 'p1', 'custom', f.clock.now(), '{"private":"body"}', f.clock.now());
    f.database.raw.prepare('INSERT INTO prospects(id, person_id, original_source_event_id, segment, qualification_state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('pr1', 'p1', 's1', 'warm', 'unreviewed', f.clock.now(), f.clock.now());
    const request = await input();
    f.database.raw.prepare('INSERT INTO persons(id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('p2', 'LIVE ONLY', f.clock.now(), f.clock.now());
    const receipt = runRestoreDrill(request);
    expect(receipt.aggregateCounts).toEqual({ people: 1, prospects: 1, sourceEvents: 1 });
    expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE|LIVE ONLY|body/);
  });
  it.each([17, 18, 19] as const)('admits an actual schema%s fixture through the production registry without an override', async (schemaVersion) => {
    const historical = await recoveryFixture({ schemaVersion });
    try {
      const backup = await historical.backups.createBackup('manual');
      const before = fs.readFileSync(backup.path);
      const liveBefore = fs.readFileSync(historical.database.path);
      expect(backup.schemaVersion).toBe(schemaVersion);
      expect(historical.schemaVersion).toBe(schemaVersion);
      expect(migrations.isRegisteredSchemaVersion(schemaVersion)).toBe(true);
      expect(runRestoreDrill({ backup, liveDatabasePath: historical.database.path, material: historical.material,
        clock: historical.clock, temporaryRoot: historical.root }).schemaVersion).toBe(schemaVersion);
      expect(fs.readFileSync(backup.path)).toEqual(before);
      expect(fs.readFileSync(historical.database.path)).toEqual(liveBefore);
      expect(temps(historical.root)).toEqual([]);
    } finally { await historical.cleanup(); }
  });
  it('rejects an actually unregistered schema20 without source mutation or temporary residue', async () => {
    f.database.raw.prepare('UPDATE app_meta SET schema_version = 20').run();
    const request = await input(); const before = fs.readFileSync(request.backup.path);
    expect(request.backup.schemaVersion).toBe(20);
    expect(migrations.isRegisteredSchemaVersion(20)).toBe(false);
    expect(() => runRestoreDrill(request)).toThrow(/^RECOVERY_FAILED$/);
    expect(fs.readFileSync(request.backup.path)).toEqual(before); expect(temps(f.root)).toEqual([]);
  });
  it('rejects missing aggregate structures without migrating the copy', async () => {
    f.database.raw.exec('ALTER TABLE source_events RENAME TO missing_source_events');
    const request = await input(); const original = fs.readFileSync(request.backup.path);
    expect(() => runRestoreDrill(request)).toThrow('RECOVERY_FAILED');
    expect(fs.readFileSync(request.backup.path)).toEqual(original);
    expect(temps(f.root)).toEqual([]);
  });
  it('revalidates source identity after SQLCipher verification and preserves replacement paths', async () => {
    const request = await input(); const open = driver.createRawDatabase;
    vi.spyOn(driver, 'createRawDatabase').mockImplementation((path, options) => {
      fs.renameSync(request.backup.path, request.backup.path + '.original');
      fs.writeFileSync(request.backup.path, 'unrelated replacement', { mode: 0o600 });
      return open(path, options);
    });
    expect(() => runRestoreDrill(request)).toThrow('RECOVERY_FAILED');
    expect(fs.readFileSync(request.backup.path, 'utf8')).toBe('unrelated replacement');
    expect(temps(f.root)).toEqual([]);
  });
  it.each(['open', 'integrity', 'count', 'close'])('fails closed on %s failure, zeroes key and cleans temporary copy', async (fault) => {
    const request = await input(); const parsed: Buffer[] = []; const parse = keys.parseRecoveryKeyMaterial;
    vi.spyOn(keys, 'parseRecoveryKeyMaterial').mockImplementation((value) => { const key = parse(value); parsed.push(key.bytes); return key; });
    const open = driver.createRawDatabase;
    vi.spyOn(driver, 'createRawDatabase').mockImplementation((path, options) => {
      if (fault === 'open') throw new Error('private path');
      const raw = open(path, options);
      if (fault === 'integrity') { const pragma = raw.pragma.bind(raw); vi.spyOn(raw, 'pragma').mockImplementation((sql, options) => sql === 'integrity_check' ? [{ integrity_check: 'failed' }] : pragma(sql, options)); }
      if (fault === 'count') { const prepare = raw.prepare.bind(raw); vi.spyOn(raw, 'prepare').mockImplementation((sql) => { if (sql.includes('AS people')) throw new Error('private count failure'); return prepare(sql); }); }
      if (fault === 'close') vi.spyOn(raw, 'close').mockImplementationOnce(() => { throw new Error('private close failure'); });
      return raw;
    });
    expect(() => runRestoreDrill(request)).toThrow(/^RECOVERY_FAILED$/);
    expect(parsed[0]).toEqual(Buffer.alloc(32)); expect(temps(f.root)).toEqual([]);
  });
  it('does not return a receipt when cleanup fails and still zeroes parsed keys', async () => {
    const request = await input(); const parsed: Buffer[] = []; const parse = keys.parseRecoveryKeyMaterial;
    vi.spyOn(keys, 'parseRecoveryKeyMaterial').mockImplementation((value) => { const key = parse(value); parsed.push(key.bytes); return key; });
    vi.spyOn(fs, 'rmdirSync').mockImplementation(() => { throw new Error('private native path'); });
    expect(() => runRestoreDrill(request)).toThrow(/^RECOVERY_FAILED$/); expect(parsed[0]).toEqual(Buffer.alloc(32));
  });
});
