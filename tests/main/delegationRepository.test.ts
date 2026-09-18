import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPmFixture, PM_NOW } from '../fixtures/pmAccounts';

describe('C1 encrypted migration', () => {
  it('adds explicit authority and immutable delegation ledgers without granting researched accounts authority', async () => {
    const f = await createPmFixture();
    try {
      f.repo.create({ commandId: randomUUID(), name: 'Fictional PM', domain: null });
      expect(f.db.raw.prepare('SELECT schema_version FROM app_meta').get()).toEqual({ schema_version: 29 });
      expect(f.db.raw.prepare('SELECT * FROM delegated_authorities').all()).toEqual([]);
      expect(f.db.raw.prepare('SELECT * FROM persons ORDER BY id').all()).toEqual(f.historicalPersons);
    } finally { f.close(); }
  });
});

import { DelegationRepository } from '../../src/main/delegation/delegationRepository';
import { delegationCommandSchema, workerEventSchema, type DelegationCommand, type WorkerEvent, type CommandReceipt } from '../../src/shared/contracts/delegationContract';
import { closeDatabase, openDatabase } from '../../src/main/db/database';
import { createTestWorkspaceKey, createTempDatabase } from '../fixtures/tempDatabase';
const workspaceId = 'fictional-workspace';
function local(f: Awaited<ReturnType<typeof createPmFixture>>) {
  return new DelegationRepository({ database: f.db, workspaceId, clock: { now: () => PM_NOW } });
}
function pause(accountId: string): Extract<DelegationCommand, { kind: 'pause' }> {
  return { commandId: randomUUID(), workspaceId, accountId, expectedAuthorityGeneration: 0, expectedVersion: 0, kind: 'pause', payload: { reason: 'Operator pause' } };
}
function changed(command: DelegationCommand): WorkerEvent {
  return { id: randomUUID(), workspaceId, accountId: command.accountId, authorityGeneration: 1, aggregateVersion: 1, kind: 'authority.changed',
    payload: { authority: { accountId: command.accountId, owner: 'worker', generation: 1, state: 'active' },
      receipt: { commandId: command.commandId, status: 'applied', authorityGeneration: 1, aggregateVersion: 1, reason: null } } };
}
it('rejects unknown keys/kinds and research account/generation forgery at the strict wire boundary', () => {
  const command = pause('a');
  expect(delegationCommandSchema.safeParse({ ...command, code: 'execute' }).success).toBe(false);
  expect(delegationCommandSchema.safeParse({ ...command, payload: { reason: 'pause', grant: true } }).success).toBe(false);
  expect(delegationCommandSchema.safeParse({ ...command, kind: 'execute-json' }).success).toBe(false);
  const event = { id: 'event', workspaceId, accountId: 'a', aggregateVersion: 1, authorityGeneration: 0,
    kind: 'research.created', payload: { account: { id: 'b', name: 'PM', domain: null as string | null, version: 1 }, createdAt: PM_NOW } };
  expect(workerEventSchema.safeParse(event).success).toBe(false);
  expect(workerEventSchema.safeParse({ ...event, accountId: 'b', authorityGeneration: 1 }).success).toBe(false);
});
it('durably replays pending commands, conflicts on changed payload and never treats pending as confirmed pause', async () => {
  const f = await createPmFixture();
  try {
    const account = f.repo.create({ commandId: randomUUID(), name: 'Fictional PM', domain: null });
    const repo = local(f); repo.initializeLocalAuthority(account.id);
    const command = pause(account.id);
    const receipt = repo.queueCommand(command);
    expect(receipt).toMatchObject({ status: 'pending', authorityGeneration: 0, aggregateVersion: 0 });
    expect(repo.queueCommand(command)).toEqual(receipt);
    expect(() => repo.queueCommand({ ...command, payload: { reason: 'Different' } } as DelegationCommand)).toThrow(/conflict/i);
    expect(repo.authority(account.id)).toMatchObject({ owner: 'local', state: 'local', generation: 0 });
    closeDatabase(f.db);
    const reopened = openDatabase({ path: f.db.path, key: createTestWorkspaceKey() });
    try { expect(new DelegationRepository({ database: reopened, workspaceId, clock: { now: () => PM_NOW } }).queueCommand(command)).toEqual(receipt); }
    finally { closeDatabase(reopened); }
  } finally { f.close(); }
});
it('applies ordered events atomically once, preserves cursor on gaps, fences stale commands and rejects changed event replay', async () => {
  const f = await createPmFixture();
  try {
    const account = f.repo.create({ commandId: randomUUID(), name: 'Fictional PM', domain: null });
    const repo = local(f); repo.initializeLocalAuthority(account.id);
    const command: DelegationCommand = { ...pause(account.id), kind: 'delegate', payload: { delegationId: 'approved-delegation', approvedAt: PM_NOW } };
    repo.queueCommand(command); expect(repo.authority(account.id)).toMatchObject({ state: 'delegating' }); const event = changed(command);
    expect(repo.applyWorkerEvent(event)).toBe('applied');
    expect(repo.applyWorkerEvent(event)).toBe('duplicate');
    expect(repo.applyWorkerEvent({ ...event, id: 'later', aggregateVersion: 3, payload: { ...event.payload,
      receipt: { ...(event as Extract<WorkerEvent, { kind: 'authority.changed' }>).payload.receipt, aggregateVersion: 3 } } } as WorkerEvent)).toBe('gap');
    expect(f.db.raw.prepare('SELECT aggregate_version FROM delegated_event_cursors').all()).toEqual([{ aggregate_version: 1 }]);
    expect(f.db.raw.prepare('SELECT id FROM delegated_applied_events').all()).toEqual([{ id: event.id }]);
    expect(repo.queueCommand({ ...command, commandId: 'stale' })).toMatchObject({ status: 'rejected' });
    expect(() => repo.applyWorkerEvent({ ...event, workspaceId: 'other' })).toThrow(/workspace/i);
    expect(() => repo.applyWorkerEvent({ ...event, payload: { ...event.payload, receipt: { ...(event as Extract<WorkerEvent, { kind: 'authority.changed' }>).payload.receipt, reason: 'changed' } } } as WorkerEvent)).toThrow(/conflict/i);
  } finally { f.close(); }
});
it('projects research-created accounts with a separate revision and no outbound authority or fabricated people', async () => {
  const f = await createPmFixture();
  try {
    const repo = local(f);
    const event: WorkerEvent = { id: randomUUID(), workspaceId, accountId: 'remote-account', authorityGeneration: 0, aggregateVersion: 1,
      kind: 'research.created', payload: { account: { id: 'remote-account', name: 'Remote Fictional PM', domain: null, version: 1 }, createdAt: PM_NOW } };
    expect(repo.applyWorkerEvent(event)).toBe('applied');
    expect(repo.applyWorkerEvent(event)).toBe('duplicate');
    expect(repo.authority(event.accountId)).toBeNull();
    expect(f.repo.snapshot(event.accountId, PM_NOW).account.name).toBe('Remote Fictional PM');
    expect(f.db.raw.prepare('SELECT * FROM persons ORDER BY id').all()).toEqual(f.historicalPersons);
  } finally { f.close(); }
});

