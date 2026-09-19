import { meetingFirstAccountCallSettingsSchema, updateCallSettingsRequestSchema, type MeetingFirstAccountCallSettings, type UpdateCallSettingsRequest, selectedCompanySchema, localCompanyDetailSchema, type LocalWorkspaceSnapshot, type LocalCommitmentsSnapshot, type LocalWorkflowReceipt, type LocalCompanyDetail, type SelectedCompany, type SelectedResearch, type LocalCompanyResearchStatus, type LinkCompanyPersonRequest } from '../../src/shared/contracts/localWorkspaceContract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const electron = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: electron }));
import { registerLocalWorkspaceIpc } from '../../src/main/workspace/registerLocalWorkspaceIpc';
import { createLocalWorkspaceApi } from '../../src/preload/apis/localWorkspaceApi';
import { createIpcClient } from '../../src/preload/ipcClient';
import { registeredIpcHandler } from '../fixtures/registeredIpcHandler';
const snapshot: LocalWorkspaceSnapshot = { scope: 'local_database' as const, generatedAt: '2026-09-09T12:00:00.000Z', workflowMode: 'legacy' as const, transitionReceipt: null, accounts: { state: 'available' as const, snapshots: [] } };
const feed: LocalCommitmentsSnapshot = { scope: 'local_database' as const, generatedAt: snapshot.generatedAt, revision: 0, reviewErrorCount: 0, items: [] };
const command = { commandId: 'cmd', manifestId: 'manifest', expectedMode: 'legacy' as const };
const receipt: LocalWorkflowReceipt = { commandId: 'cmd', manifestId: 'manifest', mode: 'meeting_first' as const, revision: 1, occurredAt: snapshot.generatedAt, cancelledActionIds: [], stoppedEnrollmentIds: [], preservedActionIds: [], parkedPersonIds: [], callbackEvidenceIds: [], unknownDraftIds: [], parkedReviewActions: [], parkedActions: [] };
const trusted = { senderFrame: { url: 'callie://app/index.html' } };
const unavailableCompany = async (): Promise<never> => { throw new Error('Company fixture unavailable'); };
const provider = { prepareCompanyDraft: async () => { throw Error('Company preparation unavailable in this fixture'); }, admitCompanyDraftEmail: async () => { throw Error('Company drafts unavailable in this fixture'); }, openCompanyDraft: async () => { throw Error('Company drafts unavailable in this fixture'); }, getCompanyDraft: async () => { throw Error('Company drafts unavailable in this fixture'); }, saveCompanyDraft: async () => { throw Error('Company drafts unavailable in this fixture'); }, getCompanyResearchSettings: async () => { throw Error('Local research setup unavailable in this fixture'); }, updateCompanyResearchSettings: async () => { throw Error('Local research setup unavailable in this fixture'); }, getCallSettings: async () => { throw Error('Call capacity unavailable in this fixture'); }, updateCallSettings: async () => { throw Error('Call capacity unavailable in this fixture'); }, linkCompanyPerson: unavailableCompany, researchCompany: unavailableCompany, getCompanyResearchStatus: unavailableCompany, getCompany: unavailableCompany, get: async () => snapshot, getCommitments: async () => feed, transition: async () => receipt, reviewCompany: unavailableCompany, createCompany: unavailableCompany, getCompanyCreateStatus: unavailableCompany };
beforeEach(() => vi.clearAllMocks());
describe('local workspace bridge', () => {
  it('roundtrips the frozen API and rejects arity, caller scope, and untrusted senders', async () => {
    const remove = registerLocalWorkspaceIpc(provider);
    expect(electron.handle).toHaveBeenCalledTimes(23);
    const api = createLocalWorkspaceApi(createIpcClient({ invoke: async (channel, ...args) => registeredIpcHandler(electron.handle, channel)(trusted, ...args) }));
    expect(await api.get()).toEqual(snapshot); expect(await api.getCommitments()).toEqual(feed); expect(await api.transition(command)).toEqual(receipt);
    for (const channel of ['local-workspace:get', 'local-workspace:get-commitments']) {
      const handler = registeredIpcHandler(electron.handle, channel);
      await expect(handler(trusted, {})).rejects.toThrow();
      await expect(handler({ senderFrame: { url: 'https://evil.invalid' } })).rejects.toThrow();
    }
    const transition = registeredIpcHandler(electron.handle, 'local-workspace:transition');
    for (const args of [[], [command, command], [{ ...command, workspaceId: 'invented' }], [{ ...command, expectedMode: 'meeting_first' }]]) await expect(transition(trusted, ...args)).rejects.toThrow();
    remove(); remove(); expect(electron.removeHandler.mock.calls.map(c => c[0])).toEqual(['local-workspace:territory-clearance-revoke', 'local-workspace:territory-clearance-confirm', 'local-workspace:territory-clearance-read', 'local-workspace:prepare-company-draft', 'local-workspace:save-company-draft', 'local-workspace:get-company-draft', 'local-workspace:open-company-draft', 'local-workspace:admit-company-phone-route', 'local-workspace:admit-company-draft-email', 'local-workspace:update-call-settings', 'local-workspace:get-call-settings', 'local-workspace:link-company-person', 'local-workspace:company-research-status', 'local-workspace:research-company', 'local-workspace:get-company', 'local-workspace:company-create-status', 'local-workspace:create-company', 'local-workspace:review-company', 'local-workspace:transition', 'local-workspace:get-commitments', 'local-workspace:get', 'local-workspace:update-company-research-settings', 'local-workspace:get-company-research-settings']);
  });
  it('rolls partial registration back and validates inbound responses', async () => {
    electron.handle.mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw new Error('registration'); });
    expect(() => registerLocalWorkspaceIpc(provider)).toThrow('registration');
    expect(electron.removeHandler).toHaveBeenCalledWith('local-workspace:get-company-research-settings');
    const api = createLocalWorkspaceApi(createIpcClient({ invoke: async () => ({ ...snapshot, workspaceId: 'invented' }) }));
    await expect(api.get()).rejects.toThrow();
  });
  it('rejects malformed nested responses at both boundaries and never leaks a provider error', async () => {
    const remove = registerLocalWorkspaceIpc({ ...provider, get: async () => { throw new Error('private database path'); }, transition: async () => ({ ...receipt, expectedMode: 'legacy' }) });
    const get = registeredIpcHandler(electron.handle, 'local-workspace:get');
    await expect(get(trusted)).rejects.toThrow(/^LOCAL_WORKSPACE_READ_FAILED$/);
    const transition = registeredIpcHandler(electron.handle, 'local-workspace:transition');
    await expect(transition(trusted, command)).rejects.toThrow(/^LOCAL_WORKFLOW_TRANSITION_FAILED$/);
    await expect(transition({ senderFrame: { url: 'https://evil.invalid' } }, command)).rejects.toThrow();
    for (const invalid of [{ ...receipt, revision: Number.MAX_SAFE_INTEGER + 1 }, { ...receipt, parkedReviewActions: [{ id: 'a', cycleId: 'c', version: 1, extra: true }] }, { ...receipt, occurredAt: 'yesterday' }]) {
      const api = createLocalWorkspaceApi(createIpcClient({ invoke: async () => invalid }));
      await expect(api.transition(command)).rejects.toThrow();
    }
    remove();
  });

});

