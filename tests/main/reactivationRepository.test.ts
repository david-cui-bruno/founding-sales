import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { BUILTIN_CADENCES } from '../../src/main/domain/cadence/builtinCadences';
import { CadenceRepository } from '../../src/main/domain/cadence/cadenceRepository';
import {
  ReactivationRepository,
  type InsertReactivationReceiptInput,
} from '../../src/main/domain/lifecycle/reactivationRepository';
import { SalesCycleRepository } from '../../src/main/domain/lifecycle/salesCycleRepository';
import { auditDomainInvariants } from '../../src/main/domain/lifecycle/invariantAudit';
import type { SalesCycle } from '../../src/main/domain/lifecycle/lifecycleTypes';
import { LifecycleIdempotencyConflictError, StaleDomainWriteError } from '../../src/main/domain/support/domainErrors';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { DOMAIN_TIMESTAMP, insertClosedCycle, seedProspect } from '../fixtures/domainRows';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';

const OCTOBER = '2026-10-01T13:00:00.000Z';
const COLD_CADENCE = BUILTIN_CADENCES.find(({ family }) => family === 'cadence_b')!;
const COLD_IDENTITY = {
  definitionId: COLD_CADENCE.id, family: 'cadence_b' as const,
  version: COLD_CADENCE.version, contentHash: COLD_CADENCE.contentHash,
} as const;

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
    const cadences = new CadenceRepository({
      database, unitOfWork, clock: { now: () => DOMAIN_TIMESTAMP },
    });
    unitOfWork.immediate(() => cadences.installBuiltins());
    const prospect = seedProspect(database.raw, 'reactivation');
    const sourceCycleId = insertClosedCycle({ database: database.raw, prefix: 'source', prospect });
    const newCycleId = 'new-cycle';
    database.raw.exec('BEGIN IMMEDIATE');
    try {
      database.raw.prepare(`
        INSERT INTO sales_cycles (
          id, person_id, prospect_id, entry_source_event_id, stage, workflow_status,
          current_next_action_id, stage_entered_at, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'ready', 'active', 'receipt-action', ?, 1, ?, ?)
      `).run(newCycleId, prospect.personId, prospect.prospectId, prospect.sourceEventId,
        OCTOBER, OCTOBER, OCTOBER);
      database.raw.prepare(`
        INSERT INTO cadence_enrollments (
          id, sales_cycle_id, cadence_definition_id, status, anchor_at,
          current_step_id, scheduled_step_count, mode, allowed_step_ids_json,
          version, stop_reason, created_at, updated_at
        ) VALUES ('receipt-enrollment', ?, ?, 'active', ?,
          'cadence-b-v1-day-0', 1, 'standard', NULL, 1, NULL, ?, ?)
      `).run(newCycleId, COLD_CADENCE.id, OCTOBER, OCTOBER, OCTOBER);
      database.raw.prepare(`
        INSERT INTO next_actions (
          id, sales_cycle_id, action_type, channel, status, due_at, timezone,
          work_intent, cadence_enrollment_id, cadence_step_id, cadence_component_id,
          created_at, updated_at
        ) VALUES ('receipt-action', ?, 'call', 'call', 'pending', ?,
          'America/New_York', 'discretionary_prospecting', 'receipt-enrollment',
          'cadence-b-v1-day-0', 'cadence-b-v1-day-0-call', ?, ?)
      `).run(newCycleId, OCTOBER, OCTOBER, OCTOBER);
      database.raw.prepare(`
        INSERT INTO stage_events (
          id, sales_cycle_id, from_stage, to_stage, effective_at, confirmed_at,
          confirmation_kind, transition_sequence, created_at
        ) VALUES ('receipt-stage', ?, NULL, 'ready', ?, ?, 'mechanical', 1, ?)
      `).run(newCycleId, OCTOBER, OCTOBER, DOMAIN_TIMESTAMP);
      database.raw.exec('COMMIT');
    } catch (error) {
      if (database.raw.inTransaction) database.raw.exec('ROLLBACK');
      throw error;
    }
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
      } as never,
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
    unitOfWork.immediate(() => repository.consumeRule({
      ruleId: 'rule', salesCycleId: sourceCycleId,
      expectedVersion: 1, consumedAt: OCTOBER,
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
          cadence: COLD_IDENTITY,
        },
      },
      result: {
        version: 1 as const,
        result: {
          kind: 'reactivated', activationKind: 'rule', cycle: newCycle,
          cadence: COLD_IDENTITY,
        },
      },
      createdAt: OCTOBER,
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
      } as never,
    }))).toThrow(LifecycleIdempotencyConflictError);
    expect(() => unitOfWork.immediate(() => repository.insertOrGetReceipt({
      ...input, createdAt: '2026-10-01T13:00:01.000Z',
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
      result: {
        version: 1, result: { kind: 'reactivated', cycleId: invalidResultCycleId },
      } as never,
    }))).toThrow();
    expect(() => database!.raw.prepare(`
      UPDATE cycle_reactivation_receipts SET result_json = '{}' WHERE activation_key = 'rule:rule'
    `).run()).toThrow();
    expect(() => database!.raw.prepare(`
      DELETE FROM cycle_reactivation_receipts WHERE activation_key = 'rule:rule'
    `).run()).toThrow();
  });

  it('rejects strict or relationally mismatched receipt envelopes on append and read', async () => {
    const {
      personId, prospectId, sourceEventId, sourceCycleId, newCycleId, newCycle,
    } = await setup();
    unitOfWork.immediate(() => repository.insertRule({
      id: 'strict-rule', salesCycleId: sourceCycleId, ruleType: 'manual',
      dueAt: OCTOBER, matcher: null, version: 1, createdAt: DOMAIN_TIMESTAMP,
    }));
    unitOfWork.immediate(() => repository.consumeRule({
      ruleId: 'strict-rule', salesCycleId: sourceCycleId,
      expectedVersion: 1, consumedAt: OCTOBER,
    }));
    const valid: InsertReactivationReceiptInput = {
      activationKey: 'rule:strict-rule', activationKind: 'rule', personId,
      sourceCycleId, reactivationRuleId: 'strict-rule', sourceEventId: null,
      newCycleId, createdAt: OCTOBER,
      command: { version: 1, command: {
        ruleId: 'strict-rule', expectedRuleVersion: 1, personId, prospectId,
        sourceCycleId, entrySourceEventId: sourceEventId, newCycleId,
        activatedAt: OCTOBER, ruleType: 'manual',
        trigger: { kind: 'due', dueAt: OCTOBER }, cadence: COLD_IDENTITY,
      } },
      result: { version: 1, result: {
        kind: 'reactivated', activationKind: 'rule', cycle: newCycle,
        cadence: COLD_IDENTITY,
      } },
    };
    expect(() => unitOfWork.immediate(() => repository.insertOrGetReceipt({
      ...valid, command: { ...valid.command, extra: true } as never,
    }))).toThrow();
    expect(() => unitOfWork.immediate(() => repository.insertOrGetReceipt({
      ...valid,
      command: { version: 1, command: { ...valid.command.command, personId: 'other-person' } },
    }))).toThrow();
    expect(() => unitOfWork.immediate(() => repository.insertOrGetReceipt({
      ...valid,
      result: { version: 1, result: {
        ...valid.result.result, cycle: { ...valid.result.result.cycle, personId: 'other-person' },
      } },
    }))).toThrow();

    unitOfWork.immediate(() => repository.insertOrGetReceipt(valid));
    expect(auditDomainInvariants({ database: database!, asOf: OCTOBER })).not.toContainEqual(
      expect.objectContaining({ kind: 'reactivation_receipt_invalid', recordId: valid.activationKey }),
    );
    database!.raw.exec(`DROP TRIGGER immutable_cycle_reactivation_receipts`);
    database!.raw.prepare(`
      UPDATE cycle_reactivation_receipts SET command_json = ? WHERE activation_key = ?
    `).run(JSON.stringify({
      version: 1, command: { ...valid.command.command, extra: true },
    }), valid.activationKey);
    expect(() => repository.getReceipt(valid.activationKey)).toThrow();
    expect(auditDomainInvariants({ database: database!, asOf: OCTOBER })).toContainEqual(
      expect.objectContaining({ kind: 'reactivation_receipt_invalid', recordId: valid.activationKey }),
    );
  });
});
