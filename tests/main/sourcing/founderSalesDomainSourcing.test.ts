import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../../src/main/db/database';
import { migrateToLatest } from '../../../src/main/db/migrate';
import {
  createDomainServices,
  type DomainServices,
} from '../../../src/main/domain/createDomainServices';
import {
  createFounderSalesDomain,
  type FounderSalesDomain,
} from '../../../src/main/domain/founderSalesDomain';
import {
  BUILTIN_PRIORITIZATION_RULE_V1,
} from '../../../src/main/domain/prioritization/builtinPrioritizationRules';
import { mapCloudSourceEvent } from '../../../src/main/sourcing/intakeMapper';
import { validParcelEvent } from '../../fixtures/cloudSourceEvents';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../../fixtures/tempDatabase';

const NOW = '2026-08-31T15:00:00.000Z';

class SequentialIds {
  private counter = 0;

  next(): string {
    this.counter += 1;
    return `generated-${this.counter}`;
  }
}

describe('FounderSalesDomain sourcing facade', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let services: DomainServices;
  let domain: FounderSalesDomain;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`, workspaceKey: key,
    });
    const clock = { now: () => NOW };
    const ids = new SequentialIds();
    services = createDomainServices({ database, clock, ids });
    services.unitOfWork.immediate(() => {
      const installed = services.prioritizationRepository
        .installRuleVersion(BUILTIN_PRIORITIZATION_RULE_V1);
      services.prioritizationRepository.activateRuleVersion({
        ruleVersionId: installed.id, expectedActiveRuleVersionId: null,
      });
      services.cadences.installBuiltins();
    });
    domain = createFounderSalesDomain({ services, database, clock, ids });
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  it('reads a null cursor before the first poll and round-trips updates', () => {
    expect(domain.getSourcingCursor()).toEqual({ lastKey: null, polledAt: null });

    domain.recordSourcingPoll({ lastKey: 'events/2026-09-01/a.ndjson' });
    expect(domain.getSourcingCursor()).toEqual({
      lastKey: 'events/2026-09-01/a.ndjson',
      polledAt: NOW,
    });

    domain.recordSourcingPoll({ lastKey: 'events/2026-09-01/b.ndjson' });
    expect(domain.getSourcingCursor()).toEqual({
      lastKey: 'events/2026-09-01/b.ndjson',
      polledAt: NOW,
    });
    expect(database.raw.prepare<[], { count: number }>(
      'SELECT COUNT(*) AS count FROM sourcing_cursor',
    ).get()).toEqual({ count: 1 });
  });

  it('imports a cloud event once: intake, unreviewed cycle, entity link', () => {
    const event = validParcelEvent();
    const mapped = mapCloudSourceEvent(event);
    if (mapped.kind !== 'intake') throw new Error('expected intake');

    const result = domain.importCloudSourceEvent({
      command: mapped.command,
      cloudEntityId: mapped.cloudEntityId,
    });

    expect(result.disposition).toBe('created');
    expect(database.raw.prepare<[], { stage: string; workflow_status: string }>(
      'SELECT stage, workflow_status FROM sales_cycles',
    ).all()).toEqual([{ stage: 'unreviewed', workflow_status: 'active' }]);
    expect(database.raw.prepare<[], { cloud_entity_id: string; person_id: string }>(
      'SELECT cloud_entity_id, person_id FROM cloud_entity_links',
    ).all()).toEqual([{
      cloud_entity_id: event.entity.cloud_entity_id,
      person_id: result.personId,
    }]);

    const replay = domain.importCloudSourceEvent({
      command: mapped.command,
      cloudEntityId: mapped.cloudEntityId,
    });

    // The replay returns the stored receipt, flagged so counters can tell
    // a re-read from a fresh import.
    expect(result.replayed).toBe(false);
    expect(replay).toEqual({ ...result, replayed: true });
    expect(database.raw.prepare<[], { count: number }>(
      'SELECT COUNT(*) AS count FROM sales_cycles',
    ).get()).toEqual({ count: 1 });
    expect(database.raw.prepare<[], { count: number }>(
      'SELECT COUNT(*) AS count FROM cloud_entity_links',
    ).get()).toEqual({ count: 1 });
    expect(database.raw.prepare<[], { count: number }>(
      'SELECT COUNT(*) AS count FROM persons',
    ).get()).toEqual({ count: 1 });
  });
});
