import * as fs from 'node:fs';
import * as keys from '../../src/main/security/recoveryKey';
import { readFileSync, statSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecoveryService } from '../../src/main/recovery/recoveryService';
import * as contract from '../../src/shared/contracts/recoveryContract';
import { createTestWorkspaceKey } from '../fixtures/tempDatabase';
import { recoveryFixture } from '../fixtures/recovery';

vi.mock('node:fs', async (original) => ({ ...await original<typeof fs>() }));

const emptyStatus: contract.RecoveryReadinessStatus = { setupCompletedAt: null, lastRestoreDrillAt: null, outreachReady: false, backup: { status: 'missing', createdAt: null, verifiedAt: null } };
describe('recovery strict contract', () => {
  it('requires strict closed confirmation and file/paste shapes', () => {
    expect(contract.beginSetupRequestSchema.safeParse({ founderConfirmed: true }).success).toBe(true);
    for (const input of [{}, { founderConfirmed: false }, { founderConfirmed: 'true' }, { founderConfirmed: true, path: '/secret' }]) {
      expect(contract.beginSetupRequestSchema.safeParse(input).success).toBe(false);
    }
    for (const input of [{ founderConfirmed: true }, { founderConfirmed: true, materialSource: 'file', recoveryMaterial: 'secret' }, { founderConfirmed: true, materialSource: 'paste', recoveryMaterial: '' }, { founderConfirmed: true, materialSource: 'paste', recoveryMaterial: 'a'.repeat(513) }, { founderConfirmed: true, materialSource: 'paste', recoveryMaterial: 'secret', backupPath: '/secret' }]) {
      expect(contract.restoreDrillRequestSchema.safeParse(input).success).toBe(false);
    }
    expect(contract.restoreDrillRequestSchema.safeParse({ founderConfirmed: true, materialSource: 'paste', recoveryMaterial: 'supplied' }).success).toBe(true);
  });
  it('enforces readiness, canonical timestamps, private projection and aggregate bounds', () => {
    expect(contract.recoveryStatusSchema.safeParse(emptyStatus).success).toBe(true);
    for (const status of [{ ...emptyStatus, outreachReady: true }, { ...emptyStatus, backup: { status: 'available', createdAt: null as string | null, verifiedAt: null as string | null } }, { ...emptyStatus, backup: { ...emptyStatus.backup, path: '/secret' } }, { ...emptyStatus, setupCompletedAt: '2026-09-06T12:00:00Z' }]) {
      expect(contract.recoveryStatusSchema.safeParse(status).success).toBe(false);
    }
    const receipt = { backupTimestamp: '2026-09-06T12:00:00.000Z', backupSha256: 'a'.repeat(64), schemaVersion: 1, verifiedAt: '2026-09-06T12:00:00.000Z', aggregateCounts: { people: 0, prospects: 1, sourceEvents: 2 } };
    expect(contract.restoreDrillReceiptSchema.safeParse(receipt).success).toBe(true);
    for (const aggregateCounts of [{ people: -1, prospects: 0, sourceEvents: 0 }, { people: 2 ** 53, prospects: 0, sourceEvents: 0 }, { ...receipt.aggregateCounts, rows: 'secret' }]) {
      expect(contract.restoreDrillReceiptSchema.safeParse({ ...receipt, aggregateCounts }).success).toBe(false);
    }
  });
});

