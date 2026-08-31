import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import {
  EventRepository,
  type AppendActivityInput,
} from '../../src/main/domain/events/eventRepository';
import { IdempotencyOwnershipConflictError } from '../../src/main/domain/support/domainErrors';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import {
  insertClosedCycle,
  seedProspect,
  type SeededProspect,
} from '../fixtures/domainRows';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

const TIMESTAMP = '2026-08-30T12:00:00.000Z';
const LATER = '2026-08-30T13:00:00.000Z';

describe('EventRepository', () => {
  let database: AppDatabase | undefined;
  let tempDatabase: TempDatabase | undefined;
  let unitOfWork: DomainUnitOfWork;
  let events: EventRepository;
  let first: SeededProspect;
  let second: SeededProspect;
  let firstCycleId: string;
  let secondCycleId: string;

  afterEach(() => {
    if (database !== undefined) closeDatabase(database);
    tempDatabase?.cleanup();
  });

  async function setup(ids: string[] = []): Promise<void> {
    tempDatabase = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: tempDatabase.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${tempDatabase.path}.backups`,
      workspaceKey: key,
    });
    first = seedProspect(database.raw, 'first');
    second = seedProspect(database.raw, 'second');
    firstCycleId = insertClosedCycle({ database: database.raw, prefix: 'first', prospect: first });
    secondCycleId = insertClosedCycle({ database: database.raw, prefix: 'second', prospect: second });
    unitOfWork = new DomainUnitOfWork(database);
    let index = 0;
    events = new EventRepository({
      database,
      unitOfWork,
      clock: { now: () => TIMESTAMP },
      ids: {
        next: () => ids[index++] ?? `generated-${index}`,
      },
    });
  }

  function activityInput(
    overrides: Partial<AppendActivityInput> & Record<string, unknown> = {},
  ): AppendActivityInput & Record<string, unknown> {
    return {
      id: 'activity-one',
      personId: first.personId,
      prospectId: first.prospectId,
      salesCycleId: firstCycleId,
      kind: 'call' as const,
      direction: 'outbound' as const,
      channel: 'phone',
      occurredAt: TIMESTAMP,
      durationSeconds: 60,
      observedOutcome: 'answered',
      adapter: 'phone',
      providerIdempotencyKey: 'provider-one',
      providerReference: 'call-1',
      metadata: { initiatedBy: 'founder' },
      ...overrides,
    };
  }

  it('appends and parses an immutable Activity', async () => {
    await setup();

    const activity = unitOfWork.immediate(() => events.appendActivity(activityInput()));

    expect(activity).toEqual({
      id: 'activity-one',
      personId: first.personId,
      prospectId: first.prospectId,
      salesCycleId: firstCycleId,
      cadenceStepId: null,
      kind: 'call',
      direction: 'outbound',
      channel: 'phone',
      occurredAt: TIMESTAMP,
      durationSeconds: 60,
      observedOutcome: 'answered',
      adapter: 'phone',
      providerIdempotencyKey: 'provider-one',
      providerReference: 'call-1',
      consentPolicyRecordId: null,
      metadata: { initiatedBy: 'founder' },
      createdAt: TIMESTAMP,
    });
    expect(events.getActivity(activity.id)).toEqual(activity);
  });

  it('returns the canonical Activity for a same-owner provider retry', async () => {
    await setup();

    const firstActivity = unitOfWork.immediate(() => events.appendActivity(activityInput()));
    const retry = unitOfWork.immediate(() => events.appendActivity(activityInput({
      id: 'retry-attempt-id',
      metadata: { laterPayload: true },
    })));

    expect(retry).toEqual(firstActivity);
    expect(database!.raw.prepare('SELECT count(*) AS count FROM activities').get()).toEqual({ count: 1 });
  });

  it('rejects a provider-key collision owned by another Person/Prospect/Cycle', async () => {
    await setup();
    unitOfWork.immediate(() => events.appendActivity(activityInput()));

    expect(() => unitOfWork.immediate(() => events.appendActivity(activityInput({
      id: 'other-owner-attempt',
      personId: second.personId,
      prospectId: second.prospectId,
      salesCycleId: secondCycleId,
    })))).toThrow(IdempotencyOwnershipConflictError);
  });

  it('propagates a same-ID/different-provider-key primary-key collision', async () => {
    await setup();
    unitOfWork.immediate(() => events.appendActivity(activityInput()));

    expect(() => unitOfWork.immediate(() => events.appendActivity(activityInput({
      providerIdempotencyKey: 'different-provider-key',
    })))).toThrow();
    expect(database!.raw.prepare('SELECT count(*) AS count FROM activities').get()).toEqual({ count: 1 });
  });

  it('does not hide simultaneous ID and provider-key conflicts against different rows', async () => {
    await setup();
    unitOfWork.immediate(() => {
      events.appendActivity(activityInput({ id: 'id-owner', providerIdempotencyKey: 'key-one' }));
      events.appendActivity(activityInput({ id: 'key-owner', providerIdempotencyKey: 'key-two' }));
    });

    expect(() => unitOfWork.immediate(() => events.appendActivity(activityInput({
      id: 'id-owner',
      providerIdempotencyKey: 'key-two',
    })))).toThrow();
    expect(database!.raw.prepare('SELECT count(*) AS count FROM activities').get()).toEqual({ count: 2 });
  });

  it('propagates unrelated foreign-key constraints without conflict suppression', async () => {
    await setup();

    expect(() => unitOfWork.immediate(() => events.appendActivity(activityInput({
      id: 'missing-person-activity',
      personId: 'missing-person',
      prospectId: null,
      salesCycleId: null,
      providerIdempotencyKey: 'unique-provider-key',
    })))).toThrow();
  });

  it('relies on schema ownership constraints for cross-Person evidence', async () => {
    await setup();

    expect(() => unitOfWork.immediate(() => events.appendActivity(activityInput({
      id: 'mismatched-activity',
      prospectId: second.prospectId,
      salesCycleId: secondCycleId,
      providerIdempotencyKey: 'mismatched-key',
    })))).toThrow();

    const otherActivity = unitOfWork.immediate(() => events.appendActivity(activityInput({
      id: 'second-activity',
      personId: second.personId,
      prospectId: second.prospectId,
      salesCycleId: secondCycleId,
      providerIdempotencyKey: 'second-key',
    })));
    expect(() => unitOfWork.immediate(() => events.appendConsentPolicyRecord({
      id: 'mismatched-consent',
      personId: first.personId,
      activityId: otherActivity.id,
      policyKind: 'outbound',
      policyVersion: 'v1',
      effectiveAt: TIMESTAMP,
      decision: 'granted',
      evidence: { founderConfirmed: true },
    }))).toThrow();
  });

  it('appends amendments, stage events, and consent records through strict outputs', async () => {
    await setup();

    const result = unitOfWork.immediate(() => {
      const activity = events.appendActivity(activityInput());
      const amendment = events.appendActivityAmendment({
        id: 'amendment-one',
        activityId: activity.id,
        amendmentKind: 'outcome_correction',
        correction: { observedOutcome: 'voicemail_left' },
        reason: 'Founder corrected the outcome',
      });
      const stageEvent = events.appendStageEvent({
        id: 'stage-one',
        salesCycleId: firstCycleId,
        fromStage: 'ready',
        toStage: 'contacted',
        effectiveAt: TIMESTAMP,
        confirmedAt: LATER,
        confirmationKind: 'mechanical',
      });
      const consent = events.appendConsentPolicyRecord({
        id: 'consent-one',
        personId: first.personId,
        activityId: activity.id,
        policyKind: 'outbound',
        policyVersion: '2026-08',
        effectiveAt: TIMESTAMP,
        decision: 'granted',
        evidence: { founderAction: true },
      });
      return { amendment, stageEvent, consent };
    });

    expect(result.amendment).toMatchObject({
      id: 'amendment-one',
      activityId: 'activity-one',
      correction: { observedOutcome: 'voicemail_left' },
      createdAt: TIMESTAMP,
    });
    expect(result.stageEvent).toEqual({
      id: 'stage-one',
      salesCycleId: firstCycleId,
      fromStage: 'ready',
      toStage: 'contacted',
      effectiveAt: TIMESTAMP,
      confirmedAt: LATER,
      confirmationKind: 'mechanical',
      backfillProvenance: null,
      createdAt: TIMESTAMP,
    });
    expect(result.consent).toMatchObject({
      id: 'consent-one',
      personId: first.personId,
      activityId: 'activity-one',
      evidence: { founderAction: true },
      createdAt: TIMESTAMP,
    });
  });

  it('orders stage history by effective time, confirmation time, then ID', async () => {
    await setup();
    unitOfWork.immediate(() => {
      events.appendStageEvent({
        id: 'stage-c', salesCycleId: firstCycleId, fromStage: 'contacted', toStage: 'interviewed',
        effectiveAt: LATER, confirmedAt: LATER, confirmationKind: 'founder',
      });
      events.appendStageEvent({
        id: 'stage-b', salesCycleId: firstCycleId, fromStage: 'ready', toStage: 'contacted',
        effectiveAt: TIMESTAMP, confirmedAt: LATER, confirmationKind: 'mechanical',
      });
      events.appendStageEvent({
        id: 'stage-a', salesCycleId: firstCycleId, fromStage: null, toStage: 'ready',
        effectiveAt: TIMESTAMP, confirmedAt: LATER, confirmationKind: 'founder',
      });
    });

    expect(events.listCycleStageEvents(firstCycleId).map(({ id }) => id))
      .toEqual(['stage-a', 'stage-b', 'stage-c']);
  });

  it('rejects undefined, BigInt, cycles, and unknown input keys', async () => {
    await setup();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => unitOfWork.immediate(() => events.appendActivity(activityInput({
      metadata: { missing: undefined },
    })))).toThrow(TypeError);
    expect(() => unitOfWork.immediate(() => events.appendActivity(activityInput({
      id: 'bigint', providerIdempotencyKey: 'bigint', metadata: { value: 1n },
    })))).toThrow(TypeError);
    expect(() => unitOfWork.immediate(() => events.appendActivity(activityInput({
      id: 'cycle', providerIdempotencyKey: 'cycle', metadata: cyclic,
    })))).toThrow(TypeError);
    expect(() => unitOfWork.immediate(() => events.appendActivity(activityInput({
      id: 'unknown', providerIdempotencyKey: 'unknown', extra: true,
    })))).toThrow(z.ZodError);
  });

  it('fails closed on malformed stored Activity and StageEvent rows', async () => {
    await setup();
    database!.raw.prepare(`
      INSERT INTO activities (
        id, person_id, prospect_id, sales_cycle_id, kind, direction, channel,
        occurred_at, adapter, provider_idempotency_key, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, 'note', 'internal', 'app', ?, NULL, NULL, ?, ?)
    `).run('malformed-activity', first.personId, first.prospectId, firstCycleId, TIMESTAMP, '{bad', TIMESTAMP);

    expect(() => events.getActivity('malformed-activity')).toThrow(z.ZodError);

    database!.raw.prepare(`
      INSERT INTO stage_events (
        id, sales_cycle_id, from_stage, to_stage, effective_at, confirmed_at,
        confirmation_kind, created_at
      ) VALUES ('malformed-stage', ?, 'ready', 'contacted', 'not-utc', ?, 'mechanical', ?)
    `).run(firstCycleId, TIMESTAMP, TIMESTAMP);

    expect(() => events.listCycleStageEvents(firstCycleId)).toThrow(z.ZodError);
  });

  it('strictly parses stored Amendment and Consent RETURNING rows', async () => {
    await setup();
    unitOfWork.immediate(() => events.appendActivity(activityInput()));
    const corruptEvents = new EventRepository({
      database: database!,
      unitOfWork,
      clock: { now: () => 'not-utc' },
      ids: { next: () => 'generated' },
    });

    expect(() => unitOfWork.immediate(() => corruptEvents.appendActivityAmendment({
      id: 'bad-amendment',
      activityId: 'activity-one',
      amendmentKind: 'correction',
      correction: {},
      reason: 'Reason',
    }))).toThrow(z.ZodError);
    expect(() => unitOfWork.immediate(() => corruptEvents.appendConsentPolicyRecord({
      id: 'bad-consent',
      personId: first.personId,
      policyKind: 'outbound',
      policyVersion: 'v1',
      effectiveAt: TIMESTAMP,
      decision: 'unknown',
      evidence: {},
    }))).toThrow(z.ZodError);
  });
});
