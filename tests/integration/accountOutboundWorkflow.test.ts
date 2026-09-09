import { AccountRoutePolicyStore, type RoutePolicyReceipt } from '../../src/main/delegation/accountRoutePolicyStore';
import { DelegationRepository } from '../../src/main/delegation/delegationRepository';
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
async function fixture(sqlPolicy = false) {
  const temp = createTempDatabase(); const key = createTestWorkspaceKey();
  let db = openDatabase({ path: temp.path, key });
  cleanup.push(() => { closeDatabase(db); key.bytes.fill(0); temp.cleanup(); });
  await migrateToLatest(db, { backupDirectory: `${temp.path}.backups`, workspaceKey: key });
  let clockNow = now; const clock = { now: () => clockNow }; const ids = { next: randomUUID };
  const makeRepo = () => new AccountRepository({ database: db, clock, ids, sourcePolicy: { attest: s => s.url === 'https://example.invalid/team' } });
  const repo = makeRepo(); const account = repo.create({ commandId: randomUUID(), name: 'Fictional PM', domain: 'example.invalid' });
  const sourceId = randomUUID(); const routeId = randomUUID(); const policySourceId = randomUUID(); const provenance = randomUUID(); const workspaceId = randomUUID();
  repo.admitEvidence({ commandId: randomUUID(), accountId: account.id, expectedVersion: 1,
    sources: [{ id: sourceId, url: 'https://example.invalid/team', fetchedAt: now, sha256: 'a'.repeat(64), excerpt: 'Business switchboard', permitted: true }, ...(sqlPolicy ? [{ id: policySourceId, url: 'https://example.invalid/team', fetchedAt: now, sha256: 'b'.repeat(64), excerpt: 'Fictional separately attested validation, federal scrub and recipient jurisdiction clearance record.', permitted: true }] : [])], claims: [],
    routes: [{ id: routeId, accountId: account.id, personId: null, channel: 'phone', value: '+14015550100', purpose: 'business', evidenceIds: sqlPolicy ? [sourceId, policySourceId] : [sourceId], verification: 'published' }] });
  const snapshot = repo.snapshot(account.id, now);
  const request = { commandId: randomUUID(), accountId: account.id, routeId, expectedRouteVersion: 1, expectedEvidenceFingerprint: snapshot.fingerprint, channel: 'call' as const };
  let evidence: AccountRoutePolicyEvidence | null = { accountId: account.id, routeId, routeVersion: 1, evidenceFingerprint: snapshot.fingerprint,
    evidenceRef: 'fictional-explicit-compliance', ownerGeneration: 'fictional-owner-1', ownerEnabled: true,
    suppression: { account: false, person: false, handle: false },
    contact: { kind: 'phone', normalizedValue: '+14015550100', validationState: 'valid', evidence: { federalStatus: 'verified_clear', tcpaFlag: false, coveredAreaCode: '401', source: 'ftc_download', scrubbedAt: '2026-09-01T00:00:00.000Z', expiresAt: '2026-10-01T00:00:00.000Z' } },
    jurisdiction: { regionCode: 'RI', timezone: 'America/New_York', reviewAt: null },
    clearance: { decision: 'allowed', registrationConfirmed: true, stateDncSubscriptionConfirmed: true, consentRuleConfirmed: true, effectiveAt: '2026-09-01T00:00:00.000Z', expiresAt: '2026-10-01T00:00:00.000Z' } };
  let outreach: AccountOutreach;
  const bind = () => { outreach = sqlPolicy ? createDomainServices({ database: db, clock, ids }).accountOutreach : new AccountOutreach({ database: db, clock, ids, accounts: makeRepo(), policy: { read: () => evidence } }); };
  bind();
  const calls: string[] = []; const subjects: unknown[] = [];
  let onReady = () => {}; let dispatchResult: () => Promise<HandoffResult> = async () => ({ status: 'handoff_accepted', reasonCode: null });
  const makeService = (overrides: Partial<Parameters<typeof createAccountOutboundService>[0]> = {}) => createAccountOutboundService({ domain: { withDomain: async fn => fn(outreach) },
    phone: { inspectCapability: async () => ({ state: 'available', reasonCode: null }), dispatch: target => {
      expect(db.raw.inTransaction).toBe(false);
      expect(db.raw.prepare('SELECT COUNT(*) AS n FROM pm_account_outbound_intents').get()).toEqual({ n: 1 });
      calls.push(target); return dispatchResult();
    } }, readiness: createInboundReadiness({ snapshot: () => ({ initialized: true, revision: 1, adapters: [{ id: 'fictional-inbound', relevant: () => true, synchronize: async subject => { subjects.push(subject); onReady(); return { revision: 'fictional-1' }; }, isAppliedCurrent: (_subject, revision) => revision === 'fictional-1' }] }) }), ...overrides });
  const policyReceipt = (overrides: Partial<RoutePolicyReceipt> = {}): RoutePolicyReceipt => ({ id: randomUUID(), accountId: account.id, routeId, routeVersion: 1,
    canonicalTarget: '+14015550100', evidenceFingerprint: snapshot.fingerprint, revision: 1, evidenceRef: policySourceId,
    evidenceIds: [policySourceId], provenance, observedAt: now, effectiveAt: now, expiresAt: '2026-09-09T14:00:00.000Z',
    policy: { contact: evidence!.contact, jurisdiction: evidence!.jurisdiction, clearance: evidence!.clearance }, ...overrides });
  const admitPolicy = (overrides: Partial<RoutePolicyReceipt> = {}) => {
    const receipt = policyReceipt(overrides);
    new AccountRoutePolicyStore({ database: db, clock, admission: { attest: value => value.provenance === provenance && value.evidenceRef === policySourceId } }).admit(receipt);
    return receipt;
  };
  return { request, calls, subjects, makeService, admitPolicy, policyReceipt, setTime: (value: string) => { clockNow = value; },
    initializeOwner: () => new DelegationRepository({ database: db, clock, workspaceId }).initializeLocalAuthority(account.id),
    secondConnection: () => { const other = openDatabase({ path: temp.path, key }); cleanup.push(() => closeDatabase(other)); return other; }, get outreach() { return outreach; }, get db(): AppDatabase { return db; }, repo,
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

  it.each(['dnc', 'tcpa'] as const)('does not downgrade existing normalized-handle %s restrictions with company policy', async restriction => {
    const f = await fixture(); const person = randomUUID(); const contact = randomUUID(); insertPerson(f.db.raw, person);
    f.db.raw.prepare("INSERT INTO person_contact_methods(id,person_id,kind,normalized_value,validation_state,reachability,is_primary,created_at,updated_at) VALUES(?,?,'phone','+14015550100','valid','direct',1,?,?)").run(contact, person, now, now);
    f.onReady(() => {
      if (restriction === 'dnc') f.db.raw.prepare("UPDATE person_contact_methods SET dnc_listed=1,federal_status='listed' WHERE id=?").run(contact);
      else f.db.raw.prepare('UPDATE person_contact_methods SET tcpa_flag=1,compliance_tcpa_flag=1 WHERE id=?').run(contact);
    });
    expect(await f.makeService().begin(f.request)).toMatchObject({ reason: restriction === 'dnc' ? 'federal_dnc_listed' : 'tcpa_blocked' }); expect(f.calls).toEqual([]);
  });

});


