import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const electron = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: electron }));
import { openDatabase, closeDatabase, type AppDatabase } from '../../src/main/db/database';
import { inspectDatabaseEncryption } from '../../src/main/db/databaseEncryption';
import { prepareEncryptedDatabase } from '../../src/main/db/plaintextDatabaseUpgrade';
import { migrateToLatest } from '../../src/main/db/migrate';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';
import { FoundationRuntime } from '../../src/main/foundation/foundationRuntime';
import { HealthService } from '../../src/main/health/healthService';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { ExecutionClient } from '../../src/main/delegation/executionClient';
import * as emailService from '../../src/main/outreach/emailService';
import * as phoneLauncher from '../../src/main/communications/phoneHandoffLauncher';
import { createLocalWorkspaceProvider } from '../../src/main/workspace/localWorkspaceProvider';
import { registerLocalWorkspaceIpc } from '../../src/main/workspace/registerLocalWorkspaceIpc';
import { createLocalWorkspaceApi } from '../../src/preload/apis/localWorkspaceApi';
import { createIpcClient } from '../../src/preload/ipcClient';
import type { LocalWorkspaceApi } from '../../src/shared/contracts/localWorkspaceContract';
import type { AdmitCompanyPhoneRoute, CompanyPhoneRouteReceipt } from '../../src/shared/contracts/localCompanyPhoneRouteContract';
import { registeredIpcHandler } from '../fixtures/registeredIpcHandler';
import { createTempDatabase, createTestWorkspaceKey } from '../fixtures/tempDatabase';

// Real provider, real IPC registration and the real preload API over a disposable encrypted runtime. No call, no verification that the
// number answers, no worker: saving a reviewed phone route is a local record only.
const trusted = { senderFrame: { url: 'callie://app/index.html' } };
const channel = 'local-workspace:admit-company-phone-route', safeCode = 'LOCAL_COMPANY_PHONE_ROUTE_FAILED';
const phone = '+14015723322';
const quote = 'Contact Us\n\n380 Broadway Providence, Rhode Island 02909\n\ninfo@lenoxmanagement.com\n\n401-572-3322';
const excerpt = 'Lenox Management\n\nProperty management, leasing and REO services across Rhode Island and Southeastern Massachusetts since 2004.\n\n'
  + quote + '\n\nOur in-house maintenance team coordinates repairs for the properties we manage.';
const source = { id: 'lenox-contact', url: 'https://lenoxmanagement.com/', fetchedAt: '2026-09-15T18:00:00.000Z',
  sha256: createHash('sha256').update(excerpt).digest('hex'), excerpt, permitted: true };
const unchangedTables = ['persons', 'prospects', 'sales_cycles', 'person_contact_methods', 'pm_account_links', 'activities',
  'email_drafts', 'email_send_intents', 'email_send_results', 'delegated_commands', 'delegated_applied_events',
  'campaign_enrollments', 'campaign_step_receipts', 'pm_account_outbound_intents', 'pm_account_outbound_results', 'pm_account_research_jobs', 'local_company_email_drafts'];
