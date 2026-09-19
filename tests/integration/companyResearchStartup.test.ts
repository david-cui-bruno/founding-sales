import { mkdirSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase, closeDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';
import { HealthService } from '../../src/main/health/healthService';
import { startApplication, type ApplicationStartupDependencies, type ApplicationStartupOptions } from '../../src/main/startApplication';
import type { FoundationRuntime } from '../../src/main/foundation/foundationRuntime';
import { createOutreachProviders } from '../../src/main/outreach/providers/outreachProviders';
import { createEmailService } from '../../src/main/outreach/emailService';
import type { SafeStorage } from '../../src/main/outreach/providers/providerTypes';
import { SqlDiscoveryReservationStore } from '../../src/main/delegation/discoveryReservationStore';
import { createTestWorkspaceKey, createTempDatabase } from '../fixtures/tempDatabase';
const task3Electron = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }));
vi.mock('electron', () => ({ safeStorage: {}, dialog: {}, shell: {}, ipcMain: task3Electron }));
const clock = { now: () => new Date().toISOString() };
const limits = { maxCompanies: 2, maxPages: 1, maxBytes: 10000, maxCostMicros: 100 };
const configuration = { workspaceId: 'fictional-workspace', budgetId: 'fictional-budget',
  audience: { residential: true as const, regions: ['Fictional Region'], terms: ['residential PM'] }, discoveryLimits: limits, researchLimits: limits,
  capability: { model: 'fixture-model', webSearch: true as const, searchCostMicros: 50, modelCostMicros: 50 },
  maxAccountBudgetMicros: 1000, permittedSources: ['https://example.invalid/'] };
const unexpected = (): never => { throw new Error('Forbidden external fixture operation'); };
const encryptionKey = randomBytes(32);
const safeStorage: SafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: value => {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]);
  },
  decryptString: value => {
    const cipher = createDecipheriv('aes-256-gcm', encryptionKey, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8');
  },
};
async function fixture(configured: boolean, hooks: { search?: () => Promise<void>; page?: () => Promise<void>; paired?: boolean; publicIpc?: boolean; response?: () => Response; resolve?: () => Promise<string[]>; config?: typeof configuration } = {}) {
  const temp = createTempDatabase();
  mkdirSync(dirname(temp.path), { recursive: true, mode: 0o700 });
  let runtime!: FoundationRuntime; let database!: AppDatabase; let ownedDomain!: DomainRuntime;
  if (hooks.publicIpc) { task3Electron.handle.mockReset(); task3Electron.removeHandler.mockReset(); }
  let delegation:import('../../src/main/delegation/delegationRuntime').DelegationRuntime|undefined;
  let lifecycle!: Parameters<NonNullable<ApplicationStartupOptions['registerOutboundLifecycle']>>[0];
  const requests: string[] = []; let factoryCalls = 0;
  let managerOwner: 'fixture' | 'startup' = 'fixture';
  let fixtureManagerDisposed = false;
  const manager = createOutreachProviders({ directory: join(dirname(temp.path), 'outreach'), safeStorage, openExternal: async () => unexpected(),
    fetch: async url => {
      requests.push(String(url));
      await hooks.search?.();
      return new Response(JSON.stringify({ status: 'completed', model: 'fixture-model', output: [
        { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [{ type: 'url', url: 'https://example.invalid/' }] } }, { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text',
          text: JSON.stringify({ companies: [{ name: 'Fictional PM', domain: 'example.invalid', sourceUrl: 'https://example.invalid/' }] }),
          annotations: [{ type: 'url_citation', url: 'https://example.invalid/' }] }] },
      ] }));
    } });
  const dispose = vi.spyOn(manager, 'dispose');
  const verifyAndDisposeManager = () => {
    try {
      // Ownership follows actual handoff, never the observed disposal count.
      expect(dispose).toHaveBeenCalledTimes(managerOwner === 'startup' || fixtureManagerDisposed ? 1 : 0);
    } finally {
      if (managerOwner === 'fixture' && !fixtureManagerDisposed) {
        fixtureManagerDisposed = true;
        manager.dispose();
        expect(dispose).toHaveBeenCalledTimes(1);
      }
    }
  };
  if (configured) await manager.configure({ apiKey: 'fictional-api-key', model: 'fixture-model' });
  const dependencies: ApplicationStartupDependencies = {
    loadWorkspaceKey: async () => createTestWorkspaceKey(), prepareEncryptedDatabase: async () => undefined,
    openDatabase, closeDatabase, migrateToLatest,
    createDomainRuntime: db => { database = db; return ownedDomain = new DomainRuntime({ database: db, clock, ids: { next: randomUUID } }); },
    createHealthService: options => new HealthService(options),
    registerOutreachIpc: options => {delegation=options.delegation;return hooks.publicIpc ? registerOutreachIpc(options) : () => undefined;},
    ...(hooks.paired?{createPairingStore:()=>({load:async()=>({endpoint:'https://worker.example.test',workspaceId:configuration.workspaceId,pairingId:'11111111-1111-4111-8111-111111111111',credential:'a'.repeat(43),emergencyCredential:'b'.repeat(43),generation:0,scopes:['commands:write' as const,'events:read' as const]}),redeem:async()=>unexpected()})}:{}),
    registerApplicationIpc: (...args) => { runtime = args[0]; return hooks.publicIpc ? registerApplicationIpc(...args) : () => undefined; },
    createResearchProviders: () => { factoryCalls++; managerOwner = 'startup'; return manager; },
    createEmailService: (gate, _path, providers) => {
      expect(providers === undefined || providers.researchCompanies === manager.researchCompanies).toBe(true);
      const service = createEmailService({ databaseGate: gate, providers: providers ?? (hooks.paired?{...manager,dispose:()=>undefined}:manager) });
      if (providers === undefined && !hooks.paired) managerOwner = 'startup';
      return service;
    },
    companyResearchResolve: hooks.resolve ?? (async () => ['93.184.216.34']),
    companyResearchHttp: async input => { requests.push(input.url); await hooks.page?.(); return hooks.response?.() ?? new Response('<p>We manage 240 residential units.</p>', { headers: { 'content-type': 'text/html' } }); },
    createBackupService: () => ({ start: async () => undefined, shutdown: async () => undefined, createBackup: unexpected, listAvailableBackups: async () => [] }),
    createRecoveryService: () => ({ status: unexpected, beginSetup: unexpected, saveSetupMaterial: unexpected, completeSetup: unexpected, selectAndRunRestoreDrill: unexpected, shutdown: async () => undefined }),
    createAppleBridgeSupervisor: unexpected,
  };
  try {
    const app = await startApplication({ appVersion: '1.0.0', userDataPath: dirname(temp.path), companyResearch: configured&&!hooks.paired ? (hooks.config ?? configuration) : undefined,
      registerOutboundLifecycle: callbacks => { lifecycle = callbacks; return () => undefined; }, createWindow: () => undefined }, dependencies);
    return { app, runtime, database, lifecycle, requests, get factoryCalls() { return factoryCalls; }, delegation, stopDomain: () => ownedDomain.shutdown(), async close() {
      try { await app.shutdown(); }
      finally { try { verifyAndDisposeManager(); } finally { temp.cleanup(); } }
    } };
  } catch (error) {
    try { verifyAndDisposeManager(); } finally { temp.cleanup(); }
    throw error;
  }
}
describe('actual startup company research composition', () => {
  it('is inert without approved configuration or a persisted discovery budget', async () => {
    const f = await fixture(false);
    try {
      // Startup owns one lazy credential manager even before research is configured.
      expect(f.factoryCalls).toBe(1);
      expect(f.app.companyResearch).toBeUndefined();
      expect(f.requests).toEqual([]);
      expect(f.database.raw.prepare('SELECT * FROM pm_accounts').all()).toEqual([]);
      expect(f.database.raw.prepare('SELECT * FROM discovery_reservations').all()).toEqual([]);
    } finally { await f.close(); }
    const configured = await fixture(true);
    try {
      expect(configured.factoryCalls).toBe(1);
      expect(await configured.app.companyResearch!.prepare(randomUUID(), new AbortController().signal)).toEqual({ status: 'blocked', accountIds: [] });
      expect(configured.requests).toEqual([]);
      expect(configured.database.raw.prepare('SELECT * FROM discovery_approved_budgets').all()).toEqual([]);
    } finally { await configured.close(); }
  });
  it('uses the real approved SQL ledger and shared credential manager to persist researched accounts once', async () => {
    const f = await fixture(true);
    try {
      await f.runtime.withDatabase(database => new SqlDiscoveryReservationStore({ database, workspaceId: configuration.workspaceId, clock })
        .approveBudget({ budgetId: configuration.budgetId, ceilingMicros: 100, evidenceRef: 'fictional-explicit-approval' }));
      expect(f.requests).toEqual([]);
      const command = randomUUID();
      const result = await f.app.companyResearch!.prepare(command, new AbortController().signal);
      expect(result.accountIds).toHaveLength(1);
      expect(await f.app.companyResearch!.runNext(new AbortController().signal)).toBe('completed');
      expect(f.requests).toEqual(['https://api.openai.com/v1/responses', 'https://example.invalid/']);
      expect(await f.app.companyResearch!.prepare(command, new AbortController().signal)).toEqual(result);
      expect(await f.app.companyResearch!.runNext(new AbortController().signal)).toBe('idle');
      expect(f.requests).toHaveLength(2);
      expect(f.database.raw.prepare('SELECT cost_micros FROM discovery_receipts').get()).toEqual({ cost_micros: null });
      expect(f.database.raw.prepare('SELECT * FROM pm_account_sources').all()).toHaveLength(1);
      expect(f.database.raw.prepare('SELECT * FROM pm_account_claims').all()).toHaveLength(2);
      expect(f.database.raw.prepare('SELECT * FROM cadence_enrollments').all()).toEqual([]);
      expect(await f.app.companyResearch!.prepare(randomUUID(), new AbortController().signal)).toEqual({ status: 'blocked', accountIds: [] });
      f.lifecycle.onLock();
      expect(await f.app.companyResearch!.runNext(new AbortController().signal)).toBe('idle');
    } finally { await f.close(); }
  });
});


