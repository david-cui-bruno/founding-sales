// @vitest-environment jsdom
const electron = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: electron }));
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createPmFixture, PM_NOW } from '../fixtures/pmAccounts';
import { openDatabase, closeDatabase } from '../../src/main/db/database';
import { createTestWorkspaceKey } from '../fixtures/tempDatabase';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { exportSelectedAccountRecord } from '../../src/main/delegation/selectedAccountSnapshot';
import { bootstrapSelectedAccountSchema } from '../../src/shared/contracts/ownerCommandContract';
import { DelegationRepository } from '../../src/main/delegation/delegationRepository';
import { delegationCommandSchema, type DelegationCommand } from '../../src/shared/contracts/delegationContract';
import { registeredIpcHandler } from '../fixtures/registeredIpcHandler';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { FounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import { createLocalWorkspaceProvider } from '../../src/main/workspace/localWorkspaceProvider';
import { registerLocalWorkspaceIpc } from '../../src/main/workspace/registerLocalWorkspaceIpc';
import { registerDailyIpc } from '../../src/main/today/registerDailyIpc';
import { registerOutreachIpc } from '../../src/main/ipc/registerOutreachIpc';
import { createDelegationRuntime } from '../../src/main/delegation/delegationRuntime';
import { createCallieApi } from '../../src/preload/createCallieApi';
import type { OutreachApi } from '../../src/shared/contracts/outreachContract';
import { ConditionalCommandHarness } from '../../cloud/lambdas/delegated-worker/test/sdkHarness';
import { WorkerAuth } from '../../cloud/lambdas/delegated-worker/src/workerAuth';
import { createWorkerHandler } from '../../cloud/lambdas/delegated-worker/src/handler';
import { NativeDeskRoute } from '../../src/renderer/features/today/NativeDeskRoute';
import { PresentationRoot } from '../../src/renderer/app/PresentationRoot';
import { firstUseFixture } from '../../src/renderer/features/today/nativeDesk.fixture';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(PM_NOW));
  vi.stubGlobal('fetch', vi.fn(async () => { throw Error('Real network forbidden'); }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// Reuse companyPhoneUi's registered bridge and delegationRuntime's HTTP-to-handler
// boundary. No ACCOUNT/AUTH seed, bootstrap, transfer, campaign or owner setup.
// The preserved first RED remains the first test. Later tests exercise actual
// handler/coordinator/repositories, with loss only at the external HTTP boundary.
async function fixture(reviewedInbox = false) {
  const local = await createPmFixture();
  let database = local.db;
  const clock = { now: () => new Date().toISOString() };
  const workspaceId = randomUUID();
  let runtime: ReturnType<typeof createDelegationRuntime> | undefined;
  const unregister: (() => void)[] = [];
  try {
    let services = createDomainServices({ database, clock, ids: { next: randomUUID }, expectedWorkspaceId: workspaceId });
    let domain = new FounderSalesDomain({ database, services, clock, ids: { next: randomUUID } });
    domain.transitionWorkflow({ commandId: randomUUID(), manifestId: randomUUID(), expectedMode: 'legacy' });
    const provider = createLocalWorkspaceProvider({ withDatabase: async fn => fn(database), withDomain: async fn => fn(domain) });
    const dynamo = new ConditionalCommandHarness();
    const auth = new WorkerAuth({ dynamo, tableName: 'fictional-guided-campaign', workspaceId, clock });
    const issued = await auth.issuePairing({ scopes: ['commands:write', 'events:read'], expiresInSeconds: 300 });
    const pairing = { ...await auth.redeemPairing(issued.code, 'fictional-campaign-device'), endpoint: 'https://campaign.example.invalid' };
    const handler = createWorkerHandler({ auth, host: 'campaign.example.invalid' });
    const paths: string[] = [], violations: string[] = [];
    const commands: DelegationCommand[] = [];
    let loss: { kind: 'bootstrap-selected-account' | 'delegate'; point: 'queue' | 'commit' } | null = null;
    let offline = false;
    const http: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (offline) throw Error('Controlled owner offline');
      if (url.origin !== pairing.endpoint || !['/commands', '/events', '/commands/reconcile'].includes(url.pathname)) throw Error('Unexpected fixture endpoint');
      const command = url.pathname === '/commands' && init?.body ? delegationCommandSchema.parse(JSON.parse(String(init.body))) : null;
      if (command) {
        commands.push(structuredClone(command));
        if (!['bootstrap-selected-account', 'delegate'].includes(command.kind)
          && !(command.kind === 'campaign-command' && command.payload.kind === 'campaign.version')) {
          violations.push(command.kind); throw Error('Forbidden preparation command');
        }
        if (loss?.kind === command.kind && loss.point === 'queue') { offline = true; throw Error('Lost after local durable queue'); }
      }
      const response = await handler({ version: '2.0', rawPath: url.pathname, rawQueryString: url.search.slice(1),
        headers: { host: url.host, 'x-forwarded-proto': 'https', authorization: new Headers(init?.headers).get('authorization') ?? '' },
        requestContext: { domainName: url.host, http: { method: init?.method ?? 'GET', sourceIp: 'fictional' } },
        ...(init?.body ? { body: String(init.body) } : {}) });
      if (command && loss?.kind === command.kind && loss.point === 'commit') { offline = true; throw Error('Lost after actual worker response'); }
      return new Response(response.body, { status: response.statusCode, headers: response.headers });
    };
    const forbidden = vi.fn(async (): Promise<never> => { throw Error('Unrelated public effect forbidden'); });
    const outreach: OutreachApi = { status: forbidden, configure: forbidden, connectGmail: forbidden, disconnectGmail: forbidden,
      openDraft: forbidden, saveDraft: forbidden, generateDraft: forbidden, sendDraft: forbidden, inspectLocalAuthority: forbidden };
    const invocations: string[] = [];
    const bootstrapRequests: { commandId: string; accountId: string }[] = [];
    let rollbackBootstrapClock = false;
    const openPublic = async (initialize = false) => {
      runtime = createDelegationRuntime({ databaseGate: { withDatabase: async fn => fn(database) }, pairing, clock, fetch: http });
      // Actual LOCAL fixture configuration only, never configure-owner/mail/grants.
      if (initialize) await runtime.configure({ expectedRevision: 0, configuration: { version: 1, state: 'active', research: null } });
      electron.handle.mockClear();
      unregister.push(registerOutreachIpc({ provider: outreach, delegation: runtime }),
        registerDailyIpc({ get: async () => services.daily.get() }), registerLocalWorkspaceIpc(provider));
      return createCallieApi({ invoke: async (channel, ...args) => {
        invocations.push(channel);
        if (channel === 'outreach:delegation-bootstrap') bootstrapRequests.push(bootstrapSelectedAccountSchema.parse(structuredClone(args[0])));
        // Genuine exporter failure from a clock rollback between preflight and
        // export, not a rejected mock API or a corrupted SQL fixture.
        const instant = Date.now();
        const rollback = channel === 'outreach:delegation-bootstrap' && rollbackBootstrapClock;
        if (rollback) vi.setSystemTime(new Date(instant - 1000));
        try { return await registeredIpcHandler(electron.handle, channel)({ senderFrame: { url: 'callie://app/index.html' } }, ...args); }
        finally { if (rollback) vi.setSystemTime(new Date(instant)); }
      } });
    };
    let api = await openPublic(true);
    const seed = async (name: string) => {
      const input = { name, domain: null as null };
      expect(await api.localWorkspace.reviewCompany(input)).toMatchObject({ complete: true, candidates: [] });
      const result = await api.localWorkspace.createCompany({ ...input, commandId: randomUUID() });
      if (result.status !== 'saved') throw Error('Fictional local company admission failed');
      return result.account;
    };
    const selected = await seed('Fictional First Campaign PM');
    const untouched = await seed('Fictional Untouched PM');
    if (reviewedInbox) {
      local.repo.admitEvidence({ commandId: randomUUID(), accountId: selected.id, expectedVersion: 1,
        sources: [{ id: 'fictional-source', url: 'https://example.invalid/team', fetchedAt: PM_NOW, sha256: 'a'.repeat(64),
          excerpt: 'Fictional residential property manager. Business email: team@example.invalid', permitted: true }], claims: [], routes: [] });
      await api.localWorkspace.admitCompanyDraftEmail({ commandId: randomUUID(), accountId: selected.id,
        expectedAccountVersion: 2, email: 'team@example.invalid', sourceId: 'fictional-source',
        quote: 'Business email: team@example.invalid', selection: 'published_company_business_inbox' });
    }
    invocations.length = 0;
    expect(readFileSync(local.db.path).subarray(0, 16).toString()).not.toBe('SQLite format 3\0');
    const repository = () => new DelegationRepository({ database, workspaceId, clock });
    return { get api() { return api; }, selected, untouched, paths, invocations, dynamo, forbidden, commands, workspaceId, repository,
      db: () => database, runtime: () => runtime!, bootstrapRequests,
      rollbackExportClock(value: boolean) { rollbackBootstrapClock = value; },
      admitLaterEvidence() {
        const account = services.daily.get().accounts.find(row => row.account.id === selected.id)!.account;
        new AccountRepository({ database, clock, ids: { next: randomUUID }, sourcePolicy: { attest: source => source.url === 'https://example.invalid/team' } })
          .admitEvidence({ commandId: randomUUID(), accountId: selected.id, expectedVersion: account.version,
            sources: [{ id: 'later-source', url: 'https://example.invalid/team', fetchedAt: clock.now(), sha256: 'b'.repeat(64),
              excerpt: 'Later fictional maintenance evidence, not in the queued copy.', permitted: true }],
            claims: [{ key: 'residential_scope', kind: 'fact', value: 'Later residential scope', evidenceIds: ['later-source'] }], routes: [] });
      },
      lose(kind: 'bootstrap-selected-account' | 'delegate', point: 'queue' | 'commit') { loss = { kind, point }; },
      reconnect() { loss = null; offline = false; },
      async reopen() {
        cleanup(); unregister.splice(0).reverse().forEach(fn => fn()); await runtime!.dispose(); closeDatabase(database);
        const key = createTestWorkspaceKey(); database = openDatabase({ path: local.db.path, key }); key.bytes.fill(0);
        services = createDomainServices({ database, clock, ids: { next: randomUUID }, expectedWorkspaceId: workspaceId });
        domain = new FounderSalesDomain({ database, services, clock, ids: { next: randomUUID } });
        api = await openPublic();
      },
      async finish() {
        cleanup(); unregister.splice(0).reverse().forEach(fn => fn()); await runtime!.dispose();
        if (database !== local.db) closeDatabase(database); local.close();
        expect(violations).toEqual([]);
        expect(paths.every(path => ['/commands', '/events', '/commands/reconcile'].includes(path))).toBe(true);
        expect(invocations.every(channel => ['daily:get', 'outreach:delegation-status', 'local-workspace:get',
          'local-workspace:get-commitments', 'outreach:delegation-bootstrap', 'outreach:delegation-submit', 'outreach:delegation-sync', 'outreach:delegation-selected-account-freshness'].includes(channel))).toBe(true);
        expect(forbidden).not.toHaveBeenCalled();
      } };

  } catch (error) {
    unregister.splice(0).reverse().forEach(fn => fn());
    await runtime?.dispose(); if (database !== local.db) closeDatabase(database); local.close(); throw error;
  }
}

it('offers explicit worker preparation for a first-time local company while existing campaign save stays held', async () => {
  const f = await fixture();
  try {
    const before = await f.api.daily.get();
    expect(before.workflowMode).toBe('meeting_first');
    expect(before.issues.filter(issue => ['scope_unknown', 'scope_mismatch', 'invalid_local_record'].includes(issue.code))).toEqual([]);
    expect(before.campaigns).toEqual([]);
    for (const account of [f.selected, f.untouched]) {
      expect(before.ownerStatus.find(row => row.accountId === account.id)).toMatchObject({ authority: null, executionVersion: null, pendingCommands: [] });
      expect(f.dynamo.inspect(`ACCOUNT#${account.id}`)).toBeUndefined();
      expect(f.dynamo.inspect(`AUTH#${account.id}`)).toBeUndefined();
    }
    expect(await f.api.delegation.status()).toMatchObject({ state: 'active', workspaceId: before.workspaceId,
      configuration: { configuration: { state: 'active', research: null } } });
    const workerTransactions = f.dynamo.transactions.length;
    render(<PresentationRoot><NativeDeskRoute surface="campaigns" firstUse={firstUseFixture()} api={f.api}
 /></PresentationRoot>);
    fireEvent.click(await screen.findByRole('button', { name: 'New call campaign' }));
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: f.selected.id } });
    fireEvent.change(screen.getByLabelText('Meeting offer'), { target: { value: 'Discuss a fictional maintenance follow-up workflow.' } });
    await waitFor(() => expect(screen.queryByText('Campaign draft setup or current workspace read is unavailable. Saving is held.')).toBeNull());
    expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Company' }).value).toBe(f.selected.id);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save call campaign draft' }).disabled).toBe(true);
    expect(await f.api.daily.get()).toEqual(before);
    expect(f.paths).toEqual([]);
    expect(f.dynamo.transactions).toHaveLength(workerTransactions);
    expect(f.invocations.every(channel => ['daily:get', 'outreach:delegation-status', 'local-workspace:get', 'local-workspace:get-commitments'].includes(channel))).toBe(true);
    expect(f.forbidden).not.toHaveBeenCalled();

    // FIRST CAUSAL RED: missing product entrypoint, not fabricated owner success.
    // Root observed this exact missing-button RED before authorizing expansion.
    expect(screen.getByRole('button', { name: 'Review worker preparation' })).toBeTruthy();
  } finally { await f.finish(); }
}, 20_000);

