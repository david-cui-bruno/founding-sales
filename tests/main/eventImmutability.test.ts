import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { EventRepository } from '../../src/main/domain/events/eventRepository';
import { DomainTransactionRequiredError } from '../../src/main/domain/support/domainErrors';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { insertClosedCycle, seedProspect } from '../fixtures/domainRows';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

const TIMESTAMP = '2026-08-30T12:00:00.000Z';

describe('immutable event persistence', () => {
  let database: AppDatabase | undefined;
  let tempDatabase: TempDatabase | undefined;
  let unitOfWork: DomainUnitOfWork;
  let events: EventRepository;
  let personId: string;
  let prospectId: string;
  let cycleId: string;

  afterEach(() => {
    if (database !== undefined) closeDatabase(database);
    tempDatabase?.cleanup();
  });

  async function setup(): Promise<void> {
    tempDatabase = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: tempDatabase.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${tempDatabase.path}.backups`,
      workspaceKey: key,
    });
    const prospect = seedProspect(database.raw, 'immutable');
    personId = prospect.personId;
    prospectId = prospect.prospectId;
    cycleId = insertClosedCycle({ database: database.raw, prefix: 'immutable', prospect });
    unitOfWork = new DomainUnitOfWork(database);
    events = new EventRepository({
      database,
      unitOfWork,
      clock: { now: () => TIMESTAMP },
      ids: { next: () => 'unused' },
    });
    unitOfWork.immediate(() => {
      const activity = events.appendActivity({
        id: 'immutable-activity',
        personId,
        prospectId,
        salesCycleId: cycleId,
        kind: 'note',
        direction: 'internal',
        channel: 'app',
        occurredAt: TIMESTAMP,
        metadata: {},
      });
      events.appendActivityAmendment({
        id: 'immutable-amendment',
        activityId: activity.id,
        amendmentKind: 'correction',
        correction: { note: 'corrected' },
        reason: 'Founder correction',
      });
      events.appendStageEvent({
        id: 'immutable-stage',
        salesCycleId: cycleId,
        fromStage: 'ready',
        toStage: 'contacted',
        effectiveAt: TIMESTAMP,
        confirmedAt: TIMESTAMP,
        confirmationKind: 'mechanical',
      });
      events.appendConsentPolicyRecord({
        id: 'immutable-consent',
        personId,
        activityId: activity.id,
        policyKind: 'outbound',
        policyVersion: 'v1',
        effectiveAt: TIMESTAMP,
        decision: 'granted',
        evidence: {},
      });
    });
  }

  it('rejects UPDATE and DELETE for every Task 6 immutable event family', async () => {
    await setup();

    const mutations = [
      {
        update: "UPDATE source_events SET evidence_ref = 'changed' WHERE id = 'immutable-source'",
        remove: "DELETE FROM source_events WHERE id = 'immutable-source'",
      },
      {
        update: "UPDATE activities SET observed_outcome = 'changed' WHERE id = 'immutable-activity'",
        remove: "DELETE FROM activities WHERE id = 'immutable-activity'",
      },
      {
        update: "UPDATE activity_amendments SET reason = 'changed' WHERE id = 'immutable-amendment'",
        remove: "DELETE FROM activity_amendments WHERE id = 'immutable-amendment'",
      },
      {
        update: "UPDATE stage_events SET confirmed_at = '2026-08-30T13:00:00.000Z' WHERE id = 'immutable-stage'",
        remove: "DELETE FROM stage_events WHERE id = 'immutable-stage'",
      },
      {
        update: "UPDATE consent_policy_records SET decision = 'denied' WHERE id = 'immutable-consent'",
        remove: "DELETE FROM consent_policy_records WHERE id = 'immutable-consent'",
      },
    ];

    for (const mutation of mutations) {
      expect(() => database!.raw.prepare(mutation.update).run()).toThrow();
      expect(() => database!.raw.prepare(mutation.remove).run()).toThrow();
    }
  });

  it('requires the Unit of Work for every event mutator but permits reads outside it', async () => {
    await setup();

    expect(() => events.appendActivity({
      id: 'outside', personId, prospectId, salesCycleId: cycleId,
      kind: 'note', direction: 'internal', channel: 'app', occurredAt: TIMESTAMP, metadata: {},
    })).toThrow(DomainTransactionRequiredError);
    expect(() => events.appendActivityAmendment({
      id: 'outside-amendment', activityId: 'immutable-activity', amendmentKind: 'correction',
      correction: {}, reason: 'Reason',
    })).toThrow(DomainTransactionRequiredError);
    expect(() => events.appendStageEvent({
      id: 'outside-stage', salesCycleId: cycleId, fromStage: 'ready', toStage: 'contacted',
      effectiveAt: TIMESTAMP, confirmedAt: TIMESTAMP, confirmationKind: 'mechanical',
    })).toThrow(DomainTransactionRequiredError);
    expect(() => events.appendConsentPolicyRecord({
      id: 'outside-consent', personId, policyKind: 'outbound', policyVersion: 'v1',
      effectiveAt: TIMESTAMP, decision: 'unknown', evidence: {},
    })).toThrow(DomainTransactionRequiredError);

    expect(events.getActivity('immutable-activity')?.id).toBe('immutable-activity');
    expect(events.listCycleStageEvents(cycleId).map(({ id }) => id)).toEqual(['immutable-stage']);
  });
});
