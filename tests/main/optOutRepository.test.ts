import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { OptOutRepository } from '../../src/main/domain/optOut/optOutRepository';
import { SalesCycleRepository } from '../../src/main/domain/lifecycle/salesCycleRepository';
import type {
  OptOutClosureCommand,
  OptOutClosureReceipt,
} from '../../src/main/domain/optOut/optOutValidation';
import {
  DomainRepositoryDatabaseMismatchError,
  DomainTransactionRequiredError,
  OptOutPersistenceConflictError,
} from '../../src/main/domain/support/domainErrors';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { DOMAIN_TIMESTAMP, insertClosedCycle, seedProspect } from '../fixtures/domainRows';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

const LATER = '2026-08-30T13:00:00.000Z';

describe('OptOutRepository', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let unitOfWork: DomainUnitOfWork;
  let repository: OptOutRepository;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`, workspaceKey: key,
    });
    unitOfWork = new DomainUnitOfWork(database);
    repository = new OptOutRepository({ database, unitOfWork });
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  function seedEvidence(prefix: string): { personId: string; activityId: string } {
    const prospect = seedProspect(database.raw, prefix);
    const activityId = `${prefix}-activity`;
    database.raw.prepare(`
      INSERT INTO activities (
        id, person_id, kind, direction, channel, occurred_at, observed_outcome,
        metadata_json, created_at
      ) VALUES (?, ?, 'text', 'inbound', 'imessage', ?, 'opted_out', '{}', ?)
    `).run(activityId, prospect.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    return { personId: prospect.personId, activityId };
  }

  function tombstone(
    id: string,
    personId: string,
    sourceActivityId: string,
    requestedAt = DOMAIN_TIMESTAMP,
  ) {
    return {
      id, personId, requestedAt,
      observedChannel: 'imessage' as const,
      sourceActivityId, evidenceRef: null as string | null,
      policyVersion: 'founder_opt_out_v1', createdAt: requestedAt,
    };
  }

  it('requires its exact active UoW for writes and exact binding identity', () => {
    const proof = seedEvidence('binding');
    expect(() => repository.insertTombstone(tombstone(
      'binding-tombstone', proof.personId, proof.activityId,
    ))).toThrow(DomainTransactionRequiredError);

    const otherUnit = new DomainUnitOfWork(database);
    expect(() => repository.assertBoundTo(database, otherUnit))
      .toThrow(DomainRepositoryDatabaseMismatchError);
    expect(() => new OptOutRepository({ database, unitOfWork: otherUnit })
      .assertBoundTo(database, unitOfWork)).toThrow(DomainRepositoryDatabaseMismatchError);
  });

  it('persists, parses, stably lists, and exactly replays tombstones and handles', () => {
    const first = seedEvidence('first');
    const second = seedEvidence('second');
    const firstRow = tombstone('first-tombstone', first.personId, first.activityId);
    const secondRow = tombstone('second-tombstone', second.personId, second.activityId, LATER);

    unitOfWork.immediate(() => {
      expect(repository.insertTombstone(firstRow)).toEqual(firstRow);
      expect(repository.insertTombstone(firstRow)).toEqual(firstRow);
      repository.insertBlockedHandle({
        id: 'first-phone', tombstoneId: firstRow.id, kind: 'phone',
        normalizedValue: '+14015550100', createdAt: DOMAIN_TIMESTAMP,
      });
      repository.insertBlockedHandle({
        id: 'first-email', tombstoneId: firstRow.id, kind: 'email',
        normalizedValue: 'owner@example.com', createdAt: DOMAIN_TIMESTAMP,
      });
      repository.insertTombstone(secondRow);
      repository.insertBlockedHandle({
        id: 'second-phone', tombstoneId: secondRow.id, kind: 'phone',
        normalizedValue: '+14015550100', createdAt: LATER,
      });
    });

    expect(repository.getForPerson(first.personId)).toEqual(firstRow);
    expect(repository.getById(firstRow.id)).toEqual(firstRow);
    expect(repository.listHandles(firstRow.id).map(({ id }) => id))
      .toEqual(['first-email', 'first-phone']);
    expect(repository.listBlocksForHandle('phone', '(401) 555-0100')
      .map(({ id }) => id)).toEqual(['first-tombstone', 'second-tombstone']);
  });

  it('rejects changed retries, noncanonical handles, and corrupted stored rows', () => {
    const proof = seedEvidence('conflict');
    const canonical = tombstone('conflict-tombstone', proof.personId, proof.activityId);
    unitOfWork.immediate(() => {
      repository.insertTombstone(canonical);
      repository.insertBlockedHandle({
        id: 'conflict-phone', tombstoneId: canonical.id, kind: 'phone',
        normalizedValue: '+14015550100', createdAt: DOMAIN_TIMESTAMP,
      });
      expect(() => repository.insertTombstone({ ...canonical, evidenceRef: 'changed' }))
        .toThrow(OptOutPersistenceConflictError);
      expect(() => repository.insertTombstone({ ...canonical, id: 'different-id' }))
        .toThrow(OptOutPersistenceConflictError);
      expect(() => repository.insertBlockedHandle({
        id: 'changed-id', tombstoneId: canonical.id, kind: 'phone',
        normalizedValue: '+14015550100', createdAt: DOMAIN_TIMESTAMP,
      })).toThrow(OptOutPersistenceConflictError);
      expect(() => repository.insertBlockedHandle({
        id: 'noncanonical', tombstoneId: canonical.id, kind: 'phone',
        normalizedValue: '(401) 555-0100', createdAt: DOMAIN_TIMESTAMP,
      })).toThrow();
    });

    database.raw.exec('DROP TRIGGER protect_opt_out_tombstone_update');
    database.raw.pragma('ignore_check_constraints = ON');
    database.raw.prepare(`
      UPDATE opt_out_tombstones SET requested_at = 'not-a-time'
      WHERE id = 'conflict-tombstone'
    `).run();
    expect(() => repository.getById('conflict-tombstone')).toThrow();
  });

  it('validates the exact retained Activity semantics on insert and every read', () => {
    const proof = seedEvidence('evidence-contract');
    const canonical = tombstone(
      'evidence-contract-tombstone', proof.personId, proof.activityId,
    );
    unitOfWork.immediate(() => {
      for (const changed of [
        { ...canonical, observedChannel: 'gmail' as const },
        { ...canonical, policyVersion: 'legacy_policy' },
        { ...canonical, evidenceRef: 'forged-evidence' },
        { ...canonical, requestedAt: '2026-08-30T11:59:59.999Z' },
        { ...canonical, requestedAt: LATER, createdAt: DOMAIN_TIMESTAMP },
      ]) expect(() => repository.insertTombstone(changed)).toThrow();
      repository.insertTombstone(canonical);
      repository.insertBlockedHandle({
        id: 'evidence-contract-phone', tombstoneId: canonical.id, kind: 'phone',
        normalizedValue: '+14015550100', createdAt: DOMAIN_TIMESTAMP,
      });
    });

    database.raw.exec('DROP TRIGGER immutable_activities');
    database.raw.prepare(`
      UPDATE activities SET direction = 'outbound'
      WHERE id = 'evidence-contract-activity'
    `).run();
    expect(() => repository.getForPerson(proof.personId)).toThrow();
    expect(() => repository.listBlocksForHandle('phone', '+14015550100')).toThrow();
  });

  it('persists an immutable relational closure receipt and rejects corrupted replay state', () => {
    const proof = seedEvidence('closure-receipt');
    const canonical = tombstone(
      'closure-receipt-tombstone', proof.personId, proof.activityId,
    );
    const command: OptOutClosureCommand = {
      version: 1 as const,
      kind: 'apply' as const,
      input: {
        personId: proof.personId, tombstoneId: canonical.id,
        requestedAt: DOMAIN_TIMESTAMP, policyVersion: 'founder_opt_out_v1' as const,
        decision: { kind: 'structured_written' as const, channel: 'imessage' as const },
        evidence: { kind: 'existing_activity' as const, activityId: proof.activityId },
        terminalStageEventId: null,
      },
    };
    const receipt: OptOutClosureReceipt = {
      sourceActivityId: proof.activityId, operationKind: 'apply' as const,
      personId: proof.personId, tombstoneId: canonical.id,
      sourceTombstoneId: null, closedCycleId: null, terminalStageEventId: null,
      command,
      result: { tombstone: canonical, handles: [], cycle: null, alreadyApplied: false },
      createdAt: DOMAIN_TIMESTAMP,
    };
    unitOfWork.immediate(() => {
      repository.insertTombstone(canonical);
      const stored = repository.insertClosureReceipt(receipt);
      expect(stored).toEqual(receipt);
      expect(repository.insertClosureReceipt(receipt)).toEqual(stored);
      expect(Object.isFrozen(stored)).toBe(true);
      expect(Object.isFrozen(stored.command)).toBe(true);
      expect(Object.isFrozen(stored.result)).toBe(true);
      expect(() => repository.insertClosureReceipt({
        ...receipt, createdAt: LATER,
      })).toThrow(OptOutPersistenceConflictError);
    });
    expect(repository.getClosureReceiptForActivity(proof.activityId)).toEqual(receipt);

    database.raw.exec('DROP TRIGGER immutable_opt_out_closure_receipts');
    database.raw.prepare(`
      UPDATE opt_out_closure_receipts SET result_json = '{}'
      WHERE source_activity_id = ?
    `).run(proof.activityId);
    expect(() => repository.getClosureReceiptForActivity(proof.activityId)).toThrow();
  });

  it('rejects a forged receipt that presents an unrelated no-response closure as opt-out work', () => {
    const prospect = seedProspect(database.raw, 'forged-closure-cycle');
    const activityId = 'forged-closure-cycle-activity';
    database.raw.prepare(`
      INSERT INTO activities (
        id, person_id, kind, direction, channel, occurred_at, observed_outcome,
        metadata_json, created_at
      ) VALUES (?, ?, 'text', 'inbound', 'imessage', ?, 'opted_out', '{}', ?)
    `).run(activityId, prospect.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    const cycleId = insertClosedCycle({
      database: database.raw, prefix: 'forged-no-response', prospect,
    });
    const cycle = new SalesCycleRepository({ database, unitOfWork }).getById(cycleId)!;
    const canonical = tombstone(
      'forged-closure-cycle-tombstone', prospect.personId, activityId,
    );
    unitOfWork.immediate(() => {
      repository.insertTombstone(canonical);
      expect(() => repository.insertClosureReceipt({
        sourceActivityId: activityId, operationKind: 'apply', personId: prospect.personId,
        tombstoneId: canonical.id, sourceTombstoneId: null,
        closedCycleId: cycle.id, terminalStageEventId: null,
        command: {
          version: 1, kind: 'apply', input: {
            personId: prospect.personId, tombstoneId: canonical.id,
            requestedAt: DOMAIN_TIMESTAMP, policyVersion: 'founder_opt_out_v1',
            decision: { kind: 'structured_written', channel: 'imessage' },
            evidence: { kind: 'existing_activity', activityId }, terminalStageEventId: null,
          },
        },
        result: { tombstone: canonical, handles: [], cycle, alreadyApplied: false },
        createdAt: DOMAIN_TIMESTAMP,
      })).toThrow();
    });
  });
});