type Fixture = Awaited<ReturnType<typeof fixture>>;
const offer = 'Discuss a fictional maintenance follow-up workflow.';
function mount(f: Fixture) {
  return render(<PresentationRoot><NativeDeskRoute surface="campaigns" firstUse={firstUseFixture()} api={f.api}
 /></PresentationRoot>);
}
async function clickEnabled(name: string) {
  const button = await screen.findByRole<HTMLButtonElement>('button', { name });
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
}
async function selectAndReview(f: Fixture) {
  await clickEnabled('New call campaign');
  fireEvent.change(screen.getByLabelText('Company'), { target: { value: f.selected.id } });
  fireEvent.change(screen.getByLabelText('Meeting offer'), { target: { value: offer } });
  await waitFor(() => expect(screen.queryByText('Campaign draft setup or current workspace read is unavailable. Saving is held.')).toBeNull());
  const paths = f.paths.length;
  await clickEnabled('Review worker preparation');
  expect(f.paths).toHaveLength(paths);
  expect(screen.getByText('Unapproved draft only. Intake and outreach readiness are not verified here.')).toBeTruthy();
}
async function owner(f: Fixture) {
  return (await f.api.daily.get()).ownerStatus.find(row => row.accountId === f.selected.id);
}
function uniqueCommands(f: Fixture) {
  return [...new Map(f.commands.map(command => [command.commandId, command])).values()];
}
async function copySelected(f: Fixture) {
  await clickEnabled('Copy selected company to worker');
  await waitFor(async () => expect(await owner(f)).toMatchObject({ authority: { owner: 'local', state: 'local', generation: 0 }, executionVersion: 1, pendingCommands: [] }));
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Delegate selected company' }).disabled).toBe(false));
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save call campaign draft' }).disabled).toBe(true);
  expect(uniqueCommands(f).map(c => c.kind)).toEqual(['bootstrap-selected-account']);
}
async function delegateSelected(f: Fixture) {
  const button = screen.getByRole('button', { name: 'Delegate selected company' });
  await clickEnabled('Delegate selected company');
  fireEvent.click(button); // synchronous duplicate intent must remain latched
  await waitFor(async () => expect(await owner(f)).toMatchObject({ authority: { owner: 'worker', state: 'active', generation: 1 }, executionVersion: 2, pendingCommands: [] }));
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save call campaign draft' }).disabled).toBe(false));
  expect(uniqueCommands(f).map(c => c.kind)).toEqual(['bootstrap-selected-account', 'delegate']);
  expect((await f.api.daily.get()).campaigns).toEqual([]);
}
function assertOneAppliedEvent(f: Fixture, commandId: string) {
  expect(f.db().raw.prepare(`SELECT COUNT(*) AS n FROM delegated_applied_events WHERE workspace_id=?
    AND (json_extract(event_json,'$.receipt.commandId')=? OR json_extract(event_json,'$.payload.receipt.commandId')=?)`)
    .get(f.workspaceId, commandId, commandId)).toEqual({ n: 1 });
  expect(f.repository().commandStatus(commandId)).toMatchObject({ commandId, status: 'applied' });
  expect(f.dynamo.transactions.flatMap(transaction => transaction.TransactItems ?? [])
    .filter(write => write.Put?.Item?.sk?.S === `COMMAND#${commandId}`)).toHaveLength(1);
  expect(f.db().raw.prepare('SELECT COUNT(*) AS n FROM delegated_commands WHERE command_id=?').get(commandId)).toEqual({ n: 1 });
}