it('retains uncertain discovery reservation after a lock and never repeats HTTP after unlock', async () => {
  let enter!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(true, { search: async () => { enter(); await gate; } });
  try {
    await f.runtime.withDatabase(database => new SqlDiscoveryReservationStore({ database, workspaceId: configuration.workspaceId, clock })
      .approveBudget({ budgetId: configuration.budgetId, ceilingMicros: 100, evidenceRef: 'fictional-explicit-approval' }));
    const command = randomUUID();
    const pending = f.app.companyResearch!.prepare(command, new AbortController().signal);
    const refused = expect(pending).rejects.toThrow();
    await entered;
    f.lifecycle.onLock(); release(); await refused;
    expect(f.database.raw.prepare('SELECT * FROM discovery_reservations').all()).toHaveLength(1);
    expect(f.database.raw.prepare('SELECT * FROM discovery_receipts').all()).toEqual([]);
    expect(f.database.raw.prepare('SELECT * FROM pm_accounts').all()).toEqual([]);
    f.lifecycle.onUnlock();
    expect(await f.app.companyResearch!.prepare(command, new AbortController().signal)).toEqual({ status: 'blocked', accountIds: [] });
    expect(f.requests).toEqual(['https://api.openai.com/v1/responses']);
  } finally { release(); await f.close(); }
});

it('parks a locked in-flight page and keeps shutdown admission closed', async () => {
  let enter!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(true, { page: async () => { enter(); await gate; } });
  try {
    await f.runtime.withDatabase(database => new SqlDiscoveryReservationStore({ database, workspaceId: configuration.workspaceId, clock })
      .approveBudget({ budgetId: configuration.budgetId, ceilingMicros: 100, evidenceRef: 'fictional-explicit-approval' }));
    await f.app.companyResearch!.prepare(randomUUID(), new AbortController().signal);
    const pending = f.app.companyResearch!.runNext(new AbortController().signal);
    await entered;
    f.lifecycle.onLock(); release();
    expect(await pending).toBe('parked');
    expect(f.database.raw.prepare('SELECT * FROM pm_account_sources').all()).toEqual([]);
    expect(f.database.raw.prepare('SELECT state,cost_micros FROM pm_account_research_jobs').get()).toEqual({ state: 'parked', cost_micros: null });
    await f.app.shutdown();
    expect(await f.app.companyResearch!.runNext(new AbortController().signal)).toBe('idle');
  } finally { release(); await f.close(); }
});

it('drains interrupted page work before closing the database and disposes the shared manager once', async () => {
  let enter!: () => void; let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(true, { page: async () => { enter(); await gate; } });
  try {
    await f.runtime.withDatabase(database => new SqlDiscoveryReservationStore({ database, workspaceId: configuration.workspaceId, clock })
      .approveBudget({ budgetId: configuration.budgetId, ceilingMicros: 100, evidenceRef: 'fictional-explicit-approval' }));
    await f.app.companyResearch!.prepare(randomUUID(), new AbortController().signal);
    const pending = f.app.companyResearch!.runNext(new AbortController().signal);
    await entered;
    const stopped = f.app.shutdown(); release();
    expect(await pending).toBe('parked');
    await stopped;
    const key = createTestWorkspaceKey();
    const reopened = openDatabase({ path: f.database.path, key });
    try {
      expect(reopened.raw.prepare('SELECT * FROM pm_account_sources').all()).toEqual([]);
      expect(reopened.raw.prepare('SELECT state,cost_micros FROM pm_account_research_jobs').get()).toEqual({ state: 'parked', cost_micros: null });
    } finally { closeDatabase(reopened); key.bytes.fill(0); }
  } finally { release(); await f.close(); }
});


it('returns current research API after persisted activation and reconfiguration',async()=>{
 const f=await fixture(true,{paired:true});const research={...configuration,audienceRevision:1,sourceRevision:1,budgetRevision:1,preparationCommandId:randomUUID()};
 try{
  expect(f.app.companyResearch).toBeUndefined();
  await f.delegation!.configure({expectedRevision:0,configuration:{version:1,state:'active',research}});
  expect(f.app.companyResearch).toBeDefined();const first=f.app.companyResearch!;
  await f.runtime.withDatabase(database=>new SqlDiscoveryReservationStore({database,workspaceId:configuration.workspaceId,clock}).approveBudget({budgetId:research.budgetId,ceilingMicros:100,evidenceRef:'explicit-first-budget'}));
  expect((await f.app.companyResearch!.prepare(randomUUID(),new AbortController().signal)).status).toBe('prepared');
  const second={...research,budgetId:'second-reviewed-budget',budgetRevision:2,preparationCommandId:randomUUID()};
  await f.delegation!.configure({expectedRevision:1,configuration:{version:1,state:'active',research:second}});
  expect(f.app.companyResearch).not.toBe(first);expect(await first.prepare(randomUUID(),new AbortController().signal)).toEqual({status:'blocked',accountIds:[]});
  await f.runtime.withDatabase(database=>new SqlDiscoveryReservationStore({database,workspaceId:configuration.workspaceId,clock}).approveBudget({budgetId:second.budgetId,ceilingMicros:100,evidenceRef:'explicit-second-budget'}));
  expect((await f.app.companyResearch!.prepare(randomUUID(),new AbortController().signal)).status).toBe('prepared');expect(f.requests).toHaveLength(2);
  f.lifecycle.onLock();expect((await f.app.companyResearch!.prepare(randomUUID(),new AbortController().signal)).status).toBe('blocked');
  await expect(f.delegation!.configure({expectedRevision:2,configuration:{version:1,state:'active',research:second}})).rejects.toThrow();
  f.lifecycle.onUnlock();await f.delegation!.configure({expectedRevision:2,configuration:{version:1,state:'paused',research:null}});expect(f.app.companyResearch).toBeUndefined();
 }finally{await f.close();}
});

