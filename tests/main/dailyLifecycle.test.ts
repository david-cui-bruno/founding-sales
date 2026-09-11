import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { openDatabase, closeDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';
import { FoundationRuntime } from '../../src/main/foundation/foundationRuntime';
import { HealthService } from '../../src/main/health/healthService';
import { createDailyProvider } from '../../src/main/ipc/registerApplicationIpc';
import { createTempDatabase, createTestWorkspaceKey } from '../fixtures/tempDatabase';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }));

/** Source-level lifecycle acceptance, with real runtime/domain/encrypted storage.
 * Only the external key loader is controlled. No real profile or keychain is used.
 */
function fixture(load?: () => Promise<void>) {
  const temp = createTempDatabase();
  const key = createTestWorkspaceKey();
  let database: AppDatabase | undefined;
  let opens = 0;
  const runtime = new FoundationRuntime({
    appVersion: '1.0.0', databasePath: temp.path, databaseExists: false,
    backupDirectory: join(dirname(temp.path), 'backups'),
    keyEnvelopePath: join(dirname(temp.path), 'fixture-envelope.json'),
  }, {
    loadWorkspaceKey: async () => { await load?.(); return { ...key, bytes: Buffer.from(key.bytes) }; },
    prepareEncryptedDatabase: async () => undefined,
    openDatabase: options => { opens++; database = openDatabase(options); return database; },
    migrateToLatest,
    createDomainRuntime: db => new DomainRuntime({ database: db, expectedWorkspaceId: 'fictional-daily-workspace',
      clock: { now: () => '2026-09-09T12:00:00.000Z' }, ids: { next: () => crypto.randomUUID() } }),
    createHealthService: options => new HealthService(options),
    closeDatabase,
  });
  return { runtime, provider: createDailyProvider(runtime), opens: () => opens,
    database: () => database,
    async close() { await runtime.shutdown(); key.bytes.fill(0); temp.cleanup(); } };
}

it('daily provider refuses reads after the real runtime shuts down instead of retaining its domain', async () => {
  const f = fixture();
  try {
    const before = await f.provider.get();
    expect(before.workspaceId).toBe('fictional-daily-workspace');
    expect(before.accounts).toEqual([]);
    expect(f.opens()).toBe(1);
    await f.runtime.shutdown();
    expect(f.database()?.raw.open).toBe(false);
    await expect(f.provider.get()).rejects.toThrow();
    expect(f.opens()).toBe(1);
  } finally { await f.close(); }
});

it('daily provider exposes no fallback snapshot while the workspace key is unavailable', async () => {
  let unavailable = true;
  const f = fixture(async () => { if (unavailable) throw new Error('fictional key unavailable'); });
  try {
    await expect(f.provider.get()).rejects.toThrow('fictional key unavailable');
    expect(f.opens()).toBe(0);
    unavailable = false;
    expect((await f.provider.get()).workspaceId).toBe('fictional-daily-workspace');
    expect(f.opens()).toBe(1);
  } finally { await f.close(); }
});

it('shutdown during daily initialization prevents a delayed key result from opening storage', async () => {
  let release!: () => void;
  const pendingKey = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(() => pendingKey);
  try {
    const read = f.provider.get();
    const rejected = expect(read).rejects.toThrow();
    const stopped = f.runtime.shutdown();
    release();
    await rejected;
    await stopped;
    expect(f.opens()).toBe(0);
    await expect(f.provider.get()).rejects.toThrow();
  } finally { release(); await f.close(); }
});