it.each([false, true])('copies only the selected company, separately delegates and saves/reopens an unapproved draft (reviewed inbox=%s)', async reviewedInbox => {
  const f = await fixture(reviewedInbox);
  try {
    const before = await f.api.daily.get();
    const selectedSnapshot = before.accounts.find(a => a.account.id === f.selected.id)!;
    const unrelated = before.accounts.find(a => a.account.id === f.untouched.id)!;
    expect(f.dynamo.inspect(`ACCOUNT#${f.selected.id}`)).toBeUndefined();
    expect(f.dynamo.inspect(`AUTH#${f.selected.id}`)).toBeUndefined();
    mount(f); await selectAndReview(f);
    await copySelected(f);
    const bootstrap = uniqueCommands(f)[0]!;
    if (bootstrap.kind !== 'bootstrap-selected-account') throw Error('Expected actual bootstrap command');
    expect(f.dynamo.inspect(`ACCOUNT#${f.selected.id}`)).toEqual(bootstrap.payload.record);
    expect(bootstrap.payload.record).toMatchObject({ account: selectedSnapshot.account, routes: selectedSnapshot.routes });
    expect(bootstrap.payload.record.sources).toEqual(reviewedInbox ? [expect.objectContaining({ id: 'fictional-source',
      url: 'https://example.invalid/team', excerpt: 'Fictional residential property manager. Business email: team@example.invalid' })] : []);
    if (reviewedInbox) expect(selectedSnapshot.routes).toEqual([expect.objectContaining({ value: 'team@example.invalid', channel: 'email' })]);
    await delegateSelected(f);
    await clickEnabled('Save call campaign draft');
    await screen.findByText('Campaign draft saved. Not approved or enrolled.');
    const saved = (await f.api.daily.get()).campaigns;
    expect(saved).toHaveLength(1);
    const campaign = saved[0]!;
    expect(campaign.version).toMatchObject({ cohortAccountIds: [f.selected.id], approvedAt: null, offer,
      channelCaps: { call: 1, email: 0, linkedin: 0 } });
    expect(campaign.enrollments).toEqual([]);
    expect(campaign.caps).toEqual([]);
    const commands = uniqueCommands(f);
    expect(commands.map(c => c.kind === 'campaign-command' ? c.payload.kind : c.kind)).toEqual(['bootstrap-selected-account', 'delegate', 'campaign.version']);
    for (const command of commands) assertOneAppliedEvent(f, command.commandId);
    const journal = f.db().raw.prepare('SELECT * FROM delegated_commands ORDER BY command_id').all();
    const events = f.db().raw.prepare('SELECT * FROM delegated_applied_events ORDER BY id').all();
    await f.reopen();
    const paths = f.paths.length;
    const view = mount(f);
    const row = await waitFor(() => {
      const button = view.container.querySelector<HTMLButtonElement>(`[data-row-key="campaign:${campaign.version.id}"]`);
      expect(button).toBeTruthy(); return button!;
    });
    fireEvent.click(row);
    expect(within(view.container.querySelector('.native-desk__detail') as HTMLElement).getByRole('heading', { name: 'Call campaign draft' })).toBeTruthy();
    expect((await f.api.daily.get()).campaigns).toEqual(saved);
    expect(f.paths).toHaveLength(paths);
    expect(f.db().raw.prepare('SELECT * FROM delegated_commands ORDER BY command_id').all()).toEqual(journal);
    expect(f.db().raw.prepare('SELECT * FROM delegated_applied_events ORDER BY id').all()).toEqual(events);
    expect((await f.api.daily.get()).accounts.find(a => a.account.id === f.untouched.id)).toEqual(unrelated);
    expect(f.dynamo.inspect(`ACCOUNT#${f.untouched.id}`)).toBeUndefined();
    expect(f.dynamo.inspect(`AUTH#${f.untouched.id}`)).toBeUndefined();
    expect(f.db().raw.prepare('SELECT COUNT(*) AS n FROM campaign_enrollments').get()).toEqual({ n: 0 });
    expect(f.db().raw.prepare('SELECT COUNT(*) AS n FROM delegated_manual_handoffs').get()).toEqual({ n: 0 });
    expect(f.forbidden).not.toHaveBeenCalled();
    expect(f.invocations).not.toContain('outreach:delegation-configure');
  } finally { await f.finish(); }
}, 20_000);