const completionKey = (v: { commandId: string; workspaceId: string; budgetId: string; inputFingerprint: string }) => ({ commandId: v.commandId, workspaceId: v.workspaceId, budgetId: v.budgetId, inputFingerprint: v.inputFingerprint });
import { SqlDiscoveryReservationStore } from '../../src/main/delegation/discoveryReservationStore';
it('reserves cumulative pre-account spend before HTTP and preserves unknown reservations across encrypted reopen', async () => {
  const f = await createPmFixture();
  try {
    const deps = { database: f.db, workspaceId, clock: { now: () => PM_NOW } };
    const store = new SqlDiscoveryReservationStore(deps);
    const input = { commandId: 'discover-1', workspaceId, budgetId: 'approved-budget', inputFingerprint: 'a'.repeat(64), searchCostMicros: 60, modelCostMicros: 40 };
    expect(store.reserveOnce(input)).toEqual({ status: 'denied' });
    store.approveBudget({ budgetId: input.budgetId, ceilingMicros: 150, evidenceRef: 'operator-approval' });
    expect(store.reserveOnce(input)).toEqual({ status: 'reserved' });
    expect(store.reserveOnce(input)).toEqual({ status: 'replay', candidates: null });
    expect(store.reserveOnce({ ...input, commandId: 'discover-2' })).toEqual({ status: 'denied' });
    expect(() => store.reserveOnce({ ...input, inputFingerprint: 'b'.repeat(64) })).toThrow(/conflict/i);
    expect(() => store.reserveOnce({ ...input, searchCostMicros: 61 })).toThrow(/conflict/i);
    expect(() => store.reserveOnce({ ...input, workspaceId: 'other' })).toThrow(/workspace/i);
    expect(() => store.reserveOnce({ ...input, searchCostMicros: -1 })).toThrow();
    const candidates = [{ name: 'Fictional PM', domain: 'example.invalid', sourceUrl: 'https://example.invalid/team' }];
    store.complete({ ...completionKey(input), candidates, costMicros: null });
    store.complete({ ...completionKey(input), candidates, costMicros: null });
    expect(() => store.complete({ ...completionKey(input), candidates: [], costMicros: 0 })).toThrow(/conflict/i);
    closeDatabase(f.db);
    const reopened = openDatabase({ path: f.db.path, key: createTestWorkspaceKey() });
    try {
      const next = new SqlDiscoveryReservationStore({ ...deps, database: reopened });
      expect(next.reserveOnce(input)).toEqual({ status: 'replay', candidates });
      expect(next.reserveOnce({ ...input, commandId: 'discover-2' })).toEqual({ status: 'denied' });
      expect(reopened.raw.prepare('SELECT * FROM pm_accounts').all()).toEqual([]);
    } finally { closeDatabase(reopened); }
  } finally { f.close(); }
});
it('settles known spend once and serializes two actual SQLite clients against one approved budget', async () => {
  const f = await createPmFixture(); const second = openDatabase({ path: f.db.path, key: createTestWorkspaceKey() });
  try {
    const deps = { database: f.db, workspaceId, clock: { now: () => PM_NOW } };
    const first = new SqlDiscoveryReservationStore(deps); const other = new SqlDiscoveryReservationStore({ ...deps, database: second });
    first.approveBudget({ budgetId: 'budget', ceilingMicros: 100, evidenceRef: 'approved' });
    const input = { commandId: 'one', workspaceId, budgetId: 'budget', inputFingerprint: 'a'.repeat(64), searchCostMicros: 60, modelCostMicros: 40 };
    expect(first.reserveOnce(input)).toEqual({ status: 'reserved' });
    expect(other.reserveOnce({ ...input, commandId: 'two' })).toEqual({ status: 'denied' });
    expect(() => first.complete({ ...completionKey(input), candidates: [], costMicros: 101 })).toThrow();
    first.complete({ ...completionKey(input), candidates: [], costMicros: 30 });
    expect(other.reserveOnce({ ...input, commandId: 'two', searchCostMicros: 40, modelCostMicros: 30 })).toEqual({ status: 'reserved' });
    for (const table of ['discovery_approved_budgets', 'discovery_reservations', 'discovery_receipts']) {
      expect(() => f.db.raw.exec(`DELETE FROM ${table}`)).toThrow(/immutable/i);
    }
  } finally { closeDatabase(second); f.close(); }
});

