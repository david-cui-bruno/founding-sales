import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import {
  createDomainServices,
  type DomainServices,
} from '../../src/main/domain/createDomainServices';
import {
  createFounderSalesDomain,
  FounderSalesDomain,
} from '../../src/main/domain/founderSalesDomain';
import {
  BUILTIN_PRIORITIZATION_RULE_V1,
} from '../../src/main/domain/prioritization/builtinPrioritizationRules';
import { DOMAIN_TIMESTAMP, insertPerson } from '../fixtures/domainRows';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

const CLOCK_NOW = '2026-08-31T15:00:00.000Z';

class FixedClock {
  constructor(private value: string = CLOCK_NOW) {}

  now(): string {
    return this.value;
  }

  set(value: string): void {
    this.value = value;
  }
}

class SequentialIds {
  private counter = 0;

  next(): string {
    this.counter += 1;
    return `generated-${this.counter}`;
  }
}

function insertOptOut(database: AppDatabase, input: {
  personId: string;
  tombstoneId: string;
  observedChannel: string;
  handles: { id: string; kind: 'phone' | 'email'; value: string }[];
}): void {
  database.raw.prepare(`
    INSERT INTO activities (
      id, person_id, kind, direction, channel, occurred_at, metadata_json, created_at
    ) VALUES (?, ?, 'note', 'internal', 'manual', ?, '{}', ?)
  `).run(
    `activity-${input.tombstoneId}`, input.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP,
  );
  database.raw.prepare(`
    INSERT INTO opt_out_tombstones (
      id, person_id, requested_at, observed_channel, source_activity_id,
      evidence_ref, policy_version, created_at
    ) VALUES (?, ?, ?, ?, ?, NULL, 'founder_opt_out_v1', ?)
  `).run(
    input.tombstoneId, input.personId, DOMAIN_TIMESTAMP, input.observedChannel,
    `activity-${input.tombstoneId}`, DOMAIN_TIMESTAMP,
  );
  for (const handle of input.handles) {
    database.raw.prepare(`
      INSERT INTO opt_out_handles (id, tombstone_id, kind, normalized_value, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(handle.id, input.tombstoneId, handle.kind, handle.value, DOMAIN_TIMESTAMP);
  }
}

describe('suppression outbox domain surface', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let services: DomainServices;
  let clock: FixedClock;
  let domain: FounderSalesDomain;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`, workspaceKey: key,
    });
    clock = new FixedClock();
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

  it('sweeps opt-out handles into the outbox and marks flushed exactly once', () => {
    insertPerson(database.raw, 'person-1');
    insertOptOut(database, {
      personId: 'person-1',
      tombstoneId: 'tombstone-1',
      observedChannel: 'imessage',
      handles: [
        { id: 'handle-1', kind: 'phone', value: '+14015550100' },
        { id: 'handle-2', kind: 'email', value: 'owner@example.com' },
      ],
    });

    const rows = domain.listUnflushedSuppressionHandles();
    expect(rows).toEqual([
      {
        handleId: 'handle-1', kind: 'phone', normalizedValue: '+14015550100',
        reason: 'opt_out', observedAt: DOMAIN_TIMESTAMP,
      },
      {
        handleId: 'handle-2', kind: 'email', normalizedValue: 'owner@example.com',
        reason: 'opt_out', observedAt: DOMAIN_TIMESTAMP,
      },
    ]);

    // Re-listing before a flush is idempotent (INSERT OR IGNORE sweep).
    expect(domain.listUnflushedSuppressionHandles()).toHaveLength(2);

    domain.markSuppressionHandlesFlushed({ handleIds: ['handle-1', 'handle-2'] });
    expect(domain.listUnflushedSuppressionHandles()).toEqual([]);

    // Flushed rows stay flushed: a later sweep never re-enqueues them.
    domain.markSuppressionHandlesFlushed({ handleIds: ['handle-1'] });
    expect(domain.listUnflushedSuppressionHandles()).toEqual([]);
  });

  it("maps founder-entered ('manual') opt-outs to founder_block", () => {
    insertPerson(database.raw, 'person-2');
    insertOptOut(database, {
      personId: 'person-2',
      tombstoneId: 'tombstone-2',
      observedChannel: 'manual',
      handles: [{ id: 'handle-3', kind: 'phone', value: '+14015550101' }],
    });

    expect(domain.listUnflushedSuppressionHandles()).toEqual([{
      handleId: 'handle-3', kind: 'phone', normalizedValue: '+14015550101',
      reason: 'founder_block', observedAt: DOMAIN_TIMESTAMP,
    }]);
  });

  it('only new handles appear after a flush (exactly-once per handle)', () => {
    insertPerson(database.raw, 'person-3');
    insertOptOut(database, {
      personId: 'person-3',
      tombstoneId: 'tombstone-3',
      observedChannel: 'gmail',
      handles: [{ id: 'handle-4', kind: 'email', value: 'a@b.com' }],
    });
    domain.markSuppressionHandlesFlushed({
      handleIds: domain.listUnflushedSuppressionHandles().map((row) => row.handleId),
    });

    database.raw.prepare(`
      INSERT INTO opt_out_handles (id, tombstone_id, kind, normalized_value, created_at)
      VALUES ('handle-5', 'tombstone-3', 'phone', '+14015550102', ?)
    `).run(DOMAIN_TIMESTAMP);

    const rows = domain.listUnflushedSuppressionHandles();
    expect(rows.map((row) => row.handleId)).toEqual(['handle-5']);
  });

  it('records and reads the enrichment rate-limit timestamp', () => {
    domain.recordEnrichmentRequested({
      cloudEntityId: 'ce_01JC0000000000000000000000',
    });
    expect(database.raw.prepare<[], { last_requested_at: string }>(
      "SELECT last_requested_at FROM sourcing_enrichment_requests WHERE cloud_entity_id = 'ce_01JC0000000000000000000000'",
    ).get()).toEqual({ last_requested_at: CLOCK_NOW });

    clock.set('2026-09-01T09:00:00.000Z');
    domain.recordEnrichmentRequested({
      cloudEntityId: 'ce_01JC0000000000000000000000',
    });
    expect(database.raw.prepare<[], { count: number }>(
      'SELECT COUNT(*) AS count FROM sourcing_enrichment_requests',
    ).get()).toEqual({ count: 1 });
  });
});
