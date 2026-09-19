import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { prepareEncryptedDatabase } from '../../src/main/db/plaintextDatabaseUpgrade';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';
import type { FounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import { FoundationRuntime } from '../../src/main/foundation/foundationRuntime';
import { HealthService } from '../../src/main/health/healthService';
import {
  createDailyProvider, createLeadDetailProvider, createLeadsProvider, registerApplicationIpc,
} from '../../src/main/ipc/registerApplicationIpc';
import { createLocalWorkspaceProvider } from '../../src/main/workspace/localWorkspaceProvider';
import { createCallieApi } from '../../src/preload/createCallieApi';
import { appHealthSchema } from '../../src/shared/healthContract';
import { dailySnapshotSchema } from '../../src/shared/contracts/dailyContract';
import { leadsListResponseSchema, type LeadsListRequest } from '../../src/shared/contracts/leadsContract';
import { leadDetailSchema } from '../../src/shared/contracts/leadDetailContract';
import { localCompanyCreateResultSchema } from '../../src/shared/contracts/localCompanyIntakeContract';
import { createTempDatabase, createTestWorkspaceKey } from '../fixtures/tempDatabase';
import { insertPerson, seedProspect, insertOpenCycleWithAction } from '../fixtures/domainRows';
import { registeredIpcHandler } from '../fixtures/registeredIpcHandler';

const electron = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }));
vi.mock('electron', () => ({ safeStorage: {}, dialog: {}, ipcMain: { handle: electron.handle, removeHandler: electron.removeHandler } }));

const NOW = '2026-09-10T15:00:00.000Z';
const listRequest: LeadsListRequest = { query: '', stages: [], priorities: [], sort: 'person_name', cursor: null, limit: 50 };
const companyInput = (name: string, domain: string | null = null) => ({ commandId: randomUUID(), name, domain });
// Person command channels that left the desktop with the legacy surfaces. None may be registered by default.
const removedPersonChannels = [
  'leads:update-field', 'leads:bulk-update', 'lead-detail:begin-outbound', 'lead-detail:outbound-capabilities',
  'lead-detail:confirm-transition', 'lead-detail:dismiss', 'lead-detail:cloud-score-override', 'lead-detail:find-contact-info',
  'friday:get',
];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

// Real foundation, migration, bootstrap/audit, domain and HealthService. The only
// gate instrumentation delegates to the actual runtime and counts admitted callbacks.
function realFoundation(options: { holdKey?: boolean; blocked?: boolean; keyError?: Error } = {}) {
  const temp = createTempDatabase(); const releaseKey = deferred(); const keyEntered = deferred();
  const counts = { key: 0, open: 0, migrate: 0, initialize: 0, health: 0, callback: 0, close: 0 };
  let domainRuntime: DomainRuntime;
  const runtime = new FoundationRuntime({ appVersion: 'fixture', databasePath: temp.path, databaseExists: false,
    backupDirectory: `${temp.path}.backups`, keyEnvelopePath: `${temp.path}.envelope` }, {
    loadWorkspaceKey: async () => {
      counts.key++; keyEntered.resolve(); if (options.holdKey) await releaseKey.promise;
      if (options.keyError) throw options.keyError;
      return createTestWorkspaceKey();
    },
    prepareEncryptedDatabase,
    openDatabase: input => { counts.open++; return openDatabase(input); },
    migrateToLatest: async (database, input) => {
      counts.migrate++; const result = await migrateToLatest(database, input);
      if (options.blocked) insertPerson(database.raw, 'orphan-without-canonical-prospect');
      return result;
    },
    createDomainRuntime: database => {
      domainRuntime = new DomainRuntime({ database, clock: { now: () => NOW }, ids: { next: randomUUID } });
      const initialize = domainRuntime.initialize.bind(domainRuntime);
      vi.spyOn(domainRuntime, 'initialize').mockImplementation(() => { counts.initialize++; return initialize(); });
      return domainRuntime;
    },
    createHealthService: input => { counts.health++; return new HealthService(input); },
    closeDatabase: database => { counts.close++; closeDatabase(database); },
  });
  const gate = {
    withDomain: <T,>(operation: (domain: FounderSalesDomain) => T | Promise<T>): Promise<T> =>
      runtime.withDomain(domain => { counts.callback++; return operation(domain); }),
    withDatabase: <T,>(operation: (database: AppDatabase) => T | Promise<T>): Promise<T> => runtime.withDatabase(operation),
    getHealth: () => runtime.getHealth(),
  };
  const stop = async () => { releaseKey.resolve(); await runtime.shutdown(); temp.cleanup(); };
  return { temp, runtime, gate, counts, releaseKey, keyEntered, stop, services: () => domainRuntime.getServices() };
}
type Fixture = ReturnType<typeof realFoundation>;
const fixtures: Fixture[] = [];
const fixture = (options: Parameters<typeof realFoundation>[0] = {}) => {
  const f = realFoundation(options); fixtures.push(f); return f;
};
const revision = (f: Fixture) => f.runtime.withDatabase(database =>
  (database.raw.prepare('SELECT total_changes() AS count').get() as { count: number }).count);
