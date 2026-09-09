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
import { delegationCommandSchema } from '../../src/shared/contracts/delegationContract';
import { createSqlAccountRoutePolicy, authorizeAccountRoute } from '../../src/main/domain/accounts/accountOutreach';
import { PLAYBOOK_CHANNEL_POLICIES_V2 } from '../../src/main/domain/cadence/cadenceScheduler';

const cleanups: (() => void)[] = [];
beforeEach(() => vi.stubGlobal('fetch', () => Promise.reject(new Error('Unconfigured network forbidden'))));
afterEach(() => { try { cleanups.splice(0).reverse().forEach(fn => fn()); } finally { vi.unstubAllGlobals(); } });
const now = '2026-09-08T14:00:00.000Z';
async function fixture(admitPolicy = true) {
  const local = await createPmFixture(); cleanups.push(local.close);
  let at = now; const clock = { now: () => at }; const workspaceId = randomUUID();
  const repo = new AccountRepository({ database: local.db, clock, ids: { next: randomUUID }, sourcePolicy: { attest: s => s.url === 'https://example.invalid/team' } });
  const account = repo.create({ commandId: randomUUID(), name: 'Fictional Phone PM', domain: null });
  repo.admitEvidence({ commandId: randomUUID(), accountId: account.id, expectedVersion: 1, claims: [],
    sources: [{ id: 'source', url: 'https://example.invalid/team', fetchedAt: now, sha256: 'a'.repeat(64), excerpt: 'Fictional switchboard and separately attested compliance evidence', permitted: true }],
    routes: [{ id: 'route', accountId: account.id, personId: null, channel: 'phone', value: '+14015550100', purpose: 'business', evidenceIds: ['source'], verification: 'published' }] });
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
    setTime: (value: string) => { at = value; }, offline: () => { offline = true; }, onReady: (fn: () => void) => { readyHook = fn; }, unavailable: () => { capability = false; }, onDispatch: (fn: () => void) => { dispatchHook = fn; },
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
      expect(policy?.ownerEnabled).toBe(false);
      return authorizeAccountRoute({ request: { commandId: randomUUID(), accountId: f.account.id, routeId: 'route', expectedRouteVersion: 1, expectedEvidenceFingerprint: f.snapshot.fingerprint, channel: 'call' }, route: f.snapshot.routes[0], evidenceFingerprint: f.snapshot.fingerprint, policy, expectedOwnerGeneration: policy?.ownerGeneration ?? null, now, windows: PLAYBOOK_CHANNEL_POLICIES_V2 });
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
