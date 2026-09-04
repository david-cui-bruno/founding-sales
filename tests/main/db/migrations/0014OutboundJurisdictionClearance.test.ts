import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../../../src/main/db/database';
import { createMigrationRunner } from '../../../../src/main/db/migrate';
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
import { migration0012UpstreamRequestState } from '../../../../src/main/db/migrations/0012UpstreamRequestState';
import { migration0013ContactComplianceEvidence } from '../../../../src/main/db/migrations/0013ContactComplianceEvidence';
import { migration0014OutboundJurisdictionClearance } from '../../../../src/main/db/migrations/0014OutboundJurisdictionClearance';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../../../fixtures/tempDatabase';

const migrationsThrough13 = [
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
  { id: '0012UpstreamRequestState', schemaVersion: 12, migration: migration0012UpstreamRequestState },
  { id: '0013ContactComplianceEvidence', schemaVersion: 13, migration: migration0013ContactComplianceEvidence },
] as const;
const through13 = createMigrationRunner(migrationsThrough13);
const through14 = createMigrationRunner([
  ...migrationsThrough13,
  { id: '0014OutboundJurisdictionClearance', schemaVersion: 14, migration: migration0014OutboundJurisdictionClearance },
]);
const TS = '2026-09-01T12:00:00.000Z';

describe('0014 outbound jurisdiction clearance migration', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let options: { backupDirectory: string; workspaceKey: ReturnType<typeof createTestWorkspaceKey> };

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    options = { backupDirectory: `${temp.path}.backups`, workspaceKey: key };
    await through13(database, options);
  });
  afterEach(() => { closeDatabase(database); temp.cleanup(); });

  function person(id: string): void {
    database.raw.prepare(`INSERT INTO persons
      (id, display_name, aliases_json, opted_out, never_record, provenance_json, version, created_at, updated_at)
      VALUES (?, ?, '[]', 0, 0, NULL, 1, ?, ?)` ).run(id, id, TS, TS);
    database.raw.prepare(`INSERT INTO source_events
      (id, person_id, channel, observed_at, source_record_json, created_at)
      VALUES (?, ?, 'frbo', ?, '{}', ?)` ).run(`se-${id}`, id, TS, TS);
    database.raw.prepare(`INSERT INTO prospects
      (id, person_id, original_source_event_id, segment, qualification_state, version, created_at, updated_at)
      VALUES (?, ?, ?, 'hot', 'unreviewed', 1, ?, ?)` ).run(`pr-${id}`, id, `se-${id}`, TS, TS);
  }
  function property(personId: string, id: string, region: string): void {
    database.raw.prepare(`INSERT INTO properties
      (id, address_line_1, locality, region, country_code, created_at, updated_at)
      VALUES (?, '1 Main', 'Town', ?, 'US', ?, ?)` ).run(id, region, TS, TS);
    database.raw.prepare(`INSERT INTO prospect_properties (prospect_id, property_id, created_at)
      VALUES (?, ?, ?)` ).run(`pr-${personId}`, id, TS);
  }

  it('backfills one unambiguous property region and leaves conflicts unknown', async () => {
    person('ma'); property('ma', 'ma-1', 'Massachusetts');
    person('conflict'); property('conflict', 'c-1', 'Rhode Island'); property('conflict', 'c-2', 'CT');
    person('mixed'); property('mixed', 'm-1', 'Massachusetts'); property('mixed', 'm-2', 'New Hampshire');
    person('blank'); property('blank', 'b-1', '   ');
    await through14(database, options);
    expect(database.raw.prepare(`SELECT person_id, region_code, timezone, source
      FROM person_outbound_jurisdictions ORDER BY person_id`).all()).toEqual([
      { person_id: 'ma', region_code: 'MA', timezone: 'America/New_York', source: 'property_address' },
    ]);
  });

  it('seeds fail-closed MA RI and CT call clearances and adds audit reason columns', async () => {
    await through14(database, options);
    expect(database.raw.prepare(`SELECT region_code, decision, registration_confirmed,
      state_dnc_subscription_confirmed, consent_rule_confirmed, source, effective_at
      FROM outbound_jurisdiction_clearances ORDER BY region_code`).all()).toEqual([
      { region_code: 'CT', decision: 'unknown', registration_confirmed: null, state_dnc_subscription_confirmed: null, consent_rule_confirmed: null, source: 'approved_design_2026_09_04', effective_at: '2026-09-04T00:00:00.000Z' },
      { region_code: 'MA', decision: 'blocked', registration_confirmed: null, state_dnc_subscription_confirmed: null, consent_rule_confirmed: null, source: 'approved_design_2026_09_04', effective_at: '2026-09-04T00:00:00.000Z' },
      { region_code: 'RI', decision: 'unknown', registration_confirmed: null, state_dnc_subscription_confirmed: null, consent_rule_confirmed: null, source: 'approved_design_2026_09_04', effective_at: '2026-09-04T00:00:00.000Z' },
    ]);
    const columns = database.raw.prepare(`PRAGMA table_info(contact_compliance_audit_events)`).all() as Array<{ name: string }>;
    expect(columns.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'resulting_call_reason_code', 'resulting_text_reason_code',
    ]));
  });
});