// Task 3: exercise the actual startup -> application registrar -> provider -> preload path.
import { registerOutreachIpc } from '../../src/main/ipc/registerOutreachIpc';
import { createCallieApi } from '../../src/preload/createCallieApi';
import { registerApplicationIpc } from '../../src/main/ipc/registerApplicationIpc';
import { createLocalWorkspaceApi } from '../../src/preload/apis/localWorkspaceApi';
import { createIpcClient } from '../../src/preload/ipcClient';
import { registeredIpcHandler } from '../fixtures/registeredIpcHandler';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { localCompanyResearchStatusSchema, type SelectedResearch } from '../../src/shared/contracts/localWorkspaceContract';
const task3Trusted = { senderFrame: { url: 'callie://app/index.html' } };
type StartupFixture = Awaited<ReturnType<typeof fixture>>;
function task3Api() {
  return createLocalWorkspaceApi(createIpcClient({ invoke: async (channel, ...args) =>
    registeredIpcHandler(task3Electron.handle, channel)(task3Trusted, ...args) }));
}
function task3Repo(f: StartupFixture, at = clock.now()) {
  return new AccountRepository({ database: f.database, clock: { now: () => at }, ids: { next: randomUUID }, research: { maxBudgetMicros: 1000 } });
}
function task3Seed(f: StartupFixture, name = 'Selected saved company', domain: string | null = 'example.invalid') {
  const account = task3Repo(f).create({ commandId: randomUUID(), name, domain });
  return Object.freeze({ commandId: randomUUID(), accountId: account.id });
}
function task3Row(f: StartupFixture, input: SelectedResearch) {
  return f.database.raw.prepare('SELECT * FROM pm_account_research_jobs WHERE command_id=?').get(input.commandId);
}
function task3Unrelated(f: StartupFixture, input: SelectedResearch) {
  return {
    jobs: f.database.raw.prepare('SELECT * FROM pm_account_research_jobs WHERE account_id<>? ORDER BY id').all(input.accountId),
    commands: f.database.raw.prepare('SELECT * FROM pm_account_commands WHERE account_id<>? ORDER BY command_id').all(input.accountId),
    reservations: f.database.raw.prepare('SELECT * FROM discovery_reservations ORDER BY command_id').all(),
  };
}
function task3Outcome<T>(promise: Promise<T>) {
  return promise.then(value => ({ kind: 'value' as const, value }), error => ({ kind: 'error' as const, error }));
}
function task3Hold() {
  let release!: () => void; let enter!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<'entered'>(resolve => { enter = () => resolve('entered'); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: Promise<'timeout'> | undefined;
  const owned = new Set<Promise<void>>();
  const page = () => {
    const pending = (async () => { enter(); await gate; })(); owned.add(pending);
    return pending;
  };
  return { entered, get deadline() { return deadline ??= new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), 2000); }); },
    release, page, drain: () => Promise.allSettled([...owned]), clear: () => clearTimeout(timer) };
}

