import { productionDomainGate } from '../fixtures/productionDomainGate';
import { createConversationsProvider } from '../../src/main/ipc/registerApplicationIpc';
import { readFileSync } from 'node:fs';
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

import { BUILTIN_PRIORITIZATION_RULE_V1 } from '../../src/main/domain/prioritization/builtinPrioritizationRules';
import {
  conversationDetailSchema,
  conversationsListResponseSchema,
} from '../../src/shared/contracts/conversationsContract';
import { insertPerson } from '../fixtures/domainRows';
import { seedDiscoveryOwner } from '../fixtures/discoveryDatabase';
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
    return `00000000-0000-4000-8000-${String(this.counter).padStart(12, '0')}`;
  }
}

describe('conversationsService', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let services: DomainServices;
  let domain: FounderSalesDomain;
  let now: string;
  let key: ReturnType<typeof createTestWorkspaceKey>;
  let ids: SequentialIds;

  beforeEach(async () => {
    temp = createTempDatabase();
    key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`,
      workspaceKey: key,
    });
    now = CLOCK_NOW;
    const clock = { now: () => now };
    ids = new SequentialIds();
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
    const service = createConversationsProvider(productionDomainGate(domain));

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
    const service = createConversationsProvider(productionDomainGate(domain));
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

  it('keeps a later manual attachment readable by discovery after encrypted reopen without backdating permission', async () => {
    const occurredAt = '2026-09-06T12:00:00.000Z';
    const attachedAt = '2026-09-06T13:00:00.000Z';
    now = occurredAt;
    services.unitOfWork.immediate(() => {
      services.prioritizationRepository.installRuleVersion(BUILTIN_PRIORITIZATION_RULE_V1);
      services.prioritizationRepository.activateRuleVersion({
        ruleVersionId: 'founder-priority-v1', expectedActiveRuleVersionId: null,
      });
    });
    const owner = seedDiscoveryOwner({ services }, { prefix: 'delayed', units: 10 });
    services.unitOfWork.immediate(() => services.events.appendActivity({
      id: 'delayed-call', personId: owner.personId, prospectId: owner.prospectId,
      salesCycleId: owner.salesCycleId, kind: 'call', direction: 'inbound', channel: 'phone',
      occurredAt, callOutcome: 'spoke',
    }));
    expect(services.events.getActivity('delayed-call')).toMatchObject({
      occurredAt, createdAt: occurredAt, consentPolicyRecordId: null, transcriptStorageRef: null,
    });

    now = attachedAt;
    const service = createConversationsProvider(productionDomainGate(domain));
    await service.attachTranscript({
      activityId: 'delayed-call', personId: owner.personId,
      rawText: 'me: How do you manage it?\nLead: I self-manage delayed Hope St.',
    });
    const evidenceRows = () => ({
      activity: database.raw.prepare('SELECT * FROM activities WHERE id = ?').get('delayed-call'),
      consents: database.raw.prepare('SELECT * FROM consent_policy_records ORDER BY id').all(),
      transcripts: database.raw.prepare('SELECT * FROM transcripts ORDER BY id').all(),
      utterances: database.raw.prepare('SELECT * FROM transcript_utterances ORDER BY id').all(),
    });
    const attached = evidenceRows();
    expect(attached.activity).toMatchObject({ occurred_at: occurredAt, created_at: occurredAt, recording_storage_ref: null });
    expect(attached.consents).toEqual([expect.objectContaining({
      person_id: owner.personId, activity_id: 'delayed-call', policy_kind: 'recording',
      policy_version: 'manual-attach-v1', decision: 'granted',
      evidence_json: '{"kind":"founder_manual_attach"}', effective_at: attachedAt, created_at: attachedAt,
    })]);
    expect(attached.transcripts).toEqual([expect.objectContaining({
      person_id: owner.personId, activity_id: 'delayed-call', source: 'manual_paste', created_at: attachedAt,
    })]);
    expect(() => database.raw.prepare('UPDATE activities SET occurred_at = ? WHERE id = ?')
      .run(attachedAt, 'delayed-call')).toThrow('activities rows are immutable');
    expect(() => database.raw.prepare('UPDATE consent_policy_records SET effective_at = ? WHERE activity_id = ?')
      .run(occurredAt, 'delayed-call')).toThrow('consent_policy_records rows are immutable');

    const activity = services.events.getActivity('delayed-call');
    const detail = await service.get({ activityId: 'delayed-call' });
    expect(detail).toMatchObject({ occurredAt, transcriptAvailable: true,
      transcript: { source: 'manual_paste', createdAt: attachedAt } });
    expect(detail.transcript?.utterances.map(u => u.text)).toEqual([
      'How do you manage it?', 'I self-manage delayed Hope St.',
    ]);
    expect(domain.getDiscoveryBrief(owner.personId).assessment).toBeNull();
    expect(evidenceRows()).toEqual(attached);
    domain.assessDiscoveryProspect(owner.prospectId);
    const brief = domain.getDiscoveryBrief(owner.personId);
    expect(brief.stale).toBe(false);
    expect(brief.assessment?.claims).toEqual(expect.arrayContaining([expect.objectContaining({
      label: 'Lead statement', value: 'I self-manage delayed Hope St.',
      refs: [expect.objectContaining({ kind: 'utterance', activityId: 'delayed-call', observedAt: occurredAt })],
    })]));
    expect(evidenceRows()).toEqual(attached);

    closeDatabase(database);
    expect(readFileSync(temp.path).subarray(0, 16).toString()).not.toBe('SQLite format 3\0');
    database = openDatabase({ path: temp.path, key });
    now = '2026-09-06T13:30:00.000Z';
    const clock = { now: () => now };
    services = createDomainServices({ database, clock, ids });
    domain = createFounderSalesDomain({ database, services, clock, ids });
    const revision = database.raw.prepare('SELECT total_changes() AS count').get();
    expect(services.events.getActivity('delayed-call')).toEqual(activity);
    expect(await createConversationsProvider(productionDomainGate(domain)).get({ activityId: 'delayed-call' })).toEqual(detail);
    expect(domain.getDiscoveryBrief(owner.personId)).toEqual(brief);
    expect(evidenceRows()).toEqual(attached);
    expect(database.raw.prepare('SELECT total_changes() AS count').get()).toEqual(revision);
  });
});