it.each([
  ['bootstrap-selected-account', 'queue'], ['bootstrap-selected-account', 'commit'],
  ['delegate', 'queue'], ['delegate', 'commit'],
] as const)('reconciles the original %s identity after loss at %s and encrypted reopen without replacement', async (kind, point) => {
  const f = await fixture();
  try {
    mount(f); await selectAndReview(f);
    if (kind === 'delegate') await copySelected(f);
    f.lose(kind, point);
    await clickEnabled(kind === 'delegate' ? 'Delegate selected company' : 'Copy selected company to worker');
    await waitFor(async () => expect((await owner(f))?.pendingCommands).toHaveLength(1));
    // Wait for the failed explicit action to settle before closing its real SQL lease.
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Reconcile queued preparation' }).disabled).toBe(false));
    const pending = f.repository().pendingCommands();
    expect(pending).toHaveLength(1);
    const original = pending[0]!;
    expect(original.kind).toBe(kind);
    expect(original.accountId).toBe(f.selected.id);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save call campaign draft' }).disabled).toBe(true);
    expect(f.dynamo.inspect(`COMMAND#${original.commandId}`) === undefined).toBe(point === 'queue');
    if (kind === 'bootstrap-selected-account') {
      expect(f.dynamo.inspect(`ACCOUNT#${f.selected.id}`) === undefined).toBe(point === 'queue');
    }
    const journal = f.db().raw.prepare('SELECT * FROM delegated_commands ORDER BY command_id').all();
    await f.reopen();
    const paths = f.paths.length, transactionCount = f.dynamo.transactions.length;
    mount(f); await selectAndReview(f);
    expect(f.paths).toHaveLength(paths);
    expect(f.dynamo.transactions).toHaveLength(transactionCount);
    expect(f.repository().pendingCommands()).toEqual([original]);
    expect(f.db().raw.prepare('SELECT * FROM delegated_commands ORDER BY command_id').all()).toEqual(journal);
    expect(screen.queryByRole('button', { name: 'Copy selected company to worker' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delegate selected company' })).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save call campaign draft' }).disabled).toBe(true);
    f.reconnect();
    await clickEnabled('Reconcile queued preparation');
    await waitFor(async () => expect(await owner(f)).toMatchObject({
      authority: { owner: kind === 'delegate' ? 'worker' : 'local', state: kind === 'delegate' ? 'active' : 'local' },
      executionVersion: kind === 'delegate' ? 2 : 1, pendingCommands: [],
    }));
    expect(f.repository().getCommand(original.commandId)).toEqual(original);
    expect(uniqueCommands(f).filter(c => c.kind === kind).map(c => c.commandId)).toEqual([original.commandId]);
    assertOneAppliedEvent(f, original.commandId);
    expect((await f.api.daily.get()).campaigns).toEqual([]);
    expect(f.dynamo.inspect(`AUTH#${f.untouched.id}`)).toBeUndefined();
    // A second restart recovers solely from applied authority/version, not retained UI intent.
    await f.reopen(); const afterRecoveryPaths = f.paths.length;
    mount(f); await selectAndReview(f);
    expect(f.paths).toHaveLength(afterRecoveryPaths);
    expect(screen.queryByRole('button', { name: 'Copy selected company to worker' })).toBeNull();
    if (kind === 'delegate') {
      expect(screen.queryByRole('button', { name: 'Delegate selected company' })).toBeNull();
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save call campaign draft' }).disabled).toBe(false);
    } else expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Delegate selected company' }).disabled).toBe(false);
  } finally { await f.finish(); }
}, 20_000);

