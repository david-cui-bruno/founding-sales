import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { BUILTIN_CADENCES } from '../../src/main/domain/cadence/builtinCadences';
import {
  createDomainServices,
  type DomainServices,
} from '../../src/main/domain/createDomainServices';
import {
  createFounderSalesDomain,
  FounderSalesDomain,
} from '../../src/main/domain/founderSalesDomain';
import {
  BUILTIN_PRIORITIZATION_RULE_V1,
} from '../../src/main/domain/prioritization/builtinPrioritizationRules';
import { createReviewService } from '../../src/main/review/reviewService';
import { reviewSnapshotSchema } from '../../src/shared/contracts/reviewContract';
import {
  insertClosedCycle,
  insertSourceEvent,
  seedProspect,
} from '../fixtures/domainRows';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

const CLOCK_NOW = '2026-08-31T15:00:00.000Z';

class FixedClock {
  constructor(private value: string = CLOCK_NOW) {}

  now(): string {
    return this.value;
  }

  set(value: string): void {
    this.value = value;
  }
}

class SequentialIds {
  private counter = 0;

  next(): string {
    this.counter += 1;
    return `generated-${this.counter}`;
  }
}

describe('reviewService', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let services: DomainServices;
  let clock: FixedClock;
  let domain: FounderSalesDomain;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`, workspaceKey: key,
    });
    clock = new FixedClock();
    const ids = new SequentialIds();
    services = createDomainServices({ database, clock, ids });
    services.unitOfWork.immediate(() => {
      const installed = services.prioritizationRepository
        .installRuleVersion(BUILTIN_PRIORITIZATION_RULE_V1);
      services.prioritizationRepository.activateRuleVersion({
        ruleVersionId: installed.id, expectedActiveRuleVersionId: null,
      });
      services.cadences.installBuiltins();
    });
    domain = createFounderSalesDomain({ services, database, clock, ids });
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  function seedUnknownHandleReview(): string {
    const prospect = seedProspect(database.raw, 'inbound');
    const sourceCycleId = insertClosedCycle({
      database: database.raw, prefix: 'inbound-closed', prospect,
    });
    const cadence = BUILTIN_CADENCES.find(({ family }) => family === 'cadence_c')!;
    const result = services.lifecycle.reactivateFromInboundResponse({
      evidence: {
        kind: 'unknown_handle', handleKind: 'phone', normalizedValue: '+14015550100',
      },
      personId: prospect.personId,
      prospectId: prospect.prospectId,
      sourceCycleId,
      newCycleId: 'promoted-cycle',
      activatedAt: CLOCK_NOW,
      cadence: {
        definitionId: cadence.id, family: 'cadence_c',
        version: cadence.version, contentHash: cadence.contentHash,
      },
    });
    if (result.kind !== 'review_required') {
      throw new Error(`Expected an open review item, got ${result.kind}.`);
    }
    return result.reviewItem.id;
  }

  it('returns a strict empty snapshot for an empty workspace', async () => {
    const service = createReviewService(domain);

    const snapshot = await service.list({ kinds: [], limit: 50 });

    expect(snapshot).toEqual({
      items: [],
      totalOpenCount: 0,
      revision: expect.any(Number),
    });
    expect(Object.keys(snapshot).sort()).toEqual(['items', 'revision', 'totalOpenCount']);
    expect(() => reviewSnapshotSchema.parse(snapshot)).not.toThrow();
  });

  it('lists an open unknown-handle review as a typed unmatched communication', async () => {
    const reviewId = seedUnknownHandleReview();
    const service = createReviewService(domain);

    const snapshot = await service.list({ kinds: ['unmatched_communication'], limit: 50 });

    expect(snapshot.items).toEqual([{
      kind: 'unmatched_communication',
      reviewId,
      channel: 'text',
      handle: '+14015550100',
      occurredAt: CLOCK_NOW,
      summary: expect.any(String),
    }]);
    expect(snapshot.totalOpenCount).toBe(1);
    expect(() => reviewSnapshotSchema.parse(snapshot)).not.toThrow();
  });

  it('filters by kind while keeping the workspace-wide open count', async () => {
    seedUnknownHandleReview();
    const service = createReviewService(domain);

    const snapshot = await service.list({ kinds: ['system_error'], limit: 50 });

    expect(snapshot.items).toEqual([]);
    expect(snapshot.totalOpenCount).toBe(1);
  });

  it('promotes an unmatched communication and empties the queue', async () => {
    const reviewId = seedUnknownHandleReview();
    insertSourceEvent({
      database: database.raw,
      id: 'promoted-source',
      personId: 'inbound-person',
      channel: 'inbound_demo',
    });
    const service = createReviewService(domain);

    const receipt = await service.resolve({
      kind: 'unmatched_communication',
      reviewId,
      expectedVersion: 1,
      action: 'promote',
      personId: null,
      sourceEventId: 'promoted-source',
    });

    expect(receipt.affectedPersonIds).toEqual(['inbound-person']);
    expect(receipt.affectedSalesCycleIds).toEqual(['promoted-cycle']);
    expect(database.raw.prepare(
      `SELECT stage, workflow_status FROM sales_cycles WHERE id = 'promoted-cycle'`,
    ).get()).toEqual({ stage: 'contacted', workflow_status: 'active' });
    expect(database.raw.prepare(
      `SELECT status FROM lifecycle_review_items WHERE id = ?`,
    ).get(reviewId)).toEqual({ status: 'resolved' });

    const after = await service.list({ kinds: [], limit: 50 });
    expect(after.items).toEqual([]);
    expect(after.totalOpenCount).toBe(0);
  });

  it('rejects resolution commands the domain does not support yet', async () => {
    const service = createReviewService(domain);

    await expect(service.resolve({
      kind: 'import_problem',
      reviewId: 'review-import',
      expectedVersion: 1,
      action: 'dismiss',
    })).rejects.toThrow(/no V1 resolution/);
  });

  it('rejects a promotion whose evidence is not an eligible source event', async () => {
    const reviewId = seedUnknownHandleReview();
    const service = createReviewService(domain);

    await expect(service.resolve({
      kind: 'unmatched_communication',
      reviewId,
      expectedVersion: 1,
      action: 'promote',
      personId: null,
      sourceEventId: 'missing-source',
    })).rejects.toThrow();

    const snapshot = await service.list({ kinds: [], limit: 50 });
    expect(snapshot.totalOpenCount).toBe(1);
  });
});
