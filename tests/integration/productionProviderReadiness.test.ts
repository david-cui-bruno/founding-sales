import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { prepareEncryptedDatabase } from '../../src/main/db/plaintextDatabaseUpgrade';
import { DomainRuntime } from '../../src/main/domain/domainRuntime';
import type { FounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import { BUILTIN_CADENCES } from '../../src/main/domain/cadence/builtinCadences';
import { FoundationRuntime } from '../../src/main/foundation/foundationRuntime';
import { HealthService } from '../../src/main/health/healthService';
import {
  createLeadsProvider, createLeadDetailProvider, createTodayProvider, createPipelineProvider,
  createReviewProvider, createFridayProvider, createImportProvider, createConversationsProvider,
  createLearningsProvider, registerApplicationIpc,
} from '../../src/main/ipc/registerApplicationIpc';
import { createCallieApi } from '../../src/preload/createCallieApi';
import { appHealthSchema } from '../../src/shared/healthContract';
import { mutationReceiptSchema } from '../../src/shared/contracts/commonContract';
import { leadsListResponseSchema, type LeadsListRequest } from '../../src/shared/contracts/leadsContract';
import type { SourcingPollHealth } from '../../src/shared/contracts/sourcingContract';
import { leadDetailSchema } from '../../src/shared/contracts/leadDetailContract';
import { todaySnapshotSchema } from '../../src/shared/contracts/todayContract';
import { pipelineSnapshotSchema } from '../../src/shared/contracts/pipelineContract';
import { reviewSnapshotSchema } from '../../src/shared/contracts/reviewContract';
import { fridayReportSchema } from '../../src/shared/contracts/fridayContract';
import { importPreviewSchema, importCommitReceiptSchema } from '../../src/shared/contracts/importContract';
import { conversationsListResponseSchema, conversationDetailSchema } from '../../src/shared/contracts/conversationsContract';
import { learningsListResponseSchema } from '../../src/shared/contracts/learningsContract';
import { createTempDatabase, createTestWorkspaceKey } from '../fixtures/tempDatabase';
import { insertPerson, seedProspect, insertOpenCycleWithAction, insertClosedCycle, insertSourceEvent } from '../fixtures/domainRows';
import { registeredIpcHandler } from '../fixtures/registeredIpcHandler';

const electron = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }));
vi.mock('electron', () => ({ safeStorage: {}, dialog: {}, ipcMain: { handle: electron.handle, removeHandler: electron.removeHandler } }));

const NOW = '2026-09-10T15:00:00.000Z';
const listRequest: LeadsListRequest = { query: '', stages: [], priorities: [], sort: 'person_name', cursor: null, limit: 50 };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
const sourcingHealth: SourcingPollHealth = { status: 'healthy', reasons: [], lastSuccessAgeMs: null,
  state: { state: 'idle' as const, pollId: null, startedAt: null, lastCompletedAt: null,
    consecutiveFailures: 0, lastFailureAt: null, lastFailureCode: null, backlogCount: null } };

