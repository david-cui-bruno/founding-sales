import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import {
  ReactivationRepository,
  type InsertReactivationReceiptInput,
} from '../../src/main/domain/lifecycle/reactivationRepository';
import { SalesCycleRepository } from '../../src/main/domain/lifecycle/salesCycleRepository';
import type { SalesCycle } from '../../src/main/domain/lifecycle/lifecycleTypes';
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

  async function setup(): Promise<{
    personId: string;
    prospectId: string;
    sourceEventId: string;
    sourceCycleId: string;
    newCycleId: string;
    newCycle: SalesCycle;
  }> {
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
    const cycles = new SalesCycleRepository({ database, unitOfWork });
    return {
      personId: prospect.personId, prospectId: prospect.prospectId,
      sourceEventId: prospect.sourceEventId, sourceCycleId, newCycleId,
      newCycle: cycles.getById(newCycleId)!,
    };
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

  it('rejects rule-specific due/matcher mismatches and changed creation evidence', async () => {
    const { sourceCycleId } = await setup();
    const eventMatcher = {
      version: 1 as const, eventType: 'new-frbo-listing' as const, personWide: true as const,
    };
    const input = {
      id: 'event-rule', salesCycleId: sourceCycleId, ruleType: 'new-frbo-listing' as const,
      dueAt: null as null, matcher: eventMatcher, version: 1, createdAt: DOMAIN_TIMESTAMP,
    };
    const first = unitOfWork.immediate(() => repository.insertRule(input));
    expect(first).toMatchObject(input);
    expect(() => unitOfWork.immediate(() => repository.insertRule({
      ...input, createdAt: '2026-08-30T12:00:01.000Z',
    }))).toThrow(LifecycleIdempotencyConflictError);
    expect(() => unitOfWork.immediate(() => repository.insertRule({
      ...input, id: 'wrong-event-matcher', matcher: {
        version: 1, eventType: 'lead-cert-expiry-window', personWide: true,
      },
    } as never))).toThrow();
    expect(() => unitOfWork.immediate(() => repository.insertRule({
      ...input, id: 'event-with-due', dueAt: OCTOBER,
    } as never))).toThrow();
    expect(() => unitOfWork.immediate(() => repository.insertRule({
      id: 'manual-with-matcher', salesCycleId: sourceCycleId, ruleType: 'manual',
      dueAt: OCTOBER, matcher: eventMatcher, version: 1, createdAt: DOMAIN_TIMESTAMP,
    } as never))).toThrow();
  });

  it('returns an exact immutable receipt on replay and conflicts on changed command', async () => {
    const {
      personId, prospectId, sourceEventId, sourceCycleId, newCycleId, newCycle,
    } = await setup();
    unitOfWork.immediate(() => repository.insertRule({
      id: 'rule', salesCycleId: sourceCycleId, ruleType: 'manual',
      dueAt: OCTOBER, matcher: null, version: 1, createdAt: DOMAIN_TIMESTAMP,
    }));
    const input: InsertReactivationReceiptInput = {
      activationKey: 'rule:rule', activationKind: 'rule' as const,
      personId, sourceCycleId, reactivationRuleId: 'rule', sourceEventId: null,
      newCycleId,
      command: {
        version: 1 as const,
        command: {
          ruleId: 'rule', expectedRuleVersion: 1, personId, prospectId,
          sourceCycleId, entrySourceEventId: sourceEventId, newCycleId,
          activatedAt: OCTOBER, ruleType: 'manual',
          trigger: { kind: 'due', dueAt: OCTOBER },
        },
      },
      result: {
        version: 1 as const,
        result: { kind: 'reactivated', activationKind: 'rule', cycle: newCycle },
      },
      createdAt: DOMAIN_TIMESTAMP,
    };
    const first = unitOfWork.immediate(() => repository.insertOrGetReceipt(input));
    const replay = unitOfWork.immediate(() => repository.insertOrGetReceipt(input));
    expect(replay).toEqual(first);
    expect(Object.isFrozen(replay.command)).toBe(true);
    expect(() => unitOfWork.immediate(() => repository.insertOrGetReceipt({
      ...input, command: {
        version: 1, command: {
          ...(input.command as { version: 1; command: Record<string, unknown> }).command,
          newCycleId: 'changed-cycle',
        },
      },
    }))).toThrow(LifecycleIdempotencyConflictError);
    expect(() => unitOfWork.immediate(() => repository.insertOrGetReceipt({
      ...input, createdAt: '2026-08-30T12:00:01.000Z',
    }))).toThrow(LifecycleIdempotencyConflictError);
    unitOfWork.immediate(() => repository.insertRule({
      id: 'invalid-result', salesCycleId: sourceCycleId, ruleType: 'manual',
      dueAt: OCTOBER, matcher: null, version: 1, createdAt: DOMAIN_TIMESTAMP,
    }));
    const invalidResultCycleId = insertClosedCycle({
      database: database!.raw, prefix: 'invalid-result-new',
      prospect: { personId, prospectId, sourceEventId },
    });
    expect(() => unitOfWork.immediate(() => repository.insertOrGetReceipt({
      ...input,
      activationKey: 'rule:invalid-result',
      reactivationRuleId: 'invalid-result',
      newCycleId: invalidResultCycleId,
      result: { version: 1, result: { kind: 'reactivated', cycleId: invalidResultCycleId } },
    }))).toThrow();
    expect(() => database!.raw.prepare(`
      UPDATE cycle_reactivation_receipts SET result_json = '{}' WHERE activation_key = 'rule:rule'
    `).run()).toThrow();
    expect(() => database!.raw.prepare(`
      DELETE FROM cycle_reactivation_receipts WHERE activation_key = 'rule:rule'
    `).run()).toThrow();
  });
});
