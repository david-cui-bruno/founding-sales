import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    vi.restoreAllMocks();
    closeDatabase(database);
    temp.cleanup();
  });

  it('does not invent suppression for a person with no contact methods', () => {
    insertPerson(database.raw, 'candidate');
    expect(domain.getEnrichmentRequestCandidate({ personId: 'candidate' }).suppressionBlocked).toBe(false);
  });

  it('blocks enrichment on the persisted opt-out projection', () => {
    insertPerson(database.raw, 'candidate');
    insertOptOut(database, {
      personId: 'candidate', tombstoneId: 'optout', observedChannel: 'manual', handles: [],
    });
    database.raw.prepare("UPDATE persons SET opted_out = 1, opted_out_at = ? WHERE id = 'candidate'").run(DOMAIN_TIMESTAMP);
    expect(domain.getEnrichmentRequestCandidate({ personId: 'candidate' }).suppressionBlocked).toBe(true);
  });

  it('blocks enrichment on a person tombstone even without the compatibility flag', () => {
    insertPerson(database.raw, 'candidate');
    insertOptOut(database, {
      personId: 'candidate', tombstoneId: 'optout', observedChannel: 'manual', handles: [],
    });
    expect(domain.getEnrichmentRequestCandidate({ personId: 'candidate' }).suppressionBlocked).toBe(true);
  });

  it.each(['phone', 'email'] as const)('blocks enrichment when a %s handle belongs to another suppressed person', (kind) => {
    insertPerson(database.raw, 'candidate');
    insertPerson(database.raw, 'suppressed');
    const value = kind === 'phone' ? '+14015550100' : 'synthetic@example.com';
    insertOptOut(database, {
      personId: 'suppressed', tombstoneId: 'optout', observedChannel: 'manual',
      handles: [{ id: 'blocked-handle', kind, value }],
    });
    services.unitOfWork.immediate(() => services.identities.addContactMethod({
      personId: 'candidate', kind, normalizedValue: value,
      validationState: 'unverified', reachability: 'none',
    }));
    expect(domain.getEnrichmentRequestCandidate({ personId: 'candidate' }).suppressionBlocked).toBe(true);
  });

  it('fails closed when authoritative suppression membership cannot be resolved', () => {
    insertPerson(database.raw, 'candidate');
    vi.spyOn(services.outboundPermission, 'inspectPerson').mockImplementation(() => {
      throw new Error('Synthetic membership read failure');
    });
    expect(domain.getEnrichmentRequestCandidate({ personId: 'candidate' }).suppressionBlocked).toBe(true);
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
