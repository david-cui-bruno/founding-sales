const recoveryElectron = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: recoveryElectron }));
vi.mock('node:crypto', async importOriginal => { const actual = await importOriginal<typeof import('node:crypto')>(); return { ...actual, randomUUID: vi.fn(actual.randomUUID) }; });
import { registerOutreachIpc } from '../../src/main/ipc/registerOutreachIpc';
import { createCallieApi } from '../../src/preload/createCallieApi';
import { registeredIpcHandler } from '../fixtures/registeredIpcHandler';
import type { OutreachApi } from '../../src/shared/contracts/outreachContract';
import { openDatabase, closeDatabase } from '../../src/main/db/database';
import { createTestWorkspaceKey } from '../fixtures/tempDatabase';
import { listDelegatedActualCallAccountIds } from '../../src/main/domain/today/todayActualCallEvidence';
import { resolveLocalDayInterval } from '../../src/main/domain/today/todayOrdering';
import { LegacyWorkflowTransition } from '../../src/main/domain/workspace/legacyWorkflowTransition';
import { createPhoneHandoffLauncher } from '../../src/main/communications/phoneHandoffLauncher';
import { createDelegationRuntime } from '../../src/main/delegation/delegationRuntime';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { exportSelectedAccountRecord } from '../../src/main/delegation/selectedAccountSnapshot';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDelegatedPhoneHandoff } from '../../src/main/delegation/executionRouter';
import { createPmFixture } from '../fixtures/pmAccounts';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { AccountRoutePolicyStore, type RoutePolicyReceipt } from '../../src/main/delegation/accountRoutePolicyStore';
import { DelegationRepository } from '../../src/main/delegation/delegationRepository';
import { ExecutionClient } from '../../src/main/delegation/executionClient';
import { SqlDelegationTransport } from '../../src/main/delegation/delegationSync';
import { createInboundReadiness } from '../../src/main/communications/inboundReadiness';
import { ConditionalCommandHarness } from '../../cloud/lambdas/delegated-worker/test/sdkHarness';
import { WorkerAuth } from '../../cloud/lambdas/delegated-worker/src/workerAuth';
import { createWorkerHandler } from '../../cloud/lambdas/delegated-worker/src/handler';
import { DynamoExecutionRepository } from '../../cloud/lambdas/delegated-worker/src/executionRepository';
import { DynamoStore, fingerprint } from '../../cloud/lambdas/delegated-worker/src/dynamoStore';
import { prepareManualCommandSchema } from '../../src/shared/contracts/ownerCommandContract';
import { delegationCommandSchema, commandReceiptSchema, workerEventSchema } from '../../src/shared/contracts/delegationContract';
import { createSqlAccountRoutePolicy, authorizeAccountRoute } from '../../src/main/domain/accounts/accountOutreach';
import { PLAYBOOK_CHANNEL_POLICIES_V2 } from '../../src/main/domain/cadence/cadenceScheduler';

const cleanups: (() => void)[] = [];
beforeEach(() => vi.stubGlobal('fetch', () => Promise.reject(new Error('Unconfigured network forbidden'))));
afterEach(() => { try { cleanups.splice(0).reverse().forEach(fn => fn()); } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); } });
const now = '2026-09-08T14:00:00.000Z';
async function fixture(admitPolicy = true, supportedFit = false, secondRoute = false) {
  const local = await createPmFixture(); cleanups.push(local.close);
  let at = now; const clock = { now: () => at }; const workspaceId = randomUUID();
  const repo = new AccountRepository({ database: local.db, clock, ids: { next: randomUUID }, sourcePolicy: { attest: s => s.url === 'https://example.invalid/team' } });
  const account = repo.create({ commandId: randomUUID(), name: 'Fictional Phone PM', domain: null });
  repo.admitEvidence({ commandId: randomUUID(), accountId: account.id, expectedVersion: 1, claims: supportedFit ? [
      { key: 'residential_scope', kind: 'fact', value: 'Residential property management', evidenceIds: ['source'] },
      { key: 'operating_footprint', kind: 'fact', value: 'Regional operator', evidenceIds: ['source'] },
    ] : [],
    sources: [{ id: 'source', url: 'https://example.invalid/team', fetchedAt: now, sha256: 'a'.repeat(64), excerpt: 'Fictional switchboard and separately attested compliance evidence', permitted: true }],
    routes: ['route', ...(secondRoute ? ['later-route'] : [])].map(id => ({ id, accountId: account.id, personId: null as string | null, channel: 'phone', value: id === 'route' ? '+14015550100' : '+14015550101', purpose: 'business', evidenceIds: ['source'], verification: 'published' })) });
  const snapshot = repo.snapshot(account.id, now);
  const policy: RoutePolicyReceipt = { id: randomUUID(), accountId: account.id, routeId: 'route', routeVersion: 1, canonicalTarget: '+14015550100', evidenceFingerprint: snapshot.fingerprint,
    revision: 1, evidenceRef: 'source', evidenceIds: ['source'], provenance: 'fictional-compliance-attestor', observedAt: now, effectiveAt: now, expiresAt: '2026-09-09T14:00:00.000Z',
    policy: { contact: { kind: 'phone', normalizedValue: '+14015550100', validationState: 'valid', evidence: { federalStatus: 'verified_clear', tcpaFlag: false, coveredAreaCode: '401', source: 'ftc_download', scrubbedAt: now, expiresAt: '2026-10-01T00:00:00.000Z' } },
      jurisdiction: { regionCode: 'RI', timezone: 'America/New_York', reviewAt: null }, clearance: { decision: 'allowed', registrationConfirmed: true, stateDncSubscriptionConfirmed: true, consentRuleConfirmed: true, effectiveAt: now, expiresAt: '2026-10-01T00:00:00.000Z' } } };
  const policyStore = new AccountRoutePolicyStore({ database: local.db, clock, admission: { attest: p => p.provenance === policy.provenance && p.evidenceRef === 'source' } }); if (admitPolicy) policyStore.admit(policy);
  const options = { dynamo: new ConditionalCommandHarness(), tableName: 'fictional-phone', workspaceId, clock };
  const auth = new WorkerAuth(options); const issued = await auth.issuePairing({ scopes: ['commands:write', 'events:read'], expiresInSeconds: 300 });
  const pairing = await auth.redeemPairing(issued.code, 'fictional-device');
  const store = new DynamoStore(options);
  await store.transact([store.put(`ACCOUNT#${account.id}`, exportSelectedAccountRecord({ database: local.db, workspaceId, accountId: account.id, asOf: now, researchRevision: 1 }), null)]);
  await new DynamoExecutionRepository(options).seedLocalAuthority(account.id);
  const repository = new DelegationRepository({ database: local.db, workspaceId, clock }); repository.initializeLocalAuthority(account.id);
  const handler = createWorkerHandler({ auth, host: 'phone.example.invalid' }); let offline = false; let onHttp: (path: string) => void = () => {};
  const paths: string[] = [];
  const http: typeof fetch = async (input, init) => {
    if (offline) throw new Error('fictional disconnected');
    const url = new URL(String(input)); paths.push(url.pathname); onHttp(url.pathname);
    const response = await handler({ version: '2.0', rawPath: url.pathname, rawQueryString: url.search.slice(1), headers: { host: url.host, 'x-forwarded-proto': 'https', authorization: new Headers(init?.headers).get('authorization') ?? '' }, requestContext: { domainName: url.host, http: { method: init?.method ?? 'GET', sourceIp: 'fictional' } }, ...(init?.body ? { body: String(init.body) } : {}) });
    return new Response(response.body, { status: response.statusCode, headers: response.headers });
  };
  const transport = new SqlDelegationTransport({ database: local.db, workspaceId, pairingId: pairing.pairingId, clock });
  const client = new ExecutionClient({ repository, transport, pairing: { endpoint: 'https://phone.example.invalid', workspaceId, credential: pairing.credential }, fetch: http });
  const apply = async (kind: string, payload: unknown) => {
    const command = delegationCommandSchema.parse({ commandId: randomUUID(), workspaceId, accountId: account.id, expectedAuthorityGeneration: repository.authority(account.id)!.generation, expectedVersion: repository.executionVersion(account.id), kind, payload });
    await client.submit(command); const sync = await client.sync(new AbortController().signal); expect(sync.ownerFresh).toBe(true); expect(repository.commandStatus(command.commandId)?.status).toBe('applied');
  };
  await apply('delegate', { delegationId: randomUUID(), approvedAt: now });
  await apply('configure-owner', { expectedConfigurationRevision: 0, configuration: { version: 1, workspaceId, accountId: account.id, pairingId: pairing.pairingId, revision: 1, state: 'active', mailboxSubject: null, calendarId: null, research: null }, mailScope: null });
  const version = { id: 'campaign-version', campaignId: 'campaign', version: 1, audienceHash: 'a'.repeat(64), offer: 'Fictional offer', objective: 'meeting', cohortAccountIds: [account.id], approvedAt: null as string | null,
    steps: [{ id: 'call-step', channel: 'call', condition: 'initial', delayHours: 0 }], capScope: 'campaign_version_lifetime', channelCaps: { call: 1, email: 0, linkedin: 0 }, contentPolicyHash: 'b'.repeat(64) };
  await apply('campaign-command', { kind: 'campaign.version', version });
  await apply('campaign-command', { kind: 'campaign.approve', campaignVersionId: version.id, snapshotHash: fingerprint(version), approvedAt: now });
  await apply('campaign-command', { kind: 'campaign.enroll', enrollmentId: 'enrollment', campaignVersionId: version.id, selectedRouteId: 'route', executionContextId: 'context', contextRevision: 1 });
  const command = prepareManualCommandSchema.parse({ commandId: randomUUID(), workspaceId, accountId: account.id, expectedAuthorityGeneration: 1, expectedVersion: repository.executionVersion(account.id), kind: 'prepare-manual', payload: { actionId: 'action', channel: 'call', routeId: 'route', routeVersion: 1, targetHash: createHash('sha256').update('+14015550100').digest('hex'), contentHash: 'b'.repeat(64), contextRevision: 'context', campaign: { campaignId: 'campaign', campaignRevision: 1, enrollmentId: 'enrollment', enrollmentRevision: 1, stepId: 'call-step' } } });
  const request = { command, expectedEvidenceFingerprint: snapshot.fingerprint };
  let revision = 1; let checkpoint = 'fictional-inbound-1'; let readyHook = () => {}; let capability = true; let dispatchHook = () => {};
  const hookErrors: unknown[] = []; cleanups.push(() => expect(hookErrors).toEqual([]));
  const subjects: unknown[] = []; const calls: string[] = []; const controller = new AbortController();
  const readiness = createInboundReadiness({ snapshot: () => ({ initialized: true, revision, adapters: [{ id: 'fictional-native-inbound', relevant: () => true,
    synchronize: async subject => { subjects.push(subject); try { readyHook(); } catch (error) { hookErrors.push(error); throw error; } return { revision: checkpoint }; }, isAppliedCurrent: (_subject, value) => value === checkpoint }] }) });
  const phone = { inspectCapability: async () => ({ state: capability ? 'available' as const : 'unavailable' as const, reasonCode: capability ? null : 'phone_route_unverified' as const }), dispatch: (target: string) => {
    expect(local.db.raw.inTransaction).toBe(false);
    expect(local.db.raw.prepare('SELECT consumed_at FROM delegated_manual_handoffs').get()).toEqual({ consumed_at: at });
    calls.push(target); dispatchHook(); return Promise.resolve({ status: 'handoff_accepted' as const, reasonCode: null });
  } };
  const makeBridge = () => createDelegatedPhoneHandoff({ database: local.db, repository, client, phone, readinessForHandoff: () => readiness, clock, signal: controller.signal, expectedWorkspaceId: workspaceId });
  return { ...local, http, pairing, repo, clock, workspaceId, account, snapshot, policy, policyStore, repository, client, request, calls, subjects, paths, makeBridge, readiness, phone, controller, store, apply,
    setTime: (value: string) => { at = value; }, offline: () => { offline = true; }, online: () => { offline = false; }, onReady: (fn: () => void) => { readyHook = fn; }, unavailable: () => { capability = false; }, onDispatch: (fn: () => void) => { dispatchHook = fn; },
    onHttp: (fn: (path: string) => void) => { onHttp = fn; }, invalidateProof: () => { revision++; checkpoint = 'changed'; } };
}