// Real foundation, migration, bootstrap/audit, domain and HealthService. The only
// gate instrumentation delegates to the actual runtime and counts admitted callbacks.
function realFoundation(options: { holdKey?: boolean; blocked?: boolean; keyError?: Error } = {}) {
  const temp = createTempDatabase(); const releaseKey = deferred(); const keyEntered = deferred();
  const counts = { key: 0, open: 0, migrate: 0, initialize: 0, health: 0, callback: 0, close: 0 };
  let domainRuntime: DomainRuntime;
  const runtime = new FoundationRuntime({ appVersion: 'fixture', databasePath: temp.path, databaseExists: false,
    backupDirectory: `${temp.path}.backups`, keyEnvelopePath: `${temp.path}.envelope` }, {
    loadWorkspaceKey: async () => {
      counts.key++; keyEntered.resolve(); if (options.holdKey) await releaseKey.promise;
      if (options.keyError) throw options.keyError;
      return createTestWorkspaceKey();
    },
    prepareEncryptedDatabase,
    openDatabase: input => { counts.open++; return openDatabase(input); },
    migrateToLatest: async (database, input) => {
      counts.migrate++; const result = await migrateToLatest(database, input);
      if (options.blocked) insertPerson(database.raw, 'orphan-without-canonical-prospect');
      return result;
    },
    createDomainRuntime: database => {
      domainRuntime = new DomainRuntime({ database, clock: { now: () => NOW }, ids: { next: randomUUID } });
      const initialize = domainRuntime.initialize.bind(domainRuntime);
      vi.spyOn(domainRuntime, 'initialize').mockImplementation(() => { counts.initialize++; return initialize(); });
      return domainRuntime;
    },
    createHealthService: input => { counts.health++; return new HealthService(input); },
    closeDatabase: database => { counts.close++; closeDatabase(database); },
  });
  runtime.setSourcingHealthProvider(() => sourcingHealth);
  const gate = {
    withDomain: <T,>(operation: (domain: FounderSalesDomain) => T | Promise<T>): Promise<T> =>
      runtime.withDomain(domain => { counts.callback++; return operation(domain); }),
    withDatabase: <T,>(operation: (database: AppDatabase) => T | Promise<T>): Promise<T> => runtime.withDatabase(operation),
    getHealth: () => runtime.getHealth(),
  };
  const stop = async () => { releaseKey.resolve(); await runtime.shutdown(); temp.cleanup(); };
  return { temp, runtime, gate, counts, releaseKey, keyEntered, stop, services: () => domainRuntime.getServices() };
}
type Fixture = ReturnType<typeof realFoundation>;
const fixtures: Fixture[] = [];
const fixture = (options: Parameters<typeof realFoundation>[0] = {}) => {
  const f = realFoundation(options); fixtures.push(f); return f;
};
const revision = (f: Fixture) => f.runtime.withDatabase(database =>
  (database.raw.prepare('SELECT total_changes() AS count').get() as { count: number }).count);
const receipt = async (f: Fixture, result: unknown, people: string[], cycles: string[]) => {
  expect(mutationReceiptSchema.parse(result)).toEqual({ revision: await revision(f), affectedPersonIds: people, affectedSalesCycleIds: cycles });
};
async function seedReady(f: Fixture) {
  return f.runtime.withDatabase(database => {
    const prospect = seedProspect(database.raw, 'ready');
    const cycle = insertOpenCycleWithAction({ database: database.raw, prefix: 'ready', prospect });
    f.services().unitOfWork.immediate(() => f.services().events.appendActivity({ id: 'ready-call', personId: prospect.personId,
      prospectId: prospect.prospectId, salesCycleId: cycle.cycleId, kind: 'call', direction: 'inbound', channel: 'phone', occurredAt: NOW, callOutcome: 'spoke' }));
    return { ...prospect, ...cycle };
  });
}
function gatedOperations(f: Fixture) {
  return [
    ['leads.list', () => createLeadsProvider(f.gate).list(listRequest)],
    ['detail.get', () => createLeadDetailProvider(f.gate).get({ personId: 'held-person' })],
    ['today.get', () => createTodayProvider(f.gate).get()],
    ['pipeline.get', () => createPipelineProvider(f.gate).get()],
    ['review.list', () => createReviewProvider(f.gate).list({ kinds: [], limit: 50 })],
    ['friday.getCurrent', () => createFridayProvider(f.gate).getCurrent()],
    ['imports.preview', () => createImportProvider(f.gate).preview({ kind: 'csv', sourceName: 'held.csv', content: 'Name\nHeld\n' })],
    ['conversations.list', () => createConversationsProvider(f.gate).list({ query: '', filter: 'all', limit: 50, cursor: null })],
    ['learnings.list', () => createLearningsProvider(f.gate).list({ categories: [], statuses: [], query: '', limit: 50 })],
    ['leads.updateField', () => createLeadsProvider(f.gate).updateField({ personId: 'held-person', field: 'person_name', value: 'Must not write' })],
    ['friday.createJob', () => createFridayProvider(f.gate).createJob({ jobId: 'must-not-write', salesCycleId: null, requestedAt: NOW })],
  ] as const;
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); electron.handle.mockReset(); electron.removeHandler.mockReset(); });
afterEach(async () => { for (const f of fixtures.splice(0)) await f.stop(); vi.useRealTimers(); });