async function seedReady(f: Fixture) {
  return f.runtime.withDatabase(database => {
    const prospect = seedProspect(database.raw, 'ready');
    const cycle = insertOpenCycleWithAction({ database: database.raw, prefix: 'ready', prospect });
    f.services().unitOfWork.immediate(() => f.services().events.appendActivity({ id: 'ready-call', personId: prospect.personId,
      prospectId: prospect.prospectId, salesCycleId: cycle.cycleId, kind: 'call', direction: 'inbound', channel: 'phone', occurredAt: NOW, callOutcome: 'spoke' }));
    return { ...prospect, ...cycle };
  });
}
// Production factories only: the two person reads, the payload-free Daily read and the local company write.
function gatedOperations(f: Fixture) {
  return [
    ['leads.list', () => createLeadsProvider(f.gate).list(listRequest)],
    ['detail.get', () => createLeadDetailProvider(f.gate).get({ personId: 'held-person' })],
    ['daily.get', () => createDailyProvider(f.gate).get()],
    ['local.createCompany', () => createLocalWorkspaceProvider(f.gate).createCompany(companyInput('Must not write'))],
  ] as const;
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); electron.handle.mockReset(); electron.removeHandler.mockReset(); });
afterEach(async () => { for (const f of fixtures.splice(0)) await f.stop(); vi.useRealTimers(); });