import { dirname, join } from 'node:path';
import { openDatabase, closeDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';
import { FoundationRuntime } from '../../src/main/foundation/foundationRuntime';
import { HealthService } from '../../src/main/health/healthService';
import { createLocalWorkspaceProvider, type SelectedCompanyResearchPort } from '../../src/main/workspace/localWorkspaceProvider';
import { createTempDatabase, createTestWorkspaceKey } from '../fixtures/tempDatabase';
function lifetimeFixture(load?: () => Promise<void>) {
  const temp = createTempDatabase();
  const key = createTestWorkspaceKey();
  let database: AppDatabase | undefined;
  let opens = 0;
  let domainRuntime: DomainRuntime | undefined;
  const runtime = new FoundationRuntime({
    appVersion: '1.0.0', databasePath: temp.path, databaseExists: false,
    backupDirectory: join(dirname(temp.path), 'backups'),
    keyEnvelopePath: join(dirname(temp.path), 'fixture-envelope.json'),
  }, {
    loadWorkspaceKey: async () => { await load?.(); return { ...key, bytes: Buffer.from(key.bytes) }; },
    prepareEncryptedDatabase: async () => undefined,
    openDatabase: options => { opens++; database = openDatabase(options); return database; },
    migrateToLatest,
    createDomainRuntime: db => domainRuntime = new DomainRuntime({ database: db,
      clock: { now: () => '2026-09-09T12:00:00.000Z' }, ids: { next: () => crypto.randomUUID() } }),
    createHealthService: options => new HealthService(options),
    closeDatabase,
  });
  return { runtime, provider: createLocalWorkspaceProvider(runtime), opens: () => opens,
    database: () => database, stopDomain: () => domainRuntime?.shutdown(),
    async close() { await runtime.shutdown(); key.bytes.fill(0); temp.cleanup(); } };
}

it('local provider refuses reads after the real runtime shuts down instead of retaining its domain', async () => {
  const f = lifetimeFixture();
  try {
    const before = await f.provider.get();
    expect(before.scope).toBe('local_database');
    expect(before.accounts).toEqual({ state: 'available', snapshots: [] });
    expect((await f.provider.getCommitments()).items).toEqual([]);
    expect(f.opens()).toBe(1);
    await f.runtime.shutdown();
    expect(f.database()?.raw.open).toBe(false);
    await expect(f.provider.get()).rejects.toThrow();
    await expect(f.provider.getCommitments()).rejects.toThrow();
    await expect(f.provider.transition(command)).rejects.toThrow();
    const company = { commandId: crypto.randomUUID(), name: 'Unavailable', domain: null as string | null };
    await expect(f.provider.reviewCompany({ name: company.name, domain: null })).rejects.toThrow();
    await expect(f.provider.createCompany(company)).rejects.toThrow();
    await expect(f.provider.getCompanyCreateStatus(company)).rejects.toThrow();
    expect(f.opens()).toBe(1);
  } finally { await f.close(); }
});

it('local provider exposes no fallback snapshot while the workspace key is unavailable', async () => {
  let unavailable = true;
  const f = lifetimeFixture(async () => { if (unavailable) throw new Error('fictional key unavailable'); });
  try {
    await expect(f.provider.get()).rejects.toThrow('fictional key unavailable');
    expect(f.opens()).toBe(0);
    unavailable = false;
    expect((await f.provider.get()).scope).toBe('local_database');
    expect(f.opens()).toBe(1);
  } finally { await f.close(); }
});

it('shutdown during local initialization prevents a delayed key result from opening storage', async () => {
  let release!: () => void;
  const pendingKey = new Promise<void>(resolve => { release = resolve; });
  const f = lifetimeFixture(() => pendingKey);
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

it('new company methods use domain readiness and return real persisted original receipts', async () => {
  const f = lifetimeFixture();
  try {
    const input = { commandId: crypto.randomUUID(), name: 'Local Manual Company', domain: null as string | null };
    expect(await f.provider.reviewCompany({ name: input.name, domain: null })).toEqual({ scope: 'local_database', input: { name: input.name, domain: null }, candidates: [], complete: true });
    const saved = await f.provider.createCompany(input);
    expect(saved.status).toBe('saved');
    if (saved.status !== 'saved') throw new Error('Expected saved company');
    expect(await f.provider.getCompanyCreateStatus(input)).toEqual({ status: 'saved', commandId: input.commandId, account: saved.account });
    expect(await f.provider.createCompany(input)).toEqual({ ...saved, replayed: true });
    expect((await f.provider.createCompany({ ...input, commandId: crypto.randomUUID() })).status).toBe('needs_review');
    const snapshot = await f.provider.get();
    expect(snapshot.accounts.state).toBe('available');
    expect(snapshot.accounts.snapshots).toEqual(expect.arrayContaining([expect.objectContaining({ account: expect.objectContaining({ id: saved.account.id }) })]));
  } finally { await f.close(); }
});

it('company operations reject domain unavailability even when foundation-only local reads remain available', async () => {
  const f = lifetimeFixture();
  try {
    await f.provider.get();
    f.stopDomain();
    expect((await f.provider.get()).scope).toBe('local_database');
    const input = { commandId: crypto.randomUUID(), name: 'Blocked Company', domain: null as string | null };
    await expect(f.provider.reviewCompany({ name: input.name, domain: null })).rejects.toThrow();
    await expect(f.provider.createCompany(input)).rejects.toThrow();
    await expect(f.provider.getCompanyCreateStatus(input)).rejects.toThrow();
    expect(f.database()!.raw.prepare('SELECT * FROM pm_accounts').all()).toEqual([]);
    expect(f.database()!.raw.prepare('SELECT * FROM pm_account_commands').all()).toEqual([]);
  } finally { await f.close(); }
});

// Task 1 additions use real disposable admission for positive response evidence.
import { createHash } from 'node:crypto';
import { createPmFixture, PM_NOW } from '../fixtures/pmAccounts';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { SystemClock } from '../../src/main/domain/support/clock';
import { UuidGenerator } from '../../src/main/domain/support/idGenerator';

async function companyBridgeFixture() {
  const f = await createPmFixture();
  try {
    const save = (name: string) => {
      const account = f.repo.create({ commandId: crypto.randomUUID(), name, domain: null });
      const source = { id: crypto.randomUUID(), url: 'https://example.invalid/team', fetchedAt: PM_NOW, sha256: createHash('sha256').update(`${name} fictional team listing`).digest('hex'), excerpt: `${name} fictional team listing`, permitted: true };
      f.repo.admitEvidence({ commandId: crypto.randomUUID(), accountId: account.id, expectedVersion: 1, sources: [source],
        claims: [{ key: 'technology', kind: 'fact', value: 'Fictional scheduling software', evidenceIds: [source.id] }],
        routes: [{ id: crypto.randomUUID(), accountId: account.id, personId: null, channel: 'email', value: 'office@example.invalid', purpose: 'business', verification: 'published', evidenceIds: [source.id] }] });
      f.repo.admitLinks({ commandId: crypto.randomUUID(), accountId: account.id, expectedVersion: 2, links: [{
        id: crypto.randomUUID(), kind: 'person_role', personId: 'historical-person', role: 'Manager', relationship: 'Published role',
        authority: 'unconfirmed', authorityEvidenceIds: [], evidenceIds: [source.id], validFrom: PM_NOW, validTo: null,
      }] });
      return f.repo.readLocalCompanyDetail(account.id, PM_NOW);
    };
    return { ...f, selected: save('Selected'), other: save('Other') };
  } catch (error) { f.close(); throw error; }
}

const selectedInvalidRequests: unknown[] = [undefined, null, {}, { accountId: '' }, { accountId: 42 },
  { accountId: 'a'.repeat(201) }, { accountId: 'saved', workspaceId: 'invented' }, { accountId: 'saved', asOf: PM_NOW }];
const invalidCompanyReplies: { name: string; change: (detail: LocalCompanyDetail, other: LocalCompanyDetail) => unknown }[] = [
  { name: 'wrong selected account', change: (_detail, other) => other },
  { name: 'unknown top-level field', change: detail => ({ ...detail, workspaceId: 'invented' }) },
  { name: 'malformed generated instant', change: detail => ({ ...detail, generatedAt: 'yesterday' }) },
  { name: 'unsafe source URL', change: detail => ({ ...detail, sources: detail.sources.map(s => ({ ...s, url: 'https://user:password@example.invalid/team' })) }) },
  { name: 'malformed source hash', change: detail => ({ ...detail, sources: detail.sources.map(s => ({ ...s, sha256: 'z'.repeat(64) })) }) },
  { name: 'unknown source field', change: detail => ({ ...detail, sources: detail.sources.map(s => ({ ...s, accountId: detail.snapshot.account.id })) }) },
  { name: 'duplicate source identity', change: detail => ({ ...detail, sources: [...detail.sources, detail.sources[0]!] }) },
  { name: 'missing source binding', change: detail => ({ ...detail, sources: [] }) },
  { name: 'cross-account route', change: (detail, other) => ({ ...detail, snapshot: { ...detail.snapshot, routes: other.snapshot.routes } }) },
  { name: 'cross-account claim evidence', change: (detail, other) => ({ ...detail, snapshot: { ...detail.snapshot, claims: other.snapshot.claims } }) },
  { name: 'cross-account link evidence', change: (detail, other) => ({ ...detail, links: other.links }) },
  { name: 'invalid claim value', change: detail => ({ ...detail, snapshot: { ...detail.snapshot, claims: [{ key: 'technology', kind: 'fact', value: '', evidenceIds: [detail.sources[0]!.id] }] } }) },
  { name: 'invalid route version', change: detail => ({ ...detail, snapshot: { ...detail.snapshot, routes: detail.snapshot.routes.map(r => ({ ...r, version: 0 })) } }) },
  { name: 'unsupported confirmed authority', change: detail => ({ ...detail, links: detail.links.map(l => ({ ...l, authority: 'confirmed', authorityEvidenceIds: [] as string[] })) }) },
  { name: 'invalid link interval', change: detail => ({ ...detail, links: detail.links.map(l => ({ ...l, validTo: l.validFrom })) }) },
  { name: 'empty availability fallback', change: () => ({ scope: 'local_database', generatedAt: PM_NOW, accounts: { state: 'available', snapshots: [] } }) },
];

describe('Task 1 selected company public boundaries', () => {
  it('roundtrips admitted evidence through strict actual schemas and the actual registrar/preload', async () => {
    const f = await companyBridgeFixture();
    let remove: (() => void) | undefined;
    try {
      const input = { accountId: f.selected.snapshot.account.id };
      expect(selectedCompanySchema.parse(input)).toEqual(input);
      expect(localCompanyDetailSchema.parse(f.selected)).toEqual(f.selected);
      const getCompany = vi.fn(async () => f.selected);
      remove = registerLocalWorkspaceIpc({ ...provider, getCompany });
      const api = createLocalWorkspaceApi(createIpcClient({ invoke: async (channel, ...args) => registeredIpcHandler(electron.handle, channel)(trusted, ...args) }));
      expect(await api.getCompany(input)).toEqual(f.selected);
      expect(getCompany).toHaveBeenCalledTimes(1);
      expect(getCompany).toHaveBeenCalledWith(input);
    } finally { remove?.(); f.close(); }
  });

  it('rejects untrusted callers and strict arity/payload before invoking the provider', async () => {
    const getCompany = vi.fn(unavailableCompany);
    const remove = registerLocalWorkspaceIpc({ ...provider, getCompany });
    try {
      const handler = registeredIpcHandler(electron.handle, 'local-workspace:get-company');
      for (const args of [[], [{ accountId: 'saved' }, { accountId: 'saved' }], ...selectedInvalidRequests.map(input => [input])]) {
        await expect(handler(trusted, ...args)).rejects.toThrow();
      }
      for (const event of [{}, { senderFrame: null }, { senderFrame: { url: 'https://evil.invalid' } }]) {
        await expect(handler(event as unknown as Parameters<typeof handler>[0], { accountId: 'saved' })).rejects.toThrow();
      }
      expect(getCompany).not.toHaveBeenCalled();
      const invoke = vi.fn(async () => { throw new Error('must not invoke'); });
      const api = createLocalWorkspaceApi(createIpcClient({ invoke }));
      for (const input of selectedInvalidRequests) await expect(api.getCompany(input as SelectedCompany)).rejects.toThrow();
      expect(invoke).not.toHaveBeenCalled();
    } finally { remove(); }
  });

  it.each(invalidCompanyReplies)('rejects $name at registrar and preload independently', async ({ change }) => {
    const f = await companyBridgeFixture();
    let remove: (() => void) | undefined;
    try {
      // Deliberately untrusted response cast, never represented as repository evidence.
      const invalid = change(f.selected, f.other);
      const input = { accountId: f.selected.snapshot.account.id };
      remove = registerLocalWorkspaceIpc({ ...provider, getCompany: async () => invalid as LocalCompanyDetail });
      const handler = registeredIpcHandler(electron.handle, 'local-workspace:get-company');
      await expect(handler(trusted, input)).rejects.toThrow(/^LOCAL_COMPANY_READ_FAILED$/);
      const api = createLocalWorkspaceApi(createIpcClient({ invoke: async () => invalid }));
      await expect(api.getCompany(input)).rejects.toThrow();
    } finally { remove?.(); f.close(); }
  });

  it('redacts read failures without manufacturing an empty detail', async () => {
    const remove = registerLocalWorkspaceIpc({ ...provider, getCompany: async () => { throw new Error('private database path'); } });
    try {
      const api = createLocalWorkspaceApi(createIpcClient({ invoke: async (channel, ...args) => registeredIpcHandler(electron.handle, channel)(trusted, ...args) }));
      await expect(api.getCompany({ accountId: 'missing' })).rejects.toThrow(/^LOCAL_COMPANY_READ_FAILED$/);
    } finally { remove(); }
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18])('rolls back all successful local registrations when handler %s fails', nth => {
    const active = new Set<string>();
    const registered: string[] = [];
    let calls = 0;
    electron.handle.mockReset().mockImplementation((channel: string) => {
      if (++calls === nth) throw new Error('selected registration failure');
      active.add(channel); registered.push(channel);
    });
    electron.removeHandler.mockReset().mockImplementation((channel: string) => { active.delete(channel); });
    try {
      expect(() => registerLocalWorkspaceIpc(provider)).toThrow('selected registration failure');
      expect(active.size).toBe(0);
      expect(electron.removeHandler.mock.calls.map(call => call[0])).toEqual([...registered].reverse());
    } finally { electron.handle.mockReset(); electron.removeHandler.mockReset(); }
  });
});

function companyStorageState(database: AppDatabase) {
  const tables = database.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return { changes: database.raw.prepare('SELECT total_changes() AS changes').get(),
    tables: tables.map(({ name }) => ({ name, rows: database.raw.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() })) };
}

it('getCompany leases real storage per read, uses the system clock, and stays read-only after domain shutdown', async () => {
  const f = lifetimeFixture();
  try {
    const now = vi.spyOn(SystemClock.prototype, 'now').mockReturnValue(PM_NOW);
    const saved = await f.provider.createCompany({ commandId: crypto.randomUUID(), name: 'Real storage selected', domain: null });
    if (saved.status !== 'saved') throw new Error('Expected saved company');
    f.stopDomain();
    const database = f.database()!;
    const before = companyStorageState(database);
    const withDatabase = vi.spyOn(f.runtime, 'withDatabase');
    const withDomain = vi.spyOn(f.runtime, 'withDomain');
    now.mockReturnValue('2026-09-10T12:00:00.000Z');
    const ids = vi.spyOn(UuidGenerator.prototype, 'next');
    const repo = new AccountRepository({ database, clock: new SystemClock(), ids: new UuidGenerator() });
    const expectedSnapshot = repo.snapshot(saved.account.id, '2026-09-10T12:00:00.000Z');
    for (let i = 0; i < 2; i++) {
      expect(await f.provider.getCompany({ accountId: saved.account.id })).toEqual({ scope: 'local_database', generatedAt: '2026-09-10T12:00:00.000Z', snapshot: expectedSnapshot, sources: [], links: [] });
    }
    expect(withDatabase).toHaveBeenCalledTimes(2);
    expect(withDomain).not.toHaveBeenCalled();
    expect(now).toHaveBeenCalled();
    expect(ids).not.toHaveBeenCalled();
    expect(companyStorageState(database)).toEqual(before);
    expect(f.opens()).toBe(1);
    await f.runtime.shutdown();
    expect(database.raw.open).toBe(false);
    await expect(f.provider.getCompany({ accountId: saved.account.id })).rejects.toThrow();
    expect(f.opens()).toBe(1);
  } finally { vi.restoreAllMocks(); await f.close(); }
});

it('getCompany rejects a locked key and retries initialization without empty fallback', async () => {
  let unavailable = true;
  const f = lifetimeFixture(async () => { if (unavailable) throw new Error('fictional key unavailable'); });
  try {
    await expect(f.provider.getCompany({ accountId: 'missing' })).rejects.toThrow('fictional key unavailable');
    expect(f.opens()).toBe(0);
    unavailable = false;
    await expect(f.provider.getCompany({ accountId: 'missing' })).rejects.toThrow();
    expect(f.opens()).toBe(1);
    const before = companyStorageState(f.database()!);
    await expect(f.provider.getCompany({ accountId: 'missing' })).rejects.toThrow();
    expect(companyStorageState(f.database()!)).toEqual(before);
    expect(f.opens()).toBe(1);
  } finally { await f.close(); }
});

it('getCompany shares pending initialization and shutdown fences delayed key results', async () => {
  let release!: () => void;
  const pendingKey = new Promise<void>(resolve => { release = resolve; });
  const f = lifetimeFixture(() => pendingKey);
  try {
    const first = f.provider.getCompany({ accountId: 'missing' });
    const second = f.provider.getCompany({ accountId: 'missing' });
    const rejected = Promise.all([expect(first).rejects.toThrow(), expect(second).rejects.toThrow()]);
    expect(f.opens()).toBe(0);
    const stopped = f.runtime.shutdown();
    release();
    await rejected; await stopped;
    expect(f.opens()).toBe(0);
    await expect(f.provider.getCompany({ accountId: 'missing' })).rejects.toThrow();
  } finally { release(); await f.close(); }
});

it('shutdown waits for an already acquired getCompany storage lease and then disposes it', async () => {
  const f = lifetimeFixture();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const acquired = new Promise<void>(resolve => { entered = resolve; });
  type ReadOutcome = { kind: 'read'; value: LocalCompanyDetail } | { kind: 'error'; error: unknown };
  let readOutcome: Promise<ReadOutcome> | undefined;
  let deadline: Promise<{ kind: 'timeout' }> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const saved = await f.provider.createCompany({ commandId: crypto.randomUUID(), name: 'Leased read', domain: null });
    if (saved.status !== 'saved') throw new Error('Expected saved company');
    const database = f.database()!;
    const before = companyStorageState(database);
    const withDatabase = f.runtime.withDatabase.bind(f.runtime);
    deadline = new Promise(resolve => { timer = setTimeout(() => resolve({ kind: 'timeout' }), 2_000); });
    const leaseDeadline = deadline;
    // Delay only the callback inside the real lease. No fake runtime or synthetic detail.
    const holdLease: FoundationRuntime['withDatabase'] = <T,>(operation: (db: AppDatabase) => T | Promise<T>) => withDatabase(async (db: AppDatabase) => {
      entered(); await held;
      const result = await Promise.race([
        operation(db),
        leaseDeadline.then(() => { throw new Error('Test lease callback exceeded its deadline'); }),
      ]);
      expect(companyStorageState(db)).toEqual(before);
      return result;
    });
    vi.spyOn(f.runtime, 'withDatabase').mockImplementation(holdLease);
    // Handle both synchronous and asynchronous failures before waiting for the lease.
    readOutcome = Promise.resolve().then(() => f.provider.getCompany({ accountId: saved.account.id })).then(
      value => ({ kind: 'read' as const, value }),
      error => ({ kind: 'error' as const, error }),
    );
    const acquisition = await Promise.race([acquired.then(() => ({ kind: 'acquired' as const })), readOutcome, deadline]);
    if (acquisition.kind === 'error') throw acquisition.error;
    if (acquisition.kind !== 'acquired') throw new Error(`Storage lease was not acquired: ${acquisition.kind}`);
    let closed = false;
    const stopped = f.runtime.shutdown().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(database.raw.open).toBe(true);
    release();
    const read = await Promise.race([readOutcome, deadline]);
    if (read.kind === 'error') throw read.error;
    if (read.kind === 'timeout') throw new Error('Storage read did not settle before the lease deadline');
    expect(read.value.snapshot.account.id).toBe(saved.account.id);
    // The wrapper observed unchanged rows before releasing the real storage lease.
    await stopped;
    expect(database.raw.open).toBe(false);
    expect(f.opens()).toBe(1);
    await expect(f.provider.getCompany({ accountId: saved.account.id })).rejects.toThrow();
  } finally {
    release();
    try {
      // Drain a released callback, but do not strand cleanup on a never-acquiring read.
      if (readOutcome && deadline) await Promise.race([readOutcome, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      vi.restoreAllMocks();
      await f.close();
    }
  }
});

const researchChannels = ['local-workspace:research-company', 'local-workspace:company-research-status'] as const;
const researchMethods = ['researchCompany', 'getCompanyResearchStatus'] as const;
const researchLimits = { maxCompanies: 1, maxPages: 1, maxBytes: 10000, maxCostMicros: 100 };

describe('Task 3 strict selected research IPC', () => {
  it('roundtrips actual persisted status with exact channel and input identities at both public boundaries', async () => {
    const f = await createPmFixture(); let remove: (() => void) | undefined;
    try {
      const account = f.repo.create({ commandId: crypto.randomUUID(), name: 'Research wire', domain: null });
      const input = Object.freeze({ commandId: crypto.randomUUID(), accountId: account.id });
      f.repo.enqueue({ ...input, limits: researchLimits });
      const status = f.repo.readSelectedResearch(input); expect(status.state).toBe('queued');
      const researchCompany = vi.fn(async (selected: SelectedResearch) => f.repo.readSelectedResearch(selected));
      const getCompanyResearchStatus = vi.fn(async (selected: SelectedResearch) => f.repo.readSelectedResearch(selected));
      const currentProvider = { ...provider, researchCompany, getCompanyResearchStatus };
      remove = registerLocalWorkspaceIpc(currentProvider);
      expect(researchCompany).not.toHaveBeenCalled(); expect(getCompanyResearchStatus).not.toHaveBeenCalled();
      expect(electron.handle.mock.calls.slice(9, 11).map(call => call[0])).toEqual(researchChannels);
      const invoke = vi.fn(async (channel: string, ...args: unknown[]) => registeredIpcHandler(electron.handle, channel)(trusted, ...args));
      const api = createLocalWorkspaceApi(createIpcClient({ invoke }));
      for (const [index, method] of researchMethods.entries()) {
        expect(typeof api[method]).toBe('function');
        expect(await api[method](input)).toEqual(status);
        expect(invoke).toHaveBeenLastCalledWith(researchChannels[index], input);
        expect(currentProvider[method]).toHaveBeenCalledTimes(1);
      }
      remove(); remove();
      expect(electron.removeHandler.mock.calls.map(call => call[0])).toEqual([
        'local-workspace:territory-clearance-revoke', 'local-workspace:territory-clearance-confirm', 'local-workspace:territory-clearance-read',
        'local-workspace:prepare-company-draft', 'local-workspace:save-company-draft', 'local-workspace:get-company-draft', 'local-workspace:open-company-draft', 'local-workspace:admit-company-phone-route', 'local-workspace:admit-company-draft-email',
        'local-workspace:update-call-settings', 'local-workspace:get-call-settings', 'local-workspace:link-company-person', ...[...researchChannels].reverse(), 'local-workspace:get-company', 'local-workspace:company-create-status',
        'local-workspace:create-company', 'local-workspace:review-company', 'local-workspace:transition',
        'local-workspace:get-commitments', 'local-workspace:get', 'local-workspace:update-company-research-settings', 'local-workspace:get-company-research-settings',
      ]);
    } finally { remove?.(); f.close(); }
  });

  it.each(researchMethods)('%s rejects malformed requests before reaching transport/provider and enforces trusted one-argument arity', async method => {
    const selected = { commandId: crypto.randomUUID(), accountId: 'saved' };
    const operation = vi.fn(async (): Promise<never> => { throw new Error('private research credential'); });
    const remove = registerLocalWorkspaceIpc({ ...provider, [method]: operation });
    try {
      const channel = researchChannels[researchMethods.indexOf(method)]!;
      const handler = registeredIpcHandler(electron.handle, channel);
      const invoke = vi.fn(async () => { throw new Error('unexpected transport'); });
      const api = createLocalWorkspaceApi(createIpcClient({ invoke }));
      expect(typeof api[method]).toBe('function'); expect(typeof handler).toBe('function');
      const invalid = [undefined, null, {}, { ...selected, commandId: 'not-uuid' }, { ...selected, accountId: '' },
        { ...selected, workspaceId: 'injected' }, { ...selected, limits: researchLimits }, { ...selected, signal: {} }];
      for (const input of invalid) {
        await expect(api[method](input as SelectedResearch)).rejects.toThrow();
        await expect(handler(trusted, input)).rejects.toThrow();
      }
      await expect(handler(trusted)).rejects.toThrow(); await expect(handler(trusted, selected, selected)).rejects.toThrow();
      await expect(handler({ senderFrame: { url: 'https://evil.invalid' } }, selected)).rejects.toThrow();
      expect(operation).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
      await expect(handler(trusted, selected)).rejects.toThrow(method === 'researchCompany' ? /^LOCAL_COMPANY_RESEARCH_FAILED$/ : /^LOCAL_COMPANY_RESEARCH_STATUS_FAILED$/);
      expect(operation).toHaveBeenCalledTimes(1);
    } finally { remove(); }
  });

  it.each(researchMethods)('%s fails closed for wrong account, wrong UUID and malformed status on registrar and preload', async method => {
    const f = await createPmFixture();
    try {
      const account = f.repo.create({ commandId: crypto.randomUUID(), name: 'Real response source', domain: null });
      const selected = { commandId: crypto.randomUUID(), accountId: account.id };
      f.repo.enqueue({ ...selected, limits: researchLimits });
      const status = f.repo.readSelectedResearch(selected); expect(status.state).toBe('queued');
      const invalid = [
        { ...status, accountId: 'other' }, { ...status, commandId: crypto.randomUUID() },
        { ...status, workspaceId: 'invented' }, { ...status, state: 'completed' },
        { ...status, reason: 7 }, { ...status, state: 'unknown' },
        { ...status, state: 'completed', receipt: { accountId: 'other', version: 2, duplicate: false } },
        { ...status, receipt: { accountId: account.id, version: 2, duplicate: false } },
      ];
      for (const reply of invalid) {
        electron.handle.mockClear();
        const remove = registerLocalWorkspaceIpc({ ...provider, [method]: async () => reply as LocalCompanyResearchStatus });
        try {
          const handler = registeredIpcHandler(electron.handle, researchChannels[researchMethods.indexOf(method)]!);
          await expect(handler(trusted, selected)).rejects.toThrow(method === 'researchCompany' ? /^LOCAL_COMPANY_RESEARCH_FAILED$/ : /^LOCAL_COMPANY_RESEARCH_STATUS_FAILED$/);
          const api = createLocalWorkspaceApi(createIpcClient({ invoke: async () => reply }));
          expect(typeof api[method]).toBe('function');
          await expect(api[method](selected)).rejects.toThrow();
        } finally { remove(); }
      }
    } finally { f.close(); }
  });

  it.each(researchMethods)('%s freezes request identities before an asynchronous response', async method => {
    const f = await createPmFixture();
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), 2000); });
    try {
      const account = f.repo.create({ commandId: crypto.randomUUID(), name: 'Frozen response', domain: null });
      const input = { commandId: crypto.randomUUID(), accountId: account.id }; const original = { ...input };
      const reply = f.repo.readSelectedResearch(original);
      const invoke = vi.fn(async () => { await held; return reply; });
      const api = createLocalWorkspaceApi(createIpcClient({ invoke })); expect(typeof api[method]).toBe('function');
      const pending = api[method](input).then(value => ({ value }), error => ({ error }));
      input.accountId = 'mutated'; input.commandId = crypto.randomUUID(); release();
      expect(await Promise.race([pending, timeout])).toEqual({ value: reply });
      expect(invoke).toHaveBeenCalledWith(researchChannels[researchMethods.indexOf(method)], original);
      // Registrar receives a separate mutable request and must bind to its admitted copy too.
      const request = { ...original }; let finish!: () => void;
      const responseGate = new Promise<void>(resolve => { finish = resolve; });
      const remove = registerLocalWorkspaceIpc({ ...provider, [method]: async () => { await responseGate; return reply; } });
      try {
        const handler = registeredIpcHandler(electron.handle, researchChannels[researchMethods.indexOf(method)]!);
        const response = Promise.resolve(handler(trusted, request)).then(value => ({ value }), error => ({ error }));
        request.accountId = 'mutated'; request.commandId = crypto.randomUUID(); finish();
        expect(await Promise.race([response, timeout])).toEqual({ value: reply });
      } finally { finish(); remove(); }
    } finally { release(); clearTimeout(timer); f.close(); }
  });
});