import { AccountRoutePolicyStore, accountRoutePolicySchema, type RoutePolicyReceipt } from '../../src/main/delegation/accountRoutePolicyStore';
it('admits only genuine capability-attested policy and enforces same account, route version, target and source provenance immutably', async () => {
  const f = await createPmFixture();
  try {
    const account = f.repo.create({ commandId: randomUUID(), name: 'Policy PM', domain: null });
    const sourceId = 'policy-source'; const routeId = 'policy-route';
    f.repo.admitEvidence({ commandId: randomUUID(), accountId: account.id, expectedVersion: 1,
      sources: [{ id: sourceId, url: 'https://example.invalid/team', fetchedAt: PM_NOW, sha256: 'a'.repeat(64), excerpt: 'Fictional evidence', permitted: true }], claims: [],
      routes: [{ id: routeId, accountId: account.id, personId: null, channel: 'phone', value: '+12025550123', purpose: 'business', evidenceIds: [sourceId], verification: 'published' }] });
    const input: RoutePolicyReceipt = { id: 'policy', accountId: account.id, routeId, routeVersion: 1, canonicalTarget: '+12025550123', evidenceFingerprint: 'b'.repeat(64),
      revision: 1, evidenceRef: sourceId, evidenceIds: [sourceId], provenance: 'fictional-review', observedAt: PM_NOW, effectiveAt: PM_NOW, expiresAt: '2026-10-01T00:00:00.000Z',
      policy: { contact: { kind: 'phone', normalizedValue: '+12025550123', validationState: 'unverified', evidence: { federalStatus: 'unknown', tcpaFlag: null, coveredAreaCode: null, source: 'legacy', scrubbedAt: null, expiresAt: null } }, jurisdiction: null, clearance: null } };
    const store = new AccountRoutePolicyStore({ database: f.db, clock: { now: () => PM_NOW }, admission: { attest: v => v.provenance === 'fictional-review' } });
    expect(() => new AccountRoutePolicyStore({ database: f.db, clock: { now: () => PM_NOW } }).admit(input)).toThrow(/attestation/i);
    store.admit(input); store.admit(input);
    expect(f.db.raw.prepare('SELECT policy_json FROM pm_account_route_policy_receipts').get()).toEqual({ policy_json: JSON.stringify(input.policy) });
    expect(accountRoutePolicySchema.safeParse({ ...input.policy, ownerEnabled: true }).success).toBe(false);
    for (const change of [{ canonicalTarget: '+12025550124' }, { routeVersion: 2 }, { evidenceRef: 'missing' }, { evidenceIds: ['missing'] }, { accountId: 'missing' }]) {
      expect(() => store.admit({ ...input, ...change, id: randomUUID(), revision: 2 })).toThrow();
    }
    expect(() => store.admit({ ...input, policy: { ...input.policy, clearance: { decision: 'allowed', registrationConfirmed: true, stateDncSubscriptionConfirmed: true, consentRuleConfirmed: true, effectiveAt: PM_NOW, expiresAt: input.expiresAt } } })).toThrow(/conflict/i);
    expect(() => f.db.raw.exec('DELETE FROM pm_account_route_policy_receipts')).toThrow(/immutable/i);
    expect(() => f.db.raw.exec("UPDATE pm_account_route_policy_receipts SET route_version=2")).toThrow(/immutable/i);
    expect(f.db.raw.pragma('foreign_key_check')).toEqual([]);
    expect(f.db.raw.prepare('SELECT * FROM delegated_authorities').all()).toEqual([]);
  } finally { f.close(); }
});