describe('delegated human phone bridge', () => {
  it('uses actual owner acknowledgment and one-shot SQL consume, not a fabricated person or call outcome', async () => {
    const f = await fixture(); const before = f.db.raw.prepare('SELECT * FROM persons').all();
    const result = await f.makeBridge().begin(f.request);
    expect(result).toMatchObject({ status: 'handoff', result: { status: 'handoff_accepted' } });
    expect(f.repository.commandStatus(f.request.command.commandId)?.status).toBe('applied');
    expect(f.subjects).toEqual([{ kind: 'account', id: f.account.id }]);
    expect(f.calls).toEqual(['+14015550100']);
    expect(await f.makeBridge().begin(f.request)).toMatchObject({ status: 'already_started' });
    expect(f.calls).toHaveLength(1); expect(f.db.raw.prepare('SELECT * FROM persons').all()).toEqual(before);
    expect(f.db.raw.prepare('SELECT * FROM campaign_step_receipts').all()).toEqual([]);
    expect(f.db.raw.prepare('SELECT * FROM pm_account_outbound_results').all()).toEqual([]);
  });
  it('keeps B4 local-only authority unchanged for worker-active accounts', async () => {
    const f = await fixture();
    const result = f.db.raw.transaction(() => {
      const policy = createSqlAccountRoutePolicy({ database: f.db, clock: f.clock, expectedWorkspaceId: f.workspaceId }).read(f.snapshot, f.snapshot.routes[0]);
      if (!policy || 'held' in policy) throw new Error('The admitted receipt must be read as evidence');
      expect(policy.ownerEnabled).toBe(false);
      return authorizeAccountRoute({ request: { commandId: randomUUID(), accountId: f.account.id, routeId: 'route', expectedRouteVersion: 1, expectedEvidenceFingerprint: f.snapshot.fingerprint, channel: 'call' }, route: f.snapshot.routes[0], evidenceFingerprint: f.snapshot.fingerprint, policy, expectedOwnerGeneration: policy.ownerGeneration, now, windows: PLAYBOOK_CHANNEL_POLICIES_V2 });
    }).immediate();
    expect(result).toEqual({ kind: 'blocked', reason: 'account_owner_changed' });
  });
  it.each(['offline', 'phone', 'abort', 'policy', 'evidence', 'context', 'suppression', 'paused', 'revoked', 'foreign'] as const)('holds %s without local fallback or consuming permission', async mode => {
    const f = await fixture();
    if (mode === 'offline') f.offline();
    if (mode === 'phone') f.unavailable();
    if (mode === 'abort') f.controller.abort();
    if (mode === 'evidence') f.request.expectedEvidenceFingerprint = 'c'.repeat(64);
    f.onReady(() => {
      if (mode === 'policy') f.policyStore.admit({ ...f.policy, id: randomUUID(), revision: 2, policy: { ...f.policy.policy, contact: { ...f.policy.policy.contact, validationState: 'invalid' } } });
      if (mode === 'context') f.db.raw.prepare("UPDATE campaign_enrollments SET execution_context_id='changed' WHERE account_id=?").run(f.account.id);
      if (mode === 'suppression') f.db.raw.prepare("INSERT INTO pm_handle_suppression_tombstones VALUES(?,'phone','+14015550100',?,'fixture','source',?)").run(randomUUID(), now, now);
      if (mode === 'paused' || mode === 'revoked') f.db.raw.prepare('UPDATE delegated_authorities SET state=? WHERE account_id=?').run(mode, f.account.id);
      if (mode === 'foreign') f.db.raw.prepare('UPDATE delegated_authorities SET workspace_id=? WHERE account_id=?').run(randomUUID(), f.account.id);
    });
    expect(await f.makeBridge().begin(f.request)).toMatchObject({ status: mode === 'offline' ? 'pending' : 'held' });
    expect(f.calls).toEqual([]);
    expect(f.db.raw.prepare('SELECT 1 FROM delegated_manual_handoffs WHERE consumed_at IS NOT NULL').all()).toEqual([]);
  });
});

it.each(['dnc', 'tcpa', 'person', 'account', 'missing-policy', 'expired', 'route', 'generation'] as const)('rechecks actual final SQL %s and leaves token unconsumed', async restriction => {
  const f = await fixture(restriction !== 'missing-policy'); let mutationApplied = false;
  const services = createDomainServices({ database: f.db, clock: f.clock, ids: { next: randomUUID } });
  // Fixture retains a genuine historical person, never creates one for the company route.
  f.db.raw.prepare("INSERT INTO person_contact_methods(id,person_id,kind,normalized_value,validation_state,reachability,is_primary,created_at,updated_at) VALUES('retained','historical-person','phone','+14015550100','valid','direct',1,?,?)").run(now, now);
  f.onReady(() => {
    if (restriction === 'dnc') f.db.raw.prepare("UPDATE person_contact_methods SET dnc_listed=1,federal_status='listed' WHERE id='retained'").run();
    if (restriction === 'tcpa') f.db.raw.prepare("UPDATE person_contact_methods SET tcpa_flag=1,compliance_tcpa_flag=1 WHERE id='retained'").run();
    if (restriction === 'person') services.optOut.apply({ personId: 'historical-person', tombstoneId: randomUUID(), requestedAt: now,
      policyVersion: 'founder_opt_out_v1', decision: { kind: 'structured_written', channel: 'imessage' },
      evidence: { kind: 'append_activity', activity: { id: randomUUID(), personId: 'historical-person', kind: 'text', direction: 'inbound', channel: 'imessage', occurredAt: now,
        observedOutcome: 'opted_out', adapter: 'messages', providerIdempotencyKey: randomUUID(), metadata: { structuredOptOut: true } } }, terminalStageEventId: null });
    if (restriction === 'account') f.db.raw.prepare("INSERT INTO pm_account_suppression_tombstones VALUES(?,?,?,'fixture','source',?)").run(randomUUID(), f.account.id, now, now);
    
    if (restriction === 'expired') f.setTime('2026-09-08T14:01:01.000Z');
    if (restriction === 'generation') f.db.raw.prepare('UPDATE delegated_authorities SET generation=2 WHERE account_id=?').run(f.account.id);
    if (restriction === 'route') f.repo.admitEvidence({ commandId: randomUUID(), accountId: f.account.id, expectedVersion: 2, sources: [], claims: [], routes: [{ id: 'route', accountId: f.account.id, personId: null, channel: 'phone', value: '+14015550101', purpose: 'business', evidenceIds: ['source'], verification: 'published' }] });
    mutationApplied = true;
  });
  expect(await f.makeBridge().begin(f.request)).toMatchObject({ status: 'held' });
  expect(mutationApplied).toBe(true); expect(f.calls).toEqual([]);
  expect(f.db.raw.prepare('SELECT consumed_at FROM delegated_manual_handoffs').get()).toEqual({ consumed_at: null });
});

it.each(['registry', 'checkpoint'] as const)('requires A1 proof currency after async readiness (%s race)', async change => {
  const f = await fixture(); let registry = 1; let checkpoint = 'first'; let checks = 0;
  const readiness = createInboundReadiness({ snapshot: () => ({ initialized: true, revision: registry, adapters: [{ id: 'fictional-native', relevant: () => true,
    synchronize: async () => ({ revision: checkpoint }), isAppliedCurrent: (_subject, value) => {
      const current = value === checkpoint;
      if (++checks === 1) queueMicrotask(() => { if (change === 'registry') registry++; else checkpoint = 'second'; });
      return current;
    } }] }) });
  const bridge = createDelegatedPhoneHandoff({ database: f.db, repository: f.repository, client: f.client, phone: f.phone, readinessForHandoff: () => readiness, clock: f.clock, expectedWorkspaceId: f.workspaceId });
  expect(await bridge.begin(f.request)).toMatchObject({ status: 'held' });
  expect(checks).toBeGreaterThan(0); expect(f.calls).toEqual([]);
  expect(f.db.raw.prepare('SELECT consumed_at FROM delegated_manual_handoffs').get()).toEqual({ consumed_at: null });
});

it('commits and dispatches in one stack before a microtask can change authority', async () => {
  const f = await fixture(); let finalChecks = 0; let changed = false;
  const readiness = createInboundReadiness({ snapshot: () => ({ initialized: true, revision: 1, adapters: [{ id: 'fictional-native', relevant: () => true,
    synchronize: async () => ({ revision: 'current' }), isAppliedCurrent: () => {
      if (++finalChecks === 2) queueMicrotask(() => { changed = true; f.db.raw.prepare("UPDATE delegated_authorities SET state='paused' WHERE account_id=?").run(f.account.id); });
      return true;
    } }] }) });
  f.onDispatch(() => expect(changed).toBe(false));
  const bridge = createDelegatedPhoneHandoff({ database: f.db, repository: f.repository, client: f.client, phone: f.phone, readinessForHandoff: () => readiness, clock: f.clock, expectedWorkspaceId: f.workspaceId });
  expect(await bridge.begin(f.request)).toMatchObject({ status: 'handoff', result: { status: 'handoff_accepted' } });
  expect(finalChecks).toBe(2); expect(changed).toBe(true); expect(f.calls).toHaveLength(1);
});

it.each(['throw', 'lost', 'abort'] as const)('retains consumed uncertainty on %s driver result and never retries', async mode => {
  const f = await fixture(); const original = f.phone.dispatch;
  f.phone.dispatch = target => { original(target); if (mode === 'abort') f.controller.abort(); if (mode === 'throw') throw new Error('fictional native error'); return Promise.reject(new Error('fictional lost native reply')); };
  expect(await f.makeBridge().begin(f.request)).toMatchObject({ status: 'handoff', result: { status: 'unknown' } });
  expect(f.calls).toHaveLength(1);
  const restarted = createDelegatedPhoneHandoff({ database: f.db, repository: f.repository, client: f.client, phone: f.phone, readinessForHandoff: () => f.readiness, clock: f.clock, expectedWorkspaceId: f.workspaceId });
  expect(await restarted.begin(f.request)).toMatchObject({ status: 'already_started' }); expect(f.calls).toHaveLength(1);
});

it('deduplicates concurrent explicit begin and rejects extra authority flags', async () => {
  const f = await fixture(); const bridge = f.makeBridge();
  const first = bridge.begin(f.request); const second = bridge.begin(f.request); expect(first).toBe(second);
  expect(await first).toMatchObject({ status: 'handoff' }); expect(f.calls).toHaveLength(1);
  expect(() => bridge.begin({ ...f.request, allowed: true } as typeof f.request)).toThrow();
  expect(() => bridge.begin({ ...f.request, command: { ...f.request.command, payload: { ...f.request.command.payload, channel: 'linkedin' } } })).toThrow();
});

it('uses durable SQL arbitration across competing bridge instances', async () => {
  const f = await fixture();
  const results = await Promise.all([f.makeBridge().begin(f.request), f.makeBridge().begin(f.request)]);
  expect(results.filter(result => result.status === 'handoff')).toHaveLength(1);
  expect(results.filter(result => result.status === 'held' || result.status === 'already_started')).toHaveLength(1);
  expect(f.calls).toHaveLength(1);
});

it.each(['missing', 'wrong-subject', 'missing-assert'] as const)('fails closed for %s readiness proof', async mode => {
  const f = await fixture();
  const readiness = mode === 'missing' ? { ...f.readiness, checkSubject: async () => ({ kind: 'ready' }) }
    : mode === 'wrong-subject' ? { ...f.readiness, checkSubject: (_subject: unknown, signal: AbortSignal) => f.readiness.checkSubject({ kind: 'person', id: 'historical-person' }, signal) }
      : { ...f.readiness, assertCurrent: undefined };
  const bridge = createDelegatedPhoneHandoff({ database: f.db, repository: f.repository, client: f.client, phone: f.phone,
    readinessForHandoff: () => readiness as typeof f.readiness, clock: f.clock, expectedWorkspaceId: f.workspaceId });
  expect(await bridge.begin(f.request)).toMatchObject({ status: 'held' }); expect(f.calls).toEqual([]);
  expect(f.db.raw.prepare('SELECT consumed_at FROM delegated_manual_handoffs').get()).toEqual({ consumed_at: null });
});

it('holds a durable pending pause between acknowledgment and the final transaction', async () => {
  const f = await fixture();
  f.onReady(() => f.repository.queueCommand({ ...f.request.command, commandId: randomUUID(), kind: 'pause', expectedVersion: f.repository.executionVersion(f.account.id), payload: { reason: 'Explicit pause' } }));
  expect(await f.makeBridge().begin(f.request)).toMatchObject({ status: 'held' });
  expect(f.repository.hasPendingStop(f.account.id)).toBe(true); expect(f.calls).toEqual([]);
});