it('recovers a local-only g0/v0 placeholder after encrypted reopen without mistaking AUTH presence for bootstrap', async () => {
  const f = await fixture();
  try {
    // Dedicated crash boundary only. No worker seed and no command insertion.
    f.repository().initializeLocalAuthority(f.selected.id);
    await f.reopen();
    expect(await owner(f)).toMatchObject({ authority: { owner: 'local', state: 'local', generation: 0 }, executionVersion: 0, pendingCommands: [] });
    mount(f); await selectAndReview(f);
    expect(f.paths).toEqual([]);
    expect(f.dynamo.inspect(`ACCOUNT#${f.selected.id}`)).toBeUndefined();
    expect(f.dynamo.inspect(`AUTH#${f.selected.id}`)).toBeUndefined();
    expect(screen.queryByRole('button', { name: 'Delegate selected company' })).toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save call campaign draft' }).disabled).toBe(true);
    await copySelected(f);
    assertOneAppliedEvent(f, uniqueCommands(f)[0]!.commandId);
  } finally { await f.finish(); }
}, 20_000);

it('retries the same preparation identity after genuine prequeue exporter clock failure and clock repair', async () => {
  const f = await fixture();
  try {
    mount(f); await selectAndReview(f);
    expect(() => exportSelectedAccountRecord({ database: f.db(), workspaceId: f.workspaceId, accountId: f.selected.id,
      researchRevision: 1, asOf: new Date(Date.parse(PM_NOW) - 1000).toISOString() })).toThrow('historical truncation');
    // Call-through observation only: the actual implementation and rejection
    // are unchanged. This is a synthetic clock fault, not a live incident.
    const bootstrap = vi.spyOn(f.runtime(), 'bootstrap');
    f.rollbackExportClock(true);
    await clickEnabled('Copy selected company to worker');
    await screen.findByText('Worker preparation could not be confirmed. Review current facts or reconcile queued work. No new command was automatically authorized.');
    expect(bootstrap).toHaveBeenCalledTimes(1);
    await expect(bootstrap.mock.results[0]!.value).rejects.toThrow('Selected account export historical truncation');
    expect(f.db().raw.prepare('SELECT COUNT(*) AS n FROM delegated_commands').get()).toEqual({ n: 0 });
    expect(f.bootstrapRequests).toHaveLength(1);
    const original = structuredClone(f.bootstrapRequests[0]!);
    expect(f.repository().getCommand(original.commandId)).toBeNull();
    expect(await owner(f)).toMatchObject({ authority: null, executionVersion: null, pendingCommands: [] });
    expect(f.commands).toEqual([]);
    expect(f.dynamo.inspect(`ACCOUNT#${f.selected.id}`)).toBeUndefined();
    expect(f.dynamo.inspect(`AUTH#${f.selected.id}`)).toBeUndefined();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save call campaign draft' }).disabled).toBe(true);
    f.rollbackExportClock(false); // legitimate repair: clock resumes normal time
    await clickEnabled('Retry same preparation');
    await waitFor(async () => expect(await owner(f)).toMatchObject({ authority: { owner: 'local', state: 'local', generation: 0 }, executionVersion: 1, pendingCommands: [] }));
    expect(f.bootstrapRequests).toEqual([original, original]);
    expect(uniqueCommands(f).map(c => [c.commandId, c.kind])).toEqual([[original.commandId, 'bootstrap-selected-account']]);
    assertOneAppliedEvent(f, original.commandId);
    expect((await f.api.daily.get()).campaigns).toEqual([]);
    expect(f.dynamo.inspect(`AUTH#${f.untouched.id}`)).toBeUndefined();
  } finally { await f.finish(); }
}, 20_000);