describe('Task 3 selected public startup research', () => {
  it('researches only the selected saved account with real parsed attested evidence and no discovery or create', async () => {
    const f = await fixture(true, { publicIpc: true });
    try {
      const api = task3Api();
      expect(typeof api.researchCompany).toBe('function');
      expect(typeof api.getCompanyResearchStatus).toBe('function');
      expect(Object.keys(api)).not.toContain('prepare'); expect(Object.keys(api)).not.toContain('runNext');
      expect(f.requests).toEqual([]);
      expect(f.database.raw.prepare('SELECT * FROM pm_account_research_jobs').all()).toEqual([]);
      const other = task3Seed(f, 'Older unrelated', 'other.invalid');
      task3Repo(f, '2026-09-08T12:00:00.000Z').enqueue({ ...other, limits });
      const selected = task3Seed(f);
      const untouched = task3Unrelated(f, selected);
      const accounts = f.database.raw.prepare('SELECT id FROM pm_accounts ORDER BY id').all();
      const create = vi.spyOn(AccountRepository.prototype, 'create');
      const enqueue = vi.spyOn(AccountRepository.prototype, 'enqueue');
      const leases = vi.spyOn(f.runtime, 'withDatabase');
      expect(await api.getCompanyResearchStatus(selected)).toEqual({ ...selected, state: 'not_recorded', receipt: null, reason: null });
      expect(enqueue).not.toHaveBeenCalled(); expect(f.requests).toEqual([]);
      const result = await api.researchCompany(selected);
      expect(result).toMatchObject({ ...selected, state: 'completed', receipt: { accountId: selected.accountId, version: 2, duplicate: false } });
      expect(f.requests).toEqual(['https://example.invalid/']);
      expect(create).not.toHaveBeenCalled(); expect(enqueue).toHaveBeenCalledTimes(1);
      expect(enqueue).toHaveBeenCalledWith({ ...selected, limits });
      expect(leases.mock.calls.length).toBeGreaterThan(3);
      expect(task3Unrelated(f, selected)).toEqual(untouched);
      expect(f.database.raw.prepare('SELECT id FROM pm_accounts ORDER BY id').all()).toEqual(accounts);
      const detail = await api.getCompany({ accountId: selected.accountId });
      expect(detail.sources).toHaveLength(1); expect(detail.snapshot.claims).toHaveLength(2);
      expect(detail.sources[0]).toMatchObject({ url: 'https://example.invalid/', permitted: true, excerpt: '<p>We manage 240 residential units.</p>' });
      expect(await api.getCompanyResearchStatus(selected)).toEqual(result);
      expect(await api.researchCompany(selected)).toEqual(result);
      expect(enqueue).toHaveBeenCalledTimes(1); expect(f.requests).toHaveLength(1);
      expect(task3Unrelated(f, selected)).toEqual(untouched);
    } finally { try { await f.close(); } finally { vi.restoreAllMocks(); } }
  });

  it('holds an absent command without capability then explicitly replays the same UUID after restoration, never on reads', async () => {
    const f = await fixture(true, { publicIpc: true, paired: true });
    try {
      const api = task3Api(); const selected = task3Seed(f);
      expect(typeof api.researchCompany).toBe('function');
      expect(f.app.companyResearch).toBeUndefined();
      expect(await api.researchCompany(selected)).toMatchObject({ ...selected, state: 'held', receipt: null });
      expect(task3Row(f, selected)).toBeUndefined(); expect(f.requests).toEqual([]);
      expect(await api.getCompanyResearchStatus(selected)).toMatchObject({ ...selected, state: 'not_recorded' });
      const research = { ...configuration, audienceRevision: 1, sourceRevision: 1, budgetRevision: 1, preparationCommandId: randomUUID() };
      await f.delegation!.configure({ expectedRevision: 0, configuration: { version: 1, state: 'active', research } });
      expect(f.app.companyResearch).toBeDefined();
      expect(await api.getCompanyResearchStatus(selected)).toMatchObject({ ...selected, state: 'not_recorded' });
      expect(task3Row(f, selected)).toBeUndefined(); expect(f.requests).toEqual([]);
      expect(await api.researchCompany(selected)).toMatchObject({ ...selected, state: 'completed' });
      expect(f.requests).toEqual(['https://example.invalid/']);
      expect(f.database.raw.prepare('SELECT command_id FROM pm_account_research_jobs').all()).toEqual([{ command_id: selected.commandId }]);
    } finally { await f.close(); }
  });

  it('uses a fresh current getter and saved queued limits after reconfiguration, with explicit-only Resume', async () => {
    const f = await fixture(true, { publicIpc: true, paired: true });
    try {
      const api = task3Api(); const other = task3Seed(f, 'Older', 'other.invalid');
      task3Repo(f, '2026-09-08T12:00:00.000Z').enqueue({ ...other, limits });
      const selected = task3Seed(f); const savedLimits = { ...limits, maxBytes: 9000, maxCostMicros: 70 };
      task3Repo(f, '2026-09-08T12:00:01.000Z').enqueue({ ...selected, limits: savedLimits });
      const before = task3Row(f, selected); const untouched = task3Unrelated(f, selected);
      expect(await api.researchCompany(selected)).toMatchObject({ ...selected, state: 'queued' });
      const research = { ...configuration, researchLimits: { ...limits, maxBytes: 1 }, audienceRevision: 1, sourceRevision: 1, budgetRevision: 1, preparationCommandId: randomUUID() };
      await f.delegation!.configure({ expectedRevision: 0, configuration: { version: 1, state: 'active', research } });
      const first = f.app.companyResearch;
      await f.delegation!.configure({ expectedRevision: 1, configuration: { version: 1, state: 'active', research: { ...research, budgetRevision: 2, preparationCommandId: randomUUID() } } });
      expect(f.app.companyResearch).not.toBe(first);
      const old = vi.spyOn(first!, 'researchCompany'); const current = vi.spyOn(f.app.companyResearch!, 'researchCompany');
      for (let i = 0; i < 2; i++) expect(await api.getCompanyResearchStatus(selected)).toMatchObject({ ...selected, state: 'queued' });
      expect(task3Row(f, selected)).toEqual(before); expect(f.requests).toEqual([]);
      expect(old).not.toHaveBeenCalled(); expect(current).not.toHaveBeenCalled();
      const enqueue = vi.spyOn(AccountRepository.prototype, 'enqueue');
      expect(await api.researchCompany(selected)).toMatchObject({ ...selected, state: 'completed' });
      expect(old).not.toHaveBeenCalled(); expect(current).toHaveBeenCalledTimes(1); expect(enqueue).not.toHaveBeenCalled();
      expect(task3Row(f, selected)).toMatchObject({ limits_json: JSON.stringify(savedLimits), reserved_cost_micros: 70 });
      expect(task3Unrelated(f, selected)).toEqual(untouched); expect(f.requests).toHaveLength(1);
    } finally { try { await f.close(); } finally { vi.restoreAllMocks(); } }
  });

  it('does not bypass a genuinely stopped domain merely because storage status is available', async () => {
    const f = await fixture(true, { publicIpc: true });
    try {
      const api = task3Api(); const selected = task3Seed(f);
      expect(typeof api.researchCompany).toBe('function'); expect(f.app.companyResearch).toBeDefined();
      expect(await api.getCompany({ accountId: selected.accountId })).toMatchObject({ snapshot: { account: { id: selected.accountId } } });
      f.stopDomain();
      await expect(f.runtime.withDomain((): void => undefined)).rejects.toThrow();
      expect(await api.getCompanyResearchStatus(selected)).toMatchObject({ ...selected, state: 'not_recorded' });
      expect(await api.researchCompany(selected)).toMatchObject({ ...selected, state: 'held', receipt: null, reason: expect.any(String) });
      expect(await f.app.companyResearch!.researchCompany(selected)).toMatchObject({ ...selected, state: 'held', receipt: null, reason: expect.any(String) });
      expect(task3Row(f, selected)).toBeUndefined(); expect(f.requests).toEqual([]);
    } finally { await f.close(); }
  });

  it.each(['denied URL', 'private IP', 'unsafe redirect', 'page budget', 'byte budget'] as const)('parks actual page-policy failure: %s', async failure => {
    const f: StartupFixture = await fixture(true, { publicIpc: true,
      config: { ...configuration, permittedSources: failure === 'denied URL' ? ['https://other.invalid/'] : ['https://example.invalid/', 'https://example.invalid/services'] },
      resolve: async () => failure === 'private IP' ? ['127.0.0.1'] : ['93.184.216.34'],
      page: async () => { expect(f.database.raw.inTransaction).toBe(false); },
      response: () => failure === 'unsafe redirect' ? new Response('redirect', { status: 302, headers: { location: 'http://127.0.0.1/private' } })
        : failure === 'page budget' ? new Response('redirect', { status: 302, headers: { location: '/services' } })
        : new Response('x'.repeat(10001), { headers: { 'content-type': 'text/html' } }),
    });
    try {
      const api = task3Api(); const selected = task3Seed(f);
      expect(typeof api.researchCompany).toBe('function');
      expect(await api.researchCompany(selected)).toMatchObject({ ...selected, state: 'parked', receipt: null });
      expect(task3Row(f, selected)).toMatchObject({ state: 'parked', attempt: 1, cost_micros: null, reserved_cost_micros: 100 });
      expect(f.requests).toHaveLength(['denied URL', 'private IP'].includes(failure) ? 0 : 1);
      expect(f.database.raw.prepare('SELECT * FROM pm_account_sources').all()).toEqual([]);
      expect(task3Repo(f).snapshot(selected.accountId, clock.now()).account.version).toBe(1);
      const row = task3Row(f, selected); const calls = [...f.requests];
      expect(await api.getCompanyResearchStatus(selected)).toMatchObject({ ...selected, state: 'parked' });
      expect(await api.researchCompany(selected)).toMatchObject({ ...selected, state: 'parked' });
      expect(task3Row(f, selected)).toEqual(row); expect(f.requests).toEqual(calls);
    } finally { await f.close(); }
  });

  it('keeps HTTP outside write transactions and parks account-version CAS changed during fetch', async () => {
    let selected!: SelectedResearch;
    const f: StartupFixture = await fixture(true, { publicIpc: true, page: async () => {
      expect(f.database.raw.inTransaction).toBe(false);
      await f.runtime.withDatabase(() => task3Repo(f).admitEvidence({ commandId: randomUUID(), accountId: selected.accountId, expectedVersion: 1, sources: [], claims: [], routes: [] }));
    } });
    try {
      selected = task3Seed(f); const api = task3Api();
      expect(await api.researchCompany(selected)).toMatchObject({ ...selected, state: 'parked', receipt: null });
      expect(f.requests).toHaveLength(1); expect(task3Repo(f).snapshot(selected.accountId, clock.now()).account.version).toBe(2);
      expect(f.database.raw.prepare('SELECT * FROM pm_account_sources').all()).toEqual([]);
      expect(task3Row(f, selected)).toMatchObject({ state: 'parked', receipt_command_id: null, cost_micros: null });
    } finally { await f.close(); }
  });

  it('reconciles a committed running receipt after lost settlement through the actual worker with zero additional HTTP', async () => {
    const f = await fixture(true, { publicIpc: true });
    try {
      const api = task3Api(); const selected = task3Seed(f); const other = task3Seed(f, 'Unrelated receipt recovery', 'other.invalid');
      task3Repo(f, '2026-09-08T12:00:00.000Z').enqueue({ ...other, limits });
      const untouched = task3Unrelated(f, selected);
      const original = AccountRepository.prototype.settle; let lose = true;
      const settle = vi.spyOn(AccountRepository.prototype, 'settle').mockImplementation(function (this: AccountRepository, input) {
        if (lose && input.status === 'completed') { lose = false; throw new Error('fixture lost settlement response'); }
        return original.call(this, input);
      });
      await expect(api.researchCompany(selected)).rejects.toThrow();
      expect(f.requests).toEqual(['https://example.invalid/']);
      const running = task3Row(f, selected) as { id: string; receipt_command_id: string };
      expect(running).toMatchObject({ state: 'running', receipt_command_id: running.id });
      expect(running.id).not.toBe(selected.commandId);
      expect(f.database.raw.prepare('SELECT account_id,account_version FROM pm_account_commands WHERE command_id=?').get(running.id)).toEqual({ account_id: selected.accountId, account_version: 2 });
      const committed = await api.getCompanyResearchStatus(selected);
      expect(committed).toMatchObject({ ...selected, state: 'completed', receipt: { accountId: selected.accountId, version: 2 } });
      const beforeCalls = settle.mock.calls.length;
      expect(await api.getCompanyResearchStatus(selected)).toEqual(committed);
      expect(settle).toHaveBeenCalledTimes(beforeCalls); expect(task3Row(f, selected)).toEqual(running);
      expect(await api.researchCompany(selected)).toEqual(committed);
      expect(settle).toHaveBeenCalledTimes(beforeCalls + 1);
      expect(task3Row(f, selected)).toMatchObject({ state: 'completed' });
      expect(f.requests).toHaveLength(1); expect(task3Unrelated(f, selected)).toEqual(untouched);
    } finally { try { await f.close(); } finally { vi.restoreAllMocks(); } }
  });

  it.each(['unexpired', 'expired', 'parked'] as const)('never reacquires ambiguous %s saved work on explicit replay', async state => {
    const f = await fixture(true, { publicIpc: true });
    try {
      const api = task3Api(); const selected = task3Seed(f); const repo = task3Repo(f);
      repo.enqueue({ ...selected, limits });
      const job = repo.claimSelected(state === 'expired' ? '2026-09-08T12:00:00.000Z' : clock.now(), selected)!;
      expect(job.accountId).toBe(selected.accountId);
      if (state === 'parked') repo.settle({ jobId: job.id, claimToken: job.claimToken, status: 'parked', receiptCommandId: null, costMicros: null });
      expect(await api.getCompanyResearchStatus(selected)).toMatchObject({ ...selected, state: state === 'parked' ? 'parked' : 'running' });
      expect(await api.researchCompany(selected)).toMatchObject({ ...selected, state: state === 'unexpired' ? 'running' : 'parked' });
      expect(f.requests).toEqual([]);
      expect(task3Row(f, selected)).toMatchObject({ attempt: 1, reserved_cost_micros: 100, cost_micros: null });
      const before = task3Row(f, selected);
      await api.researchCompany(selected); expect(task3Row(f, selected)).toEqual(before);
    } finally { await f.close(); }
  });

  it.each(['lock', 'wake', 'shutdown'] as const)('guards double Resume, cancels on %s, and drains the real owner after releasing held HTTP', async invalidation => {
    const hold = task3Hold();
    const f = await fixture(true, { publicIpc: true, page: hold.page });
    let pending: ReturnType<typeof task3Outcome<Awaited<ReturnType<ReturnType<typeof task3Api>['researchCompany']>>>> | undefined;
    let stopping: ReturnType<typeof task3Outcome<void>> | undefined;
    try {
      const api = task3Api(); const selected = task3Seed(f);
      expect(typeof api.researchCompany).toBe('function');
      pending = task3Outcome(api.researchCompany(selected));
      expect(await Promise.race([hold.entered, pending, hold.deadline])).toBe('entered');
      expect(f.requests).toHaveLength(1); expect(task3Row(f, selected)).toMatchObject({ state: 'running' });
      const duplicate = task3Outcome(api.researchCompany(selected));
      const duplicateResult = await Promise.race([duplicate, hold.deadline]);
      expect(duplicateResult).not.toBe('timeout');
      if (duplicateResult !== 'timeout' && duplicateResult.kind === 'value') expect(duplicateResult.value).toMatchObject({ ...selected, state: 'held' });
      expect(f.requests).toHaveLength(1);
      expect(await api.getCompanyResearchStatus(selected)).toMatchObject({ ...selected, state: 'running' });
      if (invalidation === 'shutdown') stopping = task3Outcome(f.app.shutdown());
      else if (invalidation === 'lock') f.lifecycle.onLock();
      else f.lifecycle.onWake();
      hold.release();
      expect(await Promise.race([pending, hold.deadline])).not.toBe('timeout');
      if (stopping) {
        expect(await Promise.race([stopping, hold.deadline])).toEqual({ kind: 'value', value: undefined });
        expect(f.database.raw.open).toBe(false);
      } else {
        expect(await api.getCompanyResearchStatus(selected)).toMatchObject({ ...selected, state: 'parked' });
        if (invalidation === 'lock') {
          const fresh = Object.freeze({ ...selected, commandId: randomUUID() });
          expect(await api.researchCompany(fresh)).toMatchObject({ ...fresh, state: 'held' });
          expect(task3Row(f, fresh)).toBeUndefined(); f.lifecycle.onUnlock();
        }
        expect(await api.researchCompany(selected)).toMatchObject({ ...selected, state: 'parked' });
        expect(f.database.raw.prepare('SELECT * FROM pm_account_sources').all()).toEqual([]);
      }
      expect(f.requests).toHaveLength(1);
    } finally {
      hold.release(); await hold.drain(); if (pending) await Promise.race([pending, hold.deadline]); if (stopping) await stopping;
      try { await f.close(); } finally { hold.clear(); }
    }
  });
});

