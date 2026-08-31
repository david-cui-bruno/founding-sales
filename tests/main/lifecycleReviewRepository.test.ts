import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { BUILTIN_CADENCES } from '../../src/main/domain/cadence/builtinCadences';
import { CadenceRepository } from '../../src/main/domain/cadence/cadenceRepository';
import {
  LifecycleReviewRepository,
  type InsertLifecycleReviewInput,
} from '../../src/main/domain/lifecycle/lifecycleReviewRepository';
import { LifecycleIdempotencyConflictError } from '../../src/main/domain/support/domainErrors';
import { auditDomainInvariants } from '../../src/main/domain/lifecycle/invariantAudit';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { DOMAIN_TIMESTAMP, insertClosedCycle, seedProspect } from '../fixtures/domainRows';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';

const RESOLVED = '2026-08-31T12:00:00.000Z';
const WARM = BUILTIN_CADENCES.find(({ family }) => family === 'cadence_c')!;
const WARM_IDENTITY = {
  definitionId: WARM.id, family: 'cadence_c' as const,
  version: WARM.version, contentHash: WARM.contentHash,
} as const;

describe('LifecycleReviewRepository', () => {
  let database: AppDatabase | undefined;
  let workspace: TempDatabase | undefined;
  let unitOfWork: DomainUnitOfWork;
  let repository: LifecycleReviewRepository;

  afterEach(() => {
    if (database !== undefined) closeDatabase(database);
    workspace?.cleanup();
  });

  it('durably reuses identical blocked activation work and refuses resolution without a receipt', async () => {
    workspace = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: workspace.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${workspace.path}.backups`, workspaceKey: key,
    });
    unitOfWork = new DomainUnitOfWork(database);
    repository = new LifecycleReviewRepository({ database, unitOfWork });
    const cadences = new CadenceRepository({
      database, unitOfWork, clock: { now: () => DOMAIN_TIMESTAMP },
    });
    unitOfWork.immediate(() => cadences.installBuiltins());
    const prospect = seedProspect(database.raw, 'review');
    const sourceCycleId = insertClosedCycle({ database: database.raw, prefix: 'review-source', prospect });
    const newCycleId = insertClosedCycle({ database: database.raw, prefix: 'review-new', prospect });
    database.raw.prepare(`
      INSERT INTO cadence_enrollments (
        id, sales_cycle_id, cadence_definition_id, status, anchor_at,
        current_step_id, scheduled_step_count, mode, allowed_step_ids_json,
        version, stop_reason, created_at, updated_at
      ) VALUES ('review-enrollment', ?, ?, 'completed', ?, NULL, 0,
        'standard', NULL, 1, 'fixture', ?, ?)
    `).run(newCycleId, WARM.id, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    const command = {
      evidence: {
        kind: 'unknown_handle' as const, handleKind: 'phone' as const,
        normalizedValue: '+14015550100',
      },
      personId: prospect.personId, prospectId: prospect.prospectId,
      sourceCycleId, newCycleId, activatedAt: DOMAIN_TIMESTAMP,
      cadence: WARM_IDENTITY,
    };
    const input: InsertLifecycleReviewInput = {
      id: 'review-item', activationKey: 'inbound-handle:phone:+14015550100',
      personId: prospect.personId, prospectId: prospect.prospectId, sourceCycleId,
      reactivationRuleId: null, sourceEventId: null,
      reason: 'unknown_inbound_handle',
      payload: {
        version: 1 as const, kind: 'reactivation_blocked' as const,
        blocker: 'unknown_inbound_handle' as const, command,
      },
      createdAt: DOMAIN_TIMESTAMP,
    };
    const first = unitOfWork.immediate(() => repository.insertOrGetOpen(input));
    const replay = unitOfWork.immediate(() => repository.insertOrGetOpen(input));
    expect(replay).toEqual(first);
    expect(() => unitOfWork.immediate(() => repository.insertOrGetOpen({
      ...input, payload: {
        ...input.payload,
        command: { ...command, newCycleId: 'changed-cycle' },
      },
    }))).toThrow(LifecycleIdempotencyConflictError);

    expect(() => unitOfWork.immediate(() => repository.insertOrGetOpen({
      ...input, id: 'wrong-person-review',
      activationKey: 'inbound-handle:phone:+14015550101',
      personId: 'other-person',
      payload: {
        ...input.payload,
        command: {
          ...command,
          evidence: { ...command.evidence, normalizedValue: '+14015550101' },
        },
      },
    }))).toThrow();
    expect(() => unitOfWork.immediate(() => repository.insertOrGetOpen({
      ...input, id: 'extra-review',
      activationKey: 'inbound-handle:phone:+14015550102',
      payload: {
        ...input.payload, extra: true,
        command: {
          ...command,
          evidence: { ...command.evidence, normalizedValue: '+14015550102' },
        },
      } as never,
    }))).toThrow();

    expect(() => unitOfWork.immediate(() => repository.resolve({
      id: first.id, activationKey: first.activationKey, expectedVersion: 1,
      resolution: {
        version: 1, kind: 'reactivated', activationKind: 'inbound_response',
        newCycleId, cadence: WARM_IDENTITY,
      },
      resolvedAt: RESOLVED,
    }))).toThrow();
    expect(repository.getByActivationKey(first.activationKey)).toMatchObject({
      status: 'open', version: 1, resolution: null,
    });
    expect(auditDomainInvariants({ database: database!, asOf: DOMAIN_TIMESTAMP })).not.toContainEqual(
      expect.objectContaining({ kind: 'lifecycle_review_invalid', recordId: first.id }),
    );
    database!.raw.prepare(`
      UPDATE lifecycle_review_items
      SET status = 'resolved', resolution_json = '{}', resolved_at = ?, version = 2
      WHERE id = 'review-item'
    `).run(RESOLVED);
    expect(() => repository.getByActivationKey(first.activationKey)).toThrow();
    expect(auditDomainInvariants({ database: database!, asOf: DOMAIN_TIMESTAMP })).toContainEqual(
      expect.objectContaining({ kind: 'lifecycle_review_invalid', recordId: first.id }),
    );
    database.raw.exec('DROP TRIGGER protect_lifecycle_review_item_identity');
    database.raw.prepare(`
      UPDATE lifecycle_review_items SET payload_json = ? WHERE id = 'review-item'
    `).run(JSON.stringify({ ...input.payload, extra: true }));
    expect(() => repository.getByActivationKey(first.activationKey)).toThrow();
    expect(auditDomainInvariants({ database: database!, asOf: DOMAIN_TIMESTAMP })).toContainEqual(
      expect.objectContaining({ kind: 'lifecycle_review_invalid', recordId: first.id }),
    );
  });
});