it('Task 3 real provider reads persisted queued running completed and parked state without capability or settlement', async () => {
  const f = lifetimeFixture();
  try {
    await f.runtime.withDatabase((): void => undefined);
    const repo = new AccountRepository({ database: f.database()!, clock: { now: () => PM_NOW }, ids: { next: () => crypto.randomUUID() }, research: { maxBudgetMicros: 1000 } });
    const account = repo.create({ commandId: crypto.randomUUID(), name: 'Persisted research', domain: 'example.invalid' });
    const selected = { commandId: crypto.randomUUID(), accountId: account.id };
    const absent = createLocalWorkspaceProvider(f.runtime, { current: () => null });
    expect(typeof absent.getCompanyResearchStatus).toBe('function');
    expect(await absent.researchCompany(selected)).toMatchObject({ ...selected, state: 'held', receipt: null });
    expect(repo.readSelectedResearch(selected).state).toBe('not_recorded');
    repo.enqueue({ ...selected, limits: researchLimits });
    const observe = async (state: string) => {
      const before = companyStorageState(f.database()!);
      expect(await absent.getCompanyResearchStatus(selected)).toMatchObject({ ...selected, state });
      expect(await absent.researchCompany(selected)).toMatchObject({ ...selected, state });
      expect(companyStorageState(f.database()!)).toEqual(before);
    };
    await observe('queued'); const job = repo.claimSelected(PM_NOW, selected)!; expect(job.accountId).toBe(account.id);
    await observe('running');
    const receipt = repo.admitEvidence({ commandId: job.receiptCommandId, accountId: account.id, expectedVersion: 1, sources: [], claims: [], routes: [] }, { jobId: job.id, claimToken: job.claimToken });
    await observe('completed');
    expect(await absent.getCompanyResearchStatus(selected)).toMatchObject({ receipt });
    expect(f.database()!.raw.prepare('SELECT state FROM pm_account_research_jobs WHERE id=?').get(job.id)).toEqual({ state: 'running' });
    const parked = { commandId: crypto.randomUUID(), accountId: account.id }; repo.enqueue({ ...parked, limits: researchLimits });
    const uncertain = repo.claimSelected(PM_NOW, parked)!;
    repo.settle({ jobId: uncertain.id, claimToken: uncertain.claimToken, status: 'parked', receiptCommandId: null, costMicros: null });
    const before = companyStorageState(f.database()!);
    expect(await absent.researchCompany(parked)).toMatchObject({ ...parked, state: 'parked' });
    expect(await absent.getCompanyResearchStatus(parked)).toMatchObject({ ...parked, state: 'parked' });
    expect(companyStorageState(f.database()!)).toEqual(before);
    await expect(absent.getCompanyResearchStatus({ ...selected, accountId: 'missing' })).rejects.toThrow();
    await f.runtime.shutdown(); await expect(absent.getCompanyResearchStatus(selected)).rejects.toThrow();
  } finally { await f.close(); }
});