it.each(['current', 'other-adapter-unavailable', 'owner-offline', 'registry-uninitialized'] as const)('assembles actual runtime-scoped A1 with owner HTTP checkpoint: %s', async mode => {
  const f = await fixture(); let otherChecks = 0; const nativeUris: string[] = [];
  const phone = createPhoneHandoffLauncher({ isExcludedNumber: value => value !== '+14015550100', driver: {
    inspectVerifiedHandler: async () => 'phone_continuity_verified', isVerifiedHandlerCurrent: () => true,
    openTelUri: uri => { expect(f.db.raw.inTransaction).toBe(false); expect(f.db.raw.prepare('SELECT consumed_at FROM delegated_manual_handoffs').get()).toEqual({ consumed_at: now }); nativeUris.push(uri); return Promise.resolve(); },
  } });
  const runtime = createDelegationRuntime({ databaseGate: { withDatabase: async fn => fn(f.db) }, pairing: { ...f.pairing, endpoint: 'https://phone.example.invalid' }, clock: f.clock, fetch: f.http,
    inboundRegistry: { snapshot: () => ({ initialized: mode !== 'registry-uninitialized', revision: 1, adapters: [runtime.adapter, {
      id: 'fictional-other-native-adapter', relevant: () => true, synchronize: async () => { otherChecks++; if (mode === 'other-adapter-unavailable') throw new Error('fictional missing adapter'); if (mode === 'owner-offline') f.offline(); return { revision: 'observed' }; }, isAppliedCurrent: (_subject, revision) => revision === 'observed',
    }] }) } });
  try {
    await runtime.configure({ expectedRevision: 0, configuration: { version: 1, state: 'active', research: null } });
    const bridge = createDelegatedPhoneHandoff({ database: f.db, repository: f.repository, client: f.client, phone, readinessForHandoff: runtime.readinessForHandoff, clock: f.clock, expectedWorkspaceId: f.workspaceId });
    const result = await bridge.begin(f.request);
    expect(result).toMatchObject({ status: mode === 'current' ? 'handoff' : 'held' });
    expect(nativeUris).toEqual(mode === 'current' ? ['tel:+14015550100'] : []);
    if (mode === 'current') { expect(f.paths).toContain('/readiness'); expect(otherChecks).toBe(1); }
  } finally { await runtime.dispose(); }
});

it('rejects changed actual evidence while the acknowledged route and target remain unchanged', async () => {
  const f = await fixture(); let changed = false;
  f.onReady(() => {
    f.repo.admitEvidence({ commandId: randomUUID(), accountId: f.account.id, expectedVersion: 2, sources: [], claims: [], routes: [] });
    const current = f.repo.snapshot(f.account.id, now);
    expect(current.routes).toEqual(f.snapshot.routes); expect(current.fingerprint).not.toBe(f.request.expectedEvidenceFingerprint); changed = true;
  });
  expect(await f.makeBridge().begin(f.request)).toMatchObject({ status: 'held' }); expect(changed).toBe(true); expect(f.calls).toEqual([]);
});

it('preserves final native capability currency and does not count unavailable handoff as a call', async () => {
  const f = await fixture(); let verified = true; const opens: string[] = [];
  const phone = createPhoneHandoffLauncher({ isExcludedNumber: () => false, driver: { inspectVerifiedHandler: async () => 'phone_continuity_verified',
    isVerifiedHandlerCurrent: () => verified, openTelUri: async uri => { opens.push(uri); } } });
  f.onReady(() => { verified = false; });
  const bridge = createDelegatedPhoneHandoff({ database: f.db, repository: f.repository, client: f.client, phone, readinessForHandoff: () => f.readiness, clock: f.clock, expectedWorkspaceId: f.workspaceId });
  expect(await bridge.begin(f.request)).toMatchObject({ status: 'handoff', result: { status: 'unavailable', reasonCode: 'phone_route_unverified' } });
  expect(opens).toEqual([]); expect(f.db.raw.prepare('SELECT * FROM campaign_step_receipts').all()).toEqual([]);
  expect(await bridge.begin(f.request)).toMatchObject({ status: 'already_started' });
});

async function todayFixture(secondRoute = false) {
  const f = await fixture(true, true, secondRoute);
  const services = createDomainServices({ database: f.db, clock: f.clock, ids: { next: randomUUID }, expectedWorkspaceId: f.workspaceId });
  const controlRepo = new AccountRepository({ database: f.db, clock: f.clock, ids: { next: () => `zz-${randomUUID()}` }, sourcePolicy: { attest: () => true } });
  // Sorts after 'Fictional Phone PM' by name and by id: the D2 morning order (window, evidence, name) keeps the control second.
  const control = controlRepo.create({ commandId: randomUUID(), name: 'Fictional Zz Control PM', domain: null });
  controlRepo.admitEvidence({ commandId: randomUUID(), accountId: control.id, expectedVersion: 1,
    claims: f.snapshot.claims.map(claim => ({ ...claim, evidenceIds: ['control-source'] })), sources: [{ id: 'control-source', url: 'https://example.invalid/team', fetchedAt: now, sha256: 'd'.repeat(64), excerpt: 'Fictional regional residential operator switchboard', permitted: true }],
    routes: [{ id: 'control-route', accountId: control.id, personId: null, channel: 'phone', value: '+14015550199', purpose: 'business', evidenceIds: ['control-source'], verification: 'published' }] });
  new LegacyWorkflowTransition({ database: f.db, unitOfWork: services.unitOfWork, clock: f.clock, ids: { next: randomUUID } }).transitionWorkflow({ commandId: randomUUID(), manifestId: randomUUID(), expectedMode: 'legacy' });
  const settings = services.workspaceSettings.readMeetingFirstAccountCallSettings();
  // Two new-firm slots a day (D2 budget): one for the firm under test, one the control fills once that call is made and its slot is consumed.
  services.unitOfWork.immediate(() => services.workspaceSettings.updateMeetingFirstAccountCallSettingsCas({ expectedRevision: settings.revision, newCallSlots: 2, totalCallCapacity: null, updatedAt: now }));
  const read = () => services.daily.get();
  const complete = async (outcome: 'connected' | 'no_answer' | 'voicemail' | 'busy' | 'wrong_number' | 'cancelled' | 'unknown' | 'not_called' | 'opt_out', sync = true) => {
    const handoff = f.repository.getManualHandoff((f.db.raw.prepare('SELECT handoff_id FROM delegated_manual_handoffs').get() as { handoff_id: string }).handoff_id)!;
    const command = delegationCommandSchema.parse({ commandId: randomUUID(), workspaceId: f.workspaceId, accountId: f.account.id,
      expectedAuthorityGeneration: f.repository.authority(f.account.id)!.generation, expectedVersion: f.repository.executionVersion(f.account.id), kind: 'complete-manual',
      payload: { handoffId: handoff.handoffId, targetHash: handoff.targetHash, outcome: { actionId: handoff.actionId, channel: 'call', outcome, observedAt: f.clock.now(), evidenceRef: randomUUID() } } });
    await f.client.submit(command);
    if (sync) { expect((await f.client.sync(new AbortController().signal)).ownerFresh).toBe(true); expect(f.repository.commandStatus(command.commandId)?.status).toBe('applied'); }
    return command;
  };
  const actualIds = () => {
    const interval = resolveLocalDayInterval({ generatedAt: f.clock.now(), timezone: services.workspaceSettings.read().timezone });
    return listDelegatedActualCallAccountIds(f.db, { accountIds: [f.account.id, control.id], from: interval.localDayStartAt, to: interval.localDayEndAt, generatedAt: f.clock.now() });
  };
  const nominationsOnly = () => services.today.planMeetingFirstAccountCalls({ due: [], ranked: read().accounts, generatedAt: f.clock.now() });
  return { ...f, services, control, read, complete, actualIds, nominationsOnly };
}

it('Today excludes a real owner-applied delegated no_answer from new nominations and fills the slot with the control', async () => {
  const f = await todayFixture();
  const before = f.read();
  expect(before.workflowMode).toBe('meeting_first');
  expect(before.calls.accountIds).toEqual([f.account.id, f.control.id]); // due plus one genuine new nomination
  expect(before.campaigns[0].enrollments[0]).toMatchObject({ state: 'active', personId: null });
  expect(await f.makeBridge().begin(f.request)).toMatchObject({ status: 'handoff', result: { status: 'handoff_accepted' } });
  await f.complete('no_answer');
  const after = f.read();
  expect(after.campaigns[0].enrollments[0].state).toBe('completed');
  expect(f.db.raw.prepare('SELECT * FROM pm_account_outbound_results').all()).toEqual([]);
  expect(after.accounts).toEqual(before.accounts);
  expect(after.calls.accountIds).toEqual([f.control.id]);
  // The call consumed one of the two daily new-firm slots (D2): a one-slot day now lists nothing new, and the firm called today never returns.
  const settings = f.services.workspaceSettings.readMeetingFirstAccountCallSettings();
  f.services.unitOfWork.immediate(() => f.services.workspaceSettings.updateMeetingFirstAccountCallSettingsCas({ expectedRevision: settings.revision, newCallSlots: 1, totalCallCapacity: null, updatedAt: now }));
  expect(f.read().calls.accountIds).toEqual([]);
});

it.each(['context-only', 'route-and-context'] as const)('Today retains historical actual call after %s change then stop then completion', async change => {
  const f = await todayFixture(change === 'route-and-context');
  const enrollment = () => f.read().campaigns[0].enrollments[0];
  expect(await f.makeBridge().begin(f.request)).toMatchObject({ status: 'handoff', result: { status: 'handoff_accepted' } });
  const selectedRouteId = change === 'context-only' ? 'route' : 'later-route';
  await f.apply('campaign-command', { kind: 'campaign.route', enrollmentId: 'enrollment', expectedEnrollmentVersion: enrollment().version,
    selectedRouteId, contextRevision: 2, executionContextId: 'later-context' });
  expect(enrollment()).toMatchObject({ selectedRouteId, selectedRouteVersion: 1, contextRevision: 2, executionContextId: 'later-context', state: 'active' });
  await f.apply('campaign-command', { kind: 'campaign.state', enrollmentId: 'enrollment', expectedEnrollmentVersion: enrollment().version, state: 'stopped', reason: 'Fictional campaign stop before late factual report' });
  expect(enrollment().state).toBe('stopped');
  expect(f.actualIds()).toEqual([]);
  expect(f.read().calls.accountIds).toEqual([f.account.id, f.control.id]); // no due obligation masks the new nomination
  const beforeAccounts = f.read().accounts;
  const command = await f.complete('no_answer');
  const row = f.db.raw.prepare("SELECT event_json FROM delegated_applied_events WHERE json_extract(event_json, '$.receipt.commandId')=?").get(command.commandId) as { event_json: string };
  const event = JSON.parse(row.event_json);
  expect(event.campaign.enrollment).toMatchObject({ id: 'enrollment', selectedRouteId, selectedRouteVersion: 1, contextRevision: 2, executionContextId: 'later-context', state: 'stopped' });
  expect(event.campaign.evidence).toMatchObject({ enrollmentId: 'enrollment', actionId: 'action', routeId: 'route', routeVersion: 1, contextRevision: 1, executionContextId: 'context', outcome: 'no_answer', state: 'human_reported_sent' });
  expect(event.campaign.evidence.conflict).toBeUndefined();
  expect(event.campaign.cap).toMatchObject({ reserved: 0, sent: 1 });
  expect(f.db.raw.prepare('SELECT * FROM pm_account_outbound_results').all()).toEqual([]);
  expect(f.read().accounts).toEqual(beforeAccounts);
  expect(enrollment().state).toBe('stopped');
  expect(f.calls).toEqual(['+14015550100']);
  expect.soft(f.actualIds()).toEqual([f.account.id]);
  expect(f.read().calls.accountIds).toEqual([f.control.id]);
});

it.each(['accepted', 'unknown', 'cancelled', 'not_called', 'pending'] as const)('Today does not count %s as an actual delegated call', async mode => {
  const f = await todayFixture();
  expect(f.nominationsOnly().accountIds).toEqual([f.account.id, f.control.id]);
  expect(await f.makeBridge().begin(f.request)).toMatchObject({ status: 'handoff' });
  if (mode !== 'accepted') {
    if (mode === 'pending') f.offline();
    const command = await f.complete(mode === 'pending' ? 'no_answer' : mode, mode !== 'pending');
    if (mode === 'pending') expect(f.repository.commandStatus(command.commandId)?.status).toBe('pending');
  }
  expect(f.actualIds()).toEqual([]);
  expect(f.nominationsOnly().accountIds).toEqual([f.account.id, f.control.id]);
  expect(f.read().calls.accountIds).toContain(f.account.id);
});