describe('production providers through actual encrypted FoundationRuntime', () => {
  it('pending initialization admits no callback or write, then release serves real reads and writes once initialized', async () => {
    const f = fixture({ holdKey: true });
    let settled = 0;
    const read = createLeadsProvider(f.gate).list(listRequest).then(value => { settled++; return value; });
    const write = createLocalWorkspaceProvider(f.gate).createCompany(companyInput('Pending Fictional PM')).then(value => { settled++; return value; });
    await f.keyEntered.promise; await Promise.resolve();
    expect(f.counts).toMatchObject({ key: 1, open: 0, migrate: 0, callback: 0 }); expect(settled).toBe(0);
    f.releaseKey.resolve();
    expect(leadsListResponseSchema.parse(await read).rows).toEqual([]);
    expect(localCompanyCreateResultSchema.parse(await write)).toMatchObject({ status: 'saved', replayed: false, account: { name: 'Pending Fictional PM', version: 1 } });
    expect(f.counts).toMatchObject({ key: 1, open: 1, migrate: 1, initialize: 1, health: 1, callback: 2 });
    expect(await f.runtime.withDatabase(db => db.raw.prepare('SELECT name, domain, version FROM pm_accounts').all())).toEqual([{ name: 'Pending Fictional PM', domain: null, version: 1 }]);
  });

  it('shutdown while initialization is pending rejects queued commands without entering a callback or opening a database', async () => {
    const f = fixture({ holdKey: true });
    const write = createLocalWorkspaceProvider(f.gate).createCompany(companyInput('Cancelled before open'));
    const rejected = expect(write).rejects.toThrow('cancelled');
    await f.keyEntered.promise; const shutdown = f.runtime.shutdown(); f.releaseKey.resolve();
    await rejected; await shutdown;
    expect(f.counts).toMatchObject({ open: 0, migrate: 0, callback: 0, close: 0 });
  });

  it('failed initialization preserves the dependency error and never admits a provider callback', async () => {
    const error = new Error('fictional key unavailable'); const f = fixture({ keyError: error });
    await expect(createLeadsProvider(f.gate).list(listRequest)).rejects.toBe(error);
    expect(f.counts).toMatchObject({ open: 0, migrate: 0, callback: 0, close: 0 });
  });

  it('ready admits genuine reads from the production factories and a persisted write from the local company slice', async () => {
    const f = fixture(); await f.runtime.initialize(); const owner = await seedReady(f);
    expect(appHealthSchema.parse(await f.runtime.getHealth())).toMatchObject({ domainReady: true, domainStatus: 'ready', databaseEncrypted: true });
    const leads = createLeadsProvider(f.gate), detail = createLeadDetailProvider(f.gate), daily = createDailyProvider(f.gate);
    const local = createLocalWorkspaceProvider(f.gate);
    expect(leadsListResponseSchema.parse(await leads.list(listRequest)).rows.map(row => row.personId)).toEqual([owner.personId]);
    expect(leadDetailSchema.parse(await detail.get({ personId: owner.personId })).personId).toBe(owner.personId);
    expect(dailySnapshotSchema.safeParse(await daily.get()).success).toBe(true);
    const command = companyInput('Ready Fictional PM', 'ready.invalid');
    const saved = localCompanyCreateResultSchema.parse(await local.createCompany(command));
    expect(saved).toMatchObject({ status: 'saved', replayed: false, commandId: command.commandId });
    if (saved.status !== 'saved') throw new Error('Expected a saved local company');
    // Find the company by independent fixture content and command identity, never by a returned ID alone.
    const companyFacts = (db: AppDatabase) => ({
      accounts: db.raw.prepare("SELECT id, name, domain, version FROM pm_accounts WHERE name = 'Ready Fictional PM' ORDER BY id").all() as { id: string; name: string; domain: string | null; version: number }[],
      commands: db.raw.prepare('SELECT command_id, account_id, account_version FROM pm_account_commands WHERE command_id = ? ORDER BY command_id').all(command.commandId) as { command_id: string; account_id: string; account_version: number }[],
    });
    const persisted = await f.runtime.withDatabase(companyFacts);
    expect(persisted.accounts).toEqual([{ id: saved.account.id, name: 'Ready Fictional PM', domain: 'ready.invalid', version: 1 }]);
    expect(persisted.commands).toEqual([{ command_id: command.commandId, account_id: saved.account.id, account_version: 1 }]);
    expect(f.counts).toMatchObject({ key: 1, open: 1, migrate: 1, initialize: 1, health: 1 });
    await f.runtime.shutdown();
    expect(readFileSync(f.temp.path).subarray(0, 16).toString()).not.toBe('SQLite format 3\0');
    const reopened = openDatabase({ path: f.temp.path, key: createTestWorkspaceKey() });
    try {
      expect(reopened.raw.prepare('SELECT display_name FROM persons WHERE id = ?').get(owner.personId)).toEqual({ display_name: `Person ${owner.personId}` });
      expect(companyFacts(reopened)).toEqual(persisted);
    }
    finally { closeDatabase(reopened); }
  });

  it('an actual audited blocked domain refuses every gated factory and write without facade callbacks', async () => {
    const f = fixture({ blocked: true }); await f.runtime.initialize();
    const health = appHealthSchema.parse(await f.runtime.getHealth());
    expect(health.domainStatus).toBe('blocked'); expect(health.domainReady).toBe(false); expect(health.domainBlockingViolationCount).toBeGreaterThan(0);
    const before = await revision(f);
    for (const [name, run] of gatedOperations(f)) await expect(run(), name).rejects.toThrow('blocked');
    expect(f.counts.callback).toBe(0); expect(await revision(f)).toBe(before);
  });

  it('a real withDatabase lease holds shutdown while stopping and stopped gates refuse every factory', async () => {
    const f = fixture(); await f.runtime.initialize(); const entered = deferred(), release = deferred();
    let changes = 0;
    const lease = f.runtime.withDatabase(async db => {
      changes = (db.raw.prepare('SELECT total_changes() AS count').get() as { count: number }).count;
      entered.resolve(); await release.promise;
      expect((db.raw.prepare('SELECT total_changes() AS count').get() as { count: number }).count).toBe(changes);
    });
    await entered.promise;
    try {
      const shutdown = f.runtime.shutdown(); expect(f.runtime.shutdown()).toBe(shutdown);
      for (const [name, run] of gatedOperations(f)) await expect(run(), name).rejects.toThrow('cancelled');
      expect(f.counts.callback).toBe(0); expect(f.counts.close).toBe(0);
      release.resolve(); await lease; await shutdown;
      expect(f.counts.close).toBe(1);
      for (const [name, run] of gatedOperations(f)) await expect(run(), name).rejects.toThrow('shut down');
      expect(f.counts.callback).toBe(0); expect(f.counts.close).toBe(1);
    } finally { release.resolve(); await lease; }
  });

  it('real preload and default registrars preserve list and detail reads, sender/schema refusal and payload-free Daily reads, with no person write', async () => {
    const f = fixture(); await f.runtime.initialize(); const owner = await seedReady(f);
    const forbidden = vi.fn(async (): Promise<never> => { throw Error('Unrequested fixture capability'); });
    const unregister = registerApplicationIpc(f.gate, undefined, undefined,
      { status: forbidden, beginSetup: forbidden, saveSetupMaterial: forbidden, completeSetup: forbidden, selectAndRunRestoreDrill: forbidden },
      { revealDatabase: forbidden, revealLogDirectory: forbidden });
    let sender: { senderFrame?: { url: string } } = { senderFrame: { url: 'callie://app/index.html' } };
    const invoke = vi.fn(async (channel: string, ...args: unknown[]) =>
      Reflect.apply(registeredIpcHandler(electron.handle, channel), undefined, [sender, ...args]) as unknown);
    const api = createCallieApi({ invoke });
    const unrelated = await f.runtime.withDatabase(db => {
      const prospect = seedProspect(db.raw, 'unrelated');
      return { ...prospect, ...insertOpenCycleWithAction({ database: db.raw, prefix: 'unrelated', prospect }) };
    });
    const unrelatedFacts = () => f.runtime.withDatabase(db => ({
      people: db.raw.prepare('SELECT * FROM persons WHERE id = ?').all(unrelated.personId),
      prospects: db.raw.prepare('SELECT * FROM prospects WHERE person_id = ? ORDER BY id').all(unrelated.personId),
      cycles: db.raw.prepare('SELECT * FROM sales_cycles WHERE person_id = ? ORDER BY id').all(unrelated.personId),
      actions: db.raw.prepare('SELECT * FROM next_actions WHERE sales_cycle_id IN (SELECT id FROM sales_cycles WHERE person_id = ?) ORDER BY id').all(unrelated.personId),
      sources: db.raw.prepare('SELECT * FROM source_events WHERE person_id = ? ORDER BY id').all(unrelated.personId),
    }));
    const unrelatedBefore = await unrelatedFacts();
    const unrelatedRowsBefore = (await api.leads.list({ ...listRequest, query: 'Person unrelated-person' })).rows;
    expect(unrelatedRowsBefore.map(row => row.personId)).toEqual([unrelated.personId]);
    for (const records of Object.values(unrelatedBefore)) expect(records).toHaveLength(1);
    try {
      const listed = await api.leads.list({ ...listRequest, query: 'Person ready-person' });
      expect(listed.rows.map(row => row.personId)).toEqual([owner.personId]);
      const detail = await api.leadDetail.get({ personId: owner.personId });
      expect(detail).toMatchObject({ personId: owner.personId, salesCycleId: owner.cycleId, activities: [expect.objectContaining({ id: 'ready-call' })] });
      const before = await revision(f), callbacks = f.counts.callback;
      for (const badSender of [{ senderFrame: { url: 'https://untrusted.invalid/' } }, {}]) {
        sender = badSender;
        await expect(api.leads.list(listRequest)).rejects.toThrow('trusted renderer');
        await expect(api.leadDetail.get({ personId: owner.personId })).rejects.toThrow('trusted renderer');
      }
      sender = { senderFrame: { url: 'callie://app/index.html' } };
      const callsBeforeMalformedPreload = invoke.mock.calls.length;
      await expect(api.leads.list({ ...listRequest, limit: 0 })).rejects.toThrow();
      await expect(api.leadDetail.get({ personId: '' })).rejects.toThrow();
      expect(invoke.mock.calls).toHaveLength(callsBeforeMalformedPreload);
      await expect(invoke('leads:list', { ...listRequest, limit: 0 })).rejects.toThrow();
      await expect(invoke('lead-detail:get', { personId: owner.personId, extra: true })).rejects.toThrow();
      expect(f.counts.callback).toBe(callbacks); expect(await revision(f)).toBe(before);
      // The bridge carries only the two person reads, and the registry holds no person command channel.
      expect(Object.keys(api.leads)).toEqual(['list']);
      expect(Object.keys(api.leadDetail)).toEqual(['get']);
      for (const channel of removedPersonChannels) await expect(invoke(channel, {}), channel).rejects.toThrow('was not registered');
      const start = invoke.mock.calls.length;
      const snapshot = await api.daily.get();
      expect(dailySnapshotSchema.safeParse(snapshot).success).toBe(true);
      expect(invoke.mock.calls.slice(start)).toEqual([['daily:get']]);
      const beforeBadDaily = f.counts.callback;
      await expect(invoke('daily:get', undefined)).rejects.toThrow('DAILY_READ_FAILED');
      await expect(invoke('daily:get', {}, {})).rejects.toThrow('DAILY_READ_FAILED');
      expect(f.counts.callback).toBe(beforeBadDaily);
      expect(await unrelatedFacts()).toEqual(unrelatedBefore);
      expect((await api.leads.list({ ...listRequest, query: 'Person unrelated-person' })).rows).toEqual(unrelatedRowsBefore);
      expect(await f.runtime.withDatabase(db => db.raw.prepare('SELECT display_name FROM persons WHERE id = ?').get(owner.personId))).toEqual({ display_name: `Person ${owner.personId}` });
      expect(forbidden).not.toHaveBeenCalled();
    } finally { unregister(); unregister(); }
    const registered = electron.handle.mock.calls.map(call => call[0]);
    expect(new Set(registered).size).toBe(registered.length);
    expect(electron.removeHandler.mock.calls.map(call => call[0]).sort()).toEqual([...registered].sort());
  });
});