it('Task 3 absent-domain execution cannot use a present capability while status uses actual storage only', async () => {
  const f = lifetimeFixture();
  try {
    const selected = await f.runtime.withDatabase(database => {
      const repo = new AccountRepository({ database, clock: { now: () => PM_NOW }, ids: { next: () => crypto.randomUUID() } });
      const account = repo.create({ commandId: crypto.randomUUID(), name: 'No domain bypass', domain: null });
      return { commandId: crypto.randomUUID(), accountId: account.id };
    });
    const researchCompany = vi.fn(async (): Promise<never> => { throw new Error('capability must not be invoked'); });
    const port: SelectedCompanyResearchPort = { researchCompany };
    const local = createLocalWorkspaceProvider(f.runtime, { current: () => port });
    expect(typeof local.researchCompany).toBe('function');
    f.stopDomain();
    await expect(f.runtime.withDomain((): void => undefined)).rejects.toThrow();
    const before = companyStorageState(f.database()!);
    expect(await local.getCompanyResearchStatus(selected)).toMatchObject({ ...selected, state: 'not_recorded' });
    expect(await local.researchCompany(selected)).toMatchObject({ ...selected, state: 'held', receipt: null, reason: expect.any(String) });
    expect(researchCompany).not.toHaveBeenCalled(); expect(companyStorageState(f.database()!)).toEqual(before);
  } finally { await f.close(); }
});

