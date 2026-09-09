import type { LocalWorkspaceSnapshot, LocalCommitmentsSnapshot, LocalWorkflowReceipt } from '../../src/shared/contracts/localWorkspaceContract';
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
const provider = { get: async () => snapshot, getCommitments: async () => feed, transition: async () => receipt, reviewCompany: unavailableCompany, createCompany: unavailableCompany, getCompanyCreateStatus: unavailableCompany };
beforeEach(() => vi.clearAllMocks());
describe('local workspace bridge', () => {
  it('roundtrips the frozen API and rejects arity, caller scope, and untrusted senders', async () => {
    const remove = registerLocalWorkspaceIpc(provider);
    expect(electron.handle).toHaveBeenCalledTimes(6);
    const api = createLocalWorkspaceApi(createIpcClient({ invoke: async (channel, ...args) => registeredIpcHandler(electron.handle, channel)(trusted, ...args) }));
    expect(await api.get()).toEqual(snapshot); expect(await api.getCommitments()).toEqual(feed); expect(await api.transition(command)).toEqual(receipt);
    for (const channel of ['local-workspace:get', 'local-workspace:get-commitments']) {
      const handler = registeredIpcHandler(electron.handle, channel);
      await expect(handler(trusted, {})).rejects.toThrow();
      await expect(handler({ senderFrame: { url: 'https://evil.invalid' } })).rejects.toThrow();
    }
    const transition = registeredIpcHandler(electron.handle, 'local-workspace:transition');
    for (const args of [[], [command, command], [{ ...command, workspaceId: 'invented' }], [{ ...command, expectedMode: 'meeting_first' }]]) await expect(transition(trusted, ...args)).rejects.toThrow();
    remove(); remove(); expect(electron.removeHandler.mock.calls.map(c => c[0])).toEqual(['local-workspace:company-create-status', 'local-workspace:create-company', 'local-workspace:review-company', 'local-workspace:transition', 'local-workspace:get-commitments', 'local-workspace:get']);
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