it('Task 3 lost transport before dispatch leaves not_recorded and explicit original-command replay enqueues exactly once', async () => {
  const f = await fixture(true, { publicIpc: true });
  try {
    const selected = task3Seed(f); let lose = true;
    const api = createLocalWorkspaceApi(createIpcClient({ invoke: async (channel, ...args) => {
      if (channel === 'local-workspace:research-company' && lose) { lose = false; throw new Error('fixture transport unavailable before dispatch'); }
      return registeredIpcHandler(task3Electron.handle, channel)(task3Trusted, ...args);
    } }));
    expect(typeof api.researchCompany).toBe('function');
    const enqueue = vi.spyOn(AccountRepository.prototype, 'enqueue');
    await expect(api.researchCompany(selected)).rejects.toThrow();
    expect(await api.getCompanyResearchStatus(selected)).toMatchObject({ ...selected, state: 'not_recorded' });
    expect(task3Row(f, selected)).toBeUndefined(); expect(enqueue).not.toHaveBeenCalled(); expect(f.requests).toEqual([]);
    expect(await api.researchCompany(selected)).toMatchObject({ ...selected, state: 'completed' });
    expect(await api.researchCompany(selected)).toMatchObject({ ...selected, state: 'completed' });
    expect(enqueue).toHaveBeenCalledTimes(1); expect(enqueue).toHaveBeenCalledWith({ ...selected, limits });
    expect(f.requests).toHaveLength(1); expect(f.database.raw.prepare('SELECT command_id FROM pm_account_research_jobs').all()).toEqual([{ command_id: selected.commandId }]);
  } finally { try { await f.close(); } finally { vi.restoreAllMocks(); } }
});