it.each(['account', 'command', 'shape'] as const)('Task 3 real provider validates unchecked optional-port %s responses before forwarding', async mismatch => {
  const f = lifetimeFixture();
  try {
    const selected = await f.runtime.withDatabase(database => {
      const repo = new AccountRepository({ database, clock: { now: () => PM_NOW }, ids: { next: () => crypto.randomUUID() } });
      const account = repo.create({ commandId: crypto.randomUUID(), name: 'Optional port response', domain: null });
      return { commandId: crypto.randomUUID(), accountId: account.id };
    });
    const read = createLocalWorkspaceProvider(f.runtime);
    const original = await read.getCompanyResearchStatus(selected);
    expect(original).toMatchObject({ ...selected, state: 'not_recorded' });
    const reply = mismatch === 'account' ? { ...original, accountId: 'other' }
      : mismatch === 'command' ? { ...original, commandId: crypto.randomUUID() } : { ...original, workspaceId: 'private' };
    const researchCompany = vi.fn(async () => reply);
    const local = createLocalWorkspaceProvider(f.runtime, { current: () => ({ researchCompany }) });
    await expect(local.researchCompany(selected)).rejects.toThrow();
    expect(researchCompany).toHaveBeenCalledTimes(1);
    expect(await read.getCompanyResearchStatus(selected)).toEqual(original);
  } finally { await f.close(); }
});

