import type { SourcingPollHealth } from '../../src/shared/contracts/sourcingContract';
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
import type { SourcingPoller } from '../../src/main/sourcing/sourcingPoller';
vi.mock('electron', () => ({ safeStorage: {}, dialog: {}, shell: {} }));
const clock = { now: () => new Date().toISOString() };
const limits = { maxCompanies: 2, maxPages: 1, maxBytes: 10000, maxCostMicros: 100 };
const configuration = { workspaceId: 'fictional-workspace', budgetId: 'fictional-budget',
  audience: { residential: true, regions: ['Fictional Region'], terms: ['residential PM'] }, discoveryLimits: limits, researchLimits: limits,
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
async function fixture(configured: boolean, hooks: { search?: () => Promise<void>; page?: () => Promise<void>; paired?: boolean } = {}) {
  const temp = createTempDatabase();
  mkdirSync(dirname(temp.path), { recursive: true, mode: 0o700 });
  let runtime!: FoundationRuntime; let database!: AppDatabase;
  let delegation:import('../../src/main/delegation/delegationRuntime').DelegationRuntime|undefined;
  let lifecycle!: Parameters<NonNullable<ApplicationStartupOptions['registerOutboundLifecycle']>>[0];
  const requests: string[] = []; let factoryCalls = 0;
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
  if (configured) await manager.configure({ apiKey: 'fictional-api-key', model: 'fixture-model' });
  const dependencies: ApplicationStartupDependencies = {
    loadWorkspaceKey: async () => createTestWorkspaceKey(), prepareEncryptedDatabase: async () => undefined,
    openDatabase, closeDatabase, migrateToLatest,
    createDomainRuntime: db => { database = db; return new DomainRuntime({ database: db, clock, ids: { next: randomUUID } }); },
    createHealthService: options => new HealthService(options),
    registerLinkedInIpc:()=>()=>undefined,
    registerOutreachIpc: options => {delegation=options.delegation;return () => undefined;},
    ...(hooks.paired?{createPairingStore:()=>({load:async()=>({endpoint:'https://worker.example.test',workspaceId:configuration.workspaceId,pairingId:'11111111-1111-4111-8111-111111111111',credential:'a'.repeat(43),emergencyCredential:'b'.repeat(43),generation:0,scopes:['commands:write' as const,'events:read' as const]}),redeem:async()=>unexpected()})}:{}),
    registerApplicationIpc: bound => { runtime = bound; return () => undefined; },
    createResearchProviders: () => { factoryCalls++; return manager; },
    createEmailService: (gate, _path, providers) => {
      expect(providers === undefined || providers.researchCompanies === manager.researchCompanies).toBe(true);
      return createEmailService({ databaseGate: gate, providers: providers ?? (hooks.paired?{...manager,dispose:()=>undefined}:manager) });
    },
    companyResearchResolve: async () => ['93.184.216.34'],
    companyResearchHttp: async input => { requests.push(input.url); await hooks.page?.(); return new Response('<p>We manage 240 residential units.</p>', { headers: { 'content-type': 'text/html' } }); },
    createBackupService: () => ({ start: async () => undefined, shutdown: async () => undefined, createBackup: unexpected, listAvailableBackups: async () => [] }),
    createRecoveryService: () => ({ status: unexpected, beginSetup: unexpected, saveSetupMaterial: unexpected, completeSetup: unexpected, selectAndRunRestoreDrill: unexpected, shutdown: async () => undefined }),
    createSourcingPoller: () => ({ getHealth: (): SourcingPollHealth => ({ status: 'healthy', reasons: [], lastSuccessAgeMs: null,
      state: { state: 'idle', pollId: null, startedAt: null, lastCompletedAt: null, consecutiveFailures: 0, lastFailureAt: null, lastFailureCode: null, backlogCount: null } }), stop() {}, idle: async (): Promise<void> => undefined }) as unknown as SourcingPoller,
    createAppleBridgeSupervisor: unexpected,
  };
  try {
    const app = await startApplication({ appVersion: '1.0.0', userDataPath: dirname(temp.path), companyResearch: configured&&!hooks.paired ? configuration : undefined,
      registerOutboundLifecycle: callbacks => { lifecycle = callbacks; return () => undefined; }, createWindow: () => undefined }, dependencies);
    return { app, runtime, database, lifecycle, requests, factoryCalls, delegation, async close() { await app.shutdown(); expect(dispose).toHaveBeenCalledTimes(1); temp.cleanup(); } };
  } catch (error) { manager.dispose(); temp.cleanup(); throw error; }
}
describe('actual startup company research composition', () => {
  it('is inert without approved configuration or a persisted discovery budget', async () => {
    const f = await fixture(false);
    try {
      expect(f.factoryCalls).toBe(0);
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
