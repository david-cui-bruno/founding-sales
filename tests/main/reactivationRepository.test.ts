import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import {
  ReactivationRepository,
  type InsertReactivationReceiptInput,
} from '../../src/main/domain/lifecycle/reactivationRepository';
import { LifecycleIdempotencyConflictError, StaleDomainWriteError } from '../../src/main/domain/support/domainErrors';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { DOMAIN_TIMESTAMP, insertClosedCycle, seedProspect } from '../fixtures/domainRows';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';

const OCTOBER = '2026-10-01T13:00:00.000Z';

describe('ReactivationRepository', () => {
  let database: AppDatabase | undefined;
  let workspace: TempDatabase | undefined;
  let unitOfWork: DomainUnitOfWork;
  let repository: ReactivationRepository;

  afterEach(() => {
    if (database !== undefined) closeDatabase(database);
    workspace?.cleanup();
  });

  async function setup(): Promise<{ personId: string; sourceCycleId: string; newCycleId: string }> {
    workspace = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: workspace.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${workspace.path}.backups`, workspaceKey: key,
    });
    unitOfWork = new DomainUnitOfWork(database);
    repository = new ReactivationRepository({ database, unitOfWork });
    const prospect = seedProspect(database.raw, 'reactivation');
    const sourceCycleId = insertClosedCycle({ database: database.raw, prefix: 'source', prospect });
    const newCycleId = insertClosedCycle({ database: database.raw, prefix: 'new', prospect });
    return { personId: prospect.personId, sourceCycleId, newCycleId };
  }

  it('persists exact rule types and consumes once with CAS', async () => {
    const { sourceCycleId } = await setup();
    const rule = unitOfWork.immediate(() => repository.insertRule({
      id: 'rule', salesCycleId: sourceCycleId, ruleType: 'seasonal:heating-oct1',
      dueAt: OCTOBER, matcher: null, version: 1, createdAt: DOMAIN_TIMESTAMP,
    }));
    expect(rule).toMatchObject({ id: 'rule', consumedAt: null, version: 1 });

    const consumed = unitOfWork.immediate(() => repository.consumeRule({
      ruleId: 'rule', salesCycleId: sourceCycleId, expectedVersion: 1,
      consumedAt: OCTOBER,
    }));
    expect(consumed.consumedAt).toBe(OCTOBER);
    expect(() => unitOfWork.immediate(() => repository.consumeRule({
      ruleId: 'rule', salesCycleId: sourceCycleId, expectedVersion: 1,
      consumedAt: OCTOBER,
    }))).toThrow(StaleDomainWriteError);
  });

  it('returns an exact immutable receipt on replay and conflicts on changed command', async () => {
    const { personId, sourceCycleId, newCycleId } = await setup();
    unitOfWork.immediate(() => repository.insertRule({
      id: 'rule', salesCycleId: sourceCycleId, ruleType: 'manual',
      dueAt: OCTOBER, matcher: null, version: 1, createdAt: DOMAIN_TIMESTAMP,
    }));
    const input: InsertReactivationReceiptInput = {
      activationKey: 'rule:rule', activationKind: 'rule' as const,
      personId, sourceCycleId, reactivationRuleId: 'rule', sourceEventId: null,
      newCycleId, command: { version: 1 as const, command: { newCycleId } },
      result: { version: 1 as const, result: { kind: 'reactivated', newCycleId } },
      createdAt: DOMAIN_TIMESTAMP,
    };
    const first = unitOfWork.immediate(() => repository.insertOrGetReceipt(input));
    const replay = unitOfWork.immediate(() => repository.insertOrGetReceipt(input));
    expect(replay).toEqual(first);
    expect(Object.isFrozen(replay.command)).toBe(true);
    expect(() => unitOfWork.immediate(() => repository.insertOrGetReceipt({
      ...input, command: { version: 1, command: { newCycleId, changed: true } },
    }))).toThrow(LifecycleIdempotencyConflictError);
    expect(() => database!.raw.prepare(`
      UPDATE cycle_reactivation_receipts SET result_json = '{}' WHERE activation_key = 'rule:rule'
    `).run()).toThrow();
    expect(() => database!.raw.prepare(`
      DELETE FROM cycle_reactivation_receipts WHERE activation_key = 'rule:rule'
    `).run()).toThrow();
  });
});
