import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { openDatabase, closeDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';
import { HealthService } from '../../src/main/health/healthService';
import { startApplication, type ApplicationStartupDependencies } from '../../src/main/startApplication';
import { registerApplicationIpc } from '../../src/main/ipc/registerApplicationIpc';
import { createOutreachProviders } from '../../src/main/outreach/providers/outreachProviders';
import { createEmailService } from '../../src/main/outreach/emailService';
import { createCallieApi } from '../../src/preload/createCallieApi';
import { registerOutreachIpc } from '../../src/main/ipc/registerOutreachIpc';
import { createTestWorkspaceKey, createTempDatabase } from '../fixtures/tempDatabase';
import { registeredIpcHandler } from '../fixtures/registeredIpcHandler';
const electron = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }));
vi.mock('electron', () => ({ safeStorage: {}, dialog: {}, shell: {}, ipcMain: electron }));
const unexpected = (): never => { throw Error('Unexpected external operation'); };
it.each([false, true])('actual null-start public IPC activation, pairing=%s, shares manager and restores pause/conflict', async paired => {
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => unexpected());
  const temp = createTempDatabase(); mkdirSync(dirname(temp.path), { recursive: true });
  let database!: AppDatabase; let pages = 0; let model = 0;
  const managers: ReturnType<typeof createOutreachProviders>[] = [];
  const disposals: ReturnType<typeof vi.spyOn>[] = [];
  const quote = 'We manage residential homes in Fictional Valley.';
  const dependencies: ApplicationStartupDependencies = {
    loadWorkspaceKey: async () => createTestWorkspaceKey(), prepareEncryptedDatabase: async () => undefined,
    openDatabase, closeDatabase, migrateToLatest,
    createDomainRuntime: db => { database = db; return new DomainRuntime({ database: db, clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID } }); },
    createHealthService: options => new HealthService(options), registerLinkedInIpc: () => () => undefined,
    registerApplicationIpc, registerOutreachIpc,
    ...(paired ? { createPairingStore: () => ({ load: async () => ({ endpoint: 'https://worker.example.test', workspaceId: 'fictional-workspace', pairingId: '11111111-1111-4111-8111-111111111111', credential: 'a'.repeat(43), emergencyCredential: 'b'.repeat(43), generation: 0, scopes: ['commands:write' as const, 'events:read' as const] }), redeem: async () => unexpected() }) } : {}),
    createResearchProviders: () => {
      const manager = createOutreachProviders({ directory: join(dirname(temp.path), 'outreach'), safeStorage: {
        isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString(),
      }, openExternal: async () => unexpected(), fetch: async (_url, options) => {
        model++;
        const body = JSON.parse(String(options?.body)); const source = JSON.parse(body.input).sources[0];
        expect(source.blocks[0].text).toBe(quote);
        expect(source.blocks[0].ref).toEqual(expect.any(Number));
        return new Response(JSON.stringify({ status: 'completed', model: body.model, output: [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ facts: [{ key: 'residential_scope', ref: source.blocks[0].ref }] }) }] }] }));
      } });
      vi.spyOn(manager, 'researchCompanies').mockImplementation(async () => unexpected());
      managers.push(manager); disposals.push(vi.spyOn(manager, 'dispose')); return manager;
    },
    createEmailService: (gate, _path, shared) => { expect(shared).toBeDefined(); return createEmailService({ databaseGate: gate, providers: shared! }); },
    companyResearchResolve: async () => ['93.184.216.34'], companyResearchHttp: async () => { pages++; return new Response(`<p>${quote}</p>`, { headers: { 'content-type': 'text/html' } }); },
    createBackupService: () => ({ start: async () => undefined, shutdown: async () => undefined, createBackup: unexpected, listAvailableBackups: async () => [] }),
    createRecoveryService: () => ({ status: unexpected, beginSetup: unexpected, saveSetupMaterial: unexpected, completeSetup: unexpected, selectAndRunRestoreDrill: unexpected, shutdown: async () => undefined }),
  };
  const start = () => { electron.handle.mockReset(); electron.removeHandler.mockReset(); return startApplication({ appVersion: '1.0.0', userDataPath: dirname(temp.path), createWindow: () => undefined }, dependencies); };
  let app: Awaited<ReturnType<typeof start>> | undefined;
  const api = createCallieApi({ invoke: async (channel, ...args) => registeredIpcHandler(electron.handle, channel)({ senderFrame: { url: 'callie://app/index.html' } }, ...args) });
  try {
    app = await start();
    expect(app.companyResearch).toBeUndefined(); expect(managers).toHaveLength(1);
    const initial = await api.localWorkspace.getCompanyResearchSettings();
    expect(initial).toMatchObject({ revision: 0, configuration: null, blockedReason: null, reservedOrSpentMicros: 0 });
    const profile = initial.profiles[0]!;
    await api.outreach.configure({ apiKey: 'fictional-key', model: profile.researchLimits.knownCompanyExtraction!.model });
    const configuration = { version: 1 as const, mode: 'known_company' as const, state: 'active' as const, profileId: profile.id, researchLimits: profile.researchLimits, maxAccountBudgetMicros: 100000, permittedSources: ['https://example.invalid/about'] };
    const saved = await api.localWorkspace.updateCompanyResearchSettings({ expectedRevision: 0, configuration, reviewed: true });
    expect(saved).toMatchObject({ revision: 1, configuration }); expect(managers).toHaveLength(1);
    expect(pages + model).toBe(0);
    await app.shutdown(); app = await start();
    expect(app.companyResearch).toBeDefined();
    expect(pages + model).toBe(0);
    expect(await app.companyResearch!.prepare(randomUUID(), new AbortController().signal)).toEqual({ status: 'blocked', accountIds: [] });
    expect(await app.companyResearch!.runNext(new AbortController().signal)).toBe('idle');
    const created = await api.localWorkspace.createCompany({ commandId: randomUUID(), name: 'Fictional Company', domain: 'example.invalid' });
    if (created.status !== 'saved') throw Error('Expected company');
    const selected = { commandId: randomUUID(), accountId: created.account.id };
    // Simulate the gap after another local CAS commits but before its callback.
    const retained = database.raw.prepare('SELECT known_company_research_json AS configuration FROM workspace_settings').get() as { configuration: string };
    database.raw.prepare('UPDATE workspace_settings SET known_company_research_revision=2,known_company_research_json=?').run(JSON.stringify({ ...configuration, state: 'paused' }));
    await expect(api.localWorkspace.researchCompany(selected)).rejects.toThrow();
    expect(database.raw.prepare('SELECT COUNT(*) AS n FROM pm_account_research_jobs').get()).toEqual({ n: 0 });
    expect(pages + model).toBe(0);
    database.raw.prepare('UPDATE workspace_settings SET known_company_research_revision=1,known_company_research_json=?').run(retained.configuration);
    expect(await api.localWorkspace.researchCompany(selected)).toMatchObject({ state: 'completed' });
    const detail = await api.localWorkspace.getCompany({ accountId: selected.accountId });
    expect(detail.sources[0]).toMatchObject({ url: configuration.permittedSources[0], excerpt: quote });
    expect(pages).toBe(1); expect(model).toBe(1);
    expect((await api.localWorkspace.getCompanyResearchSettings()).reservedOrSpentMicros).toBe(20000);
    if (paired) {
      // An independent existing paired policy becomes present later. Neither wins.
      await api.delegation.configure({ expectedRevision: 0, configuration: { version: 1, state: 'active', research: {
        workspaceId: 'fictional-workspace', budgetId: 'legacy-budget', audience: { residential: true, regions: ['Fictional Valley'], terms: ['residential'] },
        audienceRevision: 1, sourceRevision: 1, budgetRevision: 1, discoveryLimits: profile.researchLimits, researchLimits: profile.researchLimits,
        capability: { model: profile.researchLimits.knownCompanyExtraction!.model, webSearch: true, searchCostMicros: 1, modelCostMicros: 1 },
        maxAccountBudgetMicros: 100000, permittedSources: configuration.permittedSources, preparationCommandId: randomUUID(),
      } } });
      expect(app.companyResearch).toBeUndefined();
      expect((await api.localWorkspace.getCompanyResearchSettings()).blockedReason).toBe('paired_research_present');
      await expect(api.localWorkspace.updateCompanyResearchSettings({ expectedRevision: 1, configuration, reviewed: true })).rejects.toThrow();
      expect(await api.localWorkspace.researchCompany({ ...selected, commandId: randomUUID() })).toMatchObject({ state: 'held' });
    }
    const paused = { ...configuration, state: 'paused' as const };
    await api.localWorkspace.updateCompanyResearchSettings({ expectedRevision: 1, configuration: paused, reviewed: false });
    expect(app.companyResearch).toBeUndefined();
    const previous = database;
    await app.shutdown(); app = await start();
    expect(database).not.toBe(previous); expect(app.companyResearch).toBeUndefined();
    expect(await api.localWorkspace.getCompanyResearchSettings()).toMatchObject({ revision: 2, configuration: paused, reservedOrSpentMicros: 20000 });
    expect(await api.localWorkspace.researchCompany({ ...selected, commandId: randomUUID() })).toMatchObject({ state: 'held' });
    expect((await api.localWorkspace.getCompany({ accountId: selected.accountId })).sources).toEqual(detail.sources);
    expect(pages).toBe(1); expect(model).toBe(1);
  } finally { await app?.shutdown(); expect(disposals.every(dispose => dispose.mock.calls.length === 1)).toBe(true); expect(network).not.toHaveBeenCalled(); network.mockRestore(); temp.cleanup(); }
});