it('Task 3 a lost response with a late original in-flight invocation cannot acquire concurrently after not_recorded', async () => {
  const f = await fixture(true, { publicIpc: true }); const hold = task3Hold();
  let originalOutcome: ReturnType<typeof task3Outcome<unknown>> | undefined;
  try {
    const selected = task3Seed(f); const api = task3Api();
    expect(typeof f.app.companyResearch!.researchCompany).toBe('function');
    const execution = f.app.companyResearch!.researchCompany.bind(f.app.companyResearch!);
    let enteredPort = false; let holdNextLease = true;
    vi.spyOn(f.app.companyResearch!, 'researchCompany').mockImplementation(input => { enteredPort = true; return execution(input); });
    const lease = f.runtime.withDatabase.bind(f.runtime);
    const delayed: FoundationRuntime['withDatabase'] = operation => lease(async (database: AppDatabase) => {
      if (enteredPort && holdNextLease) { holdNextLease = false; await hold.page(); }
      return operation(database);
    });
    vi.spyOn(f.runtime, 'withDatabase').mockImplementation(delayed);
    const lossy = createLocalWorkspaceApi(createIpcClient({ invoke: async (channel, ...args) => {
      originalOutcome = task3Outcome(Promise.resolve(registeredIpcHandler(task3Electron.handle, channel)(task3Trusted, ...args)));
      throw new Error('fixture renderer lost response while main continues');
    } }));
    await expect(lossy.researchCompany(selected)).rejects.toThrow();
    expect(originalOutcome).toBeDefined();
    expect(await Promise.race([hold.entered, originalOutcome!, hold.deadline])).toBe('entered');
    expect(await api.getCompanyResearchStatus(selected)).toMatchObject({ ...selected, state: 'not_recorded' });
    expect(task3Row(f, selected)).toBeUndefined(); expect(f.requests).toEqual([]);
    const replay = task3Outcome(api.researchCompany(selected));
    const result = await Promise.race([replay, hold.deadline]);
    expect(result).not.toBe('timeout');
    if (result !== 'timeout' && result.kind === 'value') expect(result.value).toMatchObject({ ...selected, state: 'held' });
    expect(task3Row(f, selected)).toBeUndefined(); expect(f.requests).toEqual([]);
    hold.release();
    const originalResult = await Promise.race([originalOutcome!, hold.deadline]);
    expect(originalResult).toMatchObject({ kind: 'value', value: { ...selected, state: 'completed' } });
    expect(await api.researchCompany(selected)).toMatchObject({ ...selected, state: 'completed' });
    expect(f.requests).toHaveLength(1); expect(f.database.raw.prepare('SELECT command_id FROM pm_account_research_jobs').all()).toEqual([{ command_id: selected.commandId }]);
  } finally {
    hold.release(); await hold.drain(); if (originalOutcome) await Promise.race([originalOutcome, hold.deadline]);
    try { await f.close(); } finally { vi.restoreAllMocks(); hold.clear(); }
  }
});

it('Task 3 startup shutdown waits for an acquired selected-research storage callback before database close', async () => {
  const f = await fixture(true, { publicIpc: true }); const hold = task3Hold();
  let pending: ReturnType<typeof task3Outcome<unknown>> | undefined;
  let stopping: ReturnType<typeof task3Outcome<void>> | undefined;
  try {
    const selected = task3Seed(f); const api = task3Api();
    expect(typeof f.app.companyResearch!.researchCompany).toBe('function');
    const execute = f.app.companyResearch!.researchCompany.bind(f.app.companyResearch!);
    let admitted = false; let holdOnce = true;
    vi.spyOn(f.app.companyResearch!, 'researchCompany').mockImplementation(input => { admitted = true; return execute(input); });
    const lease = f.runtime.withDatabase.bind(f.runtime);
    const delay: FoundationRuntime['withDatabase'] = operation => lease(async (database: AppDatabase) => {
      if (admitted && holdOnce) { holdOnce = false; await hold.page(); }
      return operation(database);
    });
    vi.spyOn(f.runtime, 'withDatabase').mockImplementation(delay);
    pending = task3Outcome(api.researchCompany(selected));
    expect(await Promise.race([hold.entered, pending, hold.deadline])).toBe('entered');
    expect(f.database.raw.open).toBe(true);
    let closed = false; stopping = task3Outcome(f.app.shutdown().then(() => { closed = true; }));
    // Flush immediate promise work only. This does not claim to cancel native execution.
    await Promise.resolve(); await Promise.resolve();
    expect(closed).toBe(false); expect(f.database.raw.open).toBe(true);
    hold.release(); expect(await Promise.race([pending, hold.deadline])).not.toBe('timeout');
    expect(await Promise.race([stopping, hold.deadline])).toEqual({ kind: 'value', value: undefined });
    expect(f.database.raw.open).toBe(false); expect(f.requests).toEqual([]);
  } finally {
    hold.release(); await hold.drain(); if (pending) await Promise.race([pending, hold.deadline]); if (stopping) await stopping;
    try { await f.close(); } finally { vi.restoreAllMocks(); hold.clear(); }
  }
});

it('Task 3 saved queued work preserves global uncertain spend until explicit replay under restored approved budget', async () => {
  const f = await fixture(true, { paired: true, publicIpc: true });
  try {
    const api = task3Api(); const other = task3Seed(f, 'Uncertain other', 'other.invalid');
    const repo = task3Repo(f, '2026-09-08T12:00:00.000Z');
    repo.enqueue({ ...other, limits }); const otherJob = repo.claimSelected('2026-09-08T12:00:00.000Z', other)!;
    expect(otherJob.accountId).toBe(other.accountId);
    repo.settle({ jobId: otherJob.id, claimToken: otherJob.claimToken, status: 'parked', receiptCommandId: null, costMicros: null });
    const selected = task3Seed(f); task3Repo(f, '2026-09-08T12:00:01.000Z').enqueue({ ...selected, limits });
    const untouched = task3Unrelated(f, selected);
    const research = { ...configuration, maxAccountBudgetMicros: 100, audienceRevision: 1, sourceRevision: 1, budgetRevision: 1, preparationCommandId: randomUUID() };
    await f.delegation!.configure({ expectedRevision: 0, configuration: { version: 1, state: 'active', research } });
    expect(await api.researchCompany(selected)).toMatchObject({ ...selected, state: 'queued' });
    expect(f.requests).toEqual([]); expect(task3Row(f, selected)).toMatchObject({ attempt: 0, reserved_cost_micros: 0 });
    await f.delegation!.configure({ expectedRevision: 1, configuration: { version: 1, state: 'active', research: { ...research, maxAccountBudgetMicros: 200, budgetRevision: 2, preparationCommandId: randomUUID() } } });
    expect(await api.getCompanyResearchStatus(selected)).toMatchObject({ ...selected, state: 'queued' });
    expect(f.requests).toEqual([]); expect(task3Unrelated(f, selected)).toEqual(untouched);
    expect(await api.researchCompany(selected)).toMatchObject({ ...selected, state: 'completed' });
    expect(task3Unrelated(f, selected)).toEqual(untouched); expect(f.requests).toEqual(['https://example.invalid/']);
  } finally { await f.close(); }
});

