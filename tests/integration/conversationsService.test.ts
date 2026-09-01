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
import { createConversationsService } from '../../src/main/conversations/conversationsService';
import {
  conversationDetailSchema,
  conversationsListResponseSchema,
} from '../../src/shared/contracts/conversationsContract';
import { insertPerson } from '../fixtures/domainRows';
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

describe('conversationsService', () => {
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

  function insertCallActivity(id: string, personId: string): void {
    insertPerson(database.raw, personId);
    database.raw.prepare(`
      INSERT INTO activities (
        id, person_id, kind, direction, channel, occurred_at,
        duration_seconds, metadata_json, created_at
      ) VALUES (?, ?, 'call', 'outbound', 'phone', ?, 120, '{}', ?)
    `).run(id, personId, CLOCK_NOW, CLOCK_NOW);
  }

  it('lists, reads, and attaches a transcript through the domain facade', async () => {
    insertCallActivity('activity-1', 'person-1');
    const service = createConversationsService(domain);

    const list = conversationsListResponseSchema.parse(
      await service.list({ query: '', filter: 'all', limit: 50, cursor: null }),
    );
    expect(list.total).toBe(1);
    expect(list.rows[0]).toMatchObject({
      activityId: 'activity-1',
      personId: 'person-1',
      transcriptAvailable: false,
    });

    const receipt = await service.attachTranscript({
      activityId: 'activity-1',
      personId: 'person-1',
      rawText: 'me: Hi, thanks for taking my call.\nJordan: No problem.',
    });
    expect(receipt.affectedPersonIds).toEqual(['person-1']);

    const detail = conversationDetailSchema.parse(
      await service.get({ activityId: 'activity-1' }),
    );
    expect(detail.transcriptAvailable).toBe(true);
    expect(detail.transcript?.utterances.map((u) => u.speaker)).toEqual([
      'founder',
      'lead',
    ]);
  });

  it('rejects a second transcript for the same conversation', async () => {
    insertCallActivity('activity-2', 'person-2');
    const service = createConversationsService(domain);
    await service.attachTranscript({
      activityId: 'activity-2',
      personId: 'person-2',
      rawText: 'me: First transcript.',
    });

    await expect(
      service.attachTranscript({
        activityId: 'activity-2',
        personId: 'person-2',
        rawText: 'me: Second transcript.',
      }),
    ).rejects.toMatchObject({ code: 'TRANSCRIPT_ALREADY_ATTACHED' });
  });
});
