import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../../src/main/db/database';
import { createMigrationRunner, migrateToLatest, productionMigrations } from '../../../src/main/db/migrate';
import { createDomainServices, type DomainServices } from '../../../src/main/domain/createDomainServices';
import { createFounderSalesDomain, type FounderSalesDomain } from '../../../src/main/domain/founderSalesDomain';
import { IntakeReceiptIntegrityError } from '../../../src/main/domain/source/intakeReceiptRepository';
import { IntakeIdempotencyConflictError } from '../../../src/main/domain/source/sourceService';
import { LegacyWorkflowTransition } from '../../../src/main/domain/workspace/legacyWorkflowTransition';
import { mapCloudSourceEvent } from '../../../src/main/sourcing/intakeMapper';
import { validParcelEvent } from '../../fixtures/cloudSourceEvents';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../../fixtures/tempDatabase';

const NOW = '2026-09-09T12:00:00.000Z';
const clock = { now: () => NOW };
const migrateSchema7 = createMigrationRunner(productionMigrations.filter(({ schemaVersion }) => schemaVersion <= 7));

function syntheticInput(key: string) {
  const event = validParcelEvent();
  event.idempotency_key = key.repeat(64);
  event.entity.cloud_entity_id = `ce_01JC00000000000000000000${key.toUpperCase().repeat(2)}`;
  event.entity.person = {
    ...event.entity.person!, full_name: 'SYNTHETIC REPLAY OWNER LLC', phones: [], emails: [], org_names: [],
  };
  event.entity.property = null;
  const mapped = mapCloudSourceEvent(event);
  if (mapped.kind !== 'intake') throw new Error('Expected synthetic person intake');
  return { command: mapped.command, cloudEntityId: mapped.cloudEntityId };
}

const firstInput = syntheticInput('a');
const secondInput = syntheticInput('b');