it('Task 3 direct startup freezes selected command and account before its first asynchronous lease', async () => {
  const f = await fixture(true, { publicIpc: true }); const hold = task3Hold();
  let pending: ReturnType<typeof task3Outcome<unknown>> | undefined;
  try {
    const selected = task3Seed(f); const mutable = { ...selected };
    expect(typeof f.app.companyResearch!.researchCompany).toBe('function');
    const lease = f.runtime.withDatabase.bind(f.runtime); let once = true;
    const delayed: FoundationRuntime['withDatabase'] = operation => lease(async (database: AppDatabase) => {
      if (once) { once = false; await hold.page(); }
      return operation(database);
    });
    vi.spyOn(f.runtime, 'withDatabase').mockImplementation(delayed);
    pending = task3Outcome(f.app.companyResearch!.researchCompany(mutable));
    mutable.commandId = randomUUID(); mutable.accountId = 'mutated-account';
    expect(await Promise.race([hold.entered, pending, hold.deadline])).toBe('entered');
    hold.release();
    expect(await Promise.race([pending, hold.deadline])).toMatchObject({ kind: 'value', value: { ...selected, state: 'completed' } });
    expect(task3Row(f, selected)).toMatchObject({ account_id: selected.accountId, command_id: selected.commandId, state: 'completed' });
    expect(task3Row(f, mutable)).toBeUndefined(); expect(f.requests).toHaveLength(1);
  } finally {
    hold.release(); await hold.drain(); if (pending) await Promise.race([pending, hold.deadline]);
    try { await f.close(); } finally { vi.restoreAllMocks(); hold.clear(); }
  }
});


it('Task 3 an empty approved source list holds a valid saved account before enqueue without changing any stored state', async () => {
  const f = await fixture(true, { publicIpc: true, config: { ...configuration, permittedSources: [] } });
  try {
    const api = task3Api(); const selected = task3Seed(f);
    expect(typeof api.researchCompany).toBe('function');
    expect(typeof f.app.companyResearch!.researchCompany).toBe('function');
    expect((await api.getCompany({ accountId: selected.accountId })).snapshot.account.id).toBe(selected.accountId);
    const storedState = () => {
      const tables = f.database.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
      return { changes: f.database.raw.prepare('SELECT total_changes() AS changes').get(),
        tables: tables.map(({ name }) => ({ name, rows: f.database.raw.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() })) };
    };
    const before = storedState();
    const enqueue = vi.spyOn(AccountRepository.prototype, 'enqueue');
    const publicResult = await api.researchCompany(selected);
    expect(localCompanyResearchStatusSchema.parse(publicResult)).toEqual(publicResult);
    expect(publicResult).toMatchObject({ ...selected, state: 'held', receipt: null, reason: expect.any(String) });
    const directResult = await f.app.companyResearch!.researchCompany(selected);
    expect(localCompanyResearchStatusSchema.parse(directResult)).toEqual(directResult);
    expect(directResult).toMatchObject({ ...selected, state: 'held', receipt: null, reason: expect.any(String) });
    expect(await api.getCompanyResearchStatus(selected)).toEqual({ ...selected, state: 'not_recorded', receipt: null, reason: null });
    expect(enqueue).not.toHaveBeenCalled(); expect(task3Row(f, selected)).toBeUndefined();
    expect(f.requests).toEqual([]); expect(storedState()).toEqual(before);
  } finally { try { await f.close(); } finally { vi.restoreAllMocks(); } }
});

// Task4 public-boundary coverage adds unrelated-queue interference to retained Task3 recovery controls.
it('Task 4 lost-before-dispatch recovery preserves an older unrelated job and evidence through the same-command replay', async () => {
  const f = await fixture(true, { publicIpc: true });
  try {
    const other = task3Seed(f, 'Older unrelated lost transport', 'other.invalid');
    task3Repo(f, '2026-09-08T12:00:00.000Z').enqueue({ ...other, limits });
    expect(task3Row(f, other)).toMatchObject({ created_at: '2026-09-08T12:00:00.000Z', state: 'queued', attempt: 0, reserved_cost_micros: 0 });
    const selected = task3Seed(f); const untouched = task3Unrelated(f, selected);
    const otherDetail = await task3Api().getCompany({ accountId: other.accountId });
    let lose = true;
    const api = createLocalWorkspaceApi(createIpcClient({ invoke: async (channel, ...args) => {
      if (channel === 'local-workspace:research-company' && lose) { lose = false; throw new Error('fixture transport unavailable before dispatch'); }
      return registeredIpcHandler(task3Electron.handle, channel)(task3Trusted, ...args);
    } }));
    expect(typeof api.researchCompany).toBe('function');
    const enqueue = vi.spyOn(AccountRepository.prototype, 'enqueue');
    await expect(api.researchCompany(selected)).rejects.toThrow();
    expect(await api.getCompanyResearchStatus(selected)).toMatchObject({ ...selected, state: 'not_recorded' });
    expect(task3Row(f, selected)).toBeUndefined(); expect(enqueue).not.toHaveBeenCalled(); expect(f.requests).toEqual([]);
    expect(task3Unrelated(f, selected)).toEqual(untouched);
    expect(await api.researchCompany(selected)).toMatchObject({ ...selected, state: 'completed' });
    expect(await api.researchCompany(selected)).toMatchObject({ ...selected, state: 'completed' });
    expect(enqueue).toHaveBeenCalledTimes(1); expect(enqueue).toHaveBeenCalledWith({ ...selected, limits });
    expect(f.requests).toHaveLength(1); expect(f.database.raw.prepare('SELECT command_id FROM pm_account_research_jobs WHERE account_id=?').all(selected.accountId)).toEqual([{ command_id: selected.commandId }]);
    expect(task3Unrelated(f, selected)).toEqual(untouched);
    expect(await api.getCompany({ accountId: other.accountId })).toMatchObject({ scope: otherDetail.scope, snapshot: otherDetail.snapshot, sources: otherDetail.sources, links: otherDetail.links });
    expect(f.database.raw.prepare('SELECT COUNT(*) AS n FROM pm_account_research_jobs').get()).toEqual({ n: 2 });
  } finally { try { await f.close(); } finally { vi.restoreAllMocks(); } }
});