describe('production providers through actual encrypted FoundationRuntime', () => {
  it('pending initialization admits no callback or write, then release serves real reads and writes once initialized', async () => {
    const f = fixture({ holdKey: true });
    let settled = 0;
    const read = createLeadsProvider(f.gate).list(listRequest).then(value => { settled++; return value; });
    const write = createFridayProvider(f.gate).createJob({ jobId: 'pending-job', salesCycleId: null, requestedAt: NOW }).then(value => { settled++; return value; });
    await f.keyEntered.promise; await Promise.resolve();
    expect(f.counts).toMatchObject({ key: 1, open: 0, migrate: 0, callback: 0 }); expect(settled).toBe(0);
    f.releaseKey.resolve();
    expect(leadsListResponseSchema.parse(await read).rows).toEqual([]);
    await receipt(f, await write, [], []);
    expect(f.counts).toMatchObject({ key: 1, open: 1, migrate: 1, initialize: 1, health: 1, callback: 2 });
    expect((await createFridayProvider(f.gate).getCurrent()).jobs).toEqual([{ id: 'pending-job', salesCycleId: null, requestedAt: NOW, status: 'requested', contractorAcceptedAt: null }]);
  });

  it('shutdown while initialization is pending rejects queued commands without entering a callback or opening a database', async () => {
    const f = fixture({ holdKey: true });
    const write = createFridayProvider(f.gate).createJob({ jobId: 'cancelled-before-open', salesCycleId: null, requestedAt: NOW });
    const rejected = expect(write).rejects.toThrow('cancelled');
    await f.keyEntered.promise; const shutdown = f.runtime.shutdown(); f.releaseKey.resolve();
    await rejected; await shutdown;
    expect(f.counts).toMatchObject({ open: 0, migrate: 0, callback: 0, close: 0 });
  });

  it('failed initialization preserves the dependency error and never admits a provider callback', async () => {
    const error = new Error('fictional key unavailable'); const f = fixture({ keyError: error });
    await expect(createLeadsProvider(f.gate).list(listRequest)).rejects.toBe(error);
    expect(f.counts).toMatchObject({ open: 0, migrate: 0, callback: 0, close: 0 });
  });

  it('ready admits genuine reads from all nine factories and persisted writes from every writable slice', async () => {
    const f = fixture(); await f.runtime.initialize(); const owner = await seedReady(f);
    expect(appHealthSchema.parse(await f.runtime.getHealth())).toMatchObject({ domainReady: true, domainStatus: 'ready', databaseEncrypted: true });
    const leads = createLeadsProvider(f.gate), detail = createLeadDetailProvider(f.gate), today = createTodayProvider(f.gate);
    const pipeline = createPipelineProvider(f.gate), review = createReviewProvider(f.gate), friday = createFridayProvider(f.gate);
    const imports = createImportProvider(f.gate), conversations = createConversationsProvider(f.gate), learnings = createLearningsProvider(f.gate);
    expect(leadsListResponseSchema.parse(await leads.list(listRequest)).rows.map(row => row.personId)).toEqual([owner.personId]);
    expect(leadDetailSchema.parse(await detail.get({ personId: owner.personId })).personId).toBe(owner.personId);
    expect(todaySnapshotSchema.parse(await today.get()).revision).toBeGreaterThan(0);
    expect(pipelineSnapshotSchema.parse(await pipeline.get()).stages.flatMap(stage => stage.cards).map(card => card.personId)).toContain(owner.personId);
    expect(reviewSnapshotSchema.parse(await review.list({ kinds: [], limit: 50 })).items).toEqual([]);
    expect(fridayReportSchema.parse(await friday.getCurrent()).jobs).toEqual([]);
    expect(conversationsListResponseSchema.parse(await conversations.list({ query: '', filter: 'all', limit: 50, cursor: null })).rows.map(row => row.activityId)).toContain('ready-call');
    expect(learningsListResponseSchema.parse(await learnings.list({ categories: [], statuses: [], query: '', limit: 50 })).rows).toEqual([]);
    const preview = importPreviewSchema.parse(await imports.preview({ kind: 'csv', sourceName: 'fictional.csv', content: 'Name,Email\nFictional Owner,fictional@example.invalid\n' }));
    expect(preview.validCount).toBe(1);

    await receipt(f, await leads.updateField({ personId: owner.personId, field: 'person_name', value: 'Renamed Fictional Owner' }), [owner.personId], [owner.cycleId]);
    expect(await f.runtime.withDatabase(db => db.raw.prepare('SELECT display_name FROM persons WHERE id = ?').get(owner.personId))).toEqual({ display_name: 'Renamed Fictional Owner' });
    await receipt(f, await today.addLeadNote({ personId: owner.personId, salesCycleId: owner.cycleId, text: 'Local readiness note' }), [owner.personId], [owner.cycleId]);
    expect((await detail.get({ personId: owner.personId })).activities.some(activity => JSON.stringify(activity).includes('Local readiness note'))).toBe(true);
    await receipt(f, await conversations.attachTranscript({ personId: owner.personId, activityId: 'ready-call', rawText: 'me: Local fixture.\nLead: Fictional reply.' }), [owner.personId], [owner.cycleId]);
    expect(conversationDetailSchema.parse(await conversations.get({ activityId: 'ready-call' })).transcriptAvailable).toBe(true);
    await receipt(f, await friday.createJob({ jobId: 'ready-job', salesCycleId: owner.cycleId, requestedAt: NOW }), [], [owner.cycleId]);
    expect((await friday.getCurrent()).jobs).toEqual([{ id: 'ready-job', salesCycleId: owner.cycleId, requestedAt: NOW, status: 'requested', contractorAcceptedAt: null }]);
    const imported = importCommitReceiptSchema.parse(await imports.commit({ previewId: preview.previewId, contentHash: preview.contentHash, mapping: preview.suggestedMapping,
      source: { channel: 'registry', referredByPersonId: null }, duplicateDecisions: [] }));
    const expectedImportHash = createHash('sha256').update('Name,Email\nFictional Owner,fictional@example.invalid\n').digest('hex');
    // Find the imported owner by independent fixture content, never by a returned receipt ID.
    const importFacts = (db: AppDatabase) => ({
      people: db.raw.prepare("SELECT * FROM persons WHERE display_name = 'Fictional Owner' ORDER BY id").all() as { id: string }[],
      prospects: db.raw.prepare("SELECT * FROM prospects WHERE person_id IN (SELECT id FROM persons WHERE display_name = 'Fictional Owner') ORDER BY id").all() as { id: string; person_id: string; original_source_event_id: string }[],
      cycles: db.raw.prepare("SELECT * FROM sales_cycles WHERE person_id IN (SELECT id FROM persons WHERE display_name = 'Fictional Owner') ORDER BY id").all() as { id: string; person_id: string; prospect_id: string; entry_source_event_id: string; stage: string }[],
      sources: db.raw.prepare("SELECT * FROM source_events WHERE person_id IN (SELECT id FROM persons WHERE display_name = 'Fictional Owner') ORDER BY id").all() as { id: string; person_id: string; channel: string; source_record_json: string }[],
      jobs: db.raw.prepare("SELECT * FROM jobs WHERE type = 'lead_import_v1' AND idempotency_key = ? ORDER BY id").all(`import:${expectedImportHash}`) as { id: string; state: string; progress_current: number; progress_total: number; result_json: string }[],
    });
    const persistedImport = await f.runtime.withDatabase(importFacts);
    for (const records of [persistedImport.people, persistedImport.prospects, persistedImport.cycles, persistedImport.sources, persistedImport.jobs]) expect(records).toHaveLength(1);
    const importedPerson = persistedImport.people[0], importedProspect = persistedImport.prospects[0];
    const importedCycle = persistedImport.cycles[0], importedSource = persistedImport.sources[0], importedJob = persistedImport.jobs[0];
    expect(importedProspect.person_id).toBe(importedPerson.id);
    expect(importedProspect.original_source_event_id).toBe(importedSource.id);
    expect(importedCycle).toMatchObject({ person_id: importedPerson.id, prospect_id: importedProspect.id, entry_source_event_id: importedSource.id, stage: 'unreviewed' });
    expect(importedSource).toMatchObject({ person_id: importedPerson.id, channel: 'registry' });
    expect(JSON.parse(importedSource.source_record_json)).toMatchObject({ sourceRecord: { formatVersion: 1, importSourceName: 'fictional.csv', contentHash: expectedImportHash, rowNumber: 2 } });
    expect(importedJob).toMatchObject({ state: 'succeeded', progress_current: 1, progress_total: 1 });
    expect(JSON.parse(importedJob.result_json)).toEqual({ formatVersion: 1, importedPersonIds: [importedPerson.id], importedRowCount: 1 });
    expect(imported).toEqual({ jobId: importedJob.id, importedPersonIds: [importedPerson.id], importedRowCount: 1, revision: await revision(f) });
    expect((await leads.list({ ...listRequest, query: 'Fictional Owner' })).rows.map(row => row.personId)).toContain(importedPerson.id);
    await receipt(f, await learnings.capture({ category: 'pain', statement: 'Fictional maintenance delay', confidence: 'medium',
      evidence: [{ personId: null, activityId: null, quote: 'Fixture evidence', notedAt: NOW }], contradictionOf: null }), [], []);
    expect((await learnings.list({ categories: [], statuses: [], query: '', limit: 50 })).rows[0].statement).toBe('Fictional maintenance delay');

    const reviewId = await f.runtime.withDatabase(db => {
      const prospect = seedProspect(db.raw, 'review'); const sourceCycleId = insertClosedCycle({ database: db.raw, prefix: 'review-closed', prospect });
      const cadence = BUILTIN_CADENCES.find(value => value.family === 'cadence_c')!;
      const result = f.services().lifecycle.reactivateFromInboundResponse({ evidence: { kind: 'unknown_handle', handleKind: 'phone', normalizedValue: '+14015550100' },
        personId: prospect.personId, prospectId: prospect.prospectId, sourceCycleId, newCycleId: 'review-promoted', activatedAt: NOW,
        cadence: { definitionId: cadence.id, family: 'cadence_c', version: cadence.version, contentHash: cadence.contentHash } });
      if (result.kind !== 'review_required') throw Error('Expected genuine lifecycle review');
      insertSourceEvent({ database: db.raw, id: 'review-inbound', personId: prospect.personId, channel: 'inbound_demo' });
      return result.reviewItem.id;
    });
    expect((await review.list({ kinds: [], limit: 50 })).items.map(item => item.reviewId)).toEqual([reviewId]);
    await receipt(f, await review.resolve({ kind: 'unmatched_communication', reviewId, expectedVersion: 1, action: 'promote', personId: null, sourceEventId: 'review-inbound' }), ['review-person'], ['review-promoted']);
    expect(await f.runtime.withDatabase(db => db.raw.prepare('SELECT status FROM lifecycle_review_items WHERE id = ?').get(reviewId))).toEqual({ status: 'resolved' });
    const current = await detail.get({ personId: owner.personId });
    await receipt(f, await detail.dismissLead({ personId: owner.personId, salesCycleId: owner.cycleId, qualificationGateReason: 'out_of_area', expectedRevision: current.revision }), [owner.personId], [owner.cycleId]);
    expect(await f.runtime.withDatabase(db => db.raw.prepare('SELECT stage, workflow_status FROM sales_cycles WHERE id = ?').get(owner.cycleId))).toEqual({ stage: 'lost_nurture', workflow_status: 'closed' });
    expect(f.counts).toMatchObject({ key: 1, open: 1, migrate: 1, initialize: 1, health: 1 });
    await f.runtime.shutdown();
    expect(readFileSync(f.temp.path).subarray(0, 16).toString()).not.toBe('SQLite format 3\0');
    const reopened = openDatabase({ path: f.temp.path, key: createTestWorkspaceKey() });
    try {
      expect(reopened.raw.prepare('SELECT display_name FROM persons WHERE id = ?').get(owner.personId)).toEqual({ display_name: 'Renamed Fictional Owner' });
      expect(importFacts(reopened)).toEqual(persistedImport);
    }
    finally { closeDatabase(reopened); }
  });

  it('an actual audited blocked domain refuses all nine gated factories and writes without facade callbacks', async () => {
    const f = fixture({ blocked: true }); await f.runtime.initialize();
    const health = appHealthSchema.parse(await f.runtime.getHealth());
    expect(health.domainStatus).toBe('blocked'); expect(health.domainReady).toBe(false); expect(health.domainBlockingViolationCount).toBeGreaterThan(0);
    const before = await revision(f);
    for (const [name, run] of gatedOperations(f)) await expect(run(), name).rejects.toThrow('blocked');
    expect(f.counts.callback).toBe(0); expect(await revision(f)).toBe(before);
  });

  it('a real withDatabase lease holds shutdown while stopping and stopped gates refuse every factory', async () => {
    const f = fixture(); await f.runtime.initialize(); const entered = deferred(), release = deferred();
    let changes = 0;
    const lease = f.runtime.withDatabase(async db => {
      changes = (db.raw.prepare('SELECT total_changes() AS count').get() as { count: number }).count;
      entered.resolve(); await release.promise;
      expect((db.raw.prepare('SELECT total_changes() AS count').get() as { count: number }).count).toBe(changes);
    });
    await entered.promise;
    try {
      const shutdown = f.runtime.shutdown(); expect(f.runtime.shutdown()).toBe(shutdown);
      for (const [name, run] of gatedOperations(f)) await expect(run(), name).rejects.toThrow('cancelled');
      expect(f.counts.callback).toBe(0); expect(f.counts.close).toBe(0);
      release.resolve(); await lease; await shutdown;
      expect(f.counts.close).toBe(1);
      for (const [name, run] of gatedOperations(f)) await expect(run(), name).rejects.toThrow('shut down');
      expect(f.counts.callback).toBe(0); expect(f.counts.close).toBe(1);
    } finally { release.resolve(); await lease; }
  });

  it('real preload and default registrars preserve list/write receipts, sender/schema refusal and payload-free Friday reads', async () => {
    const f = fixture(); await f.runtime.initialize(); const owner = await seedReady(f);
    const forbidden = vi.fn(async (): Promise<never> => { throw Error('Unrequested fixture capability'); });
    const unregister = registerApplicationIpc(f.gate, undefined, undefined,
      { status: forbidden, pollNow: forbidden, retry: forbidden, setHmacSalt: forbidden },
      { status: forbidden, beginSetup: forbidden, saveSetupMaterial: forbidden, completeSetup: forbidden, selectAndRunRestoreDrill: forbidden });
    let sender: { senderFrame?: { url: string } } = { senderFrame: { url: 'callie://app/index.html' } };
    const invoke = vi.fn(async (channel: string, ...args: unknown[]) =>
      Reflect.apply(registeredIpcHandler(electron.handle, channel), undefined, [sender, ...args]) as unknown);
    const api = createCallieApi({ invoke });
    const unrelated = await f.runtime.withDatabase(db => {
      const prospect = seedProspect(db.raw, 'unrelated');
      return { ...prospect, ...insertOpenCycleWithAction({ database: db.raw, prefix: 'unrelated', prospect }) };
    });
    const unrelatedFacts = () => f.runtime.withDatabase(db => ({
      people: db.raw.prepare('SELECT * FROM persons WHERE id = ?').all(unrelated.personId),
      prospects: db.raw.prepare('SELECT * FROM prospects WHERE person_id = ? ORDER BY id').all(unrelated.personId),
      cycles: db.raw.prepare('SELECT * FROM sales_cycles WHERE person_id = ? ORDER BY id').all(unrelated.personId),
      actions: db.raw.prepare('SELECT * FROM next_actions WHERE sales_cycle_id IN (SELECT id FROM sales_cycles WHERE person_id = ?) ORDER BY id').all(unrelated.personId),
      sources: db.raw.prepare('SELECT * FROM source_events WHERE person_id = ? ORDER BY id').all(unrelated.personId),
    }));
    const unrelatedBefore = await unrelatedFacts();
    const unrelatedRowsBefore = (await api.leads.list({ ...listRequest, query: 'Person unrelated-person' })).rows;
    expect(unrelatedRowsBefore.map(row => row.personId)).toEqual([unrelated.personId]);
    for (const records of Object.values(unrelatedBefore)) expect(records).toHaveLength(1);
    try {
      const listed = await api.leads.list({ ...listRequest, query: 'Person ready-person' });
      expect(listed.rows.map(row => row.personId)).toEqual([owner.personId]);
      const update = { personId: owner.personId, field: 'person_name' as const, value: 'Public Fictional Owner' };
      await receipt(f, await api.leads.updateField(update), [owner.personId], [owner.cycleId]);
      expect(await f.runtime.withDatabase(db => db.raw.prepare('SELECT display_name FROM persons WHERE id = ?').get(owner.personId))).toEqual({ display_name: update.value });
      expect(await unrelatedFacts()).toEqual(unrelatedBefore);
      expect((await api.leads.list({ ...listRequest, query: 'Person unrelated-person' })).rows).toEqual(unrelatedRowsBefore);
      const before = await revision(f), callbacks = f.counts.callback;
      for (const badSender of [{ senderFrame: { url: 'https://untrusted.invalid/' } }, {}]) {
        sender = badSender;
        await expect(api.leads.list(listRequest)).rejects.toThrow('trusted renderer');
        await expect(api.leads.updateField({ ...update, value: 'Must not write' })).rejects.toThrow('trusted renderer');
      }
      sender = { senderFrame: { url: 'callie://app/index.html' } };
      const callsBeforeMalformedPreload = invoke.mock.calls.length;
      await expect(api.leads.updateField({ ...update, field: 'opted_out' } as never)).rejects.toThrow();
      expect(invoke.mock.calls).toHaveLength(callsBeforeMalformedPreload);
      await expect(invoke('leads:update-field', { ...update, extra: true })).rejects.toThrow();
      await expect(invoke('leads:list', { ...listRequest, limit: 0 })).rejects.toThrow();
      expect(f.counts.callback).toBe(callbacks); expect(await revision(f)).toBe(before);
      const start = invoke.mock.calls.length;
      const noPayload = await api.friday.getCurrent();
      const zero = await api.friday.getCurrent({ weekOffset: 0 });
      expect(zero).toEqual(noPayload);
      expect(invoke.mock.calls.slice(start)).toEqual([['friday:get'], ['friday:get', { weekOffset: 0 }]]);
      const beforeBadFriday = f.counts.callback;
      await expect(invoke('friday:get', undefined)).rejects.toThrow();
      await expect(invoke('friday:get', { weekOffset: 0 }, { weekOffset: 0 })).rejects.toThrow('at most one');
      expect(f.counts.callback).toBe(beforeBadFriday);
      expect(await unrelatedFacts()).toEqual(unrelatedBefore);
      expect((await api.leads.list({ ...listRequest, query: 'Person unrelated-person' })).rows).toEqual(unrelatedRowsBefore);
      expect(await f.runtime.withDatabase(db => db.raw.prepare('SELECT display_name FROM persons WHERE id = ?').get(owner.personId))).toEqual({ display_name: update.value });
      expect(forbidden).not.toHaveBeenCalled();
    } finally { unregister(); unregister(); }
    const registered = electron.handle.mock.calls.map(call => call[0]);
    expect(new Set(registered).size).toBe(registered.length);
    expect(electron.removeHandler.mock.calls.map(call => call[0]).sort()).toEqual([...registered].sort());
  });
});