// Task 5 append-only preparation. Original tests and their frozen nine-handler
// inventory above are intentionally unchanged. Parent owns inventory migration.
import type { AccountEvidenceReceipt } from '../../src/shared/contracts/accountContract';
import { seedIntakePeople } from '../fixtures/domainRows';
import { createFounderSalesDomain, type FounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
const task5Channel = 'local-workspace:link-company-person';
const task5Now = '2026-09-09T12:00:00.000Z';
const task5Quote = 'Nora Vale is the maintenance manager at Fictional Cedar PM.';
const task5Uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
function task5Request(): LinkCompanyPersonRequest {
  return { commandId: task5Uuid(1), accountId: 'selected', expectedVersion: 2,
    link: { id: 'reviewed-link', kind: 'person_role', personId: 'saved-person', role: 'Maintenance manager',
      relationship: 'Reviewed source-listed role', authority: 'unconfirmed', authorityEvidenceIds: [],
      evidenceIds: ['source'], validFrom: task5Now, validTo: null },
    sourceQuotes: [{ sourceId: 'source', quote: task5Quote }] };
}
function task5RuntimeFixture(load?: () => Promise<void>) {
  const temp = createTempDatabase(); const key = createTestWorkspaceKey();
  let database: AppDatabase | undefined; let domainRuntime: DomainRuntime | undefined; let counter = 2000; let opens = 0;
  const ids = { next: () => task5Uuid(++counter) };
  const runtime = new FoundationRuntime({ appVersion: '1.0.0', databasePath: temp.path, databaseExists: false,
    backupDirectory: join(dirname(temp.path), 'backups'), keyEnvelopePath: join(dirname(temp.path), 'fictional-envelope.json') }, {
    loadWorkspaceKey: async () => { await load?.(); return { ...key, bytes: Buffer.from(key.bytes) }; },
    prepareEncryptedDatabase: async () => undefined,
    openDatabase: options => { opens++; database = openDatabase(options); return database; }, migrateToLatest,
    createDomainRuntime: db => domainRuntime = new DomainRuntime({ database: db, clock: { now: () => task5Now }, ids }),
    createHealthService: options => new HealthService(options), closeDatabase,
  });
  return { runtime, local: createLocalWorkspaceProvider(runtime), ids, database: () => database!, opens: () => opens,
    domainServices: () => domainRuntime!.getServices(),
    stopDomain: () => domainRuntime?.shutdown(),
    async close() { try { await runtime.shutdown(); } finally { key.bytes.fill(0); temp.cleanup(); } } };
}
async function task5Seed(f: ReturnType<typeof task5RuntimeFixture>, isolatedDomain?: FounderSalesDomain) {
  // P01/P03 retain the public Foundation composition. Only P02 supplies a real
  // facade inside withDatabase, without populating Foundation's memoized facade.
  const seed = () => seedIntakePeople(f.domainServices(), { channel: 'registry', sourceName: 'fictional-link-bridge.csv',
    observedAt: task5Now, ids: f.ids, rows: [
      { displayName: 'Nora Vale', email: 'nora.vale@cedar.invalid', organization: 'Fictional Cedar PM' },
      { displayName: 'Marcus Reed', email: 'marcus.reed@cedar.invalid', organization: 'Fictional Cedar PM' },
    ] });
  const imported = isolatedDomain ? seed() : await f.runtime.withDatabase(seed);
  expect(imported).toHaveLength(2); expect(new Set(imported.map(person => person.personId)).size).toBe(2);
  const readDetails = (domain: FounderSalesDomain) => imported.map(({ personId }) => domain.getLeadDetail({ personId }));
  const details = isolatedDomain ? readDetails(isolatedDomain) : await f.runtime.withDomain(readDetails);
  const nora = details.find(p => p.personName === 'Nora Vale')!;
  const marcus = details.find(p => p.personName === 'Marcus Reed')!;
  expect(nora).toBeDefined(); expect(marcus).toBeDefined();
  expect(nora.personId).not.toBe(marcus.personId);
  expect(nora.organizationLabel).toBe('Fictional Cedar PM'); expect(marcus.organizationLabel).toBe(nora.organizationLabel);
  expect(nora.emails[0]).toMatchObject({ value: 'nora.vale@cedar.invalid', ownershipState: 'unknown' });
  expect(marcus.emails[0]).toMatchObject({ value: 'marcus.reed@cedar.invalid', ownershipState: 'unknown' });
  const companyInput = { commandId: f.ids.next(), name: 'Fictional Cedar PM', domain: 'cedar.invalid' };
  const saved = isolatedDomain ? isolatedDomain.createLocalCompany(companyInput) : await f.local.createCompany(companyInput);
  expect(saved.status).toBe('saved'); if (saved.status !== 'saved') throw new Error('Expected real saved account');
  const excerpt = `${task5Quote} Marcus Reed is the leasing coordinator.`;
  const source = { id: f.ids.next(), url: 'https://example.invalid/team', fetchedAt: task5Now,
    sha256: createHash('sha256').update(excerpt).digest('hex'), excerpt, permitted: true };
  const repo = new AccountRepository({ database: f.database(), clock: { now: () => task5Now }, ids: f.ids,
    sourcePolicy: { attest: item => item.url === source.url && item.sha256 === source.sha256 && item.excerpt === source.excerpt } });
  const admitted = repo.admitEvidence({ commandId: f.ids.next(), accountId: saved.account.id, expectedVersion: saved.account.version,
    sources: [source], claims: [], routes: [{ id: f.ids.next(), accountId: saved.account.id, personId: null, channel: 'email',
      value: 'office@cedar.invalid', purpose: 'business', verification: 'published', evidenceIds: [source.id] }] });
  expect(admitted).toMatchObject({ duplicate: false, version: 2 }); expect(f.database().raw.inTransaction).toBe(false);
  const request: LinkCompanyPersonRequest = { ...task5Request(), commandId: f.ids.next(), accountId: saved.account.id,
    expectedVersion: admitted.version, link: { ...task5Request().link, id: f.ids.next(), personId: nora.personId, evidenceIds: [source.id] },
    sourceQuotes: [{ sourceId: source.id, quote: task5Quote }] };
  return { request, repo, nora, marcus, details };
}
function task5Preserved(db: AppDatabase) {
  const mutable = new Set(['pm_accounts', 'pm_account_commands', 'pm_account_links', 'pm_account_link_evidence']);
  const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
  return tables.filter(t => !mutable.has(t.name)).map(({ name }) => ({ name,
    rows: db.raw.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map(row => JSON.stringify(row)).sort() }));
}

// Boundary-only adversarial replies are explicitly NOT evidence of person/link
// admission. The successful admission case below uses the entire real stack.
describe('Task 5 public reviewed relationship boundaries', () => {
  it('T5-B01 registers and disposes exactly one additional reviewed-link handler without replacing existing handler names', () => {
    const remove = registerLocalWorkspaceIpc({ ...provider, linkCompanyPerson: async (): Promise<never> => { throw new Error('not invoked'); } });
    try {
      const names = electron.handle.mock.calls.map(call => call[0]);
      expect(names.filter(name => name === task5Channel)).toEqual([task5Channel]);
      expect(names.filter(name => name !== task5Channel)).toEqual(['local-workspace:get-company-research-settings', 'local-workspace:update-company-research-settings', 'local-workspace:get', 'local-workspace:get-commitments',
        'local-workspace:transition', 'local-workspace:review-company', 'local-workspace:create-company',
        'local-workspace:company-create-status', 'local-workspace:get-company', 'local-workspace:research-company', 'local-workspace:company-research-status', 'local-workspace:get-call-settings', 'local-workspace:update-call-settings', 'local-workspace:admit-company-draft-email', 'local-workspace:admit-company-phone-route', 'local-workspace:open-company-draft', 'local-workspace:get-company-draft', 'local-workspace:save-company-draft', 'local-workspace:prepare-company-draft', 'local-workspace:territory-clearance-read', 'local-workspace:territory-clearance-confirm', 'local-workspace:territory-clearance-revoke']);
    } finally { remove(); }
    expect(electron.removeHandler.mock.calls.filter(call => call[0] === task5Channel)).toHaveLength(1);
  });

  it('T5-B02 rejects strict request shape, untrusted sender and wrong arity before the provider or transport', async () => {
    const linkCompanyPerson = vi.fn(async (): Promise<never> => { throw new Error('must not run'); });
    const remove = registerLocalWorkspaceIpc({ ...provider, linkCompanyPerson });
    try {
      expect(electron.handle.mock.calls.map(call => call[0])).toContain(task5Channel);
      const handler = registeredIpcHandler(electron.handle, task5Channel);
      const input = task5Request();
      const bad = [undefined, null, {}, { ...input, workspaceId: 'invented' }, { ...input, sourceQuotes: [] },
        { ...input, link: { ...input.link, authority: 'confirmed' } },
        { ...input, link: { ...input.link, verifiedContact: true } },
        { ...input, sourceQuotes: [input.sourceQuotes[0], input.sourceQuotes[0]] },
        { ...input, sourceQuotes: [{ sourceId: 'source', quote: 'x'.repeat(12001) }] }];
      for (const value of bad) await expect(handler(trusted, value)).rejects.toThrow();
      await expect(handler(trusted)).rejects.toThrow();
      await expect(handler(trusted, input, input)).rejects.toThrow();
      await expect(handler({ senderFrame: { url: 'https://untrusted.invalid' } }, input)).rejects.toThrow();
      expect(linkCompanyPerson).not.toHaveBeenCalled();
      const invoke = vi.fn(async () => { throw new Error('must not invoke'); });
      const api = createLocalWorkspaceApi(createIpcClient({ invoke }));
      expect(api.linkCompanyPerson).toBeTypeOf('function');
      for (const value of bad) await expect(api.linkCompanyPerson(value as LinkCompanyPersonRequest)).rejects.toThrow();
      expect(invoke).not.toHaveBeenCalled();
    } finally { remove(); }
  });

  it.each(['wrong account', 'extra receipt key', 'zero version', 'unsafe version', 'wrong duplicate type'] as const)(
    'T5-B03 independently rejects %s at registrar and preload', async reason => {
      const input = task5Request();
      const valid: AccountEvidenceReceipt = { accountId: input.accountId, version: 3, duplicate: false };
      const reply = reason === 'wrong account' ? { ...valid, accountId: 'another-selected-account' }
        : reason === 'extra receipt key' ? { ...valid, privatePath: 'must-not-cross-boundary' }
          : reason === 'zero version' ? { ...valid, version: 0 }
            : reason === 'unsafe version' ? { ...valid, version: Number.MAX_SAFE_INTEGER + 1 }
              : { ...valid, duplicate: 'yes' };
      const remove = registerLocalWorkspaceIpc({ ...provider, linkCompanyPerson: async () => reply as AccountEvidenceReceipt });
      try {
        expect(electron.handle.mock.calls.map(call => call[0])).toContain(task5Channel);
        await expect(registeredIpcHandler(electron.handle, task5Channel)(trusted, input)).rejects.toThrow();
        // Independent unchecked transport, not a registrar rejection reused as preload evidence.
        const api = createLocalWorkspaceApi(createIpcClient({ invoke: async () => reply }));
        expect(api.linkCompanyPerson).toBeTypeOf('function');
        await expect(api.linkCompanyPerson(input)).rejects.toThrow();
      } finally { remove(); }
    });

  it('T5-B04 accepts a duplicate original receipt without imposing current expectedVersion equality', async () => {
    const input = task5Request();
    const reply: AccountEvidenceReceipt = { accountId: input.accountId, version: 3, duplicate: true };
    const linkCompanyPerson = vi.fn(async () => reply);
    const remove = registerLocalWorkspaceIpc({ ...provider, linkCompanyPerson });
    try {
      expect(electron.handle.mock.calls.map(call => call[0])).toContain(task5Channel);
      const invoke = vi.fn(async (channel: string, ...args: unknown[]) => registeredIpcHandler(electron.handle, channel)(trusted, ...args));
      const api = createLocalWorkspaceApi(createIpcClient({ invoke }));
      expect(api.linkCompanyPerson).toBeTypeOf('function');
      expect(await api.linkCompanyPerson(input)).toEqual(reply);
      expect(invoke).toHaveBeenCalledWith(task5Channel, input);
      expect(linkCompanyPerson).toHaveBeenCalledWith(input);
    } finally { remove(); }
  });

  it('T5-B05 redacts a private provider error rather than manufacturing success', async () => {
    const remove = registerLocalWorkspaceIpc({ ...provider, linkCompanyPerson: async (): Promise<never> => { throw new Error('private database path and source quote'); } });
    try {
      expect(electron.handle.mock.calls.map(call => call[0])).toContain(task5Channel);
      const outcome = await Promise.resolve(registeredIpcHandler(electron.handle, task5Channel)(trusted, task5Request()))
        .then(value => ({ value }), error => ({ error }));
      expect(outcome).toHaveProperty('error');
      if ('error' in outcome) {
        expect(outcome.error).toBeInstanceOf(Error);
        expect((outcome.error as Error).message).toBe('LOCAL_COMPANY_LINK_FAILED');
        expect(String(outcome.error)).not.toContain('private database'); expect(String(outcome.error)).not.toContain('source quote');
      }
    } finally { remove(); }
  });

  it.each(['registrar', 'preload'] as const)('T5-B06 %s binds the selected account before an asynchronous reply', async boundary => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let timer!: ReturnType<typeof setTimeout>;
    const watchdog = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Task5 boundary watchdog')), 2000); });
    void watchdog.catch((): void => undefined);
    let pending: Promise<unknown> | undefined; let remove: (() => void) | undefined;
    const input = task5Request(); const original = structuredClone(input);
    let forwarded: LinkCompanyPersonRequest | undefined;
    const reply: AccountEvidenceReceipt = { accountId: original.accountId, version: 3, duplicate: false };
    try {
      if (boundary === 'registrar') {
        remove = registerLocalWorkspaceIpc({ ...provider, linkCompanyPerson: async request => { forwarded = request; await gate; return reply; } });
        expect(electron.handle.mock.calls.map(call => call[0])).toContain(task5Channel);
        pending = Promise.resolve(registeredIpcHandler(electron.handle, task5Channel)(trusted, input)).then(value => ({ value }), error => ({ error }));
      } else {
        const api = createLocalWorkspaceApi(createIpcClient({ invoke: async (_channel, request) => { forwarded = request as LinkCompanyPersonRequest; await gate; return reply; } }));
        expect(api.linkCompanyPerson).toBeTypeOf('function');
        pending = api.linkCompanyPerson(input).then(value => ({ value }), error => ({ error }));
      }
      input.accountId = 'mutated-after-request'; input.link.personId = 'mutated-person'; input.sourceQuotes[0]!.quote = 'mutated quote';
      release();
      expect(await Promise.race([pending, watchdog])).toEqual({ value: reply });
      expect(forwarded).toEqual(original);
    } finally {
      release();
      try { if (pending) await Promise.race([pending, watchdog]); }
      finally { clearTimeout(timer); remove?.(); }
    }
  }, 5000);
});