it('applies pause/revoke acknowledgments and late old-generation outcomes without local takeover, preserving typed manual facts', async () => {
  const f = await createPmFixture();
  try {
    const a = f.repo.create({ commandId: randomUUID(), name: 'Execution PM', domain: null }); const repo = local(f); repo.initializeLocalAuthority(a.id);
    const delegate: DelegationCommand = { ...pause(a.id), kind: 'delegate', payload: { delegationId: 'grant', approvedAt: PM_NOW } };
    repo.queueCommand(delegate); repo.applyWorkerEvent(changed(delegate));
    const dispatch: WorkerEvent = { id: 'dispatch', workspaceId, accountId: a.id, authorityGeneration: 1, aggregateVersion: 2, kind: 'action.outcome',
      payload: { actionId: 'send', state: 'dispatching', contentHash: 'a'.repeat(64), targetHash: 'b'.repeat(64), observedAt: PM_NOW, evidenceRef: 'reservation' } };
    repo.applyWorkerEvent(dispatch);
    const pauseCommand: DelegationCommand = { ...pause(a.id), expectedAuthorityGeneration: 1, expectedVersion: 2 }; repo.queueCommand(pauseCommand);
    expect(repo.authority(a.id)).toMatchObject({ state: 'active' });
    const pauseEvent: WorkerEvent = { id: 'paused', workspaceId, accountId: a.id, authorityGeneration: 1, aggregateVersion: 3, kind: 'authority.changed',
      payload: { authority: { accountId: a.id, owner: 'worker', generation: 1, state: 'paused' }, receipt: { commandId: pauseCommand.commandId, status: 'applied', authorityGeneration: 1, aggregateVersion: 3, reason: null } } };
    repo.applyWorkerEvent(pauseEvent); expect(repo.commandStatus(pauseCommand.commandId)).toEqual(pauseEvent.payload.receipt);
    const revoke: DelegationCommand = { ...pause(a.id), expectedAuthorityGeneration: 1, expectedVersion: 3, kind: 'revoke' }; repo.queueCommand(revoke);
    repo.applyWorkerEvent({ ...pauseEvent, id: 'revoked', authorityGeneration: 2, aggregateVersion: 4, payload: {
      authority: { accountId: a.id, owner: 'worker', generation: 2, state: 'revoked' }, receipt: { commandId: revoke.commandId, status: 'applied', authorityGeneration: 2, aggregateVersion: 4, reason: null } } });
    expect(repo.applyWorkerEvent({ ...dispatch, id: 'late', aggregateVersion: 5, payload: { ...dispatch.payload, state: 'provider_accepted' } })).toBe('applied');
    expect(repo.authority(a.id)).toEqual({ accountId: a.id, owner: 'worker', generation: 2, state: 'revoked' });
    expect(() => repo.initializeLocalAuthority(a.id)).toThrow();
    const manual: WorkerEvent = { id: 'manual', workspaceId, accountId: a.id, authorityGeneration: 2, aggregateVersion: 6,
      kind: 'manual.outcome', receipt: { commandId: 'manual-report', status: 'applied', authorityGeneration: 2, aggregateVersion: 6, reason: null }, payload: { actionId: 'call', channel: 'call', outcome: 'no_answer', observedAt: PM_NOW, evidenceRef: 'human-report' } };
    repo.applyWorkerEvent(manual);
    expect(JSON.parse((f.db.raw.prepare('SELECT outcome_json FROM delegated_manual_outcomes').get() as { outcome_json: string }).outcome_json)).toEqual(manual.payload);
    expect(workerEventSchema.safeParse({ ...manual, payload: { ...manual.payload, channel: 'linkedin' } }).success).toBe(false);
    expect(f.db.raw.prepare('SELECT COUNT(*) AS count FROM delegated_action_outcomes').get()).toEqual({ count: 2 });
    // Failure after ledger insertion must roll back the ledger, owner revision and cursor together.
    expect(() => repo.applyWorkerEvent({ ...dispatch, id: 'bad-target', authorityGeneration: 2, aggregateVersion: 7, payload: { ...dispatch.payload, targetHash: 'c'.repeat(64) } })).toThrow(/conflict/i);
    expect(f.db.raw.prepare("SELECT id FROM delegated_applied_events WHERE id='bad-target'").get()).toBeUndefined();
    expect(f.db.raw.prepare('SELECT aggregate_version FROM delegated_event_cursors').get()).toEqual({ aggregate_version: 6 });
  } finally { f.close(); }
});
it('admits research evidence and receipts in the same event transaction, rejecting unattested and cross-account evidence without residue', async () => {
  const f = await createPmFixture();
  try {
    const deps = { database: f.db, workspaceId, clock: { now: () => PM_NOW } };
    const repo = new DelegationRepository({ ...deps, sourcePolicy: { attest: s => s.url === 'https://example.invalid/team' } });
    const created: WorkerEvent = { id: 'research-create', workspaceId, accountId: 'researched', authorityGeneration: 0, aggregateVersion: 1, kind: 'research.created',
      payload: { account: { id: 'researched', name: 'Research PM', domain: null, version: 1 }, createdAt: PM_NOW } };
    repo.applyWorkerEvent(created);
    const evidence: WorkerEvent = { id: 'research-evidence', workspaceId, accountId: 'researched', authorityGeneration: 0, aggregateVersion: 2, kind: 'research.evidence',
      payload: { admittedAt: PM_NOW, batch: { commandId: randomUUID(), accountId: 'researched', expectedVersion: 1,
        sources: [{ id: 'source', url: 'https://example.invalid/team', fetchedAt: PM_NOW, sha256: 'a'.repeat(64), excerpt: 'Fictional residential operations', permitted: true }],
        claims: [{ key: 'residential_scope', kind: 'fact', value: 'Residential PM', evidenceIds: ['source'] }], routes: [] } } };
    expect(() => new DelegationRepository(deps).applyWorkerEvent(evidence)).toThrow(/attestation/i);
    expect(f.db.raw.prepare('SELECT * FROM pm_account_sources').all()).toEqual([]);
    expect(repo.applyWorkerEvent(evidence)).toBe('applied'); expect(repo.applyWorkerEvent(evidence)).toBe('duplicate');
    expect(f.repo.snapshot('researched', PM_NOW).claims).toEqual(evidence.payload.batch.claims);
    expect(() => repo.applyWorkerEvent({ ...evidence, id: 'bad', aggregateVersion: 3, payload: { ...evidence.payload, batch: { ...evidence.payload.batch,
      commandId: randomUUID(), expectedVersion: 2, sources: [], claims: [{ key: 'role', kind: 'fact', value: 'Unsupported', evidenceIds: ['missing'] }] } } })).toThrow(/evidence/i);
    expect(f.db.raw.prepare('SELECT aggregate_version FROM delegated_event_cursors').get()).toEqual({ aggregate_version: 2 });
    expect(repo.applyWorkerEvent({ id: 'research-receipt', workspaceId, accountId: 'researched', authorityGeneration: 0, aggregateVersion: 3, kind: 'research.receipt',
      payload: { jobId: 'job', receiptCommandId: evidence.payload.batch.commandId, status: 'completed', costMicros: null, observedAt: PM_NOW } })).toBe('applied');
    expect(repo.authority('researched')).toBeNull();
  } finally { f.close(); }
});

