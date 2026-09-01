import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { migration0004Learnings } from '../../src/main/db/migrations/0004Learnings';
import {
  addLearningEvidence,
  captureLearning,
  LearningsDomainError,
  listLearnings,
  updateLearningStatus,
  type LearningsDomainDeps,
} from '../../src/main/domain/learnings/learningsDomain';
import { insertPerson } from '../fixtures/domainRows';
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

describe('learnings domain', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let clock: FixedClock;
  let deps: LearningsDomainDeps;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`, workspaceKey: key,
    });
    await migration0004Learnings.up(database.kysely);
    clock = new FixedClock();
    deps = { database, clock, ids: new SequentialIds() };
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  const listAll = () => listLearnings(deps, {
    categories: [], statuses: [], query: '', limit: 200,
  });

  function capturePain(overrides: {
    statement?: string;
    quote?: string;
    personId?: string | null;
    notedAt?: string;
  } = {}) {
    return captureLearning(deps, {
      category: 'pain',
      statement: overrides.statement ?? 'Owners lose weekends to showings.',
      confidence: 'medium',
      evidence: [{
        personId: overrides.personId ?? null,
        activityId: null,
        quote: overrides.quote ?? 'We keep losing weekends to showings.',
        notedAt: overrides.notedAt ?? '2026-08-30T12:00:00.000Z',
      }],
      contradictionOf: null,
    });
  }

  describe('captureLearning', () => {
    it('stores the learning with evidence and returns a receipt', () => {
      insertPerson(database.raw, 'person-1');

      const receipt = captureLearning(deps, {
        category: 'pricing_reaction',
        statement: 'Owners compare us to 8% full management.',
        confidence: 'low',
        evidence: [
          {
            personId: 'person-1',
            activityId: null,
            quote: 'My manager takes 8% and never answers.',
            notedAt: '2026-08-29T10:00:00.000Z',
          },
          {
            personId: null,
            activityId: null,
            quote: 'Second owner said the same at 8%.',
            notedAt: '2026-08-30T10:00:00.000Z',
          },
        ],
        contradictionOf: null,
      });

      expect(receipt.affectedPersonIds).toEqual(['person-1']);
      expect(receipt.affectedSalesCycleIds).toEqual([]);
      expect(receipt.revision).toBeGreaterThan(0);

      const response = listAll();
      expect(response.rows).toHaveLength(1);
      const row = response.rows[0]!;
      expect(row.category).toBe('pricing_reaction');
      expect(row.status).toBe('active');
      expect(row.sampleSize).toBe(2);
      expect(row.firstObservedAt).toBe('2026-08-29T10:00:00.000Z');
      expect(row.latestObservedAt).toBe('2026-08-30T10:00:00.000Z');
      expect(row.version).toBe(1);
      expect(row.evidence.map((item) => item.personName)).toEqual([
        'Person person-1', null,
      ]);
      expect(response.totalActiveCount).toBe(1);
    });

    it('rejects evidence naming a missing person', () => {
      expect(() => capturePain({ personId: 'missing-person' }))
        .toThrowError(LearningsDomainError);
      try {
        capturePain({ personId: 'missing-person' });
      } catch (error) {
        expect((error as LearningsDomainError).code).toBe('EVIDENCE_PERSON_NOT_FOUND');
      }
      expect(listAll().rows).toHaveLength(0);
    });

    it('marks the contradicted target and links the new learning', () => {
      capturePain();
      const targetId = listAll().rows[0]!.learningId;

      captureLearning(deps, {
        category: 'invalidated_assumption',
        statement: 'Weekend showings are not the real pain.',
        confidence: 'medium',
        evidence: [{
          personId: null,
          activityId: null,
          quote: 'Three owners said weekends are fine, tenants are not.',
          notedAt: '2026-08-31T09:00:00.000Z',
        }],
        contradictionOf: targetId,
      });

      const rows = listAll().rows;
      const target = rows.find((row) => row.learningId === targetId)!;
      const contradiction = rows.find((row) => row.learningId !== targetId)!;
      expect(target.status).toBe('contradicted');
      expect(target.version).toBe(2);
      expect(contradiction.contradictionOf).toBe(targetId);
      expect(database.raw.prepare(
        'SELECT status_reason FROM learnings WHERE id = ?',
      ).get(targetId)).toEqual({
        status_reason: `Contradicted by ${contradiction.learningId}`,
      });
      expect(listAll().totalActiveCount).toBe(1);
    });

    it('rejects contradictions of missing or non-active targets', () => {
      expect(() => captureLearning(deps, {
        category: 'pain',
        statement: 'Contradiction of nothing.',
        confidence: 'low',
        evidence: [{
          personId: null, activityId: null,
          quote: 'Quote.', notedAt: CLOCK_NOW,
        }],
        contradictionOf: 'missing-learning',
      })).toThrowError(/contradict/i);

      capturePain();
      const learningId = listAll().rows[0]!.learningId;
      updateLearningStatus(deps, {
        learningId, expectedVersion: 1, status: 'retired', reason: null,
      });

      try {
        captureLearning(deps, {
          category: 'pain',
          statement: 'Contradiction of a retired learning.',
          confidence: 'low',
          evidence: [{
            personId: null, activityId: null,
            quote: 'Quote.', notedAt: CLOCK_NOW,
          }],
          contradictionOf: learningId,
        });
        expect.unreachable('capture should have thrown');
      } catch (error) {
        expect((error as LearningsDomainError).code).toBe('CONTRADICTION_TARGET_INVALID');
      }
    });
  });

  describe('addLearningEvidence', () => {
    it('appends evidence and bumps the version', () => {
      capturePain();
      const learningId = listAll().rows[0]!.learningId;
      clock.set('2026-08-31T16:00:00.000Z');

      const receipt = addLearningEvidence(deps, {
        learningId,
        expectedVersion: 1,
        evidence: {
          personId: null,
          activityId: null,
          quote: 'Another owner said the same thing.',
          notedAt: '2026-08-31T15:30:00.000Z',
        },
      });

      expect(receipt.revision).toBeGreaterThan(0);
      const row = listAll().rows[0]!;
      expect(row.sampleSize).toBe(2);
      expect(row.version).toBe(2);
      expect(row.latestObservedAt).toBe('2026-08-31T15:30:00.000Z');
      expect(database.raw.prepare(
        'SELECT updated_at FROM learnings WHERE id = ?',
      ).get(learningId)).toEqual({ updated_at: '2026-08-31T16:00:00.000Z' });
    });

    it('rejects a stale expected version and missing learnings', () => {
      capturePain();
      const learningId = listAll().rows[0]!.learningId;
      const evidence = {
        personId: null as string | null, activityId: null as string | null,
        quote: 'Quote.', notedAt: CLOCK_NOW,
      };

      try {
        addLearningEvidence(deps, { learningId, expectedVersion: 9, evidence });
        expect.unreachable('append should have thrown');
      } catch (error) {
        expect((error as LearningsDomainError).code).toBe('LEARNING_VERSION_CONFLICT');
      }

      try {
        addLearningEvidence(deps, {
          learningId: 'missing-learning', expectedVersion: 1, evidence,
        });
        expect.unreachable('append should have thrown');
      } catch (error) {
        expect((error as LearningsDomainError).code).toBe('LEARNING_NOT_FOUND');
      }

      expect(listAll().rows[0]!.sampleSize).toBe(1);
    });

    it('rejects appended evidence naming a missing person', () => {
      capturePain();
      const learningId = listAll().rows[0]!.learningId;

      try {
        addLearningEvidence(deps, {
          learningId,
          expectedVersion: 1,
          evidence: {
            personId: 'missing-person', activityId: null,
            quote: 'Quote.', notedAt: CLOCK_NOW,
          },
        });
        expect.unreachable('append should have thrown');
      } catch (error) {
        expect((error as LearningsDomainError).code).toBe('EVIDENCE_PERSON_NOT_FOUND');
      }
    });
  });

  describe('updateLearningStatus', () => {
    it('retires and reactivates with optimistic locking', () => {
      capturePain();
      const learningId = listAll().rows[0]!.learningId;

      updateLearningStatus(deps, {
        learningId, expectedVersion: 1, status: 'retired', reason: null,
      });
      expect(listAll().rows[0]!.status).toBe('retired');
      expect(listAll().totalActiveCount).toBe(0);

      updateLearningStatus(deps, {
        learningId, expectedVersion: 2, status: 'active', reason: null,
      });
      expect(listAll().rows[0]!.status).toBe('active');
      expect(listAll().rows[0]!.version).toBe(3);
    });

    it('marks contradicted with the required reason', () => {
      capturePain();
      const learningId = listAll().rows[0]!.learningId;

      updateLearningStatus(deps, {
        learningId, expectedVersion: 1,
        status: 'contradicted', reason: 'Later interviews disagreed.',
      });

      expect(database.raw.prepare(
        'SELECT status, status_reason FROM learnings WHERE id = ?',
      ).get(learningId)).toEqual({
        status: 'contradicted', status_reason: 'Later interviews disagreed.',
      });
    });

    it('rejects stale versions, missing learnings, and no-op transitions', () => {
      capturePain();
      const learningId = listAll().rows[0]!.learningId;

      try {
        updateLearningStatus(deps, {
          learningId, expectedVersion: 5, status: 'retired', reason: null,
        });
        expect.unreachable('update should have thrown');
      } catch (error) {
        expect((error as LearningsDomainError).code).toBe('LEARNING_VERSION_CONFLICT');
      }

      try {
        updateLearningStatus(deps, {
          learningId: 'missing', expectedVersion: 1, status: 'retired', reason: null,
        });
        expect.unreachable('update should have thrown');
      } catch (error) {
        expect((error as LearningsDomainError).code).toBe('LEARNING_NOT_FOUND');
      }

      try {
        updateLearningStatus(deps, {
          learningId, expectedVersion: 1, status: 'active', reason: null,
        });
        expect.unreachable('update should have thrown');
      } catch (error) {
        expect((error as LearningsDomainError).code).toBe('LEARNING_STATUS_INVALID');
      }
    });
  });

  describe('listLearnings', () => {
    it('filters by category, status, and escaped query text', () => {
      capturePain({ statement: 'Owners lose 100% of weekends.', quote: 'Every weekend gone.' });
      captureLearning(deps, {
        category: 'objection',
        statement: 'Owners fear losing tenant relationships.',
        confidence: 'high',
        evidence: [{
          personId: null, activityId: null,
          quote: 'What if my tenants stop calling me?',
          notedAt: '2026-08-31T08:00:00.000Z',
        }],
        contradictionOf: null,
      });

      expect(listLearnings(deps, {
        categories: ['objection'], statuses: [], query: '', limit: 200,
      }).rows.map((row) => row.category)).toEqual(['objection']);

      expect(listLearnings(deps, {
        categories: [], statuses: [], query: '100%', limit: 200,
      }).rows.map((row) => row.statement)).toEqual(['Owners lose 100% of weekends.']);

      expect(listLearnings(deps, {
        categories: [], statuses: [], query: 'tenants stop calling', limit: 200,
      }).rows.map((row) => row.category)).toEqual(['objection']);

      const objectionId = listLearnings(deps, {
        categories: ['objection'], statuses: [], query: '', limit: 200,
      }).rows[0]!.learningId;
      updateLearningStatus(deps, {
        learningId: objectionId, expectedVersion: 1, status: 'retired', reason: null,
      });
      expect(listLearnings(deps, {
        categories: [], statuses: ['retired'], query: '', limit: 200,
      }).rows.map((row) => row.learningId)).toEqual([objectionId]);
    });

    it('orders active learnings first, then by latest observation', () => {
      capturePain({ statement: 'Oldest active.', notedAt: '2026-08-01T00:00:00.000Z' });
      capturePain({ statement: 'Newest active.', notedAt: '2026-08-30T00:00:00.000Z' });
      capturePain({ statement: 'Retired but newest overall.', notedAt: '2026-08-31T00:00:00.000Z' });
      const retiredId = listAll().rows
        .find((row) => row.statement === 'Retired but newest overall.')!.learningId;
      updateLearningStatus(deps, {
        learningId: retiredId, expectedVersion: 1, status: 'retired', reason: null,
      });

      expect(listAll().rows.map((row) => row.statement)).toEqual([
        'Newest active.', 'Oldest active.', 'Retired but newest overall.',
      ]);
    });

    it('applies the limit while keeping the workspace active count', () => {
      capturePain({ statement: 'First learning.' });
      capturePain({ statement: 'Second learning.' });

      const response = listLearnings(deps, {
        categories: [], statuses: [], query: '', limit: 1,
      });
      expect(response.rows).toHaveLength(1);
      expect(response.totalActiveCount).toBe(2);
    });
  });
});