describe('FounderSalesDomain migrated cloud replay', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let services: DomainServices;
  let domain: FounderSalesDomain;
  let options: { backupDirectory: string; workspaceKey: ReturnType<typeof createTestWorkspaceKey> };
  let ids: { next(): string };

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    options = { backupDirectory: `${temp.path}.backups`, workspaceKey: key };
    database = openDatabase({ path: temp.path, key });
    await migrateSchema7(database, options);
    let counter = 0;
    ids = { next: () => `synthetic-${++counter}` };
    services = createDomainServices({ database, clock, ids });
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  async function latest() {
    await migrateToLatest(database, options);
    services = createDomainServices({ database, clock, ids });
    services.unitOfWork.immediate(() => services.cadences.installBuiltins());
    domain = createFounderSalesDomain({ database, services, clock, ids });
  }

  function rows(table: string) {
    return database.raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
  }

  function lifecycleSnapshot() {
    return Object.fromEntries([
      'sales_cycles', 'next_actions', 'stage_events', 'cadence_enrollments',
      'cadence_action_components', 'source_intake_receipts',
    ].map(table => [table, rows(table)]));
  }

  // Reproduce the schema7 importer boundary: real SourceService generates the
  // canonical commands/receipts, bypassing only today's cloud identity resolver.
  // Historical cycle rows use the same minimal SQL pattern as migration tests.
  function seedSchema7Import(input: ReturnType<typeof syntheticInput>, prefix: string) {
    const result = services.sources.createPersonProspect(input.command);
    expect(result.disposition).toBe('created');
    database.raw.prepare('INSERT INTO cloud_entity_links(cloud_entity_id, person_id, linked_at) VALUES (?, ?, ?)')
      .run(input.cloudEntityId, result.personId, NOW);
    services.unitOfWork.immediate(() => {
      database.raw.prepare(`INSERT INTO sales_cycles (
        id, person_id, prospect_id, entry_source_event_id, stage, workflow_status,
        current_next_action_id, stage_entered_at, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'unreviewed', 'active', ?, ?, 1, ?, ?)`)
        .run(`${prefix}-cycle`, result.personId, result.prospectId, result.sourceEventId, `${prefix}-action`, NOW, NOW, NOW);
      database.raw.prepare(`INSERT INTO next_actions (
        id, sales_cycle_id, action_type, status, due_at, timezone, work_intent, created_at
      ) VALUES (?, ?, 'review_lead', 'pending', ?, 'America/New_York', 'internal_review', ?)`)
        .run(`${prefix}-action`, `${prefix}-cycle`, NOW, NOW);
      database.raw.prepare(`INSERT INTO stage_events (
        id, sales_cycle_id, from_stage, to_stage, effective_at, confirmed_at,
        confirmation_kind, transition_sequence, created_at
      ) VALUES (?, ?, NULL, 'unreviewed', ?, ?, 'mechanical', 1, ?)`)
        .run(`${prefix}-stage`, `${prefix}-cycle`, NOW, NOW, NOW);
    });
    return result;
  }

  async function migratedPair() {
    const first = seedSchema7Import(firstInput, 'first');
    const second = seedSchema7Import(secondInput, 'second');
    expect(first.personId).not.toBe(second.personId);
    expect(rows('sales_cycles')).toHaveLength(2);
    await latest();
    expect(rows('persons')).toHaveLength(1);
    expect(rows('prospects')).toHaveLength(1);
    expect(rows('sales_cycles')).toHaveLength(1);
    expect(rows('sales_cycles')[0]).toMatchObject({ id: 'first-cycle', entry_source_event_id: first.sourceEventId });
    for (const input of [firstInput, secondInput]) {
      expect(services.intakeReceipts.getBySourceEventId(input.command.source.id)?.result).toMatchObject({
        disposition: 'created', personId: first.personId, prospectId: first.prospectId,
        sourceEventId: input.command.source.id,
      });
    }
    return first;
  }

  // Break caught: checking only entry source recreates the removed duplicate's
  // lifecycle. A status-filtered guard would also recreate closed history.
  it.each(['active', 'onboarding', 'closed', 'meeting-first parked'] as const)(
    'replays both migrated sources without changing %s lifecycle or receipt bytes', async (state) => {
      const first = await migratedPair();
      if (state === 'onboarding') {
        database.raw.prepare("UPDATE sales_cycles SET stage='won', workflow_status='onboarding' WHERE id='first-cycle'").run();
      } else if (state === 'closed') {
        const cycle = database.raw.prepare('SELECT version, current_next_action_id FROM sales_cycles WHERE id = ?')
          .get('first-cycle') as { version: number; current_next_action_id: string };
        services.lifecycle.closeLostNurture({
          cycleId: 'first-cycle', expectedCycleVersion: cycle.version, expectedCurrentActionId: cycle.current_next_action_id,
          reason: 'no_response', qualificationGateReason: null, notes: null, effectiveAt: NOW,
          manualReactivationDueAt: '2026-10-01T13:00:00.000Z',
          expectedProspectVersion: null,
        });
      } else if (state === 'meeting-first parked') {
        const manifest = new LegacyWorkflowTransition({ database, unitOfWork: services.unitOfWork, clock, ids })
          .transitionWorkflow({ commandId: 'synthetic-transition', manifestId: 'synthetic-manifest', expectedMode: 'legacy' });
        expect(manifest.parkedPersonIds).toEqual([first.personId]);
        expect(rows('sales_cycles')[0]).toMatchObject({ workflow_status: 'active' });
      }
      const before = lifecycleSnapshot();
      for (const input of [firstInput, secondInput]) {
        expect(domain.importCloudSourceEvent(input)).toMatchObject({
          disposition: 'created', personId: first.personId, prospectId: first.prospectId,
          sourceEventId: input.command.source.id, replayed: true,
        });
      }
      expect(lifecycleSnapshot()).toEqual(before);
    },
  );

  it.each([false, true])('recovers a valid receipt-only partial import once (unrelated lifecycle: %s)', async (unrelatedLifecycle) => {
    await latest();
    if (unrelatedLifecycle) {
      const unrelated = syntheticInput('d');
      unrelated.command.person.displayName = 'UNRELATED SYNTHETIC OWNER';
      domain.importCloudSourceEvent(unrelated);
    }
    const initialCycles = rows('sales_cycles').length;
    const initialActions = rows('next_actions').length;
    const initialStageEvents = rows('stage_events').length;
    const receipt = services.sources.createPersonProspect(firstInput.command);
    const receiptBytes = rows('source_intake_receipts');
    expect(domain.importCloudSourceEvent(firstInput)).toEqual({ ...receipt, replayed: true });
    expect(rows('sales_cycles')).toHaveLength(initialCycles + 1);
    expect(rows('next_actions')).toHaveLength(initialActions + 1);
    expect(rows('stage_events')).toHaveLength(initialStageEvents + 1);
    expect(rows('sales_cycles').at(-1)).toMatchObject({
      person_id: receipt.personId, prospect_id: receipt.prospectId, entry_source_event_id: receipt.sourceEventId,
    });
    expect(rows('source_intake_receipts')).toEqual(receiptBytes);
    const recovered = lifecycleSnapshot();
    expect(domain.importCloudSourceEvent(firstInput)).toEqual({ ...receipt, replayed: true });
    expect(lifecycleSnapshot()).toEqual(recovered);
  });

  it('recovers a missing cloud link without duplicating the canonical lifecycle', async () => {
    const first = await migratedPair();
    database.raw.prepare('DELETE FROM cloud_entity_links WHERE cloud_entity_id = ?').run(secondInput.cloudEntityId);
    const before = lifecycleSnapshot();
    expect(domain.importCloudSourceEvent(secondInput)).toMatchObject({ personId: first.personId, replayed: true });
    expect(rows('cloud_entity_links')).toHaveLength(2);
    expect(database.raw.prepare('SELECT person_id FROM cloud_entity_links WHERE cloud_entity_id = ?').get(secondInput.cloudEntityId))
      .toEqual({ person_id: first.personId });
    expect(lifecycleSnapshot()).toEqual(before);
  });

  it('appends a distinct source as context without another lifecycle', async () => {
    const first = await migratedPair();
    const before = lifecycleSnapshot();
    const result = domain.importCloudSourceEvent(syntheticInput('c'));
    expect(result).toMatchObject({ disposition: 'matched_existing', personId: first.personId, prospectId: first.prospectId, replayed: false });
    expect(rows('source_events')).toHaveLength(3);
    expect(rows('source_intake_receipts')).toHaveLength(3);
    const after = lifecycleSnapshot();
    expect({ ...after, source_intake_receipts: before.source_intake_receipts }).toEqual(before);
    expect(rows('source_intake_receipts').slice(0, 2)).toEqual(before.source_intake_receipts);
  });

  it('rejects changed same-key payload before lifecycle handling', async () => {
    await migratedPair();
    const before = lifecycleSnapshot();
    const changed = structuredClone(secondInput);
    changed.command.person.displayName = 'DIFFERENT SYNTHETIC OWNER';
    expect(() => domain.importCloudSourceEvent(changed)).toThrow(IntakeIdempotencyConflictError);
    expect(lifecycleSnapshot()).toEqual(before);
  });

  it('rejects corrupt receipt ownership before lifecycle handling', async () => {
    await migratedPair();
    // Deliberate corruption is confined to this disposable database. Restore
    // the immutability trigger immediately so replay runs with normal guards.
    const trigger = database.raw.prepare("SELECT sql FROM sqlite_master WHERE name='immutable_source_intake_receipts'")
      .get() as { sql: string };
    database.raw.exec('DROP TRIGGER immutable_source_intake_receipts');
    database.raw.prepare('UPDATE source_intake_receipts SET result_json = json_set(result_json, \'$.result.personId\', \'wrong-owner\') WHERE source_event_id = ?')
      .run(secondInput.command.source.id);
    database.raw.exec(trigger.sql);
    const before = lifecycleSnapshot();
    expect(() => domain.importCloudSourceEvent(secondInput)).toThrow(IntakeReceiptIntegrityError);
    expect(() => domain.importCloudSourceEvent(secondInput)).toThrow(expect.objectContaining({
      reason: 'result_ownership_mismatch', sourceEventId: secondInput.command.source.id,
    }));
    expect(lifecycleSnapshot()).toEqual(before);
  });
});
