import { createInboundReadiness } from '../../src/main/communications/inboundReadiness';
import type { AccountCallReport, AccountOutboundReceipt } from '../../src/shared/contracts/accountOutboundContract';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountOutreach, type AccountRoutePolicyEvidence } from '../../src/main/domain/accounts/accountOutreach';
import { createAccountOutboundService } from '../../src/main/communications/accountOutboundService';
import { AccountRepository } from '../../src/main/domain/accounts/accountRepository';
import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { createTempDatabase, createTestWorkspaceKey } from '../fixtures/tempDatabase';
import { FounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { insertPerson } from '../fixtures/domainRows';
import type { HandoffResult } from '../../src/shared/contracts/outboundContract';

const now = '2026-09-08T14:00:00.000Z';
const cleanup: (() => void)[] = [];
afterEach(() => { vi.useRealTimers(); cleanup.splice(0).reverse().forEach(fn => fn()); });
async function fixture() {
  const temp = createTempDatabase(); const key = createTestWorkspaceKey();
  let db = openDatabase({ path: temp.path, key });
  cleanup.push(() => { closeDatabase(db); key.bytes.fill(0); temp.cleanup(); });
  await migrateToLatest(db, { backupDirectory: `${temp.path}.backups`, workspaceKey: key });
  const clock = { now: () => now }; const ids = { next: randomUUID };
  const makeRepo = () => new AccountRepository({ database: db, clock, ids, sourcePolicy: { attest: s => s.url === 'https://example.invalid/team' } });
  const repo = makeRepo(); const account = repo.create({ commandId: randomUUID(), name: 'Fictional PM', domain: 'example.invalid' });
  const sourceId = randomUUID(); const routeId = randomUUID();
  repo.admitEvidence({ commandId: randomUUID(), accountId: account.id, expectedVersion: 1,
    sources: [{ id: sourceId, url: 'https://example.invalid/team', fetchedAt: now, sha256: 'a'.repeat(64), excerpt: 'Business switchboard', permitted: true }], claims: [],
    routes: [{ id: routeId, accountId: account.id, personId: null, channel: 'phone', value: '+14015550100', purpose: 'business', evidenceIds: [sourceId], verification: 'published' }] });
  const snapshot = repo.snapshot(account.id, now);
  const request = { commandId: randomUUID(), accountId: account.id, routeId, expectedRouteVersion: 1, expectedEvidenceFingerprint: snapshot.fingerprint, channel: 'call' as const };
  let evidence: AccountRoutePolicyEvidence | null = { accountId: account.id, routeId, routeVersion: 1, evidenceFingerprint: snapshot.fingerprint,
    evidenceRef: 'fictional-explicit-compliance', ownerGeneration: 'fictional-owner-1', ownerEnabled: true,
    suppression: { account: false, person: false, handle: false },
    contact: { kind: 'phone', normalizedValue: '+14015550100', validationState: 'valid', evidence: { federalStatus: 'verified_clear', tcpaFlag: false, coveredAreaCode: '401', source: 'ftc_download', scrubbedAt: '2026-09-01T00:00:00.000Z', expiresAt: '2026-10-01T00:00:00.000Z' } },
    jurisdiction: { regionCode: 'RI', timezone: 'America/New_York', reviewAt: null },
    clearance: { decision: 'allowed', registrationConfirmed: true, stateDncSubscriptionConfirmed: true, consentRuleConfirmed: true, effectiveAt: '2026-09-01T00:00:00.000Z', expiresAt: '2026-10-01T00:00:00.000Z' } };
  let outreach: AccountOutreach;
  const bind = () => { outreach = new AccountOutreach({ database: db, clock, ids, accounts: makeRepo(), policy: { read: () => evidence } }); };
  bind();
  const calls: string[] = []; const subjects: unknown[] = [];
  let onReady = () => {}; let dispatchResult: () => Promise<HandoffResult> = async () => ({ status: 'handoff_accepted', reasonCode: null });
  const makeService = (overrides: Partial<Parameters<typeof createAccountOutboundService>[0]> = {}) => createAccountOutboundService({ domain: { withDomain: async fn => fn(outreach) },
    phone: { inspectCapability: async () => ({ state: 'available', reasonCode: null }), dispatch: target => {
      expect(db.raw.inTransaction).toBe(false);
      expect(db.raw.prepare('SELECT COUNT(*) AS n FROM pm_account_outbound_intents').get()).toEqual({ n: 1 });
      calls.push(target); return dispatchResult();
    } }, readiness: createInboundReadiness({ snapshot: () => ({ initialized: true, revision: 1, adapters: [{ id: 'fictional-inbound', relevant: () => true, synchronize: async subject => { subjects.push(subject); onReady(); return { revision: 'fictional-1' }; }, isAppliedCurrent: (_subject, revision) => revision === 'fictional-1' }] }) }), ...overrides });
  return { request, calls, subjects, makeService, get outreach() { return outreach; }, get db(): AppDatabase { return db; }, repo,
    setEvidence: (value: AccountRoutePolicyEvidence | null) => { evidence = value; }, get evidence() { return evidence!; },
    onReady: (fn: () => void) => { onReady = fn; }, result: (fn: () => Promise<HandoffResult>) => { dispatchResult = fn; },
    reopen: () => { closeDatabase(db); db = openDatabase({ path: temp.path, key }); bind(); } };
}
describe('real SQL company outbound workflow with fictional phone boundary', () => {
  it('commits exact intent before immediate handoff without creating a Person, and counts only user report', async () => {
    const f = await fixture(); const service = f.makeService();
    const result = await service.begin(f.request);
    expect(result.status).toBe('handoff_accepted'); expect(f.calls).toEqual(['+14015550100']);
    expect(f.subjects).toEqual([{ kind: 'account', id: f.request.accountId }]);
    expect(f.db.raw.prepare('SELECT COUNT(*) AS n FROM persons').get()).toEqual({ n: 0 });
    const range = { from: '2026-09-08T00:00:00.000Z', to: '2026-09-09T00:00:00.000Z' };
    expect(f.outreach.listActualCallAttempts(range)).toEqual([]);
    const report: AccountCallReport = { commandId: f.request.commandId, attemptId: result.attemptId!, outcome: 'no_answer' as const, notes: null };
    const receipt = await service.reportCallOutcome(report);
    expect(await service.reportCallOutcome(report)).toEqual(receipt);
    expect(f.outreach.listActualCallAttempts(range)).toEqual([{ accountId: f.request.accountId, commandId: f.request.commandId, attemptId: result.attemptId, outcome: 'no_answer', reportedAt: now }]);
    await expect(service.reportCallOutcome({ ...report, outcome: 'connected' })).rejects.toThrow(/conflict/i);
    expect(await service.begin(f.request)).toEqual(result); expect(f.calls).toHaveLength(1);
  });
  it('fails closed with no genuine company policy evidence and keeps refusal durable across reopen', async () => {
    const f = await fixture(); f.setEvidence(null); const result = await f.makeService().begin(f.request);
    expect(result).toMatchObject({ status: 'refused', reason: 'account_policy_evidence_unavailable', attemptId: null });
    f.reopen(); expect(await f.makeService().begin(f.request)).toEqual(result); expect(f.calls).toEqual([]);
  });
  it.each(['account', 'person', 'handle'] as const)('blocks %s opt-out arriving during readiness', async scope => {
    const f = await fixture(); f.onReady(() => { f.evidence.suppression[scope] = true; });
    expect(await f.makeService().begin(f.request)).toMatchObject({ status: 'refused', reason: 'account_or_route_opted_out' });
    expect(f.calls).toEqual([]);
  });
  it('blocks stale route and owner changes after async preflight', async () => {
    const f = await fixture(); f.onReady(() => { f.evidence.ownerGeneration = 'new-owner'; });
    expect(await f.makeService().begin(f.request)).toMatchObject({ reason: 'account_owner_changed' }); expect(f.calls).toEqual([]);
    const second = { ...f.request, commandId: randomUUID(), expectedRouteVersion: 2 };
    expect(await f.makeService().begin(second)).toMatchObject({ reason: 'stale_route' });
  });
  it('unknown dispatch survives encrypted reopen and never retries', async () => {
    const f = await fixture(); f.result(async () => { throw new Error('fictional uncertain handoff'); });
    const result = await f.makeService().begin(f.request); expect(result.status).toBe('unknown');
    f.reopen(); expect(await f.makeService().begin(f.request)).toEqual(result); expect(f.calls).toHaveLength(1);
  });
  it.each(['cancelled', 'not_called'] as const)('%s report is never completed-attempt evidence', async outcome => {
    const f = await fixture(); const service = f.makeService(); const result = await service.begin(f.request);
    await service.reportCallOutcome({ commandId: f.request.commandId, attemptId: result.attemptId!, outcome, notes: null });
    expect(f.outreach.listActualCallAttempts({ from: '2026-09-08T00:00:00.000Z', to: '2026-09-09T00:00:00.000Z' })).toEqual([]);
  });
  it('email execution is explicitly unavailable without invoking phone', async () => {
    const f = await fixture(); expect(await f.makeService().begin({ ...f.request, channel: 'email' })).toMatchObject({ reason: 'email_execution_unavailable' }); expect(f.calls).toEqual([]);
  });
  it('concurrent same-command requests across service instances reserve only once', async () => {
    const f = await fixture(); const results = await Promise.all([f.makeService().begin(f.request), f.makeService().begin(f.request)]);
    expect(results.map(r => r.attemptId)).toEqual([results[0].attemptId, results[0].attemptId]); expect(f.calls).toHaveLength(1);
  });
  it('default domain composition exposes account outreach but never invents company policy evidence', async () => {
    const f = await fixture(); const services = createDomainServices({ database: f.db, clock: { now: () => now }, ids: { next: randomUUID } });
    expect(services.accountOutreach).toBeDefined();
    expect(services.accountOutreach.reserve(f.request, null)).toMatchObject({ kind: 'receipt', receipt: { reason: 'account_policy_evidence_unavailable' } });
  });
  it('does not run a domain callback arriving after its gate timed out', async () => {
    const f = await fixture(); let count = 0; let late: (() => unknown) | undefined;
    const service = f.makeService({ timeoutMs: 10, domain: { withDomain: async fn => {
      if (++count === 3) return new Promise(resolve => { late = () => resolve(fn(f.outreach)); });
      return fn(f.outreach);
    } } });
    vi.useFakeTimers();
    const result = service.begin(f.request); const rejected = expect(result).rejects.toThrow(/interrupted/);
    await vi.advanceTimersByTimeAsync(11); await rejected;
    expect(late).toBeDefined(); expect(() => late!()).toThrow(/interrupted/);
    expect(f.calls).toEqual([]);
    expect(f.db.raw.prepare('SELECT COUNT(*) AS n FROM pm_account_outbound_intents').get()).toEqual({ n: 0 });
  });
  it('invalidation prevents future operations until a new runtime-bound service is constructed', async () => {
    const f = await fixture(); const service = f.makeService(); service.invalidate();
    await expect(service.begin(f.request)).rejects.toThrow(/interrupted/); expect(f.calls).toEqual([]);
  });
  it('pending intent after a crash is unknown on reopen, never dispatched again', async () => {
    const f = await fixture(); const reserved = f.outreach.reserve(f.request, 'fictional-owner-1');
    expect(reserved.kind).toBe('dispatch'); f.reopen();
    expect(await f.makeService().begin(f.request)).toMatchObject({ status: 'unknown', attemptId: reserved.receipt.attemptId }); expect(f.calls).toEqual([]);
  });
  it('rejects nested authorization so an uncommitted outer transaction can never dispatch', async () => {
    const f = await fixture(); expect(() => f.db.raw.transaction(() => f.outreach.reserve(f.request, 'fictional-owner-1'))()).toThrow(/scoped transaction/);
    expect(f.db.raw.prepare('SELECT COUNT(*) AS n FROM pm_account_outbound_intents').get()).toEqual({ n: 0 });
  });
  it('consults real normalized-handle person suppression added during readiness, not only injected policy flags', async () => {
    const f = await fixture(); const person = randomUUID(); insertPerson(f.db.raw, person);
    f.db.raw.prepare("INSERT INTO person_contact_methods(id,person_id,kind,normalized_value,validation_state,reachability,is_primary,created_at,updated_at) VALUES(?,?,'phone','+14015550100','valid','direct',1,?,?)").run(randomUUID(), person, now, now);
    const services = createDomainServices({ database: f.db, clock: { now: () => now }, ids: { next: randomUUID } });
    f.onReady(() => { services.optOut.apply({ personId: person, tombstoneId: randomUUID(), requestedAt: now,
      policyVersion: 'founder_opt_out_v1', decision: { kind: 'structured_written', channel: 'imessage' },
      evidence: { kind: 'append_activity', activity: { id: randomUUID(), personId: person, kind: 'text', direction: 'inbound', channel: 'imessage', occurredAt: now,
        observedOutcome: 'opted_out', adapter: 'messages', providerIdempotencyKey: randomUUID(), metadata: { structuredOptOut: true } } }, terminalStageEventId: null }); });
    expect(await f.makeService().begin(f.request)).toMatchObject({ reason: 'account_or_route_opted_out' }); expect(f.calls).toEqual([]);
  });
  it('rejects changed command payload and invented attempt outcomes across reopen', async () => {
    const f = await fixture(); const service = f.makeService(); const receipt = await service.begin(f.request); f.reopen();
    await expect(f.makeService().begin({ ...f.request, expectedRouteVersion: 9 })).rejects.toThrow(/conflict/);
    await expect(f.makeService().reportCallOutcome({ commandId: f.request.commandId, attemptId: randomUUID(), outcome: 'connected', notes: null })).rejects.toThrow(/not found/);
    expect(receipt.attemptId).not.toBeNull(); expect(f.calls).toHaveLength(1);
  });

  it.each(['unattempted', 'refused', 'unavailable'] as const)('will not admit a call report for %s dispatch', async status => {
    const f = await fixture(); const reserved = f.outreach.reserve(f.request, 'fictional-owner-1');
    if (status !== 'unattempted') f.outreach.recordDispatch(f.request, { status, reasonCode: 'phone_route_unverified' });
    expect(() => f.outreach.reportCallOutcome({ commandId: f.request.commandId, attemptId: reserved.receipt.attemptId!, outcome: 'connected', notes: null })).toThrow(/not attempted/);
  });

  it('facade delegates stay account-scoped and fail closed without the policy binding', async () => {
    const f = await fixture(); const input = { database: f.db, clock: { now: () => now }, ids: { next: randomUUID } };
    const domain = new FounderSalesDomain({ ...input, services: createDomainServices(input) });
    expect(domain.inspectAccountOutboundCommand(f.request)).toBeNull();
    expect(domain.getAccountOutboundOwnerGeneration(f.request)).toBeNull();
    const prepared = domain.prepareAccountOutboundDispatch(f.request, null);
    expect(prepared).toMatchObject({ kind: 'receipt', receipt: { reason: 'account_policy_evidence_unavailable' } });
    expect(domain.recordAccountOutboundRefusal(f.request, 'other')).toEqual(prepared.receipt);
    expect(() => domain.recordAccountOutboundResult(f.request, { status: 'unknown', reasonCode: 'handoff_uncertain' })).toThrow(/missing/);
    expect(() => domain.reportAccountCallOutcome({ commandId: f.request.commandId, attemptId: randomUUID(), outcome: 'connected', notes: null })).toThrow(/not found/);
    expect(domain.listActualCallAttempts({ from: '2026-09-08T00:00:00.000Z', to: '2026-09-09T00:00:00.000Z' })).toEqual([]);
  });

  it('registers the idempotent flight before a scoped gate can reenter begin', async () => {
    const f = await fixture(); let reentered = false; let duplicate: Promise<AccountOutboundReceipt> | undefined;
    const service = f.makeService({ domain: { withDomain: async fn => {
      if (!reentered) { reentered = true; duplicate = service.begin(f.request); }
      return fn(f.outreach);
    } } });
    const first = service.begin(f.request); await first;
    expect(duplicate).toBe(first); expect(f.calls).toHaveLength(1);
  });
  it('does not dispatch if invalidated synchronously after reservation commits', async () => {
    const f = await fixture(); const service = f.makeService({ domain: { withDomain: async fn => fn({
      inspect: request => f.outreach.inspect(request), ownerGeneration: request => f.outreach.ownerGeneration(request),
      recordRefusal: (request, reason) => f.outreach.recordRefusal(request, reason),
      reserve: (request, owner) => { const reserved = f.outreach.reserve(request, owner); service.invalidate(); return reserved; },
      recordDispatch: (request, result) => f.outreach.recordDispatch(request, result), reportCallOutcome: report => f.outreach.reportCallOutcome(report),
    }) } });
    expect(await service.begin(f.request)).toMatchObject({ status: 'unknown' }); expect(f.calls).toEqual([]);
    f.reopen(); expect(await f.makeService().begin(f.request)).toMatchObject({ status: 'unknown' });
  });
  it('returns durable unknown rather than retry when result persistence fails after dispatch', async () => {
    const f = await fixture(); const service = f.makeService({ domain: { withDomain: async fn => fn({
      inspect: request => f.outreach.inspect(request), ownerGeneration: request => f.outreach.ownerGeneration(request),
      recordRefusal: (request, reason) => f.outreach.recordRefusal(request, reason), reserve: (request, owner) => f.outreach.reserve(request, owner),
      recordDispatch: () => { throw new Error('fictional disk failure'); }, reportCallOutcome: report => f.outreach.reportCallOutcome(report),
    }) } });
    expect(await service.begin(f.request)).toMatchObject({ status: 'unknown' }); expect(f.calls).toHaveLength(1);
    f.reopen(); expect(await f.makeService().begin(f.request)).toMatchObject({ status: 'unknown' }); expect(f.calls).toHaveLength(1);
  });

  it.each(['route', 'evidence'] as const)('rechecks actual SQL %s changes arriving during readiness', async change => {
    const f = await fixture(); const snapshot = f.repo.snapshot(f.request.accountId, now);
    f.onReady(() => { f.repo.admitEvidence({ commandId: randomUUID(), accountId: f.request.accountId, expectedVersion: snapshot.account.version,
      sources: [], claims: change === 'evidence' ? [{ kind: 'fact', key: 'operating_footprint', value: 'Fictional region', evidenceIds: snapshot.routes[0].evidenceIds }] : [],
      routes: change === 'route' ? [{ id: snapshot.routes[0].id, accountId: f.request.accountId, personId: null, channel: 'phone', value: '+14015550101', purpose: 'business', verification: 'published', evidenceIds: snapshot.routes[0].evidenceIds }] : [] }); });
    expect(await f.makeService().begin(f.request)).toMatchObject({ reason: change === 'route' ? 'stale_route' : 'stale_evidence' }); expect(f.calls).toEqual([]);
  });
  it('timeout after dispatch persists unknown and ignores a late accepted reply', async () => {
    const f = await fixture(); let finish: (value: HandoffResult) => void;
    f.result(() => new Promise(resolve => { finish = resolve; })); vi.useFakeTimers();
    const result = f.makeService({ timeoutMs: 10 }).begin(f.request);
    await vi.advanceTimersByTimeAsync(11); expect(await result).toMatchObject({ status: 'unknown' });
    finish!({ status: 'handoff_accepted', reasonCode: null }); await vi.advanceTimersByTimeAsync(0);
    expect(f.outreach.inspect(f.request)).toMatchObject({ status: 'unknown' }); expect(f.calls).toHaveLength(1);
  });
  it('unknown handoff counts only after an explicit actual user report and report replay survives reopen', async () => {
    const f = await fixture(); f.result(async () => ({ status: 'unknown', reasonCode: 'handoff_uncertain' })); const service = f.makeService();
    const result = await service.begin(f.request); const report: AccountCallReport = { commandId: f.request.commandId, attemptId: result.attemptId!, outcome: 'connected', notes: 'Fictional user confirms the call occurred.' };
    const range = { from: now, to: '2026-09-09T00:00:00.000Z' }; expect(f.outreach.listActualCallAttempts(range)).toEqual([]);
    const receipt = await service.reportCallOutcome(report); f.reopen(); expect(await f.makeService().reportCallOutcome(report)).toEqual(receipt);
    expect(f.outreach.listActualCallAttempts(range)).toHaveLength(1);
    expect(f.outreach.listActualCallAttempts({ from: '2026-09-08T00:00:00.000Z', to: now })).toEqual([]);
  });

  it('captures one immutable runtime gate rather than following caller replacement', async () => {
    const f = await fixture(); const options: Parameters<typeof createAccountOutboundService>[0] = {
      domain: { withDomain: async fn => fn(f.outreach) },
      phone: { inspectCapability: async () => ({ state: 'unavailable', reasonCode: 'phone_route_unverified' }), dispatch: async () => { throw new Error('Must never dispatch'); } },
      readiness: createInboundReadiness({ snapshot: () => ({ initialized: true, revision: 1, adapters: [] }) }),
    };
    const service = createAccountOutboundService(options);
    options.domain = { withDomain: async () => { throw new Error('Wrong runtime'); } };
    expect(await service.begin(f.request)).toMatchObject({ reason: 'phone_route_unverified' });
  });

  it.each(['registry', 'checkpoint'] as const)('refuses changed inbound %s proof after the domain gate was queued', async change => {
    const f = await fixture(); let registryRevision = 1; let checkpoint = 'one'; let count = 0;
    let release: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let queued: () => void; const reached = new Promise<void>(resolve => { queued = resolve; });
    const readiness = createInboundReadiness({ snapshot: () => ({ initialized: true, revision: registryRevision, adapters: [{ id: 'fictional', relevant: () => true,
      synchronize: async () => ({ revision: checkpoint }), isAppliedCurrent: (_subject, revision) => revision === checkpoint }] }) });
    const service = f.makeService({ readiness, domain: { withDomain: async fn => {
      if (++count === 3) { queued!(); await held; }
      return fn(f.outreach);
    } } });
    const pending = service.begin(f.request); await reached;
    if (change === 'registry') registryRevision++; else checkpoint = 'two';
    release!(); expect(await pending).toMatchObject({ reason: 'inbound_safety_unwired', attemptId: null });
    expect(f.calls).toEqual([]); expect(f.db.raw.prepare('SELECT COUNT(*) AS n FROM pm_account_outbound_intents').get()).toEqual({ n: 0 });
  });

});
