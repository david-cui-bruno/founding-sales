import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { OperationalSafetyRepository } from '../../src/main/domain/operations/operationalSafetyRepository';
import {
  DomainRepositoryDatabaseMismatchError,
  DomainTransactionRequiredError,
} from '../../src/main/domain/support/domainErrors';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';

const FIRST = '2026-09-05T12:00:00.000Z';
const SECOND = '2026-09-05T13:00:00.000Z';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

describe('OperationalSafetyRepository', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let unitOfWork: DomainUnitOfWork;
  let repository: OperationalSafetyRepository;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`,
      workspaceKey: key,
    });
    unitOfWork = new DomainUnitOfWork(database);
    repository = new OperationalSafetyRepository({ database, unitOfWork });
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  it('records validated backup receipts transactionally and lists newest first', () => {
    expect(() => repository.recordBackup({
      id: 'backup-outside',
      backupBasename: 'outside.sqlite3',
      kind: 'manual',
      schemaVersion: 15,
      sha256: SHA_A,
      sizeBytes: 1,
      createdAt: FIRST,
      verifiedAt: FIRST,
    })).toThrow(DomainTransactionRequiredError);

    unitOfWork.immediate(() => {
      repository.recordBackup({
        id: 'backup-first',
        backupBasename: 'daily-first.sqlite3',
        kind: 'daily',
        schemaVersion: 15,
        sha256: SHA_A,
        sizeBytes: 100,
        createdAt: FIRST,
        verifiedAt: FIRST,
      });
      repository.recordBackup({
        id: 'backup-second',
        backupBasename: 'pre-release-second.sqlite3',
        kind: 'pre_release',
        schemaVersion: 15,
        sha256: SHA_B,
        sizeBytes: 200,
        createdAt: SECOND,
        verifiedAt: SECOND,
      });
    });

    expect(repository.listBackups()).toEqual([
      {
        id: 'backup-second',
        backupBasename: 'pre-release-second.sqlite3',
        kind: 'pre_release',
        schemaVersion: 15,
        sha256: SHA_B,
        sizeBytes: 200,
        createdAt: SECOND,
        verifiedAt: SECOND,
      },
      {
        id: 'backup-first',
        backupBasename: 'daily-first.sqlite3',
        kind: 'daily',
        schemaVersion: 15,
        sha256: SHA_A,
        sizeBytes: 100,
        createdAt: FIRST,
        verifiedAt: FIRST,
      },
    ]);
  });

  it('records recovery setup and restore drills without losing prior readiness state', () => {
    expect(repository.getRecoveryReadiness()).toEqual({
      recoverySetupCompletedAt: null,
      lastRestoreDrillAt: null,
      lastRestoreBackupSha256: null,
      updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });

    unitOfWork.immediate(() => {
      repository.recordRecoverySetupCompleted({ completedAt: FIRST });
    });
    expect(repository.getRecoveryReadiness()).toEqual({
      recoverySetupCompletedAt: FIRST,
      lastRestoreDrillAt: null,
      lastRestoreBackupSha256: null,
      updatedAt: FIRST,
    });

    unitOfWork.immediate(() => {
      repository.recordRestoreDrill({
        performedAt: SECOND,
        backupSha256: SHA_B,
      });
    });
    expect(repository.getRecoveryReadiness()).toEqual({
      recoverySetupCompletedAt: FIRST,
      lastRestoreDrillAt: SECOND,
      lastRestoreBackupSha256: SHA_B,
      updatedAt: SECOND,
    });
  });

  it.each([
    {
      name: 'recovery setup completion',
      write: (subject: OperationalSafetyRepository) => subject.recordRecoverySetupCompleted({
        completedAt: FIRST,
      }),
    },
    {
      name: 'restore drill',
      write: (subject: OperationalSafetyRepository) => subject.recordRestoreDrill({
        performedAt: FIRST,
        backupSha256: SHA_A,
      }),
    },
  ])('fails $name when the singleton is missing and rolls back surrounding writes', ({ write }) => {
    database.raw.prepare('DELETE FROM recovery_readiness WHERE singleton = 1').run();

    expect(() => unitOfWork.immediate(() => {
      repository.recordBackup({
        id: 'must-roll-back',
        backupBasename: 'must-roll-back.sqlite3',
        kind: 'manual',
        schemaVersion: 15,
        sha256: SHA_A,
        sizeBytes: 100,
        createdAt: FIRST,
        verifiedAt: FIRST,
      });
      write(repository);
    })).toThrow();

    expect(repository.listBackups()).toEqual([]);
  });

  it('fails closed for malformed repository input and malformed persisted rows', () => {
    expect(() => unitOfWork.immediate(() => repository.recordBackup({
      id: 'malformed-input',
      backupBasename: 'malformed.sqlite3',
      kind: 'manual',
      schemaVersion: 15,
      sha256: 'short',
      sizeBytes: 100,
      createdAt: FIRST,
      verifiedAt: FIRST,
    }))).toThrow();
    expect(repository.listBackups()).toEqual([]);

    database.raw.pragma('ignore_check_constraints = ON');
    database.raw.prepare(`INSERT INTO backup_receipts
      (id, backup_basename, kind, schema_version, sha256, size_bytes, created_at, verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'malformed-row', 'malformed-row.sqlite3', 'manual', 15, 'short', 100, FIRST, FIRST,
    );
    database.raw.pragma('ignore_check_constraints = OFF');
    expect(() => repository.listBackups()).toThrow();

    database.raw.prepare(`UPDATE recovery_readiness
      SET updated_at = 'not-a-timestamp' WHERE singleton = 1`).run();
    expect(() => repository.getRecoveryReadiness()).toThrow();
  });

  it('rejects a database and DomainUnitOfWork bound to different connections', async () => {
    const otherTemp = createTempDatabase();
    const otherKey = createTestWorkspaceKey();
    const otherDatabase = openDatabase({ path: otherTemp.path, key: otherKey });
    try {
      await migrateToLatest(otherDatabase, {
        backupDirectory: `${otherTemp.path}.backups`,
        workspaceKey: otherKey,
      });
      expect(() => new OperationalSafetyRepository({
        database,
        unitOfWork: new DomainUnitOfWork(otherDatabase),
      })).toThrow(DomainRepositoryDatabaseMismatchError);
    } finally {
      closeDatabase(otherDatabase);
      otherTemp.cleanup();
    }
  });

  it('appends repair events with canonical JSON and rejects duplicate manifest candidates', () => {
    unitOfWork.immediate(() => {
      repository.appendIdentityRepairEvent({
        id: 'repair-1',
        manifestSha256: SHA_A,
        candidateId: 'candidate-1',
        canonicalPersonId: 'person-1',
        createdPersonIds: ['person-2', 'person-3'],
        reassignedSourceEventIds: ['event-1'],
        appliedAt: FIRST,
      });
    });

    expect(database.raw.prepare(`SELECT id, manifest_sha256, candidate_id,
      canonical_person_id, created_person_ids_json,
      reassigned_source_event_ids_json, applied_at
      FROM identity_repair_events`).get()).toEqual({
      id: 'repair-1',
      manifest_sha256: SHA_A,
      candidate_id: 'candidate-1',
      canonical_person_id: 'person-1',
      created_person_ids_json: '["person-2","person-3"]',
      reassigned_source_event_ids_json: '["event-1"]',
      applied_at: FIRST,
    });

    expect(() => unitOfWork.immediate(() => {
      repository.appendIdentityRepairEvent({
        id: 'repair-2',
        manifestSha256: SHA_A,
        candidateId: 'candidate-1',
        canonicalPersonId: 'person-4',
        createdPersonIds: [],
        reassignedSourceEventIds: [],
        appliedAt: SECOND,
      });
    })).toThrow();

    const selectReceipt = database.raw.prepare(
      'SELECT * FROM identity_repair_events WHERE id = ?',
    );
    const original = selectReceipt.get('repair-1');
    expect(() => database.raw.prepare(`UPDATE identity_repair_events
      SET canonical_person_id = 'person-rewritten' WHERE id = 'repair-1'`).run()).toThrow();
    expect(selectReceipt.get('repair-1')).toEqual(original);
    expect(() => database.raw.prepare(
      "DELETE FROM identity_repair_events WHERE id = 'repair-1'",
    ).run()).toThrow();
    expect(selectReceipt.get('repair-1')).toEqual(original);
  });

  it('rolls back earlier repository writes when a later receipt violates uniqueness', () => {
    expect(() => unitOfWork.immediate(() => {
      repository.recordBackup({
        id: 'rollback-first',
        backupBasename: 'duplicate.sqlite3',
        kind: 'manual',
        schemaVersion: 15,
        sha256: SHA_A,
        sizeBytes: 100,
        createdAt: FIRST,
        verifiedAt: FIRST,
      });
      repository.recordBackup({
        id: 'rollback-second',
        backupBasename: 'duplicate.sqlite3',
        kind: 'manual',
        schemaVersion: 15,
        sha256: SHA_B,
        sizeBytes: 200,
        createdAt: SECOND,
        verifiedAt: SECOND,
      });
    })).toThrow();

    expect(repository.listBackups()).toEqual([]);
  });
});