describe('Task 5 real Foundation importer/provider integration', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(task5Now));
    let sequence = 10000;
    vi.spyOn(UuidGenerator.prototype, 'next').mockImplementation(() => task5Uuid(++sequence));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('T5-P01 roundtrips the real imported person through preload registrar provider and account mutation and replays after later changes', async () => {
    const f = task5RuntimeFixture(); let remove: (() => void) | undefined;
    try {
      const saved = await task5Seed(f); const before = task5Preserved(f.database());
      remove = registerLocalWorkspaceIpc(f.local);
      expect(electron.handle.mock.calls.map(call => call[0])).toContain(task5Channel);
      const api = createLocalWorkspaceApi(createIpcClient({ invoke: async (channel, ...args) => registeredIpcHandler(electron.handle, channel)(trusted, ...args) }));
      expect(api.linkCompanyPerson).toBeTypeOf('function');
      const result = await api.linkCompanyPerson(saved.request);
      expect(result).toEqual({ accountId: saved.request.accountId, version: 3, duplicate: false });
      expect(saved.repo.listLinks(saved.request.accountId, task5Now)).toEqual([saved.request.link]);
      expect(task5Preserved(f.database())).toEqual(before);
      // Public detail revision follows all connection writes, including the account command.
      const revision = (f.database().raw.prepare('SELECT total_changes() AS count').get() as { count: number }).count;
      expect(revision).toBeGreaterThan(saved.details[0]!.revision);
      expect(await f.runtime.withDomain(domain => saved.details.map(p => domain.getLeadDetail({ personId: p.personId }))))
        .toEqual(saved.details.map(detail => ({ ...detail, revision })));
      saved.repo.admitEvidence({ commandId: f.ids.next(), accountId: saved.request.accountId, expectedVersion: result.version,
        sources: [], routes: [], claims: [{ key: 'technology', kind: 'hypothesis', value: 'Later account change', evidenceIds: [] }] });
      const later = companyStorageState(f.database());
      expect(await api.linkCompanyPerson(saved.request)).toEqual({ ...result, duplicate: true });
      expect(companyStorageState(f.database())).toEqual(later);
      await expect(api.linkCompanyPerson({ ...saved.request, sourceQuotes: [{ ...saved.request.sourceQuotes[0]!, quote: 'Nora Vale' }] })).rejects.toThrow();
      expect(companyStorageState(f.database())).toEqual(later);
      expect(f.database().raw.inTransaction).toBe(false); expect(f.opens()).toBe(1);
    } finally { remove?.(); await f.close(); }
  }, 20000);

  it('T5-P02 refuses link execution when the domain is unavailable even though storage is readable', async () => {
    const f = task5RuntimeFixture();
    try {
      const readiness = vi.spyOn(f.runtime, 'withDomain');
      // Real import, account and source admission, wholly inside the storage
      // lease. This facade is deliberately NOT Foundation's memoized facade.
      const saved = await f.runtime.withDatabase(database => task5Seed(f, createFounderSalesDomain({
        database, services: f.domainServices(), clock: { now: () => task5Now }, ids: f.ids,
      })));
      expect(readiness).not.toHaveBeenCalled();
      f.stopDomain();
      await expect(f.runtime.withDomain((): void => undefined)).rejects.toThrow();
      readiness.mockClear();
      const detail = await f.runtime.withDatabase(() => saved.repo.readLocalCompanyDetail(saved.request.accountId, task5Now));
      expect(detail.sources.map(source => source.id)).toContain(saved.request.sourceQuotes[0]!.sourceId);
      expect(saved.repo.listLinks(saved.request.accountId, task5Now)).toEqual([]);
      const before = companyStorageState(f.database());
      expect(f.local.linkCompanyPerson).toBeTypeOf('function');
      await expect(f.local.linkCompanyPerson(saved.request)).rejects.toThrow();
      expect(readiness).toHaveBeenCalledTimes(1);
      expect(companyStorageState(f.database())).toEqual(before);
      expect((await f.local.get()).scope).toBe('local_database');
      // After the refusal/unchanged assertions, prove the EXACT request was
      // otherwise admissible. This is repository evidence, not readiness proof.
      expect(saved.repo.admitReviewedPersonLink).toBeTypeOf('function');
      expect(await f.runtime.withDatabase(() => saved.repo.admitReviewedPersonLink(saved.request)))
        .toEqual({ accountId: saved.request.accountId, version: 3, duplicate: false });
      expect(saved.repo.listLinks(saved.request.accountId, task5Now)).toEqual([saved.request.link]);
    } finally { await f.close(); }
  }, 15000);

  it('T5-P03 locked-key failure cannot open storage or admit a relationship and permits a later initialization retry', async () => {
    let locked = true;
    const f = task5RuntimeFixture(async () => { if (locked) throw new Error('fictional locked key'); });
    try {
      expect(f.local.linkCompanyPerson).toBeTypeOf('function');
      await expect(f.local.linkCompanyPerson(task5Request())).rejects.toThrow(); expect(f.opens()).toBe(0);
      locked = false;
      const saved = await task5Seed(f);
      expect(await f.local.linkCompanyPerson(saved.request)).toMatchObject({ duplicate: false, version: 3 });
      await f.runtime.shutdown(); expect(f.database().raw.open).toBe(false);
      await expect(f.local.linkCompanyPerson(saved.request)).rejects.toThrow(); expect(f.opens()).toBe(1);
    } finally { await f.close(); }
  }, 20000);

  it('T5-P04 shutdown fences a delayed link initialization with handled released and joined work', async () => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let signalEntered!: () => void; let loaderEntries = 0;
    const entered = new Promise<void>(resolve => { signalEntered = resolve; });
    const f = task5RuntimeFixture(() => { loaderEntries++; signalEntered(); return gate; });
    let pending: Promise<unknown> | undefined; let stopped: Promise<void> | undefined;
    let timer!: ReturnType<typeof setTimeout>;
    const watchdog = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Task5 shutdown watchdog')), 2000); });
    void watchdog.catch((): void => undefined);
    try {
      expect(f.local.linkCompanyPerson).toBeTypeOf('function');
      pending = f.local.linkCompanyPerson(task5Request()).then(value => ({ value }), error => ({ error }));
      const first = await Promise.race([entered.then(() => 'entered' as const),
        pending.then(() => 'settled-before-entry' as const), watchdog]);
      expect(first).toBe('entered');
      expect(loaderEntries).toBe(1);
      stopped = f.runtime.shutdown(); void stopped.catch((): void => undefined);
      release();
      expect(await Promise.race([pending, watchdog])).toHaveProperty('error');
      await Promise.race([stopped, watchdog]); expect(f.opens()).toBe(0);
    } finally {
      release();
      try { await Promise.race([Promise.all([pending, stopped]), watchdog]); }
      finally {
        try { await Promise.race([f.close(), watchdog]); } finally { clearTimeout(timer); }
      }
    }
  }, 5000);
});

