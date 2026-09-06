import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { createDomainServices, type DomainServices } from '../../src/main/domain/createDomainServices';
import { outboundIntentFingerprint } from '../../src/main/communications/contactSnapshot';
import {
  OutboundCommandRepository, type OutboundCommandFact,
} from '../../src/main/domain/outbound/outboundCommandRepository';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import {
  DomainRepositoryDatabaseMismatchError, DomainTransactionRequiredError,
} from '../../src/main/domain/support/domainErrors';
import type { OutboundRequest } from '../../src/shared/contracts/outboundContract';
import { insertOpenCycleWithAction, seedProspect } from '../fixtures/domainRows';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';

const NOW = '2026-09-04T14:00:00.000Z';
const commandId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const request: OutboundRequest = {
  commandId: commandId(1), channel: 'call', personId: 'owner-person',
  salesCycleId: 'owner-cycle', contactMethodId: 'owner-phone', expectedContactSnapshot: 'a'.repeat(64),
};

describe('OutboundCommandRepository encrypted command ledger', () => {
  let temp: TempDatabase;
  let database: AppDatabase;
  let services: DomainServices;
  let repository: OutboundCommandRepository;
  let sequence: number;

  function compose() {
    services = createDomainServices({ database, clock: { now: () => NOW }, ids: { next: () => `event-${++sequence}` } });
    repository = new OutboundCommandRepository({ database, unitOfWork: services.unitOfWork, events: services.events });
  }
  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, { backupDirectory: `${temp.path}.backups`, workspaceKey: key });
    sequence = 0;
    compose();
    for (const prefix of ['owner', 'other']) {
      const prospect = seedProspect(database.raw, prefix);
      insertOpenCycleWithAction({ database: database.raw, prospect, prefix });
    }
  });
  afterEach(() => { vi.restoreAllMocks(); closeDatabase(database); temp.cleanup(); });

  const fact = (phase: OutboundCommandFact['phase'], overrides: Partial<OutboundCommandFact> = {}): OutboundCommandFact => ({
    request, phase, reasonCode: phase === 'unknown' ? 'handoff_uncertain' : null, occurredAt: NOW, ...overrides,
  });
  const append = (value: OutboundCommandFact) => services.unitOfWork.immediate(() => repository.append(value, 'owner-prospect'));
  const rows = () => database.raw.prepare("SELECT * FROM activities WHERE adapter = 'callie_outbound_v1' ORDER BY rowid").all();
  // Deliberately corrupt only a disposable fixture, without disabling immutable triggers.
  function inject(value: OutboundCommandFact, patch: Record<string, unknown> = {}, metadataPatch: Record<string, unknown> = {}) {
    const metadata = {
      version: 1, request: value.request, intentFingerprint: outboundIntentFingerprint(value.request),
      phase: value.phase, reasonCode: value.reasonCode, ...metadataPatch,
    };
    const row = {
      id: `injected-${++sequence}`, person_id: value.request.personId, prospect_id: 'owner-prospect',
      sales_cycle_id: value.request.salesCycleId, kind: 'system', direction: 'internal', channel: 'outbound_command',
      occurred_at: value.occurredAt, created_at: NOW, adapter: 'callie_outbound_v1',
      provider_idempotency_key: `${value.request.commandId}:${value.phase}`, metadata_json: JSON.stringify(metadata),
      ...patch,
    };
    const columns = Object.keys(row);
    database.raw.prepare(`INSERT INTO activities (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
      .run(...Object.values(row));
  }

  const association = { commandId: request.commandId, personId: request.personId, salesCycleId: request.salesCycleId, channel: request.channel };
  function manual(patch: Record<string, unknown> = {}, metadataPatch: Record<string, unknown> = {}) {
    inject(fact('requested'), { adapter: 'callie_manual_outbound_v1', provider_idempotency_key: request.commandId,
      kind: 'call', direction: 'outbound', channel: 'phone', observed_outcome: 'no_answer',
      metadata_json: JSON.stringify({ formatVersion: 1, loggedVia: 'founder_workflow_ui', summary: 'Reported call',
        outboundCommandId: request.commandId, loggedManually: true, currentBlockPresent: false,
        prohibitedPastTouchReported: false, prohibitionAssessment: 'unknown', ...metadataPatch }), ...patch });
  }

  it('resolves canonical manual evidence by exact indexed command key without changing unknown execution', () => {
    append(fact('requested')); append(fact('dispatching')); append(fact('unknown'));
    expect(repository.resolveManualAssociation(association)).toBeNull();
    manual();
    const before = rows();
    const activity = repository.resolveManualAssociation(association);
    expect(activity).toMatchObject({ kind: 'call', observedOutcome: 'no_answer', providerIdempotencyKey: request.commandId });
    expect(repository.listRecent(request.personId, 20)[0]).toMatchObject({ status: 'unknown', manualActivityId: activity!.id });
    expect(repository.read(request)).toEqual({ phase: 'unknown', reasonCode: 'handoff_uncertain' });
    expect(rows()).toEqual(before);
  });

  it('rejects a manually tagged opted-out row without its canonical atomic closure receipt', () => {
    append(fact('requested')); append(fact('dispatching'));
    manual({ observed_outcome: 'opted_out' }, { loggedVia: 'call_outcome', summary: undefined });
    expect(() => repository.resolveManualAssociation(association)).toThrow(expect.objectContaining({ reasonCode: 'command_evidence_invalid' }));
  });

  it.each(['person', 'cycle', 'channel', 'requested', 'refused', 'unavailable', 'missing'] as const)('rejects unsafe association lookup %s', (variant) => {
    if (variant !== 'missing') append(fact('requested'));
    if (!['missing', 'requested', 'refused', 'unavailable'].includes(variant)) append(fact('dispatching'));
    if (variant === 'refused' || variant === 'unavailable') append(fact(variant, { reasonCode: 'stale_contact' }));
    expect(() => repository.resolveManualAssociation({ ...association,
      ...(variant === 'person' ? { personId: 'other-person' } : {}),
      ...(variant === 'cycle' ? { salesCycleId: 'other-cycle' } : {}),
      ...(variant === 'channel' ? { channel: 'text' as const } : {}),
    })).toThrow(expect.objectContaining({ reasonCode: 'command_conflict' }));
  });

  it.each([
    { person_id: 'other-person', sales_cycle_id: 'other-cycle', prospect_id: 'other-prospect' },
    { channel: ' phone ' }, { id: ' padded ' }, { observed_outcome: 'x'.repeat(201) },
    { kind: 'text', channel: 'text' }, { direction: 'inbound' }, { provider_reference: 'not-manual' },
    { metadata_json: '{' }, { metadata_json: JSON.stringify({ loggedManually: true }) },
  ])('fails closed on malformed/noncanonical manual row %j', (patch) => {
    append(fact('requested')); append(fact('dispatching')); manual(patch);
    expect(() => repository.resolveManualAssociation(association)).toThrow(expect.objectContaining({ reasonCode: 'command_evidence_invalid' }));
    expect(() => repository.listRecent(request.personId, 20)).toThrow(expect.objectContaining({ reasonCode: 'command_evidence_invalid' }));
  });

  it('requires the exact active UOW and rejects mixed bindings before reads', () => {
    expect(() => repository.append(fact('requested'), 'owner-prospect')).toThrow(DomainTransactionRequiredError);
    const otherUnit = new DomainUnitOfWork(database);
    expect(() => otherUnit.immediate(() => repository.append(fact('requested'), 'owner-prospect')))
      .toThrow(DomainTransactionRequiredError);
    const prepare = vi.spyOn(database.raw, 'prepare');
    expect(() => new OutboundCommandRepository({ database, unitOfWork: otherUnit, events: services.events }))
      .toThrow(DomainRepositoryDatabaseMismatchError);
    expect(() => repository.assertBoundTo(database, otherUnit)).toThrow(DomainRepositoryDatabaseMismatchError);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('constructs and binds the composed repository without queries, clock reads or IDs', () => {
    const clock = { now: vi.fn(() => NOW) };
    const ids = { next: vi.fn(() => 'unused') };
    const prepare = vi.spyOn(database.raw, 'prepare');
    const composed = createDomainServices({ database, clock, ids });
    expect(composed.outboundCommands).toBeInstanceOf(OutboundCommandRepository);
    composed.outboundCommands.assertBoundTo(database, composed.unitOfWork);
    expect(prepare).not.toHaveBeenCalled();
    expect(clock.now).not.toHaveBeenCalled();
    expect(ids.next).not.toHaveBeenCalled();
  });

  it('appends only strict private system facts and deduplicates exact phases', () => {
    expect(repository.read(request)).toBeNull();
    append(fact('requested'));
    append(fact('dispatching'));
    append(fact('handoff_accepted'));
    append(fact('handoff_accepted'));
    expect(repository.read(request)).toEqual({ phase: 'handoff_accepted', reasonCode: null });
    const stored = rows() as Array<Record<string, unknown>>;
    expect(stored).toHaveLength(3);
    expect(stored.map((row) => row.provider_idempotency_key)).toEqual([
      `${request.commandId}:requested`, `${request.commandId}:dispatching`, `${request.commandId}:handoff_accepted`,
    ]);
    for (const row of stored) {
      expect(row).toMatchObject({ kind: 'system', direction: 'internal', channel: 'outbound_command',
        observed_outcome: null, duration_seconds: null, provider_reference: null, cadence_component_id: null });
      expect(Object.keys(JSON.parse(row.metadata_json as string)).sort())
        .toEqual(['intentFingerprint', 'phase', 'reasonCode', 'request', 'version']);
    }
    expect(JSON.stringify(stored)).not.toMatch(/canonicalPhone|normalizedValue|rawValue|body|providerError/);
  });

  it.each(['requested', 'dispatching'] as const)('projects unresolved %s as unknown, never queued work', (phase) => {
    append(fact('requested'));
    if (phase === 'dispatching') append(fact(phase));
    expect(repository.read(request)).toEqual({ phase, reasonCode: null });
    expect(repository.listRecent(request.personId, 20)).toEqual([{
      commandId: request.commandId, channel: 'call', contactMethodId: 'owner-phone', requestedAt: NOW,
      manualActivityId: null, status: 'unknown', reasonCode: 'handoff_uncertain',
    }]);
  });

  it('reopens the actual encrypted fixture with the same terminal state and no new facts', () => {
    append(fact('requested')); append(fact('dispatching')); append(fact('unknown'));
    const before = rows();
    closeDatabase(database);
    expect(readFileSync(temp.path).subarray(0, 16).toString()).not.toBe('SQLite format 3\0');
    database = openDatabase({ path: temp.path, key: createTestWorkspaceKey() });
    compose();
    expect(repository.read(request)).toEqual({ phase: 'unknown', reasonCode: 'handoff_uncertain' });
    append(fact('unknown'));
    expect(rows()).toEqual(before);
  });

  it.each([
    { personId: 'other-person' }, { salesCycleId: 'other-cycle' }, { contactMethodId: 'other-phone' },
    { channel: 'text' as const }, { expectedContactSnapshot: 'b'.repeat(64) },
  ])('rejects changed intent without leaking or appending a competing fact: %j', (patch) => {
    append(fact('requested'));
    const before = rows();
    const changed = { ...request, ...patch };
    for (const operation of [() => repository.read(changed), () => append(fact('refused', { request: changed, reasonCode: 'outbound_busy' }))]) {
      expect(operation).toThrow(expect.objectContaining({ reasonCode: 'command_conflict', message: 'Outbound command conflicts with existing intent.' }));
    }
    expect(rows()).toEqual(before);
  });

  it.each([
    ['dispatching'], ['handoff_accepted'], ['requested', 'handoff_accepted'],
    ['dispatching', 'requested'], ['requested', 'unknown'],
    ['requested', 'refused', 'dispatching'], ['requested', 'dispatching', 'unknown', 'handoff_accepted'],
  ] as OutboundCommandFact['phase'][][])('fails closed on missing/out-of-order/competing phases: %j', (...phases) => {
    for (const phase of phases) inject(fact(phase, { reasonCode: phase === 'refused' ? 'outbound_busy' : phase === 'unknown' ? 'handoff_uncertain' : null }));
    expect(() => repository.read(request)).toThrow(expect.objectContaining({ reasonCode: 'command_evidence_invalid' }));
    const before = rows();
    expect(() => append(fact('dispatching'))).toThrow();
    expect(rows()).toEqual(before);
  });

  it.each([
    { kind: 'call' }, { direction: 'outbound' }, { channel: 'phone' },
    { person_id: 'other-person', prospect_id: 'other-prospect', sales_cycle_id: 'other-cycle' },
    { prospect_id: null }, { observed_outcome: 'delivered' }, { provider_reference: 'raw provider reply' },
    { metadata_json: '{invalid' }, { metadata_json: ' '.repeat(20_000) },
    { occurred_at: 'not-a-date' }, { created_at: 'not-a-date' },
  ])('validates every row, not just a good latest terminal: %j', (patch) => {
    inject(fact('requested'), patch); inject(fact('dispatching')); inject(fact('handoff_accepted'));
    expect(() => repository.read(request)).toThrow(expect.objectContaining({ reasonCode: 'command_evidence_invalid' }));
  });

  it.each([
    { version: 2 }, { phase: 'dispatching' }, { intentFingerprint: 'b'.repeat(64) },
    { reasonCode: 'outbound_busy' }, { target: '+14015550100' },
    { request: { ...request, contactMethodId: 'changed' } },
  ])('rejects strict metadata corruption in an earlier fact: %j', (metadataPatch) => {
    inject(fact('requested'), {}, metadataPatch); inject(fact('dispatching')); inject(fact('handoff_accepted'));
    expect(() => repository.read(request)).toThrow(expect.objectContaining({ reasonCode: 'command_evidence_invalid' }));
  });

  it('rejects regressing business timestamps and mismatched prospect ownership', () => {
    append(fact('requested'));
    expect(() => append(fact('dispatching', { occurredAt: '2026-09-04T13:59:59.000Z' }))).toThrow();
    expect(() => services.unitOfWork.immediate(() => repository.append(fact('dispatching'), 'other-prospect'))).toThrow();
    expect(rows()).toHaveLength(1);
  });

  it.each([
    { contactMethodId: 'another-contact' }, { expectedContactSnapshot: 'b'.repeat(64) }, { channel: 'text' as const },
  ])('rejects coherent per-fact fingerprints that disagree across the command: %j', (patch) => {
    inject(fact('requested'));
    inject(fact('dispatching', { request: { ...request, ...patch } }));
    inject(fact('handoff_accepted'));
    const before = rows();
    expect(() => repository.read(request)).toThrow(expect.objectContaining({ reasonCode: 'command_evidence_invalid' }));
    expect(() => append(fact('unknown'))).toThrow(expect.objectContaining({ reasonCode: 'command_evidence_invalid' }));
    expect(rows()).toEqual(before);
  });

  it.each([
    { phase: 'refused', reasonCode: null }, { phase: 'requested', reasonCode: 'outbound_busy' },
    { phase: 'handoff_accepted', reasonCode: 'handoff_uncertain' },
    { phase: 'refused', reasonCode: 'raw provider error' }, { phase: 'requested', body: 'private draft' },
  ])('rejects hostile fact envelopes with no persisted request: %j', (patch) => {
    expect(() => append({ ...fact('requested'), ...patch } as OutboundCommandFact))
      .toThrow(expect.objectContaining({ reasonCode: 'command_evidence_invalid' }));
    expect(rows()).toEqual([]);
  });

  it('rolls back requested insertion when its paired fact fails', () => {
    database.raw.exec(`CREATE TRIGGER reject_dispatch BEFORE INSERT ON activities
      WHEN NEW.provider_idempotency_key = '${request.commandId}:dispatching'
      BEGIN SELECT RAISE(ABORT, 'fixture dispatch failure'); END`);
    expect(() => services.unitOfWork.immediate(() => {
      repository.append(fact('requested'), 'owner-prospect');
      repository.append(fact('dispatching'), 'owner-prospect');
    })).toThrow('fixture dispatch failure');
    expect(rows()).toEqual([]);
  });

  it('limits logical commands to twenty then loads every phase in stable request-time/ID order', () => {
    for (let n = 1; n <= 25; n++) {
      const current = { ...request, commandId: commandId(n) };
      append(fact('requested', { request: current }));
      append(fact('dispatching', { request: current }));
      append(fact('handoff_accepted', { request: current }));
    }
    const recent = repository.listRecent(request.personId, 999);
    expect(recent).toHaveLength(20);
    expect(recent.map((item) => item.commandId)).toEqual(Array.from({ length: 20 }, (_, i) => commandId(i + 1)));
    expect(recent.every((item) => item.status === 'handoff_accepted')).toBe(true);
    expect(repository.listRecent(request.personId, 1)).toHaveLength(1);
    expect(repository.listRecent(request.personId, 0)).toEqual([]);
    expect(repository.listRecent('other-person', 20)).toEqual([]);
    // An additional terminal on command #20 must not be hidden by a phase-row LIMIT.
    inject(fact('unknown', { request: { ...request, commandId: commandId(20) } }));
    expect(() => repository.listRecent(request.personId, 20)).toThrow(expect.objectContaining({ reasonCode: 'command_evidence_invalid' }));
  });

  it('associates an older command outside the twenty-attempt projection through exact lookup, and projects the twentieth link', () => {
    for (let n = 1; n <= 25; n++) {
      const current = { ...request, commandId: commandId(n) };
      append(fact('requested', { request: current })); append(fact('dispatching', { request: current }));
    }
    for (const n of [20, 25]) manual({ provider_idempotency_key: commandId(n) }, { outboundCommandId: commandId(n) });
    const recent = repository.listRecent(request.personId, 20);
    expect(recent).toHaveLength(20);
    expect(recent.at(-1)).toMatchObject({ commandId: commandId(20), manualActivityId: expect.any(String), status: 'unknown' });
    expect(recent.slice(0, 19).every((item) => item.manualActivityId === null)).toBe(true);
    expect(repository.resolveManualAssociation({ ...association, commandId: commandId(25) })).not.toBeNull();
  });

  it('orders by request time, uses the exact indexed seam, and ignores later manual evidence', () => {
    append(fact('requested')); append(fact('dispatching')); append(fact('unknown'));
    const later = { ...request, commandId: commandId(2) };
    append(fact('requested', { request: later, occurredAt: '2026-09-04T14:01:00.000Z' }));
    manual();
    const prepare = vi.spyOn(database.raw, 'prepare');
    repository.read(request);
    const queries = prepare.mock.calls.map(([sql]) => sql);
    const factQuery = queries.find((sql) => sql.includes('provider_idempotency_key IN'));
    expect(factQuery).toBeDefined();
    const plan = database.raw.prepare(`EXPLAIN QUERY PLAN ${factQuery}`).all('callie_outbound_v1', ...[
      'requested', 'dispatching', 'handoff_accepted', 'refused', 'unavailable', 'unknown',
    ].map((phase) => `${request.commandId}:${phase}`));
    expect(JSON.stringify(plan)).toContain('activities_provider_idempotency_idx');
    const recent = repository.listRecent(request.personId, 20);
    expect(recent.map((item) => item.commandId)).toEqual([later.commandId, request.commandId]);
    expect(recent[1]).toMatchObject({ status: 'unknown', reasonCode: 'handoff_uncertain', manualActivityId: repository.resolveManualAssociation(association)!.id });
  });
});