it('Task 4 late original versus explicit replay preserves an older unrelated job and evidence without a concurrent acquisition', async () => {
  const f = await fixture(true, { publicIpc: true }); const hold = task3Hold();
  let originalOutcome: ReturnType<typeof task3Outcome<unknown>> | undefined;
  try {
    const other = task3Seed(f, 'Older unrelated late original', 'other.invalid');
    task3Repo(f, '2026-09-08T12:00:00.000Z').enqueue({ ...other, limits });
    expect(task3Row(f, other)).toMatchObject({ created_at: '2026-09-08T12:00:00.000Z', state: 'queued', attempt: 0, reserved_cost_micros: 0 });
    const selected = task3Seed(f); const api = task3Api(); const untouched = task3Unrelated(f, selected);
    const otherDetail = await api.getCompany({ accountId: other.accountId });
    expect(typeof f.app.companyResearch!.researchCompany).toBe('function');
    const execution = f.app.companyResearch!.researchCompany.bind(f.app.companyResearch!);
    let enteredPort = false; let holdNextLease = true;
    vi.spyOn(f.app.companyResearch!, 'researchCompany').mockImplementation(input => { enteredPort = true; return execution(input); });
    const lease = f.runtime.withDatabase.bind(f.runtime);
    const delayed: FoundationRuntime['withDatabase'] = operation => lease(async (database: AppDatabase) => {
      if (enteredPort && holdNextLease) { holdNextLease = false; await hold.page(); }
      return operation(database);
    });
    vi.spyOn(f.runtime, 'withDatabase').mockImplementation(delayed);
    const lossy = createLocalWorkspaceApi(createIpcClient({ invoke: async (channel, ...args) => {
      originalOutcome = task3Outcome(Promise.resolve(registeredIpcHandler(task3Electron.handle, channel)(task3Trusted, ...args)));
      throw new Error('fixture renderer lost response while main continues');
    } }));
    await expect(lossy.researchCompany(selected)).rejects.toThrow();
    expect(originalOutcome).toBeDefined();
    expect(await Promise.race([hold.entered, originalOutcome!, hold.deadline])).toBe('entered');
    expect(await api.getCompanyResearchStatus(selected)).toMatchObject({ ...selected, state: 'not_recorded' });
    expect(task3Row(f, selected)).toBeUndefined(); expect(f.requests).toEqual([]);
    const replay = task3Outcome(api.researchCompany(selected));
    const result = await Promise.race([replay, hold.deadline]);
    expect(result).not.toBe('timeout');
    if (result !== 'timeout' && result.kind === 'value') expect(result.value).toMatchObject({ ...selected, state: 'held' });
    expect(task3Row(f, selected)).toBeUndefined(); expect(f.requests).toEqual([]);
    expect(task3Unrelated(f, selected)).toEqual(untouched);
    hold.release();
    const originalResult = await Promise.race([originalOutcome!, hold.deadline]);
    expect(originalResult).toMatchObject({ kind: 'value', value: { ...selected, state: 'completed' } });
    expect(await api.researchCompany(selected)).toMatchObject({ ...selected, state: 'completed' });
    expect(f.requests).toHaveLength(1); expect(f.database.raw.prepare('SELECT command_id FROM pm_account_research_jobs WHERE account_id=?').all(selected.accountId)).toEqual([{ command_id: selected.commandId }]);
    expect(task3Unrelated(f, selected)).toEqual(untouched);
    expect(await api.getCompany({ accountId: other.accountId })).toMatchObject({ scope: otherDetail.scope, snapshot: otherDetail.snapshot, sources: otherDetail.sources, links: otherDetail.links });
    expect(f.database.raw.prepare('SELECT COUNT(*) AS n FROM pm_account_research_jobs').get()).toEqual({ n: 2 });
  } finally {
    hold.release(); await hold.drain(); if (originalOutcome) await Promise.race([originalOutcome, hold.deadline]);
    try { await f.close(); } finally { vi.restoreAllMocks(); hold.clear(); }
  }
});

  it.each(['unexpired', 'expired', 'parked'] as const)('Task 4 ambiguous %s replay retains selected spend and an older unrelated queued job', async state => {
    const f = await fixture(true, { publicIpc: true });
    try {
      const api = task3Api(); const other = task3Seed(f, 'Older unrelated ambiguous work', 'other.invalid');
      task3Repo(f, '2026-09-08T12:00:00.000Z').enqueue({ ...other, limits });
      expect(task3Row(f, other)).toMatchObject({ created_at: '2026-09-08T12:00:00.000Z', state: 'queued', attempt: 0, reserved_cost_micros: 0 });
      const selected = task3Seed(f); const repo = task3Repo(f); const untouched = task3Unrelated(f, selected);
      const otherDetail = await api.getCompany({ accountId: other.accountId });
      repo.enqueue({ ...selected, limits });
      const job = repo.claimSelected(state === 'expired' ? '2026-09-08T12:00:00.000Z' : clock.now(), selected)!;
      expect(job.accountId).toBe(selected.accountId);
      if (state === 'parked') repo.settle({ jobId: job.id, claimToken: job.claimToken, status: 'parked', receiptCommandId: null, costMicros: null });
      expect(await api.getCompanyResearchStatus(selected)).toMatchObject({ ...selected, state: state === 'parked' ? 'parked' : 'running' });
      expect(await api.researchCompany(selected)).toMatchObject({ ...selected, state: state === 'unexpired' ? 'running' : 'parked' });
      expect(f.requests).toEqual([]);
      expect(task3Row(f, selected)).toMatchObject({ attempt: 1, reserved_cost_micros: 100, cost_micros: null });
      const before = task3Row(f, selected);
      await api.researchCompany(selected); expect(task3Row(f, selected)).toEqual(before);
      expect(task3Unrelated(f, selected)).toEqual(untouched);
      expect(await api.getCompany({ accountId: other.accountId })).toMatchObject({ scope: otherDetail.scope, snapshot: otherDetail.snapshot, sources: otherDetail.sources, links: otherDetail.links });
      expect(f.database.raw.prepare('SELECT COUNT(*) AS n FROM pm_account_research_jobs').get()).toEqual({ n: 2 });
    } finally { await f.close(); }
  });


it('rejects invalid public activation before persistence and keeps the previous research instance usable', async () => {
  const f = await fixture(true, { paired: true, publicIpc: true });
  const api = createCallieApi({ invoke: async (channel, ...args) =>
    registeredIpcHandler(task3Electron.handle, channel)(task3Trusted, ...args) });
  const research = { ...configuration, audienceRevision: 1, sourceRevision: 1, budgetRevision: 1, preparationCommandId: randomUUID() };
  try {
    const saved = await api.delegation.configure({ expectedRevision: 0, configuration: { version: 1, state: 'active', research } });
    const first = f.app.companyResearch;
    const factoryCalls = f.factoryCalls;
    const invalid = { version: 1 as const, state: 'active' as const, research: { ...research, permittedSources: ['http://example.invalid/'] } };
    await expect(api.delegation.configure({ expectedRevision: 1, configuration: invalid })).rejects.toThrow('OUTREACH_REQUEST_FAILED');
    // Public read exposes the actual committed record, not a mocked callback outcome.
    expect((await api.delegation.status()).configuration).toEqual(saved);
    expect(f.app.companyResearch).toBe(first);
    expect(f.factoryCalls).toBe(factoryCalls);
    expect(f.requests).toEqual([]);
    const selected = task3Seed(f);
    expect(await api.localWorkspace.researchCompany(selected)).toMatchObject({ state: 'completed' });
    expect(f.requests).toEqual(['https://example.invalid/']);
    await expect(api.delegation.configure({ expectedRevision: 0, configuration: saved.configuration })).rejects.toThrow();
    expect((await api.delegation.status()).configuration).toEqual(saved);
    expect(f.app.companyResearch).toBe(first);
    // Pausing may retain a schema-valid source that cannot be activated.
    const paused = await api.delegation.configure({ expectedRevision: 1, configuration: { ...invalid, state: 'paused' } });
    expect(paused).toMatchObject({ revision: 2, configuration: { ...invalid, state: 'paused' } });
    expect(f.app.companyResearch).toBeUndefined();
    await expect(api.delegation.configure({ expectedRevision: 2, configuration: invalid })).rejects.toThrow();
    expect((await api.delegation.status()).configuration).toEqual(paused);
    const empty = await api.delegation.configure({ expectedRevision: 2, configuration: { version: 1, state: 'active', research: null } });
    expect(empty.revision).toBe(3); expect(f.app.companyResearch).toBeUndefined();
    const held = await api.delegation.configure({ expectedRevision: 3,
      configuration: { version: 1, state: 'active', research: { ...research, permittedSources: [] } } });
    expect(held.revision).toBe(4); expect(f.app.companyResearch).toBeDefined();
    expect(f.requests).toEqual(['https://example.invalid/']);
  } finally { await f.close(); }
});