it.each(['connected', 'voicemail', 'busy', 'wrong_number'] as const)('Today counts owner-applied actual %s without inventing local B4 evidence', async outcome => {
  const f = await todayFixture();
  expect(await f.makeBridge().begin(f.request)).toMatchObject({ status: 'handoff' });
  await f.complete(outcome);
  expect(f.actualIds()).toEqual([f.account.id]);
  expect(f.read().calls.accountIds).toEqual([f.control.id]);
  expect(f.db.raw.prepare('SELECT * FROM pm_account_outbound_results').all()).toEqual([]);
});

it('Today resolves unknown on the original handoff once, remains read-only, and retains earlier actual evidence after opt-out', async () => {
  const f = await todayFixture();
  expect(await f.makeBridge().begin(f.request)).toMatchObject({ status: 'handoff' });
  await f.complete('unknown');
  expect(f.actualIds()).toEqual([]);
  const command = await f.complete('no_answer');
  await f.client.submit(command);
  await f.client.sync(new AbortController().signal);
  expect(f.actualIds()).toEqual([f.account.id]);
  await f.complete('opt_out');
  const changes = f.db.raw.prepare('SELECT total_changes() AS n').get();
  const paths = [...f.paths];
  expect(f.actualIds()).toEqual([f.account.id]);
  const restarted = createDomainServices({ database: f.db, clock: f.clock, ids: { next: () => { throw Error('read allocated an ID'); } }, expectedWorkspaceId: f.workspaceId });
  expect(restarted.daily.get().calls.accountIds).toEqual([f.control.id]);
  expect(f.read().calls.accountIds).toEqual([f.control.id]);
  expect(f.db.raw.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
  expect(f.paths).toEqual(paths);
  expect(f.calls).toHaveLength(1);
  // The isolated PM fixture uses this public test key, never a user workspace key.
  const key = createTestWorkspaceKey();
  closeDatabase(f.db);
  const reopened = openDatabase({ path: f.db.path, key });
  cleanups.push(() => { closeDatabase(reopened); key.bytes.fill(0); });
  const recovered = createDomainServices({ database: reopened, clock: f.clock, ids: { next: () => { throw Error('recovery allocated an ID'); } }, expectedWorkspaceId: f.workspaceId });
  const recoveredChanges = reopened.raw.prepare('SELECT total_changes() AS n').get();
  expect(recovered.daily.get().calls.accountIds).toEqual([f.control.id]);
  expect(reopened.raw.prepare('SELECT total_changes() AS n').get()).toEqual(recoveredChanges);
  expect(f.paths).toEqual(paths);
  expect(f.calls).toHaveLength(1);
});

it('Today retains a genuine new due campaign obligation even after an actual delegated call today', async () => {
  const f = await todayFixture();
  expect(await f.makeBridge().begin(f.request)).toMatchObject({ status: 'handoff' });
  await f.complete('no_answer');
  expect(f.read().calls.accountIds).toEqual([f.control.id]);
  const version = { ...f.read().campaigns[0].version, id: 'retained-due-version', campaignId: 'retained-due-campaign', approvedAt: null as string | null,
    steps: [{ id: 'retained-due-step', channel: 'call', condition: 'initial', delayHours: 0 }] };
  await f.apply('campaign-command', { kind: 'campaign.version', version });
  await f.apply('campaign-command', { kind: 'campaign.approve', campaignVersionId: version.id, snapshotHash: fingerprint(version), approvedAt: now });
  await f.apply('campaign-command', { kind: 'campaign.enroll', enrollmentId: 'retained-due-enrollment', campaignVersionId: version.id, selectedRouteId: 'route', executionContextId: 'retained-due-context', contextRevision: 1 });
  expect(f.actualIds()).toEqual([f.account.id]);
  expect(f.read().calls.accountIds).toEqual([f.account.id, f.control.id]);
  const settings = f.services.workspaceSettings.readMeetingFirstAccountCallSettings();
  f.services.unitOfWork.immediate(() => f.services.workspaceSettings.updateMeetingFirstAccountCallSettingsCas({ expectedRevision: settings.revision, newCallSlots: 1, totalCallCapacity: 0, updatedAt: now }));
  expect(f.read().calls).toMatchObject({ accountIds: [f.account.id, f.control.id], workloadConflict: true });
});

it.each([
  ['America/New_York', '2026-09-09T03:59:59.999Z', '2026-09-09T04:00:00.000Z', false],
  ['America/New_York', '2026-09-09T04:00:00.000Z', '2026-09-09T04:00:00.000Z', true],
  ['Asia/Tokyo', '2026-09-08T14:59:59.999Z', '2026-09-08T15:00:00.000Z', false],
  ['Asia/Tokyo', '2026-09-08T15:00:00.000Z', '2026-09-08T15:00:00.000Z', true],
] as const)('Today uses the half-open founder day in %s for observed %s', async (timezone, observedAt, readAt, counts) => {
  const f = await todayFixture();
  f.db.raw.prepare('UPDATE workspace_settings SET timezone=?').run(timezone);
  expect(await f.makeBridge().begin(f.request)).toMatchObject({ status: 'handoff' });
  f.setTime(observedAt);
  await f.complete('no_answer');
  expect(f.actualIds()).toEqual([f.account.id]);
  f.setTime(readAt);
  expect(f.actualIds()).toEqual(counts ? [f.account.id] : []);
  expect(f.read().calls.accountIds).toEqual(counts ? [f.control.id] : [f.account.id, f.control.id]);
});

it('Today rejects contradictory actual evidence after a definitive not_called report', async () => {
  const f = await todayFixture();
  expect(await f.makeBridge().begin(f.request)).toMatchObject({ status: 'handoff' });
  await f.complete('not_called');
  await f.complete('no_answer');
  expect(f.db.raw.prepare("SELECT outcome FROM campaign_step_receipts WHERE outcome LIKE 'conflict:%'").all()).toEqual([{ outcome: 'conflict:contradictory_finalized_outcome:no_answer' }]);
  expect(f.actualIds()).toEqual([]);
  expect(f.nominationsOnly().accountIds).toEqual([f.account.id, f.control.id]);
});

it.each(['unconsumed', 'workspace', 'action', 'target', 'context', 'generation', 'handoff-event'] as const)('Today does not count crossed or missing %s evidence', async mode => {
  const f = await todayFixture();
  expect(await f.makeBridge().begin(f.request)).toMatchObject({ status: 'handoff' });
  await f.complete('no_answer');
  expect(f.actualIds()).toEqual([f.account.id]);
  if (mode === 'unconsumed') f.db.raw.prepare('UPDATE delegated_manual_handoffs SET consumed_at=NULL').run();
  if (mode === 'workspace') f.db.raw.prepare("UPDATE delegated_manual_handoffs SET workspace_id='foreign'").run();
  if (mode === 'action') f.db.raw.prepare("UPDATE delegated_manual_handoffs SET action_id='other-action'").run();
  if (mode === 'target') f.db.raw.prepare('UPDATE delegated_manual_handoffs SET target_hash=?').run('a'.repeat(64));
  if (mode === 'context') f.db.raw.prepare("UPDATE delegated_manual_handoffs SET context_revision='other-context'").run();
  if (mode === 'generation') f.db.raw.prepare('UPDATE delegated_manual_handoffs SET authority_generation=9').run();
  if (mode === 'handoff-event') f.db.raw.prepare("UPDATE delegated_manual_handoffs SET event_id=(SELECT event_id FROM delegated_manual_outcomes LIMIT 1)").run();
  expect(f.actualIds()).toEqual([]);
  expect(f.nominationsOnly().accountIds).toEqual([f.account.id, f.control.id]);
});

it('Today limits completion evidence to selected accounts and preserves historical calls after owner revocation', async () => {
  const f = await todayFixture();
  expect(await f.makeBridge().begin(f.request)).toMatchObject({ status: 'handoff' });
  await f.apply('revoke', { reason: 'Fictional explicit revoke' });
  await f.complete('no_answer');
  expect(f.actualIds()).toEqual([f.account.id]);
  expect(listDelegatedActualCallAccountIds(f.db, { accountIds: [f.control.id], from: '2026-09-08T00:00:00.000Z', to: '2026-09-09T00:00:00.000Z', generatedAt: now })).toEqual([]);
  expect(f.read().calls.accountIds).toEqual([f.control.id]);
});

function phoneRecoveryPublic(f: Awaited<ReturnType<typeof fixture>>, database = f.db) {
  recoveryElectron.handle.mockClear();
  const forbidden = vi.fn(() => { throw Error('Recovery effect forbidden'); });
  const runtime = createDelegationRuntime({ databaseGate: { withDatabase: async fn => fn(database) },
    pairing: { ...f.pairing, endpoint: 'https://phone.example.invalid' }, clock: f.clock, fetch: forbidden,
    phone: { inspectCapability: forbidden, dispatch: forbidden }, inboundRegistry: { snapshot: forbidden } });
  const provider: OutreachApi = { status: forbidden, configure: forbidden, connectGmail: forbidden,
    disconnectGmail: forbidden, openDraft: forbidden, saveDraft: forbidden, generateDraft: forbidden,
    sendDraft: forbidden, inspectLocalAuthority: forbidden };
  const unregister = registerOutreachIpc({ provider, delegation: runtime });
  const api = createCallieApi({ invoke: async (channel, ...args) => registeredIpcHandler(recoveryElectron.handle, channel)({ senderFrame: { url: 'callie://app/index.html' } }, ...args) });
  return { api, runtime, forbidden, unregister, request: { accountId: f.account.id, enrollmentId: 'enrollment', stepId: 'call-step' } };
}
it('phone_state_empty_is_local_only: real owner scope through registered IPC and runtime', async () => {
  const f = await fixture(); const publicRead = phoneRecoveryPublic(f);
  const before = f.db.raw.prepare('SELECT total_changes() AS count').get();
  try {
    expect(await publicRead.api.delegation.getPhoneHandoffState(publicRead.request)).toMatchObject({
      ...publicRead.request, workspaceId: f.workspaceId, completeness: 'complete', issue: null,
      remote: 'unknown', attempts: [], completions: [],
      campaign: { campaignId: 'campaign', campaignRevision: 1, campaignVersionId: 'campaign-version' },
    });
    expect(f.db.raw.prepare('SELECT total_changes() AS count').get()).toEqual(before);
    expect(publicRead.forbidden).not.toHaveBeenCalled();
  } finally { publicRead.unregister(); await publicRead.runtime.dispose(); }
});

async function recoveryRead(f: Awaited<ReturnType<typeof fixture>>, p: ReturnType<typeof phoneRecoveryPublic>, database = f.db, request = p.request) {
  const snapshot = () => ['delegated_authorities', 'delegated_commands', 'delegated_applied_events', 'delegated_manual_handoffs', 'delegated_manual_outcomes', 'campaign_enrollments', 'campaign_versions', 'campaign_caps'].map(table => database.raw.prepare(`SELECT * FROM ${table}`).all());
  const before = snapshot(), changes = database.raw.prepare('SELECT total_changes() AS n').get(), paths = [...f.paths], calls = [...f.calls];
  const execution = await import('../../src/main/delegation/executionClient');
  const transport = await import('../../src/main/delegation/delegationSync');
  const crypto = await import('node:crypto');
  const construction = vi.spyOn(execution, 'ExecutionClient').mockImplementation(() => { throw Error('read constructed client'); });
  const transportConstruction = vi.spyOn(transport, 'SqlDelegationTransport').mockImplementation(() => { throw Error('read constructed transport'); });
  const ids = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => { throw Error('read allocated identity'); });
  const submit = vi.spyOn(f.client, 'submit'), sync = vi.spyOn(f.client, 'sync');
  const modes: string[] = [], originalTransaction = database.raw.transaction.bind(database.raw);
  const transaction = vi.spyOn(database.raw, 'transaction').mockImplementation(fn => new Proxy(originalTransaction(fn), {
    get(target, key, receiver) { if (['deferred', 'immediate', 'exclusive', 'default'].includes(String(key))) modes.push(String(key)); return Reflect.get(target, key, receiver); },
    apply(target, receiver, args) { modes.push('default'); return Reflect.apply(target, receiver, args); },
  }));
  try { return await p.api.delegation.getPhoneHandoffState(request); }
  finally {
    expect(snapshot()).toEqual(before); expect(database.raw.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
    expect(f.paths).toEqual(paths); expect(f.calls).toEqual(calls); expect(p.forbidden).not.toHaveBeenCalled();
    expect(construction).not.toHaveBeenCalled(); expect(transportConstruction).not.toHaveBeenCalled(); expect(ids).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled(); expect(sync).not.toHaveBeenCalled(); expect(transaction.mock.calls.length).toBeLessThanOrEqual(1); expect(modes).toEqual(transaction.mock.calls.length ? ['deferred'] : []);
    transaction.mockRestore(); construction.mockRestore(); transportConstruction.mockRestore(); ids.mockRestore(); submit.mockRestore(); sync.mockRestore();
  }
}
function reopenPhone(f: Awaited<ReturnType<typeof fixture>>) {
  closeDatabase(f.db); const key = createTestWorkspaceKey(); const database = openDatabase({ path: f.db.path, key });
  cleanups.push(() => { closeDatabase(database); key.bytes.fill(0); }); return database;
}
async function reportPhone(f: Awaited<ReturnType<typeof fixture>>, outcome: 'connected' | 'unknown' | 'no_answer' | 'not_called' | 'opt_out', sync = true) {
  const h = f.db.raw.prepare('SELECT handoff_id,target_hash FROM delegated_manual_handoffs').get() as { handoff_id: string; target_hash: string };
  const command = delegationCommandSchema.parse({ ...f.request.command, commandId: randomUUID(), kind: 'complete-manual', expectedAuthorityGeneration: f.repository.authority(f.account.id)!.generation,
    expectedVersion: f.repository.executionVersion(f.account.id), payload: { handoffId: h.handoff_id, targetHash: h.target_hash, outcome: { actionId: 'action', channel: 'call', outcome, observedAt: f.clock.now(), evidenceRef: randomUUID(), replyText: 'Saved untrusted <human> note' } } });
  await f.client.submit(command);
  if (sync) { expect((await f.client.sync(new AbortController().signal)).ownerFresh).toBe(true); expect(f.repository.commandStatus(command.commandId)?.status).toBe('applied'); }
  return command;
}
it('phone_state_requested_origin comes only from the exact immutable applied connected command and consumed handoff', async () => {
  const f = await fixture(); expect(await f.makeBridge().begin(f.request)).toMatchObject({ status: 'handoff' });
  const p = phoneRecoveryPublic(f);
  try {
    f.offline(); const command = await reportPhone(f, 'connected', false);
    if (command.kind !== 'complete-manual') throw Error('Expected complete-manual report');
    expect((await recoveryRead(f, p)).completions[0].applied).toBeNull();
    f.online(); await f.client.sync(new AbortController().signal);
    const result = await recoveryRead(f, p), completion = result.completions[0];
    const ref = completion.applied?.originalCall;
    expect(ref).toMatchObject({ commandId: command.commandId, handoffId: command.payload.handoffId, actionId: 'action', commandFingerprint: fingerprint(command), outcomeEventId: completion.receiptEvent?.eventId });
    const row = f.db.raw.prepare('SELECT event_json,fingerprint FROM delegated_applied_events WHERE id=?').get(ref!.outcomeEventId) as { event_json: string; fingerprint: string };
    expect(ref!.outcomeEventHash).toBe(row.fingerprint); expect(ref!.outcomeEventHash).toBe(fingerprint(JSON.parse(row.event_json)));
    const { delegatedPhoneStateSchema } = await import('../../src/shared/contracts/delegatedPhoneStateContract');
    for (const key of ['commandId', 'handoffId', 'actionId', 'outcomeEventId'] as const) {
      const crossed = structuredClone(result); crossed.completions[0].applied!.originalCall![key] = 'foreign';
      expect(delegatedPhoneStateSchema.safeParse(crossed).success).toBe(false);
    }
    p.unregister(); await p.runtime.dispose(); const database = reopenPhone(f), reopened = phoneRecoveryPublic(f, database);
    try { expect((await recoveryRead(f, reopened, database)).completions[0].applied?.originalCall).toEqual(ref); } finally { reopened.unregister(); await reopened.runtime.dispose(); }
  } finally { p.unregister(); await p.runtime.dispose(); }
});
it.each(['opt_out', 'not_called'] as const)('phone_state_requested_origin disappears after later %s evidence', async outcome => {
  const f = await fixture(); expect(await f.makeBridge().begin(f.request)).toMatchObject({ status: 'handoff' });
  await reportPhone(f, 'connected'); const p = phoneRecoveryPublic(f);
  try {
    expect((await recoveryRead(f, p)).completions[0].applied?.originalCall).toBeDefined();
    f.setTime(new Date(Date.parse(f.clock.now()) + 1000).toISOString()); await reportPhone(f, outcome);
    const result = await recoveryRead(f, p); expect(result.completeness).toBe('complete');
    expect(result.completions.every(c => c.applied?.originalCall === undefined)).toBe(true);
  } finally { p.unregister(); await p.runtime.dispose(); }
});
it.each(['pending', 'local-rejected', 'owner-rejected'] as const)('phone_state_preserves_pending_and_rejected_receipts: %s after restart', async mode => {
  const f = await fixture();
  const command = prepareManualCommandSchema.parse({ ...f.request.command, ...(mode === 'local-rejected' ? { expectedVersion: 0 } : {}), payload: { ...f.request.command.payload, ...(mode === 'owner-rejected' ? { targetHash: 'f'.repeat(64) } : {}) } });
  if (mode === 'pending') f.offline();
  await f.client.submit(command);
  if (mode === 'owner-rejected') { await f.apply('pause', { reason: 'Make refused preparation provably stale' }); expect((await f.client.sync(new AbortController().signal)).ownerFresh).toBe(true); }
  const database = reopenPhone(f), p = phoneRecoveryPublic(f, database);
  try {
    const result = await recoveryRead(f, p, database);
    expect(result.completeness).toBe('complete'); expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({ command, receipt: { status: mode === 'pending' ? 'pending' : 'rejected' }, handoff: null, receiptEvent: mode === 'owner-rejected' ? { kind: 'authority.changed' } : null });
  } finally { p.unregister(); await p.runtime.dispose(); }
});
it('phone_state_prepared_unconsumed_survives_restart and expiry without reservation release', async () => {
  const f = await fixture(); await f.client.submit(f.request.command); await f.client.sync(new AbortController().signal);
  const database = reopenPhone(f), p = phoneRecoveryPublic(f, database);
  try {
    const before = await recoveryRead(f, p, database);
    expect(before.attempts[0]).toMatchObject({ receipt: { status: 'applied' }, receiptEvent: { kind: 'manual.handoff' }, handoff: { consumedAt: null } });
    f.setTime('2026-09-08T14:02:00.000Z'); const expired = await recoveryRead(f, p, database);
    expect(expired.attempts).toEqual(before.attempts); expect(f.calls).toHaveLength(0);
    expect(database.raw.prepare('SELECT reserved,sent FROM campaign_caps WHERE channel=\'call\'').get()).toEqual({ reserved: 1, sent: 0 });
  } finally { p.unregister(); await p.runtime.dispose(); }
});
it('phone_state_consumed_lost_reply_is_unknown_not_retryable after actual SQL reopen', async () => {
  const f = await fixture(); const dispatch = f.phone.dispatch;
  f.phone.dispatch = target => { dispatch(target); throw Error('lost native reply'); };
  expect(await f.makeBridge().begin(f.request)).toMatchObject({ status: 'handoff', result: { status: 'unknown' } });
  const database = reopenPhone(f), p = phoneRecoveryPublic(f, database);
  try {
    for (let i = 0; i < 2; i++) {
      const result = await recoveryRead(f, p, database);
      expect(result.attempts[0].handoff?.consumedAt).toBe(now); expect(result.completions).toEqual([]);
      expect(JSON.stringify(result)).not.toContain('handoff_accepted');
    }
    expect(f.calls).toHaveLength(1);
  } finally { p.unregister(); await p.runtime.dispose(); }
});
it.each([['unknown', 'no_answer', 'opt_out'], ['no_answer', 'not_called']] as const)('phone_state_complete_pending_applied_and_conflict preserves %j', async (...outcomes) => {
  const f = await fixture(); expect(await f.makeBridge().begin(f.request)).toMatchObject({ status: 'handoff' });
  const p = phoneRecoveryPublic(f);
  try {
    f.offline(); const first = await reportPhone(f, outcomes[0], false);
    const pending = await recoveryRead(f, p); expect(pending.completions[0]).toMatchObject({ command: first, receipt: { status: 'pending' }, applied: null });
    f.online(); await f.client.sync(new AbortController().signal);
    for (const outcome of outcomes.slice(1)) { f.setTime(new Date(Date.parse(f.clock.now()) + 1000).toISOString()); await reportPhone(f, outcome); }
    const result = await recoveryRead(f, p); expect(result.completeness).toBe('complete');
    expect(result.completions.map(c => c.applied?.outcome.outcome)).toEqual(outcomes);
    expect(result.completions.every(c => c.receipt.status === 'applied')).toBe(true);
    if (outcomes.at(-1) === 'not_called') expect(result.completions.at(-1)?.applied?.evidence).toMatchObject({ outcome: 'not_called', state: 'cancelled', conflict: 'contradictory_finalized_outcome' });
    p.unregister(); await p.runtime.dispose(); const database = reopenPhone(f), reopened = phoneRecoveryPublic(f, database);
    try { expect(await recoveryRead(f, reopened, database)).toEqual(result); } finally { reopened.unregister(); await reopened.runtime.dispose(); }
  } finally { p.unregister(); await p.runtime.dispose(); }
});
it.each(['pause', 'revoke'] as const)('phone_state_historical_stop_and_binding_change with %s and original generation', async stop => {
  const f = await fixture(true, false, true); expect(await f.makeBridge().begin(f.request)).toMatchObject({ status: 'handoff' });
  await f.apply('campaign-command', { kind: 'campaign.route', enrollmentId: 'enrollment', expectedEnrollmentVersion: 1, selectedRouteId: 'later-route', contextRevision: 2, executionContextId: 'later-context' });
  await f.apply('campaign-command', { kind: 'campaign.state', enrollmentId: 'enrollment', expectedEnrollmentVersion: 2, state: 'stopped', reason: 'Historical stop' });
  await f.apply(stop, { reason: 'Historical authority change' });
  await reportPhone(f, 'no_answer'); const database = reopenPhone(f), p = phoneRecoveryPublic(f, database);
  try {
    const result = await recoveryRead(f, p, database); expect(result.completeness).toBe('complete');
    expect(result.completions[0].applied?.evidence).toMatchObject({ routeId: 'route', executionContextId: 'context', contextRevision: 1, stepId: 'call-step' });
    expect(result.completions[0].receiptEvent?.authorityGeneration).toBe(1);
    expect(result.completions[0].command.expectedAuthorityGeneration).toBe(stop === 'revoke' ? 2 : 1);
  } finally { p.unregister(); await p.runtime.dispose(); }
});
it('phone_state_empty_is_local_only rejects each foreign selector and lifecycle without effects', async () => {
  const f = await fixture(), p = phoneRecoveryPublic(f);
  try {
    for (const key of ['accountId', 'enrollmentId', 'stepId'] as const) await expect(recoveryRead(f, p, f.db, { ...p.request, [key]: 'foreign' })).rejects.toThrow(/^OUTREACH_REQUEST_FAILED$/);
    p.runtime.invalidate(true); await expect(recoveryRead(f, p)).rejects.toThrow(/^OUTREACH_REQUEST_FAILED$/);
    p.runtime.invalidate(false); await p.runtime.dispose(); await expect(recoveryRead(f, p)).rejects.toThrow(/^OUTREACH_REQUEST_FAILED$/);
  } finally { p.unregister(); await p.runtime.dispose(); }
});

function allowPhoneCorruption(f: Awaited<ReturnType<typeof fixture>>) {
  // Isolated negative fixture only. Production code never disables SQL protections.
  f.db.raw.pragma('foreign_keys = OFF'); f.db.raw.pragma('ignore_check_constraints = ON');
  const triggers = f.db.raw.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('delegated_commands','delegated_applied_events','delegated_manual_handoffs','delegated_manual_outcomes','campaign_versions')").all() as { name: string }[];
  for (const t of triggers) f.db.raw.exec(`DROP TRIGGER "${t.name.replaceAll('"', '""')}"`);
}
const phoneCorruptions = [
  ['command fingerprint', "UPDATE delegated_commands SET fingerprint='" + 'c'.repeat(64) + "' WHERE json_extract(command_json,'$.kind')='prepare-manual'"],
  ['event fingerprint', "UPDATE delegated_applied_events SET fingerprint='" + 'c'.repeat(64) + "' WHERE json_extract(event_json,'$.kind')='manual.outcome'"],
  ['command missing', "DELETE FROM delegated_commands WHERE json_extract(command_json,'$.kind')='prepare-manual'"],
  ['handoff missing', 'DELETE FROM delegated_manual_handoffs'],
  ['handoff event missing', "DELETE FROM delegated_applied_events WHERE json_extract(event_json,'$.kind')='manual.handoff'"],
  ['outcome event missing', "DELETE FROM delegated_applied_events WHERE json_extract(event_json,'$.kind')='manual.outcome'"],
  ['outcome projection missing', 'DELETE FROM delegated_manual_outcomes'],
  ['handoff action', "UPDATE delegated_manual_handoffs SET action_id='crossed'"],
  ['handoff target', "UPDATE delegated_manual_handoffs SET target_hash='" + 'c'.repeat(64) + "'"],
  ['handoff content', "UPDATE delegated_manual_handoffs SET content_hash='" + 'c'.repeat(64) + "'"],
  ['handoff context', "UPDATE delegated_manual_handoffs SET context_revision='crossed'"],
  ['handoff route', "UPDATE delegated_manual_handoffs SET route_id='crossed'"],
  ['handoff version', 'UPDATE delegated_manual_handoffs SET route_version=2'],
  ['handoff generation', 'UPDATE delegated_manual_handoffs SET authority_generation=2'],
  ['handoff channel', "UPDATE delegated_manual_handoffs SET channel='linkedin'"],
  ['handoff event crossed', "UPDATE delegated_manual_handoffs SET event_id='orphan'"],
  ['handoff consumed missing', 'UPDATE delegated_manual_handoffs SET consumed_at=NULL'],
  ['handoff outcome pointer', "UPDATE delegated_manual_handoffs SET outcome_command_id='orphan'"],
  ['outcome action', "UPDATE delegated_manual_outcomes SET action_id='crossed'"],
  ['outcome channel', "UPDATE delegated_manual_outcomes SET channel='linkedin'"],
  ['outcome time', "UPDATE delegated_manual_outcomes SET observed_at='2026-09-08T13:00:00.000Z'"],
  ['outcome crossed event', "UPDATE delegated_manual_outcomes SET event_id='orphan'"],
  ['outcome payload', "UPDATE delegated_manual_outcomes SET outcome_json='{}'"],
  ['unrelated malformed JSON', "UPDATE delegated_commands SET command_json='not JSON' WHERE json_extract(command_json,'$.kind')='configure-owner'"],
  ['unrelated invalid timestamp', "UPDATE delegated_commands SET created_at='yesterday' WHERE json_extract(command_json,'$.kind')='configure-owner'"],
  ['scalar oversized', "UPDATE delegated_manual_handoffs SET context_revision=printf('%0201d',1)"],
  ['scalar NUL suffix', "UPDATE delegated_manual_handoffs SET context_revision='x'||char(0)||printf('%01000d',1)"],
  ['scalar wrong storage', "UPDATE delegated_manual_handoffs SET route_id=x'0102'"],
  ['scalar unsafe number', 'UPDATE delegated_manual_handoffs SET route_version=9007199254740992'],
] as const;
it.each(phoneCorruptions)('phone_state_corruption_never_becomes_absence: %s', async (_name, sql) => {
  const f = await fixture(); await f.makeBridge().begin(f.request); await reportPhone(f, 'no_answer'); const p = phoneRecoveryPublic(f);
  try {
    expect((await recoveryRead(f, p)).completeness).toBe('complete');
    allowPhoneCorruption(f); f.db.raw.exec(sql);
    expect(await recoveryRead(f, p)).toMatchObject({ completeness: 'incomplete', issue: 'invalid_record', attempts: [], completions: [] });
  } finally { p.unregister(); await p.runtime.dispose(); }
});
it('phone_state_corruption_never_becomes_absence: duplicate prepared action and independent invalid precedence', async () => {
  const f = await fixture(); f.repository.queueCommand(f.request.command);
  f.repository.queueCommand({ ...f.request.command, commandId: randomUUID() }); const p = phoneRecoveryPublic(f);
  try {
    expect(await recoveryRead(f, p)).toMatchObject({ completeness: 'incomplete', issue: 'ambiguous_identity' });
    allowPhoneCorruption(f); f.db.raw.prepare("UPDATE delegated_commands SET created_at='bad' WHERE command_id=?").run(f.request.command.commandId);
    expect(await recoveryRead(f, p)).toMatchObject({ completeness: 'incomplete', issue: 'invalid_record' });
  } finally { p.unregister(); await p.runtime.dispose(); }
});
it('phone_state_bounds_are_nonvacuous: exactly 32 distinct pending prepares and 33rd witness', async () => {
  const f = await fixture();
  for (let i = 0; i < 32; i++) f.repository.queueCommand({ ...f.request.command, commandId: randomUUID(), payload: { ...f.request.command.payload, actionId: `action-${i}` } });
  const p = phoneRecoveryPublic(f);
  try {
    const result = await recoveryRead(f, p); expect(result.completeness).toBe('complete'); expect(result.attempts).toHaveLength(32);
    f.repository.queueCommand({ ...f.request.command, commandId: randomUUID(), payload: { ...f.request.command.payload, actionId: 'action-32' } });
    expect(await recoveryRead(f, p)).toMatchObject({ completeness: 'incomplete', issue: 'prepare_limit', attempts: [], completions: [] });
  } finally { p.unregister(); await p.runtime.dispose(); }
});
it('phone_state_bounds_are_nonvacuous: exactly 100 completions and 101st witness on real consumed handoff', async () => {
  const f = await fixture(); await f.makeBridge().begin(f.request);
  const h = f.db.raw.prepare('SELECT handoff_id,target_hash FROM delegated_manual_handoffs').get() as { handoff_id: string; target_hash: string };
  const queue = () => f.repository.queueCommand(delegationCommandSchema.parse({ ...f.request.command, commandId: randomUUID(), kind: 'complete-manual', expectedVersion: f.repository.executionVersion(f.account.id), payload: { handoffId: h.handoff_id, targetHash: h.target_hash, outcome: { actionId: 'action', channel: 'call', outcome: 'unknown', observedAt: now, evidenceRef: randomUUID() } } }));
  for (let i = 0; i < 100; i++) queue(); const p = phoneRecoveryPublic(f);
  try {
    const result = await recoveryRead(f, p); expect(result.completeness).toBe('complete'); expect(result.completions).toHaveLength(100);
    queue(); expect(await recoveryRead(f, p)).toMatchObject({ completeness: 'incomplete', issue: 'completion_limit', attempts: [], completions: [] });
  } finally { p.unregister(); await p.runtime.dispose(); }
});
it('phone_state_bounds_are_nonvacuous: account source rows 512 admitted and 513 held', async () => {
  const f = await fixture();
  const queue = () => f.repository.queueCommand(delegationCommandSchema.parse({ ...f.request.command, commandId: randomUUID(), kind: 'pause', payload: { reason: 'Unrelated source-count witness' } }));
  const existing = (f.db.raw.prepare('SELECT count(*) AS n FROM delegated_commands').get() as { n: number }).n;
  for (let i = existing; i < 512; i++) queue(); const p = phoneRecoveryPublic(f);
  try {
    expect(await recoveryRead(f, p)).toMatchObject({ completeness: 'complete', attempts: [], completions: [] });
    queue(); expect(await recoveryRead(f, p)).toMatchObject({ completeness: 'incomplete', issue: 'source_limit' });
  } finally { p.unregister(); await p.runtime.dispose(); }
});
it('phone_state_bounds_are_nonvacuous: UTF-8 per-body exact budget and overflow without parsing oversize', async () => {
  const f = await fixture(); f.repository.queueCommand(f.request.command); allowPhoneCorruption(f);
  const row = f.db.raw.prepare('SELECT command_json FROM delegated_commands WHERE command_id=?').get(f.request.command.commandId) as { command_json: string };
  const padded = row.command_json + ' '.repeat(1_048_576 - Buffer.byteLength(row.command_json));
  f.db.raw.prepare('UPDATE delegated_commands SET command_json=? WHERE command_id=?').run(padded, f.request.command.commandId);
  const p = phoneRecoveryPublic(f);
  try {
    expect((await recoveryRead(f, p)).completeness).toBe('complete');
    f.db.raw.prepare('UPDATE delegated_commands SET command_json=? WHERE command_id=?').run(padded + ' ', f.request.command.commandId);
    expect(await recoveryRead(f, p)).toMatchObject({ completeness: 'incomplete', issue: 'source_limit' });
  } finally { p.unregister(); await p.runtime.dispose(); }
});
it('phone_state_read_has_no_effects rejects ambient transaction and post-work lifecycle race', async () => {
  const f = await fixture(), p = phoneRecoveryPublic(f);
  const { readDelegatedPhoneHandoffState } = await import('../../src/main/delegation/delegatedPhoneState');
  try {
    f.db.raw.transaction(() => { expect(() => readDelegatedPhoneHandoffState(f.db, { ...p.request, workspaceId: f.workspaceId, generatedAt: now })).toThrow('phone_snapshot_unavailable'); }).deferred();
    const clock = vi.spyOn(f.clock, 'now').mockImplementation(() => { queueMicrotask(() => p.runtime.invalidate(true)); return now; });
    await expect(recoveryRead(f, p)).rejects.toThrow(/^OUTREACH_REQUEST_FAILED$/); expect(clock).toHaveBeenCalledTimes(1); clock.mockRestore();
  } finally { p.unregister(); await p.runtime.dispose(); }
});
it('phone_state_safe_projection excludes valid unrelated research, LinkedIn, email and campaign canaries', async () => {
  const f = await fixture(); await f.makeBridge().begin(f.request); await reportPhone(f, 'unknown');
  const canary = 'UNRELATED_PRIVATE_CANARY';
  f.repository.queueCommand(delegationCommandSchema.parse({ ...f.request.command, commandId: randomUUID(), kind: 'manual-outcome', payload: { actionId: 'unrelated-linkedin', channel: 'linkedin', outcome: 'unknown', observedAt: now, evidenceRef: canary, replyText: canary } }));
  f.repository.queueCommand(delegationCommandSchema.parse({ ...f.request.command, commandId: randomUUID(), kind: 'campaign-command', payload: { kind: 'campaign.version', version: { id: 'unrelated-version', campaignId: canary, version: 1, audienceHash: 'a'.repeat(64), offer: canary, objective: 'meeting', cohortAccountIds: [f.account.id], approvedAt: null, steps: [{ id: canary, channel: 'email', condition: 'initial', delayHours: 0 }], capScope: 'campaign_version_lifetime', channelCaps: { call: 0, email: 1, linkedin: 0 }, contentPolicyHash: 'b'.repeat(64) } } }));
  expect(f.repository.applyWorkerEvent({ id: 'research-canary', workspaceId: f.workspaceId, accountId: f.account.id, authorityGeneration: 0, aggregateVersion: 1, kind: 'research.receipt', payload: { jobId: canary, receiptCommandId: null, status: 'parked', costMicros: null, observedAt: now } })).toBe('applied');
  const p = phoneRecoveryPublic(f);
  try {
    const result = await recoveryRead(f, p); expect(result.completeness).toBe('complete'); expect(result.attempts).toHaveLength(1); expect(result.completions).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(canary); expect(JSON.stringify(result)).not.toContain('Fictional offer'); expect(JSON.stringify(result)).not.toContain('cohortAccountIds');
  } finally { p.unregister(); await p.runtime.dispose(); }
});
it('phone_state_bounds_are_nonvacuous: aggregate JSON exact 8 MiB and one-byte overflow', async () => {
  const f = await fixture();
  for (let i = 0; i < 9; i++) f.repository.queueCommand(delegationCommandSchema.parse({ ...f.request.command, commandId: randomUUID(), kind: 'pause', payload: { reason: '界'.repeat(500) } }));
  allowPhoneCorruption(f);
  const rows = f.db.raw.prepare('SELECT command_id,command_json,receipt_json FROM delegated_commands ORDER BY command_id').all() as { command_id: string; command_json: string; receipt_json: string }[];
  const size = () => (f.db.raw.prepare(`SELECT (SELECT sum(length(CAST(command_json AS BLOB))+length(CAST(receipt_json AS BLOB))) FROM delegated_commands)+(SELECT sum(length(CAST(event_json AS BLOB))) FROM delegated_applied_events)+(SELECT sum(length(CAST(snapshot_json AS BLOB))) FROM campaign_versions) AS n`).get() as { n: number }).n;
  let remaining = 8_388_608 - size(); let last = rows[0];
  for (const row of rows) { const padding = Math.min(remaining, 1_048_576 - Buffer.byteLength(row.command_json)); if (padding <= 0) break; row.command_json += ' '.repeat(padding); f.db.raw.prepare('UPDATE delegated_commands SET command_json=? WHERE command_id=?').run(row.command_json, row.command_id); remaining -= padding; last = row; }
  expect(remaining).toBe(0); expect(size()).toBe(8_388_608); expect(Buffer.byteLength(last.command_json)).toBeLessThan(1_048_576);
  const p = phoneRecoveryPublic(f);
  try {
    expect((await recoveryRead(f, p)).completeness).toBe('complete');
    f.db.raw.prepare('UPDATE delegated_commands SET command_json=? WHERE command_id=?').run(last.command_json + ' ', last.command_id);
    expect(await recoveryRead(f, p)).toMatchObject({ completeness: 'incomplete', issue: 'source_limit' });
  } finally { p.unregister(); await p.runtime.dispose(); }
});
it('phone_state scope anchor oversized rejects rather than returning an unproven incomplete identity', async () => {
  const f = await fixture(); allowPhoneCorruption(f);
  f.db.raw.prepare('UPDATE campaign_versions SET snapshot_json=?').run(JSON.stringify({ value: 'x'.repeat(1_048_576) })); const p = phoneRecoveryPublic(f);
  try { await expect(recoveryRead(f, p)).rejects.toThrow(/^OUTREACH_REQUEST_FAILED$/); }
  finally { p.unregister(); await p.runtime.dispose(); }
});
it('phone_state_corruption_never_becomes_absence: duplicate owner rejections and crossed foreign acknowledgment', async () => {
  const f = await fixture(); f.repository.queueCommand(f.request.command); allowPhoneCorruption(f);
  const insert = (id: string, workspaceId: string, version: number) => {
    const event = { id, workspaceId, accountId: f.account.id, authorityGeneration: 1, aggregateVersion: version, kind: 'authority.changed', payload: { authority: { accountId: f.account.id, owner: 'worker', generation: 1, state: 'active' }, receipt: { commandId: f.request.command.commandId, status: 'rejected', authorityGeneration: 1, aggregateVersion: version, reason: 'Synthetic stale acknowledgment witness' } } };
    f.db.raw.prepare('INSERT INTO delegated_applied_events VALUES(?,?,?,?,?,?,?,?,?)').run(id, workspaceId, f.account.id, 'execution', version, 1, fingerprint(event), JSON.stringify(event), now);
  };
  f.db.raw.exec('DROP INDEX delegated_receipt_once');
  insert('rejected-one', f.workspaceId, 6); insert('rejected-two', f.workspaceId, 7); const p = phoneRecoveryPublic(f);
  try {
    expect(await recoveryRead(f, p)).toMatchObject({ completeness: 'incomplete', issue: 'ambiguous_identity' });
    f.db.raw.prepare("DELETE FROM delegated_applied_events WHERE id IN ('rejected-one','rejected-two')").run();
    insert('foreign-rejection', 'foreign-workspace', 6);
    expect(await recoveryRead(f, p)).toMatchObject({ completeness: 'incomplete', issue: 'invalid_record' });
  } finally { p.unregister(); await p.runtime.dispose(); }
});
it('phone_state preserves a locally rejected completion attempt separately from applied human reports', async () => {
  const f = await fixture(); await f.makeBridge().begin(f.request);
  const h = f.db.raw.prepare('SELECT handoff_id,target_hash FROM delegated_manual_handoffs').get() as { handoff_id: string; target_hash: string };
  const command = delegationCommandSchema.parse({ ...f.request.command, commandId: randomUUID(), kind: 'complete-manual', expectedVersion: 0, payload: { handoffId: h.handoff_id, targetHash: h.target_hash, outcome: { actionId: 'action', channel: 'call', outcome: 'no_answer', observedAt: now, evidenceRef: 'local-stale-report' } } });
  expect(f.repository.queueCommand(command).status).toBe('rejected'); const p = phoneRecoveryPublic(f);
  try {
    const result = await recoveryRead(f, p); expect(result.completeness).toBe('complete');
    expect(result.completions[0]).toMatchObject({ command, receipt: { status: 'rejected' }, receiptEvent: null, applied: null });
  } finally { p.unregister(); await p.runtime.dispose(); }
});
it.each(['events', 'handoffs', 'outcomes'] as const)('phone_state_bounds_are_nonvacuous: %s table 512 valid histories then 513th source witness', async kind => {
  const f = await fixture(); allowPhoneCorruption(f);
  f.db.raw.exec('DELETE FROM delegated_applied_events; DELETE FROM delegated_commands');
  const insertCommand = f.db.raw.prepare('INSERT INTO delegated_commands VALUES(?,?,?,?,?,?,?)');
  const insertEvent = f.db.raw.prepare('INSERT INTO delegated_applied_events VALUES(?,?,?,?,?,?,?,?,?)');
  const seed = (i: number, overflow = false) => {
    const commandId = `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`, eventId = `bounded-event-${i}`, actionId = `bounded-action-${i}`, aggregateVersion = i + 1;
    const command = kind === 'handoffs' ? { ...f.request.command, commandId, expectedVersion: i, payload: { ...f.request.command.payload, actionId, channel: 'linkedin' } }
      : { ...f.request.command, commandId, expectedVersion: i, kind: 'manual-outcome', payload: { actionId, channel: 'linkedin', outcome: 'unknown', observedAt: now, evidenceRef: `report-${i}` } };
    const receipt = commandReceiptSchema.parse({ commandId, status: 'applied', authorityGeneration: 1, aggregateVersion, reason: null });
    const event = workerEventSchema.parse(kind === 'events' ? { id: eventId, workspaceId: f.workspaceId, accountId: f.account.id, authorityGeneration: 0, aggregateVersion, kind: 'research.receipt', payload: { jobId: actionId, receiptCommandId: null, status: 'parked', costMicros: null, observedAt: now } }
      : kind === 'handoffs' ? { id: eventId, workspaceId: f.workspaceId, accountId: f.account.id, authorityGeneration: 1, aggregateVersion, kind: 'manual.handoff', payload: { ...command.payload, handoffId: `bounded-handoff-${i}`, expiresAt: '2026-09-08T14:01:00.000Z' }, receipt }
        : { id: eventId, workspaceId: f.workspaceId, accountId: f.account.id, authorityGeneration: 1, aggregateVersion, kind: 'manual.outcome', payload: command.payload, receipt });
    if (!overflow && kind !== 'events') insertCommand.run(commandId, f.workspaceId, f.account.id, fingerprint(command), JSON.stringify(command), JSON.stringify({ ...receipt, status: 'pending', aggregateVersion: i }), now);
    if (!overflow || kind === 'events') insertEvent.run(eventId, f.workspaceId, f.account.id, kind === 'events' ? 'research' : 'execution', aggregateVersion, kind === 'events' ? 0 : 1, fingerprint(event), JSON.stringify(event), now);
    if (kind === 'handoffs') f.db.raw.prepare('INSERT INTO delegated_manual_handoffs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)').run(f.workspaceId, f.account.id, `bounded-handoff-${i}`, actionId, 1, f.request.command.payload.targetHash, f.request.command.payload.contentHash, 'context', 'linkedin', 'route', 1, '2026-09-08T14:01:00.000Z', eventId);
    if (kind === 'outcomes') f.db.raw.prepare('INSERT INTO delegated_manual_outcomes VALUES(?,?,?,?,?,?,?)').run(eventId, f.workspaceId, f.account.id, actionId, 'linkedin', JSON.stringify(command.payload), now);
  };
  f.db.raw.transaction(() => { for (let i = 0; i < 512; i++) seed(i); }).immediate();
  const p = phoneRecoveryPublic(f);
  try {
    expect(await recoveryRead(f, p)).toMatchObject({ completeness: 'complete', attempts: [], completions: [] });
    seed(512, true); expect(await recoveryRead(f, p)).toMatchObject({ completeness: 'incomplete', issue: 'source_limit' });
  } finally { p.unregister(); await p.runtime.dispose(); }
});
it('phone_state_corruption_never_becomes_absence: same opaque handoff in another workspace is not a crossed reference', async () => {
  const f = await fixture(); await f.makeBridge().begin(f.request); const p = phoneRecoveryPublic(f);
  try {
    const control = await recoveryRead(f, p);
    f.db.raw.prepare("INSERT INTO delegated_manual_handoffs SELECT 'unrelated-workspace',account_id,handoff_id,action_id,authority_generation,target_hash,content_hash,context_revision,channel,route_id,route_version,expires_at,event_id,consumed_at,outcome_command_id FROM delegated_manual_handoffs WHERE workspace_id=?").run(f.workspaceId);
    expect(await recoveryRead(f, p)).toEqual(control);
  } finally { p.unregister(); await p.runtime.dispose(); }
});
it('phone_state_closed_database rejects fixed public error without touching effects', async () => {
  const f = await fixture(), p = phoneRecoveryPublic(f); closeDatabase(f.db);
  try { await expect(p.api.delegation.getPhoneHandoffState(p.request)).rejects.toThrow(/^OUTREACH_REQUEST_FAILED$/); expect(p.forbidden).not.toHaveBeenCalled(); }
  finally { p.unregister(); await p.runtime.dispose(); }
});
it.each([
  ['receipt.commandId', '33333333-3333-4333-8333-333333333333'], ['campaign.commandId', '33333333-3333-4333-8333-333333333333'],
  ['campaign.evidence.actionId', 'crossed'], ['campaign.evidence.enrollmentId', 'crossed'], ['campaign.evidence.campaignVersionId', 'crossed'],
  ['campaign.evidence.stepId', 'crossed'], ['campaign.evidence.routeId', 'crossed'], ['campaign.evidence.routeVersion', 2],
  ['campaign.evidence.executionContextId', 'crossed'], ['campaign.evidence.outcome', 'unknown'], ['campaign.evidence.state', 'unknown'],
  ['campaign.enrollment.id', 'crossed'], ['campaign.enrollment.campaignVersionId', 'crossed'], ['campaign.enrollment.version', 1],
  ['campaign.cap.campaignVersionId', 'crossed'], ['campaign.evidence', null], ['campaign.enrollment', null],
  ['payload.replyText', 'different saved note'], ['authorityGeneration', 2], ['aggregateVersion', 1],
] as const)('phone_state_corruption_never_becomes_absence: recomputed event fingerprint cannot hide %s', async (path, value) => {
  const f = await fixture(); await f.makeBridge().begin(f.request); await reportPhone(f, 'no_answer'); const p = phoneRecoveryPublic(f);
  try {
    expect((await recoveryRead(f, p)).completeness).toBe('complete'); allowPhoneCorruption(f);
    const row = f.db.raw.prepare("SELECT id,event_json FROM delegated_applied_events WHERE json_extract(event_json,'$.kind')='manual.outcome'").get() as { id: string; event_json: string };
    const event: unknown = JSON.parse(row.event_json); let target: unknown = event; const keys = path.split('.');
    for (const key of keys.slice(0, -1)) { if (typeof target !== 'object' || target === null) throw Error('fixture path'); target = Reflect.get(target, key); }
    if (typeof target !== 'object' || target === null) throw Error('fixture path'); Reflect.set(target, keys.at(-1)!, value);
    f.db.raw.prepare('UPDATE delegated_applied_events SET event_json=?,fingerprint=? WHERE id=?').run(JSON.stringify(event), fingerprint(event), row.id);
    expect(await recoveryRead(f, p)).toMatchObject({ completeness: 'incomplete', issue: 'invalid_record', attempts: [], completions: [] });
  } finally { p.unregister(); await p.runtime.dispose(); }
});
it.each(['local', 'delegating', 'active', 'paused', 'revoked'] as const)('phone_state scope is not permission: %s authority admits saved local absence', async state => {
  const f = await fixture(); f.db.raw.prepare('UPDATE delegated_authorities SET state=?,owner=? WHERE account_id=?').run(state, state === 'local' ? 'local' : 'worker', f.account.id);
  const p = phoneRecoveryPublic(f);
  try { expect(await recoveryRead(f, p)).toMatchObject({ completeness: 'complete', attempts: [], completions: [], remote: 'unknown' }); }
  finally { p.unregister(); await p.runtime.dispose(); }
});
it('phone_state scope rejects real other account for existing enrollment and corrupt version identity', async () => {
  const f = await fixture(); const other = f.repo.create({ commandId: randomUUID(), name: 'Other scoped account', domain: null });
  new DelegationRepository({ database: f.db, workspaceId: f.workspaceId, clock: f.clock }).initializeLocalAuthority(other.id);
  const p = phoneRecoveryPublic(f);
  try {
    await expect(recoveryRead(f, p, f.db, { ...p.request, accountId: other.id })).rejects.toThrow(/^OUTREACH_REQUEST_FAILED$/);
    allowPhoneCorruption(f); f.db.raw.prepare("UPDATE campaign_versions SET campaign_id='crossed'").run();
    await expect(recoveryRead(f, p)).rejects.toThrow(/^OUTREACH_REQUEST_FAILED$/);
  } finally { p.unregister(); await p.runtime.dispose(); }
});
it('phone_state repeated prepare action remains ambiguous even with an applied original and rejected second command', async () => {
  const f = await fixture(); await f.makeBridge().begin(f.request); await reportPhone(f, 'no_answer');
  expect(f.repository.queueCommand({ ...f.request.command, commandId: randomUUID() }).status).toBe('rejected'); const p = phoneRecoveryPublic(f);
  try { expect(await recoveryRead(f, p)).toMatchObject({ completeness: 'incomplete', issue: 'ambiguous_identity', attempts: [], completions: [] }); }
  finally { p.unregister(); await p.runtime.dispose(); }
});
it('phone_state cross-account prepared action ownership is invalid even before either owner acknowledgment', async () => {
  const f = await fixture(); f.repository.queueCommand(f.request.command);
  const other = f.repo.create({ commandId: randomUUID(), name: 'Foreign action owner', domain: null });
  const foreign = new DelegationRepository({ database: f.db, workspaceId: f.workspaceId, clock: f.clock }); foreign.initializeLocalAuthority(other.id);
  foreign.queueCommand({ ...f.request.command, commandId: randomUUID(), accountId: other.id, expectedAuthorityGeneration: 0, expectedVersion: 0 });
  const p = phoneRecoveryPublic(f);
  try { expect(await recoveryRead(f, p)).toMatchObject({ completeness: 'incomplete', issue: 'invalid_record' }); }
  finally { p.unregister(); await p.runtime.dispose(); }
});
it('phone_state preserves a completion queued before intervening owner events without expectedVersion-plus-one inference', async () => {
  const f = await fixture(); await f.makeBridge().begin(f.request); f.offline(); const command = await reportPhone(f, 'no_answer', false);
  f.online(); await f.apply('pause', { reason: 'Intervening owner event before late factual completion' });
  expect(f.repository.commandStatus(command.commandId)?.status).toBe('applied'); const p = phoneRecoveryPublic(f);
  try {
    const result = await recoveryRead(f, p); expect(result.completeness).toBe('complete');
    expect(result.completions[0].receiptEvent!.aggregateVersion).toBeGreaterThan(command.expectedVersion + 1);
    expect(result.completions[0].applied?.evidence).toMatchObject({ outcome: 'no_answer', executionContextId: 'context' });
  } finally { p.unregister(); await p.runtime.dispose(); }
});
it.each([
  ['delegated_commands', 'receipt_json'], ['delegated_applied_events', 'event_json'], ['delegated_manual_outcomes', 'outcome_json'], ['campaign_versions', 'snapshot_json'],
] as const)('phone_state byte admission guards %s.%s before fetching an oversized body', async (table, column) => {
  const f = await fixture(); await f.makeBridge().begin(f.request); await reportPhone(f, 'no_answer'); allowPhoneCorruption(f);
  const row = f.db.raw.prepare(`SELECT rowid AS row_id,${column} AS body FROM ${table} ORDER BY rowid LIMIT 1`).get() as { row_id: number; body: string };
  const padded = row.body + ' '.repeat(1_048_576 - Buffer.byteLength(row.body));
  f.db.raw.prepare(`UPDATE ${table} SET ${column}=? WHERE rowid=?`).run(padded, row.row_id); const p = phoneRecoveryPublic(f);
  try {
    expect((await recoveryRead(f, p)).completeness).toBe('complete');
    f.db.raw.prepare(`UPDATE ${table} SET ${column}=? WHERE rowid=?`).run(padded + ' ', row.row_id);
    if (table === 'campaign_versions') await expect(recoveryRead(f, p)).rejects.toThrow(/^OUTREACH_REQUEST_FAILED$/);
    else expect(await recoveryRead(f, p)).toMatchObject({ completeness: 'incomplete', issue: 'source_limit' });
  } finally { p.unregister(); await p.runtime.dispose(); }
});
it('phone_state_safe_projection excludes another real enrollment and its linked prepared handoff', async () => {
  const f = await fixture(); await f.makeBridge().begin(f.request); await reportPhone(f, 'no_answer');
  const canary = 'OTHER_ENROLLMENT_PRIVATE';
  const version: import('../../src/shared/contracts/campaignContract').CampaignVersion = { id: 'other-version', campaignId: 'other-campaign', version: 1, audienceHash: 'a'.repeat(64), offer: canary, objective: 'meeting', cohortAccountIds: [f.account.id], approvedAt: null,
    steps: [{ id: 'other-step', channel: 'call', condition: 'initial', delayHours: 0 }], capScope: 'campaign_version_lifetime', channelCaps: { call: 1, email: 0, linkedin: 0 }, contentPolicyHash: 'b'.repeat(64) };
  await f.apply('campaign-command', { kind: 'campaign.version', version });
  await f.apply('campaign-command', { kind: 'campaign.approve', campaignVersionId: version.id, snapshotHash: fingerprint(version), approvedAt: now });
  await f.apply('campaign-command', { kind: 'campaign.enroll', enrollmentId: 'other-enrollment', campaignVersionId: version.id, selectedRouteId: 'route', executionContextId: 'other-context', contextRevision: 1 });
  const otherPrepare = prepareManualCommandSchema.parse({ ...f.request.command, commandId: randomUUID(), expectedVersion: f.repository.executionVersion(f.account.id), payload: { ...f.request.command.payload, actionId: 'other-action', contextRevision: 'other-context', campaign: { campaignId: version.campaignId, campaignRevision: 1, enrollmentId: 'other-enrollment', enrollmentRevision: 1, stepId: 'other-step' } } });
  await f.client.submit(otherPrepare); await f.client.sync(new AbortController().signal); expect(f.repository.commandStatus(otherPrepare.commandId)?.status).toBe('applied');
  f.repository.queueCommand(delegationCommandSchema.parse({ ...f.request.command, commandId: randomUUID(), expectedVersion: f.repository.executionVersion(f.account.id), kind: 'configure-owner', payload: { expectedConfigurationRevision: 1, configuration: { version: 1, workspaceId: f.workspaceId, accountId: f.account.id, pairingId: f.pairing.pairingId, revision: 2, state: 'paused', mailboxSubject: canary, calendarId: canary, research: null }, mailScope: null } }));
  const p = phoneRecoveryPublic(f);
  try {
    const result = await recoveryRead(f, p); expect(result.completeness).toBe('complete'); expect(result.attempts).toHaveLength(1); expect(result.completions).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(canary); expect(JSON.stringify(result)).not.toContain('other-enrollment'); expect(JSON.stringify(result)).not.toContain('other-action');
  } finally { p.unregister(); await p.runtime.dispose(); }
});

// Reviewer regressions: real producer/SQL/public fixture, synthetic crossed status only.
it.each(['prepare', 'complete'] as const)('ack_review_requested_followup_crossed_%s_uuid_is_invalid_not_pending', async kind => {
  const f = await fixture();
  let command = delegationCommandSchema.parse(f.request.command);
  if (kind === 'prepare') f.repository.queueCommand(command);
  else { await f.makeBridge().begin(f.request); f.offline(); command = await reportPhone(f, 'no_answer', false); }
  const p = phoneRecoveryPublic(f);
  try {
    const before = await recoveryRead(f, p); expect(before.completeness).toBe('complete');
    expect((kind === 'prepare' ? before.attempts[0] : before.completions[0]).receipt.status).toBe('pending');
    const version = (f.repository.executionVersion(f.account.id) ?? 0) + 1;
    const event = workerEventSchema.parse({ id: `crossed-followup-${kind}`, workspaceId: f.workspaceId, accountId: f.account.id,
      authorityGeneration: 1, aggregateVersion: version, kind: 'requested_followup.status',
      payload: { commandId: command.commandId, draftId: 'unrelated-followup-draft', status: { receipt: { commandId: command.commandId,
        status: 'applied', authorityGeneration: 1, aggregateVersion: version, reason: null }, state: 'pending_preflight', intentCommandId: null, reason: null } } });
    // Real producer rejects this crossed graph. Isolated corruption tests its persisted read boundary.
    expect(() => f.repository.applyWorkerEvent(event)).toThrow('requested_status_identity');
    f.db.raw.prepare('INSERT INTO delegated_applied_events VALUES(?,?,?,?,?,?,?,?,?)').run(event.id, event.workspaceId, event.accountId, 'execution', event.aggregateVersion, event.authorityGeneration, fingerprint(event), JSON.stringify(event), now);
    expect(f.repository.commandStatus(command.commandId)?.status).toBe('applied'); // canonical receipt classifier sees this kind
    expect(await recoveryRead(f, p)).toMatchObject({ completeness: 'incomplete', issue: 'invalid_record', attempts: [], completions: [] });
  } finally { p.unregister(); await p.runtime.dispose(); }
});
it.each(['same-account-unrelated', 'foreign-workspace-crossed'] as const)('ack_review_followup_control_%s', async mode => {
  const f = await fixture(); f.repository.queueCommand(f.request.command); const p = phoneRecoveryPublic(f);
  try {
    const before = await recoveryRead(f, p); const crossed = mode === 'foreign-workspace-crossed';
    const commandId = crossed ? f.request.command.commandId : randomUUID();
    const event = workerEventSchema.parse({ id: `followup-control-${mode}`, workspaceId: crossed ? 'foreign-workspace' : f.workspaceId, accountId: f.account.id, authorityGeneration: 1, aggregateVersion: 6, kind: 'requested_followup.status',
      payload: { commandId, draftId: 'unrelated-draft', status: { receipt: { commandId, status: 'applied', authorityGeneration: 1, aggregateVersion: 6, reason: null }, state: 'pending_preflight', intentCommandId: null, reason: null } } });
    f.db.raw.prepare('INSERT INTO delegated_applied_events VALUES(?,?,?,?,?,?,?,?,?)').run(event.id, event.workspaceId, event.accountId, 'execution', event.aggregateVersion, event.authorityGeneration, fingerprint(event), JSON.stringify(event), now);
    if (crossed) expect(await recoveryRead(f, p)).toMatchObject({ completeness: 'incomplete', issue: 'invalid_record' });
    else expect(await recoveryRead(f, p)).toEqual(before);
  } finally { p.unregister(); await p.runtime.dispose(); }
});
it('ack_review_real_stale_generation_rejection_survives_reopen', async () => {
  const f = await fixture(); await f.makeBridge().begin(f.request);
  const h = f.repository.getManualHandoff((f.db.raw.prepare('SELECT handoff_id FROM delegated_manual_handoffs').get() as { handoff_id: string }).handoff_id)!;
  expect(h.authorityGeneration).toBe(1); expect(h.consumedAt).toBe(now);
  const command = delegationCommandSchema.parse({ ...f.request.command, commandId: randomUUID(), kind: 'complete-manual', expectedAuthorityGeneration: 0,
    expectedVersion: f.repository.executionVersion(f.account.id), payload: { handoffId: h.handoffId, targetHash: h.targetHash,
      outcome: { actionId: h.actionId, channel: 'call', outcome: 'no_answer', observedAt: now, evidenceRef: 'stale-generation-human-report' } } });
  const receipt = f.repository.queueCommand(command); expect(receipt.status).toBe('rejected');
  const database = reopenPhone(f), p = phoneRecoveryPublic(f, database);
  try {
    const result = await recoveryRead(f, p, database); expect(result.completeness).toBe('complete');
    expect(result.completions).toHaveLength(1); expect(result.completions[0]).toMatchObject({ command, receipt, receiptEvent: null, applied: null });
  } finally { p.unregister(); await p.runtime.dispose(); }
});
it('ack_review_applied_completion_still_rejects_generation_older_than_original_handoff', async () => {
  const f = await fixture(); await f.makeBridge().begin(f.request); await reportPhone(f, 'no_answer'); const p = phoneRecoveryPublic(f);
  try {
    const result = await recoveryRead(f, p); expect(result.completeness).toBe('complete');
    const { delegatedPhoneStateSchema } = await import('../../src/shared/contracts/delegatedPhoneStateContract');
    expect(delegatedPhoneStateSchema.safeParse(result).success).toBe(true);
    if (result.completeness !== 'complete') throw Error('fixture'); result.completions[0].command.expectedAuthorityGeneration = 0;
    expect(delegatedPhoneStateSchema.safeParse(result).success).toBe(false);
  } finally { p.unregister(); await p.runtime.dispose(); }
});
