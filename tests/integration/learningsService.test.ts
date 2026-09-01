import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import {
  createDomainServices,
  type DomainServices,
} from '../../src/main/domain/createDomainServices';
import {
  createFounderSalesDomain,
  type FounderSalesDomain,
} from '../../src/main/domain/founderSalesDomain';
import { createLearningsService } from '../../src/main/learnings/learningsService';
import {
  learningsListResponseSchema,
} from '../../src/shared/contracts/learningsContract';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

const CLOCK_NOW = '2026-08-31T15:00:00.000Z';

class SequentialIds {
  private counter = 0;

  next(): string {
    this.counter += 1;
    return `generated-${this.counter}`;
  }
}

describe('learningsService', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let services: DomainServices;
  let domain: FounderSalesDomain;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`,
      workspaceKey: key,
    });
    const clock = { now: () => CLOCK_NOW };
    const ids = new SequentialIds();
    services = createDomainServices({ database, clock, ids });
    domain = createFounderSalesDomain({ database, services, clock, ids });
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  it('captures, lists, and curates a learning through the domain facade', async () => {
    const service = createLearningsService(domain);

    await service.capture({
      category: 'pain',
      statement: 'Landlords lose days chasing plumbers for urgent repairs.',
      confidence: 'medium',
      evidence: [
        {
          personId: null,
          activityId: null,
          quote: 'Last month a burst pipe sat for four days.',
          notedAt: CLOCK_NOW,
        },
      ],
      contradictionOf: null,
    });

    const list = learningsListResponseSchema.parse(
      await service.list({ categories: [], statuses: [], query: '', limit: 50 }),
    );
    expect(list.totalActiveCount).toBe(1);
    const learning = list.rows[0]!;
    expect(learning).toMatchObject({
      category: 'pain',
      status: 'active',
      sampleSize: 1,
    });

    await service.addEvidence({
      learningId: learning.learningId,
      expectedVersion: learning.version,
      evidence: {
        personId: null,
        activityId: null,
        quote: 'Second landlord reported the same delay pattern.',
        notedAt: CLOCK_NOW,
      },
    });

    const updated = learningsListResponseSchema.parse(
      await service.list({ categories: [], statuses: [], query: '', limit: 50 }),
    ).rows[0]!;
    expect(updated.sampleSize).toBe(2);

    await service.updateStatus({
      learningId: updated.learningId,
      expectedVersion: updated.version,
      status: 'retired',
      reason: null,
    });

    const retired = learningsListResponseSchema.parse(
      await service.list({ categories: [], statuses: ['retired'], query: '', limit: 50 }),
    );
    expect(retired.rows[0]!.status).toBe('retired');
    expect(retired.totalActiveCount).toBe(0);
  });

  it('surfaces version conflicts from stale curation commands', async () => {
    const service = createLearningsService(domain);
    await service.capture({
      category: 'objection',
      statement: 'Owners fear another subscription fee.',
      confidence: 'low',
      evidence: [
        {
          personId: null,
          activityId: null,
          quote: 'Why would I pay monthly for this?',
          notedAt: CLOCK_NOW,
        },
      ],
      contradictionOf: null,
    });
    const learning = learningsListResponseSchema.parse(
      await service.list({ categories: [], statuses: [], query: '', limit: 50 }),
    ).rows[0]!;

    await expect(
      service.updateStatus({
        learningId: learning.learningId,
        expectedVersion: learning.version + 5,
        status: 'retired',
        reason: null,
      }),
    ).rejects.toMatchObject({ code: 'LEARNING_VERSION_CONFLICT' });
  });
});
