import { selectedCompanySchema, localCompanyDetailSchema, type LocalWorkspaceSnapshot, type LocalCommitmentsSnapshot, type LocalWorkflowReceipt, type LocalCompanyDetail, type SelectedCompany } from '../../src/shared/contracts/localWorkspaceContract';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
const provider = { getCompany: unavailableCompany, get: async () => snapshot, getCommitments: async () => feed, transition: async () => receipt, reviewCompany: unavailableCompany, createCompany: unavailableCompany, getCompanyCreateStatus: unavailableCompany };
beforeEach(() => vi.clearAllMocks());
describe('local workspace bridge', () => {
  it('roundtrips the frozen API and rejects arity, caller scope, and untrusted senders', async () => {
    const remove = registerLocalWorkspaceIpc(provider);
    expect(electron.handle).toHaveBeenCalledTimes(7);
    const api = createLocalWorkspaceApi(createIpcClient({ invoke: async (channel, ...args) => registeredIpcHandler(electron.handle, channel)(trusted, ...args) }));
    expect(await api.get()).toEqual(snapshot); expect(await api.getCommitments()).toEqual(feed); expect(await api.transition(command)).toEqual(receipt);
    for (const channel of ['local-workspace:get', 'local-workspace:get-commitments']) {
      const handler = registeredIpcHandler(electron.handle, channel);
      await expect(handler(trusted, {})).rejects.toThrow();
      await expect(handler({ senderFrame: { url: 'https://evil.invalid' } })).rejects.toThrow();
    }
    const transition = registeredIpcHandler(electron.handle, 'local-workspace:transition');
    for (const args of [[], [command, command], [{ ...command, workspaceId: 'invented' }], [{ ...command, expectedMode: 'meeting_first' }]]) await expect(transition(trusted, ...args)).rejects.toThrow();
    remove(); remove(); expect(electron.removeHandler.mock.calls.map(c => c[0])).toEqual(['local-workspace:get-company', 'local-workspace:company-create-status', 'local-workspace:create-company', 'local-workspace:review-company', 'local-workspace:transition', 'local-workspace:get-commitments', 'local-workspace:get']);
  });
  it('rolls partial registration back and validates inbound responses', async () => {
    electron.handle.mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw new Error('registration'); });
    expect(() => registerLocalWorkspaceIpc(provider)).toThrow('registration');
    expect(electron.removeHandler).toHaveBeenCalledWith('local-workspace:get');
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
import { createLocalWorkspaceProvider } from '../../src/main/workspace/localWorkspaceProvider';
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

  it.each([1, 2, 3, 4, 5, 6, 7])('rolls back all successful local registrations when handler %s fails', nth => {
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