const callInitial: MeetingFirstAccountCallSettings = { newCallSlots: null, totalCallCapacity: null, revision: 0, updatedAt: '2026-09-11T12:00:00.000Z' };
const callUpdate: UpdateCallSettingsRequest = { expectedRevision: 0, newCallSlots: 0, totalCallCapacity: null };
const callReply = { ...callInitial, newCallSlots: 0, revision: 1 };
describe('Call capacity strict boundaries (pure)', () => {
  it('roundtrips exactly two appended channels and independent null/zero values', async () => {
    const updateCallSettings = vi.fn(async () => callReply);
    const remove = registerLocalWorkspaceIpc({ ...provider, getCallSettings: async () => callInitial, updateCallSettings });
    try {
      // The two call-capacity channels were appended after link-company-person; the six company draft and phone route channels and the three territory clearance channels follow them.
      expect(electron.handle.mock.calls.slice(-11, -9).map(c => c[0])).toEqual(['local-workspace:get-call-settings', 'local-workspace:update-call-settings']);
      const api = createLocalWorkspaceApi(createIpcClient({ invoke: async (channel, ...args) => registeredIpcHandler(electron.handle, channel)(trusted, ...args) }));
      expect(await api.getCallSettings()).toEqual(callInitial); expect(await api.updateCallSettings(callUpdate)).toEqual(callReply); expect(updateCallSettings).toHaveBeenCalledWith(callUpdate);
      expect(updateCallSettingsRequestSchema.parse({ expectedRevision: 0, newCallSlots: 9, totalCallCapacity: 0 })).toEqual({ expectedRevision: 0, newCallSlots: 9, totalCallCapacity: 0 });
    } finally { remove(); }
  });
  it('rejects malformed requests before provider or transport, including unsafe integers and caller timestamps', async () => {
    const updateCallSettings = vi.fn(async () => callReply); const getCallSettings = vi.fn(async () => callInitial);
    const remove = registerLocalWorkspaceIpc({ ...provider, getCallSettings, updateCallSettings });
    try {
      const handler = registeredIpcHandler(electron.handle, 'local-workspace:update-call-settings');
      const invoke = vi.fn(async () => callReply); const api = createLocalWorkspaceApi(createIpcClient({ invoke }));
      const invalid = [undefined, null, {}, { expectedRevision: 0, newCallSlots: 0 }, ...[-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '0'].map(newCallSlots => ({ ...callUpdate, newCallSlots })),
        { ...callUpdate, totalCallCapacity: -1 }, { ...callUpdate, expectedRevision: Number.MAX_SAFE_INTEGER + 1 }, { ...callUpdate, updatedAt: callInitial.updatedAt }, { ...callUpdate, commandId: 'x' }, { ...callUpdate, workspaceId: 'x' }];
      for (const input of invalid) {
        await expect(api.updateCallSettings(input as UpdateCallSettingsRequest)).rejects.toThrow();
        await expect(handler(trusted, input)).rejects.toThrow(/^LOCAL_CALL_SETTINGS_UPDATE_FAILED$/);
      }
      await expect(handler(trusted)).rejects.toThrow(); await expect(handler(trusted, callUpdate, callUpdate)).rejects.toThrow();
      await expect(handler({ senderFrame: { url: 'https://evil.invalid' } }, callUpdate)).rejects.toThrow();
      const get = registeredIpcHandler(electron.handle, 'local-workspace:get-call-settings');
      await expect(get(trusted, undefined)).rejects.toThrow(); await expect(get({ senderFrame: { url: 'https://evil.invalid' } })).rejects.toThrow();
      expect(getCallSettings).not.toHaveBeenCalled(); expect(updateCallSettings).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
    } finally { remove(); }
  });
  it('binds exact revision and submitted values at both ends, rejecting malformed settings and redacting failures', async () => {
    for (const reply of [{ ...callReply, revision: 2 }, { ...callReply, newCallSlots: null }, { ...callReply, totalCallCapacity: 0 }, { ...callReply, updatedAt: '2026-09-11T12:00:00Z' }, { ...callReply, extra: true }, { ...callReply, revision: Number.MAX_SAFE_INTEGER + 1 }]) {
      electron.handle.mockClear();
      const remove = registerLocalWorkspaceIpc({ ...provider, updateCallSettings: async () => reply });
      try {
        await expect(registeredIpcHandler(electron.handle, 'local-workspace:update-call-settings')(trusted, callUpdate)).rejects.toThrow(/^LOCAL_CALL_SETTINGS_UPDATE_FAILED$/);
        const api = createLocalWorkspaceApi(createIpcClient({ invoke: async () => reply })); await expect(api.updateCallSettings(callUpdate)).rejects.toThrow();
      } finally { remove(); }
    }
    expect(meetingFirstAccountCallSettingsSchema.safeParse({ ...callInitial, newCallSlots: undefined }).success).toBe(false);
    electron.handle.mockClear(); const remove = registerLocalWorkspaceIpc({ ...provider, getCallSettings: async () => { throw Error('/private/database'); } });
    try { await expect(registeredIpcHandler(electron.handle, 'local-workspace:get-call-settings')(trusted)).rejects.toThrow(/^LOCAL_CALL_SETTINGS_READ_FAILED$/); } finally { remove(); }
  });
  it('freezes caller values before awaiting transport and provider replies', async () => {
    let resolve!: (result: MeetingFirstAccountCallSettings) => void;
    const request = { ...callUpdate }; const invoke = vi.fn(() => new Promise<MeetingFirstAccountCallSettings>(done => { resolve = done; }));
    const api = createLocalWorkspaceApi(createIpcClient({ invoke })); const saving = api.updateCallSettings(request);
    request.newCallSlots = 9; request.expectedRevision = 7; resolve(callReply); expect(await saving).toEqual(callReply);
    expect(invoke).toHaveBeenCalledWith('local-workspace:update-call-settings', callUpdate);
    const updateCallSettings = vi.fn(() => new Promise<MeetingFirstAccountCallSettings>(done => { resolve = done; }));
    const remove = registerLocalWorkspaceIpc({ ...provider, updateCallSettings });
    try {
      const source = { ...callUpdate }; const pending = registeredIpcHandler(electron.handle, 'local-workspace:update-call-settings')(trusted, source);
      source.newCallSlots = 5; resolve(callReply); expect(await pending).toEqual(callReply); expect(updateCallSettings).toHaveBeenCalledWith(callUpdate);
    } finally { remove(); }
  });
});

describe('Call capacity real Foundation stack (native)', () => {
  it('commits through preload, registrar, provider and matching facade, keeps lost delivery unknown and refuses shutdown', async () => {
    const f = lifetimeFixture(); const remove = registerLocalWorkspaceIpc(f.provider); let loseDelivery = false;
    const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
      const result = await registeredIpcHandler(electron.handle, channel)(trusted, ...args);
      if (loseDelivery && channel === 'local-workspace:update-call-settings') throw Error('Lost response after commit');
      return result;
    });
    const api = createLocalWorkspaceApi(createIpcClient({ invoke }));
    try {
      const initial = await api.getCallSettings(); expect(initial).toMatchObject({ revision: 0, newCallSlots: null, totalCallCapacity: null });
      const started = Date.now(); const saved = await api.updateCallSettings(callUpdate);
      expect(saved).toMatchObject({ revision: 1, newCallSlots: 0, totalCallCapacity: null }); expect(Date.parse(saved.updatedAt)).toBeGreaterThanOrEqual(started); expect(Date.parse(saved.updatedAt)).toBeLessThanOrEqual(Date.now());
      await expect(api.updateCallSettings(callUpdate)).rejects.toThrow('LOCAL_CALL_SETTINGS_UPDATE_FAILED'); expect(await api.getCallSettings()).toEqual(saved);
      loseDelivery = true;
      await expect(api.updateCallSettings({ expectedRevision: 1, newCallSlots: null, totalCallCapacity: 0 })).rejects.toThrow('Lost response');
      expect(await api.getCallSettings()).toMatchObject({ revision: 2, newCallSlots: null, totalCallCapacity: 0 });
      expect(invoke.mock.calls.filter(c => c[0] === 'local-workspace:update-call-settings')).toHaveLength(3);
      await f.runtime.shutdown(); await expect(api.getCallSettings()).rejects.toThrow('LOCAL_CALL_SETTINGS_READ_FAILED');
    } finally { remove(); await f.close(); }
  });
});