const auditRows = (database: AppDatabase) => unchangedTables.map(table => ({ table, rows: database.raw.prepare(`SELECT * FROM ${table}`).all() }));
const evidenceRows = (database: AppDatabase, accountId: string) => ['pm_account_claims', 'pm_account_claim_evidence', 'pm_account_sources']
  .map(table => ({ table, rows: database.raw.prepare(`SELECT * FROM ${table} WHERE account_id=?`).all(accountId) }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('admits a reviewed business phone route through preload and IPC, replays it exactly, hides causes behind the safe code and survives a fresh encrypted runtime', async () => {
  const temp = createTempDatabase(), key = createTestWorkspaceKey();
  const forbidden = vi.fn((): never => { throw new Error('Phone route review must not invoke provider/mail/phone/worker effects'); });
  vi.stubGlobal('fetch', forbidden);
  const effects = [vi.spyOn(emailService, 'createEmailService').mockImplementation(forbidden),
    vi.spyOn(phoneLauncher, 'createPhoneHandoffLauncher').mockImplementation(forbidden),
    vi.spyOn(ExecutionClient.prototype, 'submit').mockImplementation(forbidden),
    vi.spyOn(ExecutionClient.prototype, 'sync').mockImplementation(forbidden)];
  const clock = { now: () => new Date().toISOString() };
  const runtimes: FoundationRuntime[] = [], removers: (() => void)[] = [];
  function session(databaseExists: boolean) {
    electron.handle.mockClear();
    const runtime = new FoundationRuntime({ appVersion: '1.0.0', databasePath: temp.path, databaseExists,
      backupDirectory: join(dirname(temp.path), 'backups'), keyEnvelopePath: join(dirname(temp.path), 'fixture-envelope.json') }, {
      loadWorkspaceKey: async () => ({ ...key, bytes: Buffer.from(key.bytes) }), prepareEncryptedDatabase,
      openDatabase: options => openDatabase(options), migrateToLatest,
      createDomainRuntime: database => new DomainRuntime({ database, clock, ids: { next: randomUUID } }),
      createHealthService: options => new HealthService(options), closeDatabase: database => { closeDatabase(database); },
    });
    runtimes.push(runtime);
    const remove = registerLocalWorkspaceIpc(createLocalWorkspaceProvider(runtime, { current: forbidden })); removers.push(remove);
    const handler = registeredIpcHandler(electron.handle, channel);
    const invoke = vi.fn(async (name: string, ...args: unknown[]) => registeredIpcHandler(electron.handle, name)(trusted, ...args));
    return { runtime, remove, handler, invoke, api: createLocalWorkspaceApi(createIpcClient({ invoke })) };
  }
  try {
    const first = session(false);
    const created = await first.api.createCompany({ commandId: randomUUID(), name: 'Lenox Management', domain: 'lenoxmanagement.com' });
    expect(created.status).toBe('saved'); if (created.status !== 'saved') throw new Error('Expected real saved company');
    const accountId = created.account.id;
    // Trusted fixture admission of the saved source, never renderer-authored research or a real website fetch.
    await first.runtime.withDatabase(database => new AccountRepository({ database, clock, ids: { next: randomUUID },
      sourcePolicy: { attest: (candidate, owner) => owner === accountId && candidate.id === source.id && candidate.sha256 === source.sha256 && candidate.excerpt === source.excerpt } })
      .admitEvidence({ commandId: randomUUID(), accountId, expectedVersion: created.account.version, sources: [source], routes: [], claims: [] }));
    const before = await first.api.getCompany({ accountId });
    expect(before.sources).toEqual([source]); expect(before.snapshot.routes).toEqual([]);
    const originalRows = await first.runtime.withDatabase(auditRows), originalEvidence = await first.runtime.withDatabase(database => evidenceRows(database, accountId));
    expect(originalRows.every(entry => entry.rows.length === 0)).toBe(true);

    // Intended first absent-method RED on the current product: the preload has no phone route admission yet.
    const request: AdmitCompanyPhoneRoute = { commandId: randomUUID(), accountId, expectedAccountVersion: before.snapshot.account.version, phone, sourceId: source.id, quote,
      selection: 'published_company_business_phone' };
    const receipt = await first.api.admitCompanyPhoneRoute!(request);
    expect(receipt).toEqual({ commandId: request.commandId, accountId, accountVersion: before.snapshot.account.version + 1, selection: 'published_company_business_phone',
      route: { routeId: expect.any(String), routeVersion: 1, phone, personId: null },
      publication: { sourceId: source.id, url: source.url, sha256: source.sha256, fetchedAt: source.fetchedAt, quote } });
    const admitted = await first.api.getCompany({ accountId });
    expect(admitted.snapshot.account.version).toBe(receipt.accountVersion);
    expect(admitted.snapshot.routes).toEqual([{ id: receipt.route.routeId, accountId, version: 1, personId: null, channel: 'phone', value: phone, purpose: 'business', verification: 'published', evidenceIds: [source.id] }]);
    expect(admitted.sources).toEqual(before.sources); expect(admitted.snapshot.claims).toEqual(before.snapshot.claims);
    // Same command, same reviewed values: the identical receipt, no second route.
    expect(await first.api.admitCompanyPhoneRoute!(request)).toEqual(receipt);
    expect((await first.api.getCompany({ accountId })).snapshot.routes).toHaveLength(1);
    // Failures cross the boundary as the fixed safe code only; the cause never leaks and nothing is written.
    const rowsAfter = await first.runtime.withDatabase(auditRows);
    await expect(first.api.admitCompanyPhoneRoute!({ ...request, commandId: randomUUID(), expectedAccountVersion: receipt.accountVersion, quote: 'Contact Us' })).rejects.toThrow(new RegExp(`^${safeCode}$`));
    await expect(first.api.admitCompanyPhoneRoute!({ ...request, commandId: randomUUID(), expectedAccountVersion: receipt.accountVersion, phone: '+14015550199' })).rejects.toThrow(new RegExp(`^${safeCode}$`));
    await expect(first.api.admitCompanyPhoneRoute!({ ...request, quote: '401-572-3322' })).rejects.toThrow(new RegExp(`^${safeCode}$`));
    await expect(first.handler(trusted, { ...request, phone: '401-572-3322' })).rejects.toThrow(new RegExp(`^${safeCode}$`));
    await expect(first.handler({ senderFrame: { url: 'https://evil.example/' } }, request)).rejects.toThrow(new RegExp(`^${safeCode}$`));
    expect((await first.api.getCompany({ accountId })).snapshot.account.version).toBe(receipt.accountVersion);
    expect(await first.runtime.withDatabase(auditRows)).toEqual(rowsAfter);
    // A reply that does not carry the command's own identity is refused in the preload, whatever main returned.
    const tampered = (change: (result: CompanyPhoneRouteReceipt) => CompanyPhoneRouteReceipt) => createLocalWorkspaceApi(createIpcClient({
      invoke: async (name, ...args) => change(await registeredIpcHandler(electron.handle, name)(trusted, ...args) as CompanyPhoneRouteReceipt) }));
    await expect(tampered(result => ({ ...result, commandId: randomUUID() })).admitCompanyPhoneRoute!(request)).rejects.toThrow();
    await expect(tampered(result => ({ ...result, accountId: 'other-account' })).admitCompanyPhoneRoute!(request)).rejects.toThrow();
    await expect(tampered(result => ({ ...result, route: { ...result.route, phone: '+14015550199' } })).admitCompanyPhoneRoute!(request)).rejects.toThrow();
    expect(await first.runtime.withDatabase(auditRows)).toEqual(originalRows);
    expect(await first.runtime.withDatabase(database => evidenceRows(database, accountId))).toEqual(originalEvidence);
    expect(await first.runtime.withDatabase(inspectDatabaseEncryption)).toMatchObject({ encrypted: true, integrity: 'ok' });
    first.remove(); await first.runtime.shutdown();

    const second = session(true);
    expect(await second.api.admitCompanyPhoneRoute!(request)).toEqual(receipt);
    expect(await second.api.getCompany({ accountId })).toMatchObject({ snapshot: { account: admitted.snapshot.account, routes: admitted.snapshot.routes }, sources: before.sources });
    expect(await second.runtime.withDatabase(auditRows)).toEqual(originalRows);
    expect(forbidden).not.toHaveBeenCalled(); for (const effect of effects) expect(effect).not.toHaveBeenCalled();
    second.remove(); await second.runtime.shutdown();
  } finally {
    removers.reverse().forEach(remove => remove());
    await Promise.all(runtimes.map(runtime => runtime.shutdown())); key.bytes.fill(0); temp.cleanup();
  }
}, 30_000);

it('the IPC handler refuses a provider reply with foreign identity and a provider without the method, both as the safe code', async () => {
  const request: AdmitCompanyPhoneRoute = { commandId: randomUUID(), accountId: 'lenox', expectedAccountVersion: 2, phone, sourceId: source.id, quote, selection: 'published_company_business_phone' };
  const receipt: CompanyPhoneRouteReceipt = { commandId: request.commandId, accountId: 'lenox', accountVersion: 3, route: { routeId: 'route-1', routeVersion: 1, phone, personId: null },
    publication: { sourceId: source.id, url: source.url, sha256: source.sha256, fetchedAt: source.fetchedAt, quote }, selection: 'published_company_business_phone' };
  const withProvider = async (provider: Partial<LocalWorkspaceApi>, run: (handler: ReturnType<typeof registeredIpcHandler>) => Promise<void>) => {
    electron.handle.mockClear();
    const remove = registerLocalWorkspaceIpc(provider as LocalWorkspaceApi);
    try { await run(registeredIpcHandler(electron.handle, channel)); } finally { remove(); }
  };
  await withProvider({ admitCompanyPhoneRoute: async () => receipt }, async handler => { expect(await handler(trusted, request)).toEqual(receipt); });
  await withProvider({ admitCompanyPhoneRoute: async () => ({ ...receipt, commandId: randomUUID() }) }, async handler => { await expect(handler(trusted, request)).rejects.toThrow(new RegExp(`^${safeCode}$`)); });
  await withProvider({ admitCompanyPhoneRoute: async () => ({ ...receipt, accountId: 'other' }) }, async handler => { await expect(handler(trusted, request)).rejects.toThrow(new RegExp(`^${safeCode}$`)); });
  await withProvider({ admitCompanyPhoneRoute: async () => ({ ...receipt, accountVersion: 4 }) }, async handler => { await expect(handler(trusted, request)).rejects.toThrow(new RegExp(`^${safeCode}$`)); });
  await withProvider({ admitCompanyPhoneRoute: async () => { throw new Error('private cause'); } }, async handler => { await expect(handler(trusted, request)).rejects.toThrow(new RegExp(`^${safeCode}$`)); });
  await withProvider({}, async handler => { await expect(handler(trusted, request)).rejects.toThrow(new RegExp(`^${safeCode}$`)); });
});