import { createMigrationRunner, productionMigrations } from '../../src/main/db/migrate';
import { seedProspect, insertOpenCycleWithAction } from '../fixtures/domainRows';
it('preserves genuine historical20 unknown email sends and all nonempty historical business tables through21 then22 and reopen', async () => {
  const temp = createTempDatabase(); const key = createTestWorkspaceKey(); const db = openDatabase({ path: temp.path, key });
  try {
    const options = { backupDirectory: `${temp.path}.backups`, workspaceKey: key };
    await createMigrationRunner(productionMigrations.slice(0, 20))(db, options);
    const p = seedProspect(db.raw, 'legacy'); const cycle = insertOpenCycleWithAction({ database: db.raw, prefix: 'legacy', prospect: p });
    db.raw.prepare(`INSERT INTO person_contact_methods(id,person_id,kind,normalized_value,validation_state,reachability,is_primary,created_at,updated_at)
      VALUES('contact',?,'email','fictional@example.invalid','unverified','direct',1,?,?)`).run(p.personId, PM_NOW, PM_NOW);
    db.raw.prepare(`INSERT INTO email_drafts(id,person_id,sales_cycle_id,contact_method_id,recipient,contact_snapshot,subject,body,revision,status,generation,created_at,updated_at)
      VALUES('draft',?,?,'contact','fictional@example.invalid',?,'Historical','Preserve me',1,'unknown','edited',?,?)`).run(p.personId, cycle.cycleId, 'a'.repeat(64), PM_NOW, PM_NOW);
    db.raw.prepare("INSERT INTO email_send_intents VALUES('legacy-command','draft',1,?,'{}',?)").run('b'.repeat(64), PM_NOW);
    db.raw.prepare("INSERT INTO email_send_results VALUES('legacy-command','unknown','{}',?)").run(PM_NOW);
    const tables = (db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('app_meta','kysely_migration','kysely_migration_lock') ORDER BY name").all() as { name: string }[]).map(r => r.name);
    const before = tables.map(table => db.raw.prepare(`SELECT * FROM "${table}"`).all());
    expect(await createMigrationRunner(productionMigrations.slice(0, 21))(db, options)).toEqual({ fromVersion: 20, toVersion: 21, appliedMigrationIds: ['0021DelegatedWork'] });
    const historical21Tables = (db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('app_meta','kysely_migration','kysely_migration_lock') ORDER BY name").all() as { name: string }[]).map(row => row.name);
    const historical21Rows = historical21Tables.map(table => db.raw.prepare(`SELECT * FROM "${table}"`).all());
    expect(await createMigrationRunner(productionMigrations.slice(0, 22))(db, options)).toEqual({ fromVersion: 21, toVersion: 22, appliedMigrationIds: ['0022MailPersistence'] });
    expect(historical21Tables.map(table => db.raw.prepare(`SELECT * FROM "${table}"`).all())).toEqual(historical21Rows);
    expect(tables.map(table => db.raw.prepare(`SELECT * FROM "${table}"`).all())).toEqual(before);
    expect(db.raw.prepare('SELECT * FROM delegated_authorities').all()).toEqual([]);
    closeDatabase(db); const reopened = openDatabase({ path: temp.path, key });
    try { expect(reopened.raw.prepare('SELECT status FROM email_send_results').get()).toEqual({ status: 'unknown' }); expect(reopened.raw.pragma('foreign_key_check')).toEqual([]); }
    finally { closeDatabase(reopened); }
  } finally { closeDatabase(db); key.bytes.fill(0); temp.cleanup(); }
});

it('creates durable unset call allocation without mutating historical workspace settings', async () => {
 const f = await createPmFixture(); try {
 expect(f.db.raw.prepare('SELECT singleton,new_call_slots,total_call_capacity,revision FROM meeting_first_call_settings').get())
  .toEqual({singleton:1,new_call_slots:null,total_call_capacity:null,revision:0});
 expect(() => f.db.raw.exec('UPDATE meeting_first_call_settings SET new_call_slots=-1')).toThrow();
 expect(() => f.db.raw.exec('INSERT INTO meeting_first_call_settings VALUES(2,NULL,NULL,0,\'2026-09-08T00:00:00.000Z\')')).toThrow();
 }finally{f.close();}
});
it('enforces cumulative budget ceilings even for direct SQL writers', async () => {
 const f=await createPmFixture(); try {
 const store=new SqlDiscoveryReservationStore({database:f.db,workspaceId,clock:{now:()=>PM_NOW}});
 store.approveBudget({budgetId:'budget',ceilingMicros:100,evidenceRef:'approval'});
 store.reserveOnce({workspaceId,budgetId:'budget',commandId:'first',inputFingerprint:'a'.repeat(64),searchCostMicros:60,modelCostMicros:40});
 expect(()=>f.db.raw.prepare('INSERT INTO discovery_reservations VALUES(?,?,?,?,?,?,?)').run(workspaceId,'budget','bypass','a'.repeat(64),1,0,PM_NOW)).toThrow(/budget/i);
 expect(()=>f.db.raw.prepare('INSERT INTO discovery_receipts VALUES(?,?,?,?,?,?)').run(workspaceId,'budget','first','[]',101,PM_NOW)).toThrow(/ceiling/i);
 }finally{f.close();}
});
it('accepts authenticated remote emergency pauses without requiring a nonexistent local command', async () => {
 const f=await createPmFixture(); try {
 const a=f.repo.create({commandId:randomUUID(),name:'PM',domain:null});const repo=local(f);repo.initializeLocalAuthority(a.id);
 const command:DelegationCommand={...pause(a.id),kind:'delegate',payload:{delegationId:'grant',approvedAt:PM_NOW}};repo.queueCommand(command);repo.applyWorkerEvent(changed(command));
 const event:WorkerEvent={id:'remote-pause',workspaceId,accountId:a.id,aggregateVersion:2,authorityGeneration:1,kind:'authority.changed',payload:{authority:{accountId:a.id,owner:'worker',generation:1,state:'paused'},receipt:{commandId:'emergency',status:'applied',authorityGeneration:1,aggregateVersion:2,reason:null}}};
 expect(repo.applyWorkerEvent(event)).toBe('applied');expect(repo.commandStatus('emergency')).toEqual(event.payload.receipt);
 expect(()=>repo.applyWorkerEvent({...event,id:'bad-grant',aggregateVersion:3,payload:{authority:{...event.payload.authority,owner:'local',state:'local'},receipt:{...event.payload.receipt,commandId:'bad',aggregateVersion:3}}})).toThrow();
 }finally{f.close();}
});
it('persists exact approvals with route/recipient and permission-source identity, rejecting changed replay', async () => {
 const f=await createPmFixture();try{
 const a=f.repo.create({commandId:randomUUID(),name:'Approval PM',domain:null});
 f.repo.admitEvidence({commandId:randomUUID(),accountId:a.id,expectedVersion:1,claims:[],sources:[{id:'permission',url:'https://example.invalid/team',fetchedAt:PM_NOW,sha256:'a'.repeat(64),excerpt:'Fictional source',permitted:true}],routes:[{id:'email-route',accountId:a.id,personId:null,channel:'email',value:'fictional@example.invalid',purpose:'business',verification:'published',evidenceIds:['permission']}]});
 const approval={id:'approval',accountId:a.id,recipient:'fictional@example.invalid',sender:'sender@example.invalid',footerHash:'a'.repeat(64),subjectHash:'b'.repeat(64),bodyHash:'c'.repeat(64),routeId:'email-route',routeVersion:1,threadId:null as string|null,threadRevision:0,contextRevision:'context',campaignId:null as string|null,campaignRevision:0,permissionEvidenceId:'permission',approvedAt:PM_NOW};
 const repo=local(f);expect(repo.saveApproval(approval)).toEqual(approval);expect(repo.saveApproval(approval)).toEqual(approval);
 expect(()=>repo.saveApproval({...approval,bodyHash:'d'.repeat(64)})).toThrow(/conflict/i);
 expect(()=>repo.saveApproval({...approval,id:'wrong',recipient:'other@example.invalid'})).toThrow(/recipient/i);
 expect(()=>repo.saveApproval({...approval,id:'missing-permission',permissionEvidenceId:'missing'})).toThrow();
 expect(()=>f.db.raw.exec('DELETE FROM delegated_approvals')).toThrow(/immutable/i);
 expect(JSON.parse((f.db.raw.prepare('SELECT snapshot_json FROM delegated_approvals').get() as {snapshot_json:string}).snapshot_json)).toEqual(approval);
 }finally{f.close();}
});
it('keeps account and normalized handle suppression tombstones permanently without fabricated Persons', async()=>{
 const f=await createPmFixture();try{
 const a=f.repo.create({commandId:randomUUID(),name:'Suppressed PM',domain:null});
 f.db.raw.prepare('INSERT INTO pm_account_suppression_tombstones VALUES(?,?,?,?,?,?)').run('account-optout',a.id,PM_NOW,'user_report','reported-optout',PM_NOW);
 f.db.raw.prepare('INSERT INTO pm_handle_suppression_tombstones VALUES(?,?,?,?,?,?,?)').run('handle-optout','phone','+12025550123',PM_NOW,'user_report','reported-optout',PM_NOW);
 for(const table of ['pm_account_suppression_tombstones','pm_handle_suppression_tombstones']) expect(()=>f.db.raw.exec(`DELETE FROM ${table}`)).toThrow(/immutable/i);
 expect(()=>f.db.raw.prepare('INSERT INTO pm_handle_suppression_tombstones VALUES(?,?,?,?,?,?,?)').run('bad','email',' Mixed@EXAMPLE.invalid ',PM_NOW,'user_report','reported-optout',PM_NOW)).toThrow();
 expect(f.db.raw.prepare('SELECT * FROM persons ORDER BY id').all()).toEqual(f.historicalPersons);
 closeDatabase(f.db);const reopened=openDatabase({path:f.db.path,key:createTestWorkspaceKey()});try{expect(reopened.raw.prepare('SELECT account_id FROM pm_account_suppression_tombstones').get()).toEqual({account_id:a.id});expect(reopened.raw.prepare('SELECT normalized_value FROM pm_handle_suppression_tombstones').get()).toEqual({normalized_value:'+12025550123'});}finally{closeDatabase(reopened);}
 }finally{f.close();}
});

it('keeps ordered synchronization moving through two distinct remote emergency pauses and a revoke', async () => {
  const f = await createPmFixture();
  try {
    const a = f.repo.create({ commandId: randomUUID(), name: 'Emergency PM', domain: null });
    const repo = local(f); repo.initializeLocalAuthority(a.id);
    const command: DelegationCommand = { ...pause(a.id), kind: 'delegate', payload: { delegationId: 'grant', approvedAt: PM_NOW } };
    repo.queueCommand(command); repo.applyWorkerEvent(changed(command));
    const event: Extract<WorkerEvent, { kind: 'authority.changed' }> = { id: 'pause-A', workspaceId, accountId: a.id, aggregateVersion: 2, authorityGeneration: 1,
      kind: 'authority.changed', payload: { authority: { accountId: a.id, owner: 'worker', generation: 1, state: 'paused' },
        receipt: { commandId: 'emergency-A', status: 'applied', authorityGeneration: 1, aggregateVersion: 2, reason: null } } };
    expect(repo.applyWorkerEvent(event)).toBe('applied');
    const second = { ...event, id: 'pause-B', aggregateVersion: 3, payload: { ...event.payload, receipt: { ...event.payload.receipt, commandId: 'emergency-B', aggregateVersion: 3 } } };
    expect(repo.applyWorkerEvent(second)).toBe('applied');
    expect(repo.applyWorkerEvent(second)).toBe('duplicate');
    expect(repo.applyWorkerEvent({ ...event, id: 'revoke-C', aggregateVersion: 4, authorityGeneration: 2, payload: {
      authority: { accountId: a.id, owner: 'worker', generation: 2, state: 'revoked' },
      receipt: { commandId: 'emergency-C', status: 'applied', authorityGeneration: 2, aggregateVersion: 4, reason: null } } })).toBe('applied');
    expect(repo.authority(a.id)).toMatchObject({ owner: 'worker', generation: 2, state: 'revoked' });
    expect(f.db.raw.prepare('SELECT aggregate_version FROM delegated_event_cursors').get()).toEqual({ aggregate_version: 4 });
  } finally { f.close(); }
});
it('acknowledges a manual outcome command durably without rewriting its original pending replay receipt', async () => {
  const f = await createPmFixture();
  try {
    const a = f.repo.create({ commandId: randomUUID(), name: 'Manual PM', domain: null });
    const repo = local(f); repo.initializeLocalAuthority(a.id);
    const delegate: DelegationCommand = { ...pause(a.id), kind: 'delegate', payload: { delegationId: 'grant', approvedAt: PM_NOW } };
    repo.queueCommand(delegate); repo.applyWorkerEvent(changed(delegate));
    const command: Extract<DelegationCommand, { kind: 'manual-outcome' }> = { commandId: 'manual-command', workspaceId, accountId: a.id,
      expectedAuthorityGeneration: 1, expectedVersion: 1, kind: 'manual-outcome',
      payload: { actionId: 'call-attempt', channel: 'call', outcome: 'no_answer', observedAt: PM_NOW, evidenceRef: 'user-report' } };
    const pending = repo.queueCommand(command);
    const event: WorkerEvent = { id: 'manual-ack', workspaceId, accountId: a.id, authorityGeneration: 1, aggregateVersion: 2,
      kind: 'manual.outcome', payload: command.payload, receipt: { commandId: command.commandId, status: 'applied', authorityGeneration: 1, aggregateVersion: 2, reason: null } };
    const applied: CommandReceipt = { commandId: command.commandId, status: 'applied', authorityGeneration: 1, aggregateVersion: 2, reason: null };
    for (const receipt of [
      { ...event.receipt, status: 'pending' as const },
      { ...event.receipt, authorityGeneration: 2 },
      { ...event.receipt, aggregateVersion: 3 },
      { ...event.receipt, commandId: delegate.commandId },
    ]) expect(() => repo.applyWorkerEvent({ ...event, receipt })).toThrow();
    expect(() => repo.applyWorkerEvent({ ...event, payload: { ...command.payload, actionId: 'wrong-action' } })).toThrow(/correspondence/i);
    const other = f.repo.create({ commandId: randomUUID(), name: 'Other PM', domain: null });
    repo.initializeLocalAuthority(other.id);
    const otherDelegate: DelegationCommand = { ...delegate, commandId: randomUUID(), accountId: other.id };
    repo.queueCommand(otherDelegate); repo.applyWorkerEvent(changed(otherDelegate));
    expect(() => repo.applyWorkerEvent({ ...event, accountId: other.id })).toThrow(/correspondence/i);
    expect(workerEventSchema.safeParse({ ...event, receipt: { ...event.receipt, arbitrary: true } }).success).toBe(false);
    expect(f.db.raw.prepare('SELECT COUNT(*) AS count FROM delegated_manual_outcomes').get()).toEqual({ count: 0 });
    expect(repo.commandStatus(command.commandId)).toEqual(pending);
    expect(repo.applyWorkerEvent(event)).toBe('applied');
    expect(() => repo.applyWorkerEvent({ ...event, id: 'duplicate-command-ack', aggregateVersion: 3,
      receipt: { ...event.receipt, aggregateVersion: 3 } })).toThrow(/acknowledgment conflict/i);
    expect(f.db.raw.prepare('SELECT aggregate_version FROM delegated_event_cursors').get()).toEqual({ aggregate_version: 2 });
    expect(repo.commandStatus(command.commandId)).toEqual(applied);
    expect(repo.queueCommand(command)).toEqual(pending);
    expect(repo.applyWorkerEvent(event)).toBe('duplicate');
    closeDatabase(f.db); const reopened = openDatabase({ path: f.db.path, key: createTestWorkspaceKey() });
    try {
      const next = new DelegationRepository({ database: reopened, workspaceId, clock: { now: () => PM_NOW } });
      expect(next.commandStatus(command.commandId)).toEqual(applied);
      expect(next.queueCommand(command)).toEqual(pending);
      expect(next.applyWorkerEvent(event)).toBe('duplicate');
      expect(() => next.queueCommand({ ...command, payload: { ...command.payload, channel: 'call', outcome: 'connected' } })).toThrow(/conflict/i);
      expect(() => next.applyWorkerEvent({ ...event, payload: { ...command.payload, channel: 'call', outcome: 'connected' } })).toThrow(/conflict/i);
      expect(reopened.raw.prepare('SELECT COUNT(*) AS count FROM delegated_manual_outcomes').get()).toEqual({ count: 1 });
    } finally { closeDatabase(reopened); }
  } finally { f.close(); }
});
it('replays strict owner thread observations, context fences and optout evidence in one ordered transaction', async () => {
  const f = await createPmFixture();
  try {
    const account = f.repo.create({ commandId: randomUUID(), name: 'Thread PM', domain: null });
    const repo = local(f); repo.initializeLocalAuthority(account.id);
    const command: DelegationCommand = { ...pause(account.id), kind: 'delegate', payload: { delegationId: 'approved', approvedAt: PM_NOW } };
    repo.queueCommand(command); repo.applyWorkerEvent(changed(command));
    const event = { id: 'mail-event', workspaceId, accountId: account.id, authorityGeneration: 1, aggregateVersion: 2, kind: 'thread.observed',
      payload: { observedAt: PM_NOW, projection: { revision: 1, contextRevision: 'ctx-1', thread: {
        accountId: account.id, mailboxSubject: 'mailbox', provider: 'gmail', providerThreadId: 'thread1', messages: [
          { id: 'msg1', threadId: 'thread1', rfcMessageId: null as string | null, references: [] as string[], from: ['Owner@example.com'], to: ['me@example.com'], cc: [] as string[], date: PM_NOW,
            subject: 'Stop', bodyParts: [{ mimeType: 'text/plain', text: 'Please stop', truncated: false }] }],
      }, signals: [{ kind: 'opt_out', evidence: [{ messageId: 'msg1', quote: 'Please stop' }], requiresApproval: true }] },
      approvalInvalidation: { threadId: 'thread1', previousRevision: 0, revision: 1, contextRevision: 'ctx-1' } } };
    const parsed = workerEventSchema.parse(event);
    expect(workerEventSchema.safeParse({ ...event, accountId: 'other' }).success).toBe(false);
    expect(workerEventSchema.safeParse({ ...event, payload: { ...event.payload, execute: true } }).success).toBe(false);
    expect(repo.applyWorkerEvent(parsed)).toBe('applied');
    expect(repo.applyWorkerEvent(parsed)).toBe('duplicate');
    expect(f.db.raw.prepare('SELECT revision,context_revision FROM delegated_threads').get()).toEqual({ revision: 1, context_revision: 'ctx-1' });
    expect(f.db.raw.prepare('SELECT account_id FROM pm_account_suppression_tombstones').all()).toEqual([{ account_id: account.id }]);
    expect(f.db.raw.prepare('SELECT normalized_value FROM pm_handle_suppression_tombstones').all()).toEqual([{ normalized_value: 'owner@example.com' }]);
    const conflict = workerEventSchema.parse({ ...event, id: 'conflict', aggregateVersion: 3 });
    expect(() => repo.applyWorkerEvent(conflict)).toThrow(/revision/i);
    expect(f.db.raw.prepare("SELECT aggregate_version FROM delegated_event_cursors WHERE stream='execution'").get()).toEqual({ aggregate_version: 2 });
    expect(repo.authority(account.id)).toMatchObject({ owner: 'worker', state: 'active', generation: 1 });
    closeDatabase(f.db);
    const reopened = openDatabase({ path: f.db.path, key: createTestWorkspaceKey() });
    try { expect(new DelegationRepository({ database: reopened, workspaceId, clock: { now: () => PM_NOW } }).applyWorkerEvent(parsed)).toBe('duplicate'); }
    finally { closeDatabase(reopened); }
  } finally { f.close(); }
});