describe('recovery service with immutable SQLCipher repository', () => {
  let f: Awaited<ReturnType<typeof recoveryFixture>>;
  let service: RecoveryService;
  let savePath: string | null;
  let backupPath: string | null;
  let materialPath: string | null;
  let loaded: Buffer[];
  const dialogs = { saveMaterial: vi.fn(), selectBackup: vi.fn(), selectMaterial: vi.fn() };
  beforeEach(async () => {
    f = await recoveryFixture(); loaded = []; savePath = backupPath = materialPath = null;
    dialogs.saveMaterial.mockImplementation(async () => savePath);
    dialogs.selectBackup.mockImplementation(async () => backupPath);
    dialogs.selectMaterial.mockImplementation(async () => materialPath);
    service = new RecoveryService({ databaseGate: f.gate, backups: f.backups, liveDatabasePath: f.database.path, clock: f.clock, ids: f.ids, dialogs,
      loadWorkspaceKey: async () => { const key = createTestWorkspaceKey(); loaded.push(key.bytes); return key; }, temporaryRoot: f.root });
  });
  afterEach(async () => { await service.shutdown(); await f.cleanup(); vi.restoreAllMocks(); });
  it('status observes actual artifacts without key loading or dialogs', async () => {
    expect(await service.status()).toEqual(emptyStatus);
    expect(loaded).toEqual([]);
    const backup = await f.backups.createBackup('manual');
    expect((await service.status()).backup).toEqual({ status: 'available', createdAt: backup.createdAt, verifiedAt: backup.verifiedAt });
    writeFileSync(backup.path, 'tampered');
    expect((await service.status()).backup.status).toBe('missing');
    vi.spyOn(f.backups, 'listAvailableBackups').mockRejectedValue(new Error('/secret unavailable'));
    expect((await service.status()).backup.status).toBe('unavailable');
  });
  it('reveals only on explicit begin, zeroes raw key, and consumes session only on Complete', async () => {
    const session = await service.beginSetup({ founderConfirmed: true });
    expect(session.material).toBe(f.material); expect(loaded[0]).toEqual(Buffer.alloc(32));
    expect(await service.status()).toEqual(emptyStatus);
    expect(await service.saveSetupMaterial({ sessionId: session.sessionId })).toEqual({ kind: 'cancelled' });
    const status = await service.completeSetup({ sessionId: session.sessionId, founderConfirmed: true });
    expect(status.setupCompletedAt).toBe(f.clock.now()); expect(status.outreachReady).toBe(false);
    expect(JSON.stringify(status)).not.toContain(f.material);
    await expect(service.completeSetup({ sessionId: session.sessionId, founderConfirmed: true })).rejects.toThrow('RECOVERY_FAILED');
    await expect(service.saveSetupMaterial({ sessionId: session.sessionId })).rejects.toThrow('RECOVERY_FAILED');
  });
  it('writes only explicit exclusive private export and does not mark setup complete', async () => {
    const session = await service.beginSetup({ founderConfirmed: true }); savePath = join(f.root, 'recovery.txt');
    expect(await service.saveSetupMaterial({ sessionId: session.sessionId })).toEqual({ kind: 'saved', backupBasename: 'recovery.txt' });
    expect(readFileSync(savePath, 'utf8')).toBe(f.material); expect(statSync(savePath).mode & 0o777).toBe(0o600);
    expect((await service.status()).setupCompletedAt).toBeNull();
    await expect(service.saveSetupMaterial({ sessionId: session.sessionId })).rejects.toThrow('RECOVERY_FAILED');
    expect(readFileSync(savePath, 'utf8')).toBe(f.material);
  });
  it('refuses symlink export without changing target', async () => {
    const session = await service.beginSetup({ founderConfirmed: true }); const target = join(f.root, 'target'); writeFileSync(target, 'preserved');
    savePath = join(f.root, 'link'); symlinkSync(target, savePath);
    await expect(service.saveSetupMaterial({ sessionId: session.sessionId })).rejects.toThrow('RECOVERY_FAILED');
    expect(readFileSync(target, 'utf8')).toBe('preserved');
  });
  it('expires at ten minutes and revalidates after an awaited dialog', async () => {
    const session = await service.beginSetup({ founderConfirmed: true });
    dialogs.saveMaterial.mockImplementation(async () => { f.setTime('2026-09-06T12:10:00.000Z'); return join(f.root, 'expired'); });
    await expect(service.saveSetupMaterial({ sessionId: session.sessionId })).rejects.toThrow('RECOVERY_FAILED');
    expect(existsSync(join(f.root, 'expired'))).toBe(false);
    await expect(service.completeSetup({ sessionId: session.sessionId, founderConfirmed: true })).rejects.toThrow('RECOVERY_FAILED');
  });
  it('replaces older sessions and rejects invalid inputs without revealing request contents', async () => {
    const old = await service.beginSetup({ founderConfirmed: true }); await service.beginSetup({ founderConfirmed: true });
    await expect(service.saveSetupMaterial({ sessionId: old.sessionId })).rejects.toThrow('RECOVERY_FAILED');
    await expect(service.beginSetup({ founderConfirmed: true, [f.material]: f.material } as never)).rejects.toThrow(/^RECOVERY_FAILED$/);
    await expect((service.status as (...args: unknown[]) => Promise<unknown>)({ path: f.material })).rejects.toThrow(/^RECOVERY_FAILED$/);
  });
  it('does not open a queued native dialog after shutdown begins', async () => {
    const session = await service.beginSetup({ founderConfirmed: true });
    dialogs.saveMaterial.mockClear();
    const saving = service.saveSetupMaterial({ sessionId: session.sessionId });
    const rejected = expect(saving).rejects.toThrow('RECOVERY_FAILED');
    await Promise.resolve();
    await service.shutdown(); await rejected;
    expect(dialogs.saveMaterial).not.toHaveBeenCalled();
  });
  it('drains pending dialogs on shutdown and ignores late selected destinations', async () => {
    const session = await service.beginSetup({ founderConfirmed: true }); let resolve!: (value: string) => void;
    dialogs.saveMaterial.mockImplementation(() => new Promise<string>((r) => { resolve = r; }));
    const saving = service.saveSetupMaterial({ sessionId: session.sessionId });
    const rejected = expect(saving).rejects.toThrow('RECOVERY_FAILED');
    await vi.waitFor(() => expect(resolve).toBeDefined()); await service.shutdown(); await rejected;
    resolve(join(f.root, 'late-export'));
    expect(existsSync(join(f.root, 'late-export'))).toBe(false);
    await expect(service.beginSetup({ founderConfirmed: true })).rejects.toThrow('RECOVERY_FAILED');
  });
  it('selects only present receipt-matching backups and independently supplied material', async () => {
    const backup = await f.backups.createBackup('manual'); backupPath = backup.path;
    const setup = await service.beginSetup({ founderConfirmed: true }); await service.completeSetup({ sessionId: setup.sessionId, founderConfirmed: true });
    await expect(service.selectAndRunRestoreDrill({ founderConfirmed: true, materialSource: 'paste', recoveryMaterial: 'wrong' })).rejects.toThrow(/^RECOVERY_FAILED$/);
    expect((await service.status()).lastRestoreDrillAt).toBeNull();
    f.setTime('2026-09-06T12:01:00.000Z');
    const result = await service.selectAndRunRestoreDrill({ founderConfirmed: true, materialSource: 'paste', recoveryMaterial: f.material });
    expect(result.kind).toBe('completed'); expect((await service.status()).outreachReady).toBe(true);
    expect(f.database.raw.prepare('SELECT backup_sha256 FROM restore_drill_receipts').get()).toEqual({ backup_sha256: backup.sha256 });
    expect(JSON.stringify(result)).not.toContain(f.material); expect(JSON.stringify(result)).not.toContain(f.root);
    await expect(service.selectAndRunRestoreDrill({ founderConfirmed: true, materialSource: 'paste', recoveryMaterial: f.material })).rejects.toThrow('RECOVERY_FAILED');
    expect(f.repository.getRecoveryReadiness().lastRestoreDrillAt).toBe(f.clock.now());
  });
  it('zeroes loaded keys when material formatting fails', async () => {
    vi.spyOn(keys, 'createRecoveryKeyMaterial').mockImplementation(() => { throw new Error('private key failure'); });
    await expect(service.beginSetup({ founderConfirmed: true })).rejects.toThrow(/^RECOVERY_FAILED$/);
    expect(loaded[0]).toEqual(Buffer.alloc(32));
  });
  it('drains a late key load before shutdown resolves and never returns its material', async () => {
    await service.shutdown(); let resolve!: (key: ReturnType<typeof createTestWorkspaceKey>) => void;
    const key = createTestWorkspaceKey();
    service = new RecoveryService({ databaseGate: f.gate, backups: f.backups, liveDatabasePath: f.database.path, clock: f.clock, ids: f.ids, dialogs,
      loadWorkspaceKey: () => new Promise((r) => { resolve = r; }) });
    const begin = service.beginSetup({ founderConfirmed: true }); const rejected = expect(begin).rejects.toThrow('RECOVERY_FAILED');
    await vi.waitFor(() => expect(resolve).toBeDefined()); let finished = false;
    const stopping = service.shutdown().then(() => { finished = true; });
    await Promise.resolve(); expect(finished).toBe(false); resolve(key); await stopping; await rejected;
    expect(key.bytes).toEqual(Buffer.alloc(32));
  });
  it.each(['fsync', 'parent', 'replacement'])('export %s failure cannot overwrite or delete unrelated data', async (fault) => {
    const session = await service.beginSetup({ founderConfirmed: true }); savePath = join(f.root, 'export.txt');
    if (fault === 'parent') fs.chmodSync(f.root, 0o777);
    if (fault === 'fsync') vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('private native error'); });
    if (fault === 'replacement') {
      const sync = fs.fsyncSync;
      vi.spyOn(fs, 'fsyncSync').mockImplementationOnce((fd) => { sync(fd); fs.renameSync(savePath!, savePath + '.owned'); fs.writeFileSync(savePath!, 'replacement', { mode: 0o600 }); });
    }
    await expect(service.saveSetupMaterial({ sessionId: session.sessionId })).rejects.toThrow(/^RECOVERY_FAILED$/);
    if (fault === 'replacement') { expect(readFileSync(savePath, 'utf8')).toBe('replacement'); expect(readFileSync(savePath + '.owned', 'utf8')).toBe(''); }
    else expect(existsSync(savePath)).toBe(false);
    fs.chmodSync(f.root, 0o700);
    expect(f.repository.getRecoveryReadiness().recoverySetupCompletedAt).toBeNull();
  });
  it('commits a linked immutable receipt only after key zeroization and temporary cleanup', async () => {
    const backup = await f.backups.createBackup('manual'); backupPath = backup.path;
    const parsed: Buffer[] = []; const parse = keys.parseRecoveryKeyMaterial;
    vi.spyOn(keys, 'parseRecoveryKeyMaterial').mockImplementation((value) => { const key = parse(value); parsed.push(key.bytes); return key; });
    const prepare = f.database.raw.prepare.bind(f.database.raw);
    vi.spyOn(f.database.raw, 'prepare').mockImplementation((sql) => {
      if (sql.includes('INSERT INTO restore_drill_receipts')) {
        expect(parsed[0]).toEqual(Buffer.alloc(32));
        expect(fs.readdirSync(f.root).filter((name) => name.startsWith('callie-restore-'))).toEqual([]);
      }
      return prepare(sql);
    });
    expect((await service.selectAndRunRestoreDrill({ founderConfirmed: true, materialSource: 'paste', recoveryMaterial: f.material })).kind).toBe('completed');
    expect(() => f.database.raw.exec('DELETE FROM restore_drill_receipts')).toThrow();
    expect(f.database.raw.prepare('SELECT COUNT(*) AS count FROM restore_drill_receipts').get()).toEqual({ count: 1 });
  });
  it('records no receipt after cleanup or receipt-transaction failure', async () => {
    const backup = await f.backups.createBackup('manual'); backupPath = backup.path;
    vi.spyOn(fs, 'rmdirSync').mockImplementationOnce(() => { throw new Error('private cleanup failure'); });
    const request = { founderConfirmed: true as const, materialSource: 'paste' as const, recoveryMaterial: f.material };
    await expect(service.selectAndRunRestoreDrill(request)).rejects.toThrow(/^RECOVERY_FAILED$/);
    expect(f.repository.getRecoveryReadiness().lastRestoreDrillAt).toBeNull();
    f.database.raw.exec("CREATE TRIGGER fixture_reject_drill BEFORE INSERT ON restore_drill_receipts BEGIN SELECT RAISE(ABORT, 'fixture'); END");
    await expect(service.selectAndRunRestoreDrill(request)).rejects.toThrow(/^RECOVERY_FAILED$/);
    expect(f.repository.getRecoveryReadiness().lastRestoreDrillAt).toBeNull();
  });
  it('revalidates backup after the material picker and never accepts removed artifacts', async () => {
    const backup = await f.backups.createBackup('manual'); backupPath = backup.path;
    materialPath = join(f.root, 'material.txt'); writeFileSync(materialPath, f.material, { mode: 0o600 });
    dialogs.selectMaterial.mockImplementation(async () => { fs.unlinkSync(backup.path); return materialPath; });
    await expect(service.selectAndRunRestoreDrill({ founderConfirmed: true, materialSource: 'file' })).rejects.toThrow(/^RECOVERY_FAILED$/);
    expect(f.repository.getRecoveryReadiness().lastRestoreDrillAt).toBeNull();
  });
  it('file supply and dialog cancellation never fall back to setup material', async () => {
    const backup = await f.backups.createBackup('manual'); backupPath = backup.path;
    expect(await service.selectAndRunRestoreDrill({ founderConfirmed: true, materialSource: 'file' })).toEqual({ kind: 'cancelled' });
    materialPath = join(f.root, 'supplied.txt'); writeFileSync(materialPath, f.material, { mode: 0o600 });
    expect((await service.selectAndRunRestoreDrill({ founderConfirmed: true, materialSource: 'file' })).kind).toBe('completed');
    expect((await service.status()).outreachReady).toBe(false);
    backupPath = join(f.root, 'untrusted.sqlite3');
    await expect(service.selectAndRunRestoreDrill({ founderConfirmed: true, materialSource: 'file' })).rejects.toThrow('RECOVERY_FAILED');
  });
});