it('reconciles queued bootstrap after changed local evidence and encrypted reopen without recopy or automatic delegation', async () => {
  const f = await fixture(true);
  try {
    mount(f); await selectAndReview(f);
    f.lose('bootstrap-selected-account', 'queue');
    await clickEnabled('Copy selected company to worker');
    await waitFor(() => expect(f.repository().pendingCommands()).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Reconcile queued preparation' }).disabled).toBe(false));
    const original = f.repository().pendingCommands()[0]!;
    if (original.kind !== 'bootstrap-selected-account') throw Error('Expected queued bootstrap');
    const frozenRecord = structuredClone(original.payload.record);
    vi.setSystemTime(new Date(Date.parse(PM_NOW) + 60_000));
    f.admitLaterEvidence();
    const changed = (await f.api.daily.get()).accounts.find(row => row.account.id === f.selected.id)!;
    expect(changed.account.version).toBe(frozenRecord.account.version + 1);
    expect(changed.claims).toEqual([expect.objectContaining({ value: 'Later residential scope' })]);
    await f.reopen();
    const paths = f.paths.length;
    mount(f); await selectAndReview(f);
    expect(f.paths).toHaveLength(paths);
    expect(f.repository().getCommand(original.commandId)).toEqual(original);
    f.reconnect();
    await clickEnabled('Reconcile queued preparation');
    await waitFor(async () => expect(await owner(f)).toMatchObject({ authority: { owner: 'local', state: 'local', generation: 0 }, executionVersion: 1, pendingCommands: [] }));
    expect(f.dynamo.inspect(`ACCOUNT#${f.selected.id}`)).toEqual(frozenRecord);
    expect(f.repository().getCommand(original.commandId)).toEqual(original);
    expect(uniqueCommands(f).map(c => [c.commandId, c.kind])).toEqual([[original.commandId, 'bootstrap-selected-account']]);
    assertOneAppliedEvent(f, original.commandId);
    expect((await f.api.daily.get()).accounts.find(row => row.account.id === f.selected.id)).toEqual(changed);
    expect((await f.api.daily.get()).campaigns).toEqual([]);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save call campaign draft' }).disabled).toBe(true);
    expect(f.dynamo.inspect(`AUTH#${f.untouched.id}`)).toBeUndefined();
  } finally { await f.finish(); }
}, 20_000);

it('retries the retained null-AUTH copy identity after real AUTH initialization and a prequeue suppression-read failure', async () => {
  const f = await fixture();
  const raw = f.db().raw;
  const prepare = raw.prepare.bind(raw);
  let injected = 0;
  const suppressionSql = 'SELECT id,observed_at AS observedAt,source,evidence_ref AS evidenceRef FROM pm_account_suppression_tombstones WHERE account_id=? LIMIT 101';
  const sql = vi.spyOn(raw, 'prepare').mockImplementation((...args: Parameters<typeof raw.prepare>) => {
    if (args[0] === suppressionSql && injected === 0) {
      // One synthetic DB-read fault after the real independently committed AUTH,
      // never fabricated authority, an API rejection stub, or ledger corruption.
      expect(prepare('SELECT owner,state,generation,aggregate_version FROM delegated_authorities WHERE account_id=?').get(f.selected.id))
        .toEqual({ owner: 'local', state: 'local', generation: 0, aggregate_version: 0 });
      expect(prepare('SELECT COUNT(*) AS n FROM delegated_commands').get()).toEqual({ n: 0 });
      injected++;
      throw Error('Synthetic suppression read unavailable after AUTH commit');
    }
    return prepare(...args);
  });
  try {
    expect(await owner(f)).toMatchObject({ authority: null, executionVersion: null, pendingCommands: [] });
    mount(f); await selectAndReview(f);
    const bootstrap = vi.spyOn(f.runtime(), 'bootstrap'); // call-through, no replacement
    await clickEnabled('Copy selected company to worker');
    await screen.findByText('Worker preparation could not be confirmed. Review current facts or reconcile queued work. No new command was automatically authorized.');
    expect(injected).toBe(1);
    expect(bootstrap).toHaveBeenCalledTimes(1);
    await expect(bootstrap.mock.results[0]!.value).rejects.toThrow('Synthetic suppression read unavailable after AUTH commit');
    expect(f.bootstrapRequests).toHaveLength(1);
    const original = structuredClone(f.bootstrapRequests[0]!);
    expect(await owner(f)).toMatchObject({ authority: { owner: 'local', state: 'local', generation: 0 }, executionVersion: 0, pendingCommands: [] });
    expect(prepare('SELECT COUNT(*) AS n FROM delegated_commands').get()).toEqual({ n: 0 });
    expect(f.commands).toEqual([]);
    expect(f.dynamo.inspect(`ACCOUNT#${f.selected.id}`)).toBeUndefined();
    expect(f.dynamo.inspect(`AUTH#${f.selected.id}`)).toBeUndefined();
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Meeting offer' }).value).toBe(offer);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save call campaign draft' }).disabled).toBe(true);
    sql.mockRestore(); // repair only the injected read fault, leave real AUTH untouched
    await clickEnabled('Retry same preparation');
    await waitFor(() => expect(f.bootstrapRequests).toEqual([original, original]));
    await waitFor(async () => expect(await owner(f)).toMatchObject({ authority: { owner: 'local', state: 'local', generation: 0 }, executionVersion: 1, pendingCommands: [] }));
    expect(uniqueCommands(f).map(c => [c.commandId, c.kind])).toEqual([[original.commandId, 'bootstrap-selected-account']]);
    assertOneAppliedEvent(f, original.commandId);
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Meeting offer' }).value).toBe(offer);
    expect((await f.api.daily.get()).campaigns).toEqual([]);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save call campaign draft' }).disabled).toBe(true);
    expect(f.dynamo.inspect(`AUTH#${f.untouched.id}`)).toBeUndefined();
  } finally { sql.mockRestore(); await f.finish(); }
}, 20_000);
