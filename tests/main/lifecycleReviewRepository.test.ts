import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import {
  LifecycleReviewRepository,
  type InsertLifecycleReviewInput,
} from '../../src/main/domain/lifecycle/lifecycleReviewRepository';
import { LifecycleIdempotencyConflictError, StaleDomainWriteError } from '../../src/main/domain/support/domainErrors';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { DOMAIN_TIMESTAMP, insertClosedCycle, seedProspect } from '../fixtures/domainRows';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';

const RESOLVED = '2026-08-31T12:00:00.000Z';

describe('LifecycleReviewRepository', () => {
  let database: AppDatabase | undefined;
  let workspace: TempDatabase | undefined;
  let unitOfWork: DomainUnitOfWork;
  let repository: LifecycleReviewRepository;

  afterEach(() => {
    if (database !== undefined) closeDatabase(database);
    workspace?.cleanup();
  });

  it('durably reuses identical blocked activation work and CAS-resolves it', async () => {
    workspace = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: workspace.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${workspace.path}.backups`, workspaceKey: key,
    });
    unitOfWork = new DomainUnitOfWork(database);
    repository = new LifecycleReviewRepository({ database, unitOfWork });
    const prospect = seedProspect(database.raw, 'review');
    const sourceCycleId = insertClosedCycle({ database: database.raw, prefix: 'review-source', prospect });
    const input: InsertLifecycleReviewInput = {
      id: 'review-item', activationKey: `inbound:${prospect.sourceEventId}`,
      personId: prospect.personId, prospectId: prospect.prospectId, sourceCycleId,
      reactivationRuleId: null, sourceEventId: prospect.sourceEventId,
      reason: 'unmatched_communication',
      payload: { version: 1 as const, command: { handle: '+14015550100' } },
      createdAt: DOMAIN_TIMESTAMP,
    };
    const first = unitOfWork.immediate(() => repository.insertOrGetOpen(input));
    const replay = unitOfWork.immediate(() => repository.insertOrGetOpen(input));
    expect(replay).toEqual(first);
    expect(() => unitOfWork.immediate(() => repository.insertOrGetOpen({
      ...input, payload: { version: 1, command: { handle: '+14015550199' } },
    }))).toThrow(LifecycleIdempotencyConflictError);

    const resolved = unitOfWork.immediate(() => repository.resolve({
      id: first.id, activationKey: first.activationKey, expectedVersion: 1,
      resolution: { version: 1, result: { kind: 'reactivated' } }, resolvedAt: RESOLVED,
    }));
    expect(resolved).toMatchObject({ status: 'resolved', version: 2, resolvedAt: RESOLVED });
    expect(() => unitOfWork.immediate(() => repository.resolve({
      id: first.id, activationKey: first.activationKey, expectedVersion: 1,
      resolution: { version: 1, result: { kind: 'reactivated' } }, resolvedAt: RESOLVED,
    }))).toThrow(StaleDomainWriteError);
    expect(() => database!.raw.prepare(`
      UPDATE lifecycle_review_items
      SET status = 'open', resolution_json = NULL, resolved_at = NULL, version = 3
      WHERE id = 'review-item'
    `).run()).toThrow();
  });
});
