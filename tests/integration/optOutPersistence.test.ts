import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { IdentityRepository } from '../../src/main/domain/identity/identityRepository';
import { OptOutRepository } from '../../src/main/domain/optOut/optOutRepository';
import { OutboundPermissionService } from '../../src/main/domain/optOut/outboundPermissionService';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { DOMAIN_TIMESTAMP, seedProspect } from '../fixtures/domainRows';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

describe('permanent opt-out persistence', () => {
  let database: AppDatabase | undefined;
  let temp: TempDatabase | undefined;

  afterEach(() => {
    if (database !== undefined) closeDatabase(database);
    temp?.cleanup();
  });

  it('survives encrypted reopen, blocks deletion, and blocks same-handle re-import', async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`, workspaceKey: key,
    });
    const original = seedProspect(database.raw, 'persisted-opt-out');
    database.raw.prepare(`
      INSERT INTO person_contact_methods (
        id, person_id, kind, normalized_value, validation_state, reachability,
        is_primary, created_at, updated_at
      ) VALUES ('persisted-phone', ?, 'phone', '+14015550100', 'valid',
                'direct', 1, ?, ?)
    `).run(original.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    database.raw.prepare(`
      INSERT INTO activities (
        id, person_id, kind, direction, channel, occurred_at, observed_outcome,
        metadata_json, created_at
      ) VALUES ('persisted-evidence', ?, 'text', 'inbound', 'imessage', ?,
                'opted_out', '{}', ?)
    `).run(original.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    let unitOfWork = new DomainUnitOfWork(database);
    let optOuts = new OptOutRepository({ database, unitOfWork });
    unitOfWork.immediate(() => {
      optOuts.insertTombstone({
        id: 'persisted-tombstone', personId: original.personId,
        requestedAt: DOMAIN_TIMESTAMP, observedChannel: 'imessage',
        sourceActivityId: 'persisted-evidence', evidenceRef: null,
        policyVersion: 'founder_opt_out_v1', createdAt: DOMAIN_TIMESTAMP,
      });
      optOuts.insertBlockedHandle({
        id: 'persisted-handle', tombstoneId: 'persisted-tombstone', kind: 'phone',
        normalizedValue: '+14015550100', createdAt: DOMAIN_TIMESTAMP,
      });
    });
    closeDatabase(database);

    database = openDatabase({ path: temp.path, key });
    unitOfWork = new DomainUnitOfWork(database);
    optOuts = new OptOutRepository({ database, unitOfWork });
    const identities = new IdentityRepository({
      database, unitOfWork, clock: { now: () => DOMAIN_TIMESTAMP },
      ids: { next: () => 'reimport-generated-contact' },
    });
    const reimported = seedProspect(database.raw, 'reimported-person');
    database.raw.prepare(`
      INSERT INTO person_contact_methods (
        id, person_id, kind, normalized_value, validation_state, reachability,
        is_primary, created_at, updated_at
      ) VALUES ('reimported-phone', ?, 'phone', '+14015550100', 'valid',
                'direct', 1, ?, ?)
    `).run(reimported.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    const permission = new OutboundPermissionService({
      database, unitOfWork, identities, optOuts,
    });

    expect(optOuts.getForPerson(original.personId)).toMatchObject({
      id: 'persisted-tombstone', sourceActivityId: 'persisted-evidence',
    });
    expect(permission.inspectPerson(reimported.personId)).toMatchObject({
      kind: 'blocked', tombstoneIds: ['persisted-tombstone'],
    });
    expect(() => database!.raw.prepare(`DELETE FROM persons WHERE id = ?`)
      .run(original.personId)).toThrow();
    expect(() => database!.raw.prepare(`
      INSERT OR REPLACE INTO opt_out_tombstones
      SELECT * FROM opt_out_tombstones WHERE id = 'persisted-tombstone'
    `).run()).toThrow();
  });
});
