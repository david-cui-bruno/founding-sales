import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../../../src/main/db/database';
import { createMigrationRunner, migrateToLatest } from '../../../../src/main/db/migrate';
import { migration0001Foundation } from '../../../../src/main/db/migrations/0001Foundation';
import { migration0002DomainFoundation } from '../../../../src/main/db/migrations/0002DomainFoundation';
import { migration0003Transcripts } from '../../../../src/main/db/migrations/0003Transcripts';
import { migration0004Learnings } from '../../../../src/main/db/migrations/0004Learnings';
import { migration0005SourcingChannels } from '../../../../src/main/db/migrations/0005SourcingChannels';
import { migration0006SourcingState } from '../../../../src/main/db/migrations/0006SourcingState';
import { migration0007SourcingOutbox } from '../../../../src/main/db/migrations/0007SourcingOutbox';
import { migration0008DedupeCloudPersons } from '../../../../src/main/db/migrations/0008DedupeCloudPersons';
import { migration0009SourcingFileLedger } from '../../../../src/main/db/migrations/0009SourcingFileLedger';
import { migration0010NoDueDates } from '../../../../src/main/db/migrations/0010NoDueDates';
import { migration0011ContactDncFlags } from '../../../../src/main/db/migrations/0011ContactDncFlags';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../../../fixtures/tempDatabase';

const migrateThroughSchema11 = createMigrationRunner([
  { id: '0001Foundation', schemaVersion: 1, migration: migration0001Foundation },
  { id: '0002DomainFoundation', schemaVersion: 2, migration: migration0002DomainFoundation },
  { id: '0003Transcripts', schemaVersion: 3, migration: migration0003Transcripts },
  { id: '0004Learnings', schemaVersion: 4, migration: migration0004Learnings },
  { id: '0005SourcingChannels', schemaVersion: 5, migration: migration0005SourcingChannels },
  { id: '0006SourcingState', schemaVersion: 6, migration: migration0006SourcingState },
  { id: '0007SourcingOutbox', schemaVersion: 7, migration: migration0007SourcingOutbox },
  { id: '0008DedupeCloudPersons', schemaVersion: 8, migration: migration0008DedupeCloudPersons },
  { id: '0009SourcingFileLedger', schemaVersion: 9, migration: migration0009SourcingFileLedger },
  { id: '0010NoDueDates', schemaVersion: 10, migration: migration0010NoDueDates },
  { id: '0011ContactDncFlags', schemaVersion: 11, migration: migration0011ContactDncFlags },
]);

describe('0012 upstream request state migration', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let options: {
    backupDirectory: string;
    workspaceKey: ReturnType<typeof createTestWorkspaceKey>;
  };

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    options = { backupDirectory: `${temp.path}.backups`, workspaceKey: key };
    await migrateThroughSchema11(database, options);
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  it('migrates schema 11 to schema 12 and creates both empty tables', async () => {
    const result = await migrateToLatest(database, options);

    expect(result.fromVersion).toBe(11);
    expect(result.toVersion).toBe(16);
    expect(result.appliedMigrationIds).toEqual([
      '0012UpstreamRequestState',
      '0013ContactComplianceEvidence',
      '0014OutboundJurisdictionClearance',
      '0015RecoveryMetadata',
      '0016ContactPresentationEvidence',
    ]);
    expect(database.raw.prepare<[], { schema_version: number }>(
      'SELECT schema_version FROM app_meta WHERE singleton = 1',
    ).get()).toEqual({ schema_version: 16 });

    expect(database.raw.prepare<[], { count: number }>(
      'SELECT COUNT(*) AS count FROM sourcing_suppression_outbox',
    ).get()).toEqual({ count: 0 });
    expect(database.raw.prepare<[], { count: number }>(
      'SELECT COUNT(*) AS count FROM sourcing_enrichment_requests',
    ).get()).toEqual({ count: 0 });
  });

  it('enforces the suppression outbox handle primary key (exactly-once rows)', async () => {
    await migrateToLatest(database, options);

    const ts = '2026-09-01T12:00:00.000Z';
    database.raw.prepare(`
      INSERT INTO persons (
        id, display_name, aliases_json, opted_out, never_record, version,
        created_at, updated_at
      ) VALUES ('person-1', 'Person', '[]', 0, 0, 1, ?, ?)
    `).run(ts, ts);
    database.raw.prepare(`
      INSERT INTO activities (
        id, person_id, kind, direction, channel, occurred_at, metadata_json, created_at
      ) VALUES ('activity-1', 'person-1', 'note', 'internal', 'manual', ?, '{}', ?)
    `).run(ts, ts);
    database.raw.prepare(`
      INSERT INTO opt_out_tombstones (
        id, person_id, requested_at, observed_channel, source_activity_id,
        evidence_ref, policy_version, created_at
      ) VALUES ('tombstone-1', 'person-1', ?, 'manual', 'activity-1', NULL, 'v1', ?)
    `).run(ts, ts);
    database.raw.prepare(`
      INSERT INTO opt_out_handles (id, tombstone_id, kind, normalized_value, created_at)
      VALUES ('handle-1', 'tombstone-1', 'phone', '+14015550100', ?)
    `).run(ts);

    database.raw.prepare(
      "INSERT INTO sourcing_suppression_outbox (handle_id, flushed_at) VALUES ('handle-1', NULL)",
    ).run();
    expect(() => database.raw.prepare(
      "INSERT INTO sourcing_suppression_outbox (handle_id, flushed_at) VALUES ('handle-1', NULL)",
    ).run()).toThrow(/UNIQUE|PRIMARY/i);
    // The outbox references real handles only.
    expect(() => database.raw.prepare(
      "INSERT INTO sourcing_suppression_outbox (handle_id, flushed_at) VALUES ('no-such-handle', NULL)",
    ).run()).toThrow(/FOREIGN KEY/i);
    // INSERT OR IGNORE is the sweep's idempotence primitive.
    database.raw.prepare(
      "INSERT OR IGNORE INTO sourcing_suppression_outbox (handle_id, flushed_at) VALUES ('handle-1', NULL)",
    ).run();
    expect(database.raw.prepare<[], { count: number }>(
      'SELECT COUNT(*) AS count FROM sourcing_suppression_outbox',
    ).get()).toEqual({ count: 1 });
  });

  it('is idempotent: a second run applies nothing', async () => {
    await migrateToLatest(database, options);
    const secondResult = await migrateToLatest(database, options);

    expect(secondResult).toEqual({
      fromVersion: 16,
      toVersion: 16,
      appliedMigrationIds: [],
    });
    expect(database.raw.prepare<[], { schema_version: number }>(
      'SELECT schema_version FROM app_meta WHERE singleton = 1',
    ).get()).toEqual({ schema_version: 16 });
  });
});
