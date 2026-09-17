import { productionDomainGate } from '../fixtures/productionDomainGate';
import { createReviewProvider } from '../fixtures/legacyDomainProviders';
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

import { reviewSnapshotSchema, type ReviewKind } from '../../src/shared/contracts/reviewContract';
import {
  insertClosedCycle,
  insertOpenCycleWithAction,
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

  type ReliabilityMappedKind = 'unmatched_communication' | 'system_error';

  function seedReliabilityReview(index: number, kind: ReliabilityMappedKind, activatedAt = CLOCK_NOW) {
    const prefix = `reliability-${String(index).padStart(4, '0')}`;
    const prospect = seedProspect(database.raw, prefix);
    const sourceCycleId = insertClosedCycle({ database: database.raw, prefix: `${prefix}-closed`, prospect });
    const cadence = BUILTIN_CADENCES.find(definition => definition.family === 'cadence_c')!;
    if (kind === 'system_error') {
      insertOpenCycleWithAction({ database: database.raw, prefix: `${prefix}-active`, prospect });
      insertSourceEvent({ database: database.raw, id: `${prefix}-inbound`, personId: prospect.personId, channel: 'inbound_demo' });
    }
    const evidence = kind === 'unmatched_communication'
      ? { kind: 'unknown_handle' as const, handleKind: 'email' as const, normalizedValue: `${prefix}@example.com` }
      : { kind: 'source_event' as const, sourceEventId: `${prefix}-inbound`, channel: 'inbound_demo' as const };
    const result = services.lifecycle.reactivateFromInboundResponse({
      evidence, personId: prospect.personId, prospectId: prospect.prospectId,
      sourceCycleId, newCycleId: `${prefix}-reactivated`, activatedAt,
      cadence: { definitionId: cadence.id, family: 'cadence_c', version: cadence.version, contentHash: cadence.contentHash },
    });
    expect(result.kind).toBe('review_required');
    if (result.kind !== 'review_required') throw new Error('Valid fixture did not create a retained review');
    expect(result.reviewItem.reason).toBe(kind === 'unmatched_communication' ? 'unknown_inbound_handle' : 'operational_cycle_exists');
    return result.reviewItem.id;
  }

  function reliabilityReviewCursor(page: object): string | null {
    expect(page).toHaveProperty('nextCursor');
    const cursor = 'nextCursor' in page ? page.nextCursor : undefined;
    expect(cursor === null || typeof cursor === 'string').toBe(true);
    if (cursor === null) return null;
    if (typeof cursor === 'string') return cursor;
    throw new Error('Review boundary did not return a typed continuation');
  }

  describe('reliability: complete lifecycle projection', () => {
    it.each([
      { majority: 'system_error' as const, minority: 'unmatched_communication' as const },
      { majority: 'unmatched_communication' as const, minority: 'system_error' as const },
    ])('finds all three later $minority records after 205 $majority rows', async ({ majority, minority }) => {
      for (let index = 0; index < 205; index += 1) seedReliabilityReview(index, majority);
      const laterIds = Array.from({ length: 3 }, (_, offset) =>
        seedReliabilityReview(205 + offset, minority, '2026-08-31T16:00:00.000Z'));
      const before = database.raw.prepare('SELECT * FROM lifecycle_review_items ORDER BY id').all();
      const changes = database.raw.prepare('SELECT total_changes() AS count').get();
      const service = createReviewProvider(productionDomainGate(domain));
      const filtered = await service.list({ kinds: [minority], limit: 200 });
      expect(filtered.items.map(item => item.reviewId).sort()).toEqual([...laterIds].sort());
      expect(filtered.items.every(item => item.kind === minority)).toBe(true);
      expect(filtered).toMatchObject({
        totalOpenCount: 208, matchedCount: 3, nextCursor: null,
        countScope: 'lifecycle_review_items', observedAt: CLOCK_NOW,
        queues: {
          [majority]: { source: 'lifecycle_review_items', openCount: 205 },
          [minority]: { source: 'lifecycle_review_items', openCount: 3 },
          ambiguous_identity: { source: 'not_integrated', openCount: null },
          transcript_suggestion: { source: 'not_integrated', openCount: null },
          import_problem: { source: 'not_integrated', openCount: null },
          adapter_failure: { source: 'not_integrated', openCount: null },
        },
      });
      expect(database.raw.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
      expect(database.raw.prepare('SELECT * FROM lifecycle_review_items ORDER BY id').all()).toEqual(before);
    }, 30_000);

    it('walks all 208 tied lifecycle identities as 200 plus eight without a read-side mutation', async () => {
      const expectedIds = Array.from({ length: 208 }, (_, index) =>
        seedReliabilityReview(index, index < 205 ? 'unmatched_communication' : 'system_error'));
      const before = database.raw.prepare('SELECT * FROM lifecycle_review_items ORDER BY id').all();
      const changes = database.raw.prepare('SELECT total_changes() AS count').get();
      const service = createReviewProvider(productionDomainGate(domain));
      const request = { kinds: [] as ReviewKind[], limit: 200 };
      const first = await service.list(request);
      expect(first.items).toHaveLength(200);
      expect(first).toMatchObject({ totalOpenCount: 208, matchedCount: 208 });
      const cursor = reliabilityReviewCursor(first);
      expect(cursor).not.toBeNull();
      const continuation = { ...request, cursor };
      const second = await service.list(continuation);
      expect(second.items).toHaveLength(8);
      expect(second).toMatchObject({ totalOpenCount: 208, matchedCount: 208, nextCursor: null });
      const seen = [...first.items, ...second.items].map(item => item.reviewId);
      expect(seen).toEqual([...expectedIds].sort()); // All timestamps tie: id ASC is decisive.
      expect(new Set(seen).size).toBe(208);
      expect(database.raw.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
      expect(database.raw.prepare('SELECT * FROM lifecycle_review_items ORDER BY id').all()).toEqual(before);
    }, 30_000);

    it('counts every local kind even in a limit-one or unavailable-source view', async () => {
      seedReliabilityReview(0, 'unmatched_communication');
      seedReliabilityReview(1, 'system_error');
      const service = createReviewProvider(productionDomainGate(domain));
      const summary = await service.list({ kinds: [], limit: 1 });
      expect(summary.items).toHaveLength(1);
      expect(summary).toMatchObject({ totalOpenCount: 2, matchedCount: 2,
        queues: { unmatched_communication: { openCount: 1 }, system_error: { openCount: 1 } } });
      const both = await service.list({ kinds: ['unmatched_communication', 'system_error'], limit: 200 });
      expect(both.items).toHaveLength(2);
      for (const kind of ['ambiguous_identity', 'transcript_suggestion', 'import_problem', 'adapter_failure'] as const) {
        const unavailable = await service.list({ kinds: [kind], limit: 1 });
        expect(unavailable).toMatchObject({ items: [], totalOpenCount: 2, matchedCount: 0, nextCursor: null,
          queues: { [kind]: { source: 'not_integrated', openCount: null } } });
      }
    });

    it.each(['null', '{', '[]', '{"blocker":42}', '{"blocker":"unknown_inbound_handle","command":{"evidence":{"kind":"unknown_handle","normalizedValue":42}}}'])('retains a corrupt payload as a safe system-error item: %s', async payload => {
        const originalId = seedReliabilityReview(0, 'unmatched_communication');
        const original = database.raw.prepare('SELECT * FROM lifecycle_review_items WHERE id = ?').get(originalId);
        const id = 'synthetic-corrupt-review';
        // Synthetic malformed persisted evidence, not a valid lifecycle command or recovery bypass.
        // Keep the valid original and all immutable/FK guards. Only the new row has a bad payload.
        const inserted = database.raw.prepare(`
          INSERT INTO lifecycle_review_items (
            id, activation_key, status, person_id, prospect_id, source_cycle_id,
            reactivation_rule_id, source_event_id, reason, payload_json,
            resolution_json, resolved_at, version, created_at, updated_at
          )
          SELECT ?, ?, status, person_id, prospect_id, source_cycle_id,
            reactivation_rule_id, source_event_id, reason, ?,
            resolution_json, resolved_at, version, created_at, updated_at
          FROM lifecycle_review_items WHERE id = ?
        `).run(id, 'inbound-handle:email:synthetic-corrupt@example.com', payload, originalId);
        expect(inserted.changes).toBe(1);
        expect(database.raw.prepare('SELECT * FROM lifecycle_review_items WHERE id = ?').get(originalId)).toEqual(original);
        const before = database.raw.prepare('SELECT * FROM lifecycle_review_items ORDER BY id').all();
        const changes = database.raw.prepare('SELECT total_changes() AS count').get();
        await expect(createReviewProvider(productionDomainGate(domain)).list({ kinds: [], limit: 200 })).resolves.toMatchObject({
          items: expect.arrayContaining([
            expect.objectContaining({ reviewId: originalId, kind: 'unmatched_communication' }),
            expect.objectContaining({ reviewId: id, kind: 'system_error' }),
          ]),
          totalOpenCount: 2, matchedCount: 2,
          queues: { unmatched_communication: { openCount: 1 }, system_error: { openCount: 1 } },
        });
        expect(database.raw.prepare('SELECT * FROM lifecycle_review_items ORDER BY id').all()).toEqual(before);
        expect(database.raw.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
      });

    it('rejects a continuation after an intervening retained-review insertion', async () => {
      seedReliabilityReview(0, 'unmatched_communication');
      seedReliabilityReview(1, 'unmatched_communication');
      seedReliabilityReview(2, 'unmatched_communication');
      const service = createReviewProvider(productionDomainGate(domain));
      const request = { kinds: [] as ReviewKind[], limit: 2 };
      const first = await service.list(request);
      const cursor = reliabilityReviewCursor(first);
      expect(cursor).not.toBeNull();
      seedReliabilityReview(3, 'system_error');
      const continuation = { ...request, cursor };
      await expect(service.list(continuation)).rejects.toThrow('LIST_CURSOR_STALE');
      const refreshed = await service.list(request);
      expect(refreshed).toMatchObject({ totalOpenCount: 4, matchedCount: 4 });
    });
  });

  // Explicit parent-only opt-in, with setup separate from five serial complete walks.
  if (process.env.FSS_LIST_BENCHMARK === '1') {
    it.each([208, 2080])('benchmark: complete fictional review projection with %i records', async count => {
      const setupStart = performance.now();
      const expectedIds = Array.from({ length: count }, (_, index) =>
        seedReliabilityReview(index, index % 10 === 0 ? 'system_error' : 'unmatched_communication')).sort();
      const setupMs = performance.now() - setupStart;
      const changes = database.raw.prepare('SELECT total_changes() AS count').get();
      const service = createReviewProvider(productionDomainGate(domain));
      const samples: { firstMs: number; continuationMs: number[]; walkMs: number }[] = [];
      for (let sample = 0; sample < 5; sample += 1) {
        const start = performance.now();
        const first = await service.list({ kinds: [], cursor: null, limit: 200 });
        const firstMs = performance.now() - start;
        const seen = first.items.map(row => row.reviewId);
        const continuationMs: number[] = [];
        let cursor = first.nextCursor;
        for (let page = 1; cursor !== null && page < Math.ceil(count / 200); page += 1) {
          const pageStart = performance.now();
          const next = await service.list({ kinds: [], cursor, limit: 200 });
          continuationMs.push(performance.now() - pageStart);
          expect(next.totalOpenCount).toBe(count);
          seen.push(...next.items.map(row => row.reviewId));
          cursor = next.nextCursor;
        }
        const walkMs = performance.now() - start;
        expect(cursor).toBeNull();
        expect(seen.sort()).toEqual(expectedIds);
        expect(new Set(seen).size).toBe(count);
        expect(database.raw.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
        samples.push({ firstMs, continuationMs, walkMs });
      }
      console.log(JSON.stringify({ benchmark: 'full-projection-review', fictionalRecords: count, setupMs, samples }));
    }, 120_000);
  }

  it('returns a strict empty snapshot for an empty workspace', async () => {
    const service = createReviewProvider(productionDomainGate(domain));

    const snapshot = await service.list({ kinds: [], limit: 50 });

    expect(snapshot).toEqual({
      items: [],
      totalOpenCount: 0,
      nextCursor: null, matchedCount: 0,
  countScope: 'lifecycle_review_items', observedAt: CLOCK_NOW,
  queues: {
    unmatched_communication: { source: 'lifecycle_review_items', openCount: 0 },
    system_error: { source: 'lifecycle_review_items', openCount: 0 },
    ambiguous_identity: { source: 'not_integrated', openCount: null },
    transcript_suggestion: { source: 'not_integrated', openCount: null },
    import_problem: { source: 'not_integrated', openCount: null },
    adapter_failure: { source: 'not_integrated', openCount: null },
  },
      revision: expect.any(Number),
    });
    expect(Object.keys(snapshot).sort()).toEqual(['countScope', 'items', 'matchedCount', 'nextCursor', 'observedAt', 'queues', 'revision', 'totalOpenCount']);
    expect(() => reviewSnapshotSchema.parse(snapshot)).not.toThrow();
  });

  it('lists an open unknown-handle review as a typed unmatched communication', async () => {
    const reviewId = seedUnknownHandleReview();
    const service = createReviewProvider(productionDomainGate(domain));

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
    const service = createReviewProvider(productionDomainGate(domain));

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
    const service = createReviewProvider(productionDomainGate(domain));

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
    const service = createReviewProvider(productionDomainGate(domain));

    await expect(service.resolve({
      kind: 'import_problem',
      reviewId: 'review-import',
      expectedVersion: 1,
      action: 'dismiss',
    })).rejects.toThrow(/no V1 resolution/);
  });

  it('rejects a promotion whose evidence is not an eligible source event', async () => {
    const reviewId = seedUnknownHandleReview();
    const service = createReviewProvider(productionDomainGate(domain));

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