describe('schema21 production SQL policy binding with fictional admitted evidence and phone', () => {
  it('requires separate admitted compliance and explicit local owner, then dispatches account-only', async () => {
    const f = await fixture(true);
    expect(await f.makeService().begin(f.request)).toMatchObject({ reason: 'account_policy_evidence_unavailable' });
    const receipt = f.admitPolicy(); f.initializeOwner();
    const request = { ...f.request, commandId: randomUUID() }; const result = await f.makeService().begin(request);
    expect(result.status).toBe('handoff_accepted'); expect(f.calls).toEqual(['+14015550100']);
    expect(f.db.raw.prepare('SELECT COUNT(*) AS n FROM persons').get()).toEqual({ n: 0 });
    expect(f.db.raw.prepare('SELECT route_version,evidence_fingerprint,canonical_target FROM pm_account_outbound_intents WHERE command_id=?').get(request.commandId))
      .toEqual({ route_version: receipt.routeVersion, evidence_fingerprint: receipt.evidenceFingerprint, canonical_target: receipt.canonicalTarget });
  });
  it('does not admit policy without the trusted evidence attestation boundary', async () => {
    const f = await fixture(true); f.initializeOwner();
    expect(() => new AccountRoutePolicyStore({ database: f.db, clock: { now: () => now } }).admit(f.policyReceipt())).toThrow(/attestation/);
    expect(await f.makeService().begin(f.request)).toMatchObject({ reason: 'account_policy_evidence_unavailable' }); expect(f.calls).toEqual([]);
  });
  it.each(['missing', 'worker', 'delegating', 'paused', 'revoked'] as const)('rejects %s execution authority instead of assuming local clearance', async state => {
    const f = await fixture(true); f.admitPolicy();
    if (state !== 'missing') { f.initializeOwner(); f.db.raw.prepare('UPDATE delegated_authorities SET owner=?,state=? WHERE account_id=?').run(state === 'worker' ? 'worker' : 'local', state === 'worker' ? 'active' : state, f.request.accountId); }
    expect((await f.makeService().begin(f.request)).status).toBe('refused'); expect(f.calls).toEqual([]);
  });
  it('rechecks owner generation from a second SQL connection after readiness', async () => {
    const f = await fixture(true); f.admitPolicy(); f.initializeOwner(); const other = f.secondConnection();
    f.onReady(() => { other.raw.prepare('UPDATE delegated_authorities SET generation=generation+1 WHERE account_id=?').run(f.request.accountId); });
    expect(await f.makeService().begin(f.request)).toMatchObject({ reason: 'account_owner_changed' }); expect(f.calls).toEqual([]);
  });
  it.each(['account', 'handle'] as const)('rechecks durable %s suppression committed by a second SQL connection', async scope => {
    const f = await fixture(true); f.admitPolicy(); f.initializeOwner(); const other = f.secondConnection();
    f.onReady(() => {
      if (scope === 'account') other.raw.prepare('INSERT INTO pm_account_suppression_tombstones(id,account_id,observed_at,source,evidence_ref,admitted_at) VALUES(?,?,?,?,?,?)')
        .run(randomUUID(), f.request.accountId, now, 'fictional-user-report', randomUUID(), now);
      else other.raw.prepare('INSERT INTO pm_handle_suppression_tombstones(id,kind,normalized_value,observed_at,source,evidence_ref,admitted_at) VALUES(?,?,?,?,?,?,?)')
        .run(randomUUID(), 'phone', '+14015550100', now, 'fictional-user-report', randomUUID(), now);
    });
    expect(await f.makeService().begin(f.request)).toMatchObject({ reason: 'account_or_route_opted_out' }); expect(f.calls).toEqual([]);
  });
  it('requires the latest unexpired policy revision, never falls back to earlier clearance', async () => {
    const f = await fixture(true); f.initializeOwner(); f.admitPolicy();
    f.admitPolicy({ revision: 2, expiresAt: '2026-09-08T15:00:00.000Z', policy: { ...f.policyReceipt().policy, clearance: { ...f.policyReceipt().policy.clearance!, decision: 'blocked' } } });
    expect(await f.makeService().begin(f.request)).toMatchObject({ reason: 'jurisdiction_blocked' }); expect(f.calls).toEqual([]);
    f.setTime('2026-09-08T15:00:00.000Z');
    expect(await f.makeService().begin({ ...f.request, commandId: randomUUID() })).toMatchObject({ reason: 'account_policy_evidence_unavailable' });
  });
  it('rejects a receipt bound to an older account evidence fingerprint even with unchanged route', async () => {
    const f = await fixture(true); f.initializeOwner(); f.admitPolicy(); const before = f.repo.snapshot(f.request.accountId, now);
    f.repo.admitEvidence({ commandId: randomUUID(), accountId: f.request.accountId, expectedVersion: before.account.version, sources: [], routes: [],
      claims: [{ kind: 'fact', key: 'operating_footprint', value: 'Fictional changed territory', evidenceIds: before.routes[0].evidenceIds }] });
    const latest = f.repo.snapshot(f.request.accountId, now);
    expect(await f.makeService().begin({ ...f.request, expectedEvidenceFingerprint: latest.fingerprint })).toMatchObject({ reason: 'account_policy_evidence_unavailable' }); expect(f.calls).toEqual([]);
  });
  it('persists real-policy unknown dispatch and explicit attempt evidence across encrypted restart without retry', async () => {
    const f = await fixture(true); f.initializeOwner(); f.admitPolicy(); f.result(async () => { throw new Error('Fictional uncertain phone'); });
    const result = await f.makeService().begin(f.request); expect(result.status).toBe('unknown');
    const report: AccountCallReport = { commandId: f.request.commandId, attemptId: result.attemptId!, outcome: 'no_answer', notes: null };
    const outcome = await f.makeService().reportCallOutcome(report); f.reopen();
    expect(await f.makeService().begin(f.request)).toEqual(result); expect(await f.makeService().reportCallOutcome(report)).toEqual(outcome);
    expect(f.outreach.listActualCallAttempts({ from: now, to: '2026-09-09T00:00:00.000Z' })).toHaveLength(1); expect(f.calls).toHaveLength(1);
  });
  it('rechecks a newly admitted restrictive policy revision after readiness', async () => {
    const f = await fixture(true); f.initializeOwner(); f.admitPolicy();
    f.onReady(() => { const policy = f.policyReceipt().policy;
      f.admitPolicy({ revision: 2, policy: { ...policy, contact: { ...policy.contact, evidence: { ...policy.contact.evidence, federalStatus: 'listed' } } } }); });
    expect(await f.makeService().begin(f.request)).toMatchObject({ reason: 'federal_dnc_listed' }); expect(f.calls).toEqual([]);
  });
  it.each(['validation', 'jurisdiction', 'local_time', 'email'] as const)('preserves %s refusal with durable policy evidence', async constraint => {
    const f = await fixture(true); f.initializeOwner(); const policy = f.policyReceipt().policy;
    if (constraint === 'validation') policy.contact.validationState = 'unverified';
    if (constraint === 'jurisdiction') policy.jurisdiction = null;
    f.admitPolicy({ policy });
    if (constraint === 'local_time') f.setTime('2026-09-08T23:00:00.000Z');
    const reason = { validation: 'contact_validation_unusable', jurisdiction: 'jurisdiction_unknown', local_time: 'outside_recipient_window', email: 'email_execution_unavailable' }[constraint];
    expect(await f.makeService().begin({ ...f.request, channel: constraint === 'email' ? 'email' : 'call' })).toMatchObject({ reason }); expect(f.calls).toEqual([]);
  });
  it('honors a genuine opted-out linked person without fabricating route person identity', async () => {
    const f = await fixture(true); const person = randomUUID(); insertPerson(f.db.raw, person);
    const snapshot = f.repo.snapshot(f.request.accountId, now);
    f.repo.admitLinks({ commandId: randomUUID(), accountId: f.request.accountId, expectedVersion: snapshot.account.version,
      links: [{ id: randomUUID(), kind: 'person_role', personId: person, role: 'Office contact', authority: 'unconfirmed', authorityEvidenceIds: [],
        relationship: 'Fictional office contact', evidenceIds: snapshot.routes[0].evidenceIds, validFrom: now, validTo: null }] });
    const current = f.repo.snapshot(f.request.accountId, now); f.request.expectedEvidenceFingerprint = current.fingerprint;
    f.admitPolicy({ evidenceFingerprint: current.fingerprint }); f.initializeOwner();
    const services = createDomainServices({ database: f.db, clock: { now: () => now }, ids: { next: randomUUID } });
    f.onReady(() => { services.optOut.apply({ personId: person, tombstoneId: randomUUID(), requestedAt: now, policyVersion: 'founder_opt_out_v1',
      decision: { kind: 'structured_written', channel: 'imessage' }, evidence: { kind: 'append_activity', activity: { id: randomUUID(), personId: person,
        kind: 'text', direction: 'inbound', channel: 'imessage', occurredAt: now, observedOutcome: 'opted_out', adapter: 'messages',
        providerIdempotencyKey: randomUUID(), metadata: { structuredOptOut: true } } }, terminalStageEventId: null }); });
    expect(await f.makeService().begin(f.request)).toMatchObject({ reason: 'account_or_route_opted_out' }); expect(f.calls).toEqual([]);
    expect(current.routes[0].personId).toBeNull();
  });
  it('two real SQL connections racing the same command reserve and hand off only once', async () => {
    const f = await fixture(true); f.admitPolicy(); f.initializeOwner(); const other = f.secondConnection();
    const secondDomain = createDomainServices({ database: other, clock: { now: () => now }, ids: { next: randomUUID } }).accountOutreach;
    const first = f.makeService(); const second = f.makeService({ domain: { withDomain: async fn => fn(secondDomain) } });
    const receipts = await Promise.all([first.begin(f.request), second.begin(f.request)]);
    expect(receipts[0].attemptId).toBe(receipts[1].attemptId); expect(f.calls).toHaveLength(1);
    expect(other.raw.prepare('SELECT COUNT(*) AS n FROM pm_account_outbound_intents').get()).toEqual({ n: 1 });
  });

  it('does not count an orphan user-report envelope without any dispatch evidence', async () => {
    const f = await fixture(true); f.admitPolicy(); f.initializeOwner();
    const reserved = f.outreach.reserve(f.request, f.outreach.ownerGeneration(f.request));
    f.db.raw.prepare("INSERT INTO pm_account_outbound_results(id,command_id,attempt_id,account_id,kind,outcome,result_json,created_at) VALUES(?,?,?,?,'call_outcome','connected',?,?)")
      .run(randomUUID(), f.request.commandId, reserved.receipt.attemptId, f.request.accountId, JSON.stringify({ version: 1, source: 'user_report', outcome: 'connected', notes: null }), now);
    expect(f.outreach.listActualCallAttempts({ from: now, to: '2026-09-09T00:00:00.000Z' })).toEqual([]);
  });

});
