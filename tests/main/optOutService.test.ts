import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { BUILTIN_CADENCES } from '../../src/main/domain/cadence/builtinCadences';
import { CadenceRepository } from '../../src/main/domain/cadence/cadenceRepository';
import { FOUNDER_CHANNEL_POLICIES_V1 } from '../../src/main/domain/cadence/cadenceScheduler';
import { EventRepository } from '../../src/main/domain/events/eventRepository';
import { IdentityRepository } from '../../src/main/domain/identity/identityRepository';
import { LifecycleService } from '../../src/main/domain/lifecycle/lifecycleService';
import { auditDomainInvariants } from '../../src/main/domain/lifecycle/invariantAudit';
import { OptOutRepository } from '../../src/main/domain/optOut/optOutRepository';
import { OptOutService } from '../../src/main/domain/optOut/optOutService';
import type {
  ApplyOptOutInput,
  OptOutFaultPoint,
} from '../../src/main/domain/optOut/optOutTypes';
import { SourceRepository } from '../../src/main/domain/source/sourceRepository';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import {
  DOMAIN_TIMESTAMP,
  insertOpenCycleWithAction,
  seedProspect,
} from '../fixtures/domainRows';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

const LATER = '2026-08-30T13:00:00.000Z';

describe('OptOutService', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let unitOfWork: DomainUnitOfWork;
  let identities: IdentityRepository;
  let events: EventRepository;
  let optOuts: OptOutRepository;
  let lifecycle: LifecycleService;
  let generated = 0;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`, workspaceKey: key,
    });
    unitOfWork = new DomainUnitOfWork(database);
    const clock = { now: () => DOMAIN_TIMESTAMP };
    const ids = { next: () => `generated-${++generated}` };
    identities = new IdentityRepository({ database, unitOfWork, clock, ids });
    events = new EventRepository({ database, unitOfWork, clock, ids });
    const sources = new SourceRepository({ database, unitOfWork, clock });
    const cadences = new CadenceRepository({ database, unitOfWork, clock });
    unitOfWork.immediate(() => cadences.installBuiltins());
    lifecycle = new LifecycleService({
      database, unitOfWork, identities, events, sources, cadences, clock, ids,
      timezone: 'America/New_York', policies: FOUNDER_CHANNEL_POLICIES_V1,
    });
    optOuts = new OptOutRepository({ database, unitOfWork });
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  function service(faultInjector?: (point: OptOutFaultPoint) => void): OptOutService {
    return new OptOutService({
      database, unitOfWork, identities, events, optOuts, lifecycle,
      clock: { now: () => DOMAIN_TIMESTAMP }, ids: { next: () => `opt-${++generated}` },
      faultInjector,
    });
  }

  function addPhone(personId: string, id: string, phone = '+14015550100'): void {
    database.raw.prepare(`
      INSERT INTO person_contact_methods (
        id, person_id, kind, normalized_value, validation_state, reachability,
        is_primary, created_at, updated_at
      ) VALUES (?, ?, 'phone', ?, 'valid', 'direct', 1, ?, ?)
    `).run(id, personId, phone, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
  }

  function command(personId: string, suffix: string): ApplyOptOutInput {
    return {
      personId, tombstoneId: `${suffix}-tombstone`, requestedAt: DOMAIN_TIMESTAMP,
      policyVersion: 'founder_opt_out_v1' as const,
      decision: { kind: 'structured_written' as const, channel: 'imessage' as const },
      evidence: {
        kind: 'append_activity' as const,
        activity: {
          id: `${suffix}-activity`, personId, kind: 'text' as const,
          direction: 'inbound' as const, channel: 'imessage', occurredAt: DOMAIN_TIMESTAMP,
          observedOutcome: 'opted_out', adapter: 'messages',
          providerIdempotencyKey: `${suffix}-provider`, metadata: { structuredOptOut: true },
        },
      },
      terminalStageEventId: null,
    };
  }

  it('applies once atomically, captures all handles, and exactly replays provider evidence', () => {
    const prospect = seedProspect(database.raw, 'apply');
    addPhone(prospect.personId, 'apply-phone');
    database.raw.prepare(`
      INSERT INTO person_contact_methods (
        id, person_id, kind, normalized_value, validation_state, reachability,
        is_primary, created_at, updated_at
      ) VALUES ('apply-email', ?, 'email', 'owner@example.com', 'invalid', 'none', 1, ?, ?)
    `).run(prospect.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    const apply = service();
    const input = command(prospect.personId, 'apply');
    if (input.evidence.kind !== 'append_activity') throw new Error('Expected append evidence.');
    const inputActivity = input.evidence.activity;

    const first = apply.apply(input);
    expect(first).toMatchObject({
      tombstone: {
        id: 'apply-tombstone', personId: prospect.personId,
        observedChannel: 'imessage', sourceActivityId: 'apply-activity',
      },
      alreadyApplied: false,
    });
    expect(first.handles.map(({ kind, normalizedValue }) => ({ kind, normalizedValue })))
      .toEqual([
        { kind: 'email', normalizedValue: 'owner@example.com' },
        { kind: 'phone', normalizedValue: '+14015550100' },
      ]);
    expect(identities.getPerson(prospect.personId)).toMatchObject({
      optedOut: true, optedOutAt: DOMAIN_TIMESTAMP, version: 2,
    });
    expect(auditDomainInvariants({ database, asOf: DOMAIN_TIMESTAMP })
      .filter(({ kind }) => kind.startsWith('opt_out'))).toEqual([]);
    const activityCount = database.raw.prepare(`SELECT COUNT(*) AS count FROM activities`).get();
    const second = apply.apply(input);
    expect(second).toEqual({ ...first, alreadyApplied: true });
    expect(database.raw.prepare(`SELECT COUNT(*) AS count FROM activities`).get())
      .toEqual(activityCount);
    expect(database.raw.prepare(`SELECT COUNT(*) AS count FROM opt_out_tombstones`).get())
      .toEqual({ count: 1 });
    expect(() => apply.apply({
      ...input,
      evidence: {
        kind: 'append_activity',
        activity: { ...inputActivity, metadata: { structuredOptOut: false } },
      },
    })).toThrow();
    const laterInput = command(prospect.personId, 'later-observation');
    if (laterInput.evidence.kind !== 'append_activity') throw new Error('Expected append evidence.');
    const later = apply.apply({
      ...laterInput, requestedAt: LATER,
      evidence: {
        ...laterInput.evidence,
        activity: { ...laterInput.evidence.activity, occurredAt: LATER },
      },
    });
    expect(later).toMatchObject({
      alreadyApplied: true,
      tombstone: { id: 'apply-tombstone', requestedAt: DOMAIN_TIMESTAMP },
    });
    expect(database.raw.prepare(`SELECT COUNT(*) AS count FROM activities WHERE person_id = ?`)
      .get(prospect.personId)).toEqual({ count: 2 });
    const warm = BUILTIN_CADENCES.find(({ family }) => family === 'cadence_c')!;
    const beforeReactivation = {
      cycles: database.raw.prepare(`SELECT COUNT(*) AS count FROM sales_cycles`).get(),
      reviews: database.raw.prepare(`SELECT COUNT(*) AS count FROM lifecycle_review_items`).get(),
    };
    expect(lifecycle.reactivateFromInboundResponse({
      personId: prospect.personId, prospectId: prospect.prospectId,
      sourceCycleId: 'historical-cycle', newCycleId: 'must-not-exist',
      activatedAt: LATER,
      cadence: {
        definitionId: warm.id, family: 'cadence_c', version: warm.version,
        contentHash: warm.contentHash,
      },
      evidence: {
        kind: 'unknown_handle', handleKind: 'phone', normalizedValue: '+14015550999',
      },
    })).toEqual({ kind: 'permanently_blocked', tombstoneId: 'apply-tombstone' });
    expect({
      cycles: database.raw.prepare(`SELECT COUNT(*) AS count FROM sales_cycles`).get(),
      reviews: database.raw.prepare(`SELECT COUNT(*) AS count FROM lifecycle_review_items`).get(),
    }).toEqual(beforeReactivation);
  });

  it('closes lifecycle before tombstone insertion and preserves immutable history', () => {
    const prospect = seedProspect(database.raw, 'lifecycle-opt-out');
    const cycle = insertOpenCycleWithAction({
      database: database.raw, prefix: 'lifecycle-opt-out', prospect,
    });
    addPhone(prospect.personId, 'lifecycle-phone');
    const input = {
      ...command(prospect.personId, 'lifecycle'),
      terminalStageEventId: 'lifecycle-terminal-event',
    };
    const sourceBefore = database.raw.prepare(`
      SELECT * FROM source_events WHERE id = ?
    `).get(prospect.sourceEventId);

    const result = service().apply(input);
    expect(result.cycle).toMatchObject({
      id: cycle.cycleId, stage: 'lost_nurture', workflowStatus: 'closed',
      closeReason: 'opt_out', currentNextActionId: null,
    });
    expect(database.raw.prepare(`SELECT status FROM next_actions WHERE id = ?`).get(cycle.actionId))
      .toEqual({ status: 'cancelled' });
    expect(database.raw.prepare(`SELECT to_stage FROM stage_events WHERE id = ?`)
      .get('lifecycle-terminal-event')).toEqual({ to_stage: 'lost_nurture' });
    expect(database.raw.prepare(`SELECT * FROM source_events WHERE id = ?`)
      .get(prospect.sourceEventId)).toEqual(sourceBefore);
    expect(database.raw.prepare(`
      SELECT COUNT(*) AS count FROM reactivation_rules WHERE sales_cycle_id = ?
    `).get(cycle.cycleId)).toEqual({ count: 0 });
  });

  it.each([
    {
      name: 'Gmail', decision: { kind: 'structured_written', channel: 'gmail' } as const,
      activity: { kind: 'email', direction: 'inbound', channel: 'gmail' } as const,
    },
    {
      name: 'manual', decision: { kind: 'founder_confirmed', channel: 'manual' } as const,
      activity: { kind: 'note', direction: 'internal', channel: 'manual' } as const,
    },
    {
      name: 'call', decision: { kind: 'founder_confirmed', channel: 'call' } as const,
      activity: { kind: 'call', direction: 'inbound', channel: 'phone' } as const,
    },
  ])('accepts only explicit $name decision evidence', ({ name, decision, activity }) => {
    const prospect = seedProspect(database.raw, `decision-${name}`);
    const result = service().apply({
      personId: prospect.personId, tombstoneId: `decision-${name}-tombstone`,
      requestedAt: DOMAIN_TIMESTAMP, policyVersion: 'founder_opt_out_v1',
      decision, terminalStageEventId: null,
      evidence: {
        kind: 'append_activity',
        activity: {
          id: `decision-${name}-activity`, personId: prospect.personId,
          ...activity, occurredAt: DOMAIN_TIMESTAMP, observedOutcome: 'opted_out',
          metadata: {},
        },
      },
    });
    expect(result.tombstone.observedChannel).toBe(decision.channel);
  });

  it('rejects inferred/mismatched evidence and rolls back each outer fault phase byte-for-byte', () => {
    const invalid = seedProspect(database.raw, 'invalid-evidence');
    expect(() => service().apply({
      ...command(invalid.personId, 'invalid-evidence'),
      decision: { kind: 'structured_written', channel: 'gmail' },
    })).toThrow();
    expect(database.raw.prepare(`SELECT COUNT(*) AS count FROM activities WHERE person_id = ?`)
      .get(invalid.personId)).toEqual({ count: 0 });

    for (const point of [
      'after_activity', 'after_lifecycle_close', 'after_tombstone',
      'after_handle', 'after_postcondition',
    ] as const) {
      const prospect = seedProspect(database.raw, `fault-${point}`);
      insertOpenCycleWithAction({
        database: database.raw, prefix: `fault-${point}`, prospect,
      });
      addPhone(prospect.personId, `fault-${point}-phone`);
      const before = snapshotPerson(prospect.personId);
      expect(() => service((candidate) => {
        if (candidate === point) throw new Error(`fault:${point}`);
      }).apply({
        ...command(prospect.personId, `fault-${point}`),
        terminalStageEventId: `fault-${point}-terminal`,
      })).toThrow(`fault:${point}`);
      expect(snapshotPerson(prospect.personId)).toEqual(before);
    }

    const internal = seedProspect(database.raw, 'internal-lifecycle-fault');
    insertOpenCycleWithAction({
      database: database.raw, prefix: 'internal-lifecycle-fault', prospect: internal,
    });
    const beforeInternal = snapshotPerson(internal.personId);
    database.raw.exec(`
      CREATE TRIGGER fail_opt_out_stage_event
      AFTER INSERT ON stage_events
      WHEN NEW.id = 'internal-lifecycle-terminal'
      BEGIN
        SELECT RAISE(ABORT, 'injected lifecycle phase failure');
      END
    `);
    expect(() => service().apply({
      ...command(internal.personId, 'internal-lifecycle-fault'),
      terminalStageEventId: 'internal-lifecycle-terminal',
    })).toThrow();
    expect(snapshotPerson(internal.personId)).toEqual(beforeInternal);
  });

  it('propagates the most restrictive tombstone and records retrospective truth only', () => {
    const source = seedProspect(database.raw, 'propagate-source');
    const target = seedProspect(database.raw, 'propagate-target');
    addPhone(source.personId, 'source-phone', '+14015550100');
    addPhone(target.personId, 'target-phone', '+14015550101');
    const apply = service();
    apply.apply(command(source.personId, 'source'));

    const propagated = apply.propagateMostRestrictiveOptOut({
      sourceTombstoneId: 'source-tombstone', targetPersonId: target.personId,
      targetTombstoneId: 'target-tombstone', terminalStageEventId: null,
      evidenceActivity: {
        id: 'propagation-activity', personId: target.personId, kind: 'system',
        direction: 'internal', channel: 'identity_propagation', occurredAt: LATER,
        observedOutcome: 'opted_out', metadata: { sourceTombstoneId: 'source-tombstone' },
      },
    });
    expect(propagated.tombstone).toMatchObject({
      id: 'target-tombstone', personId: target.personId,
      requestedAt: DOMAIN_TIMESTAMP, observedChannel: 'identity_propagation',
    });
    expect(propagated.handles.map(({ normalizedValue }) => normalizedValue))
      .toEqual(['+14015550100', '+14015550101']);
    expect(optOuts.getById('source-tombstone')).not.toBeNull();
    const bothOptedReplay = apply.propagateMostRestrictiveOptOut({
      sourceTombstoneId: 'source-tombstone', targetPersonId: target.personId,
      targetTombstoneId: 'ignored-new-target-tombstone', terminalStageEventId: null,
      evidenceActivity: {
        id: 'second-propagation-activity', personId: target.personId, kind: 'system',
        direction: 'internal', channel: 'identity_propagation', occurredAt: LATER,
        observedOutcome: 'opted_out', metadata: { sourceTombstoneId: 'source-tombstone' },
      },
    });
    expect(bothOptedReplay).toMatchObject({
      alreadyApplied: true, tombstone: { id: 'target-tombstone' },
    });
    expect(optOuts.getById('ignored-new-target-tombstone')).toBeNull();

    const past = apply.recordPastOffAppTouch({
      personId: target.personId, reportedAt: LATER,
      activity: {
        id: 'late-audit-touch', personId: target.personId, kind: 'call',
        direction: 'outbound', channel: 'phone', occurredAt: DOMAIN_TIMESTAMP,
        observedOutcome: 'answered', metadata: {
          reportedAfterOptOut: false, prohibitedTouchReported: false,
        },
      },
    });
    expect(past.metadata).toMatchObject({
      reportedAfterOptOut: true, prohibitedTouchReported: true,
    });
    expect(() => apply.recordPastOffAppTouch({
      personId: target.personId, reportedAt: DOMAIN_TIMESTAMP,
      activity: { ...past, direction: 'outbound', occurredAt: LATER },
    } as never)).toThrow();
  });

  function snapshotPerson(personId: string): unknown {
    return {
      person: database.raw.prepare(`SELECT * FROM persons WHERE id = ?`).get(personId),
      activities: database.raw.prepare(`SELECT * FROM activities WHERE person_id = ? ORDER BY id`).all(personId),
      tombstones: database.raw.prepare(`SELECT * FROM opt_out_tombstones WHERE person_id = ? ORDER BY id`).all(personId),
      handles: database.raw.prepare(`
        SELECT handle.* FROM opt_out_handles AS handle
        JOIN opt_out_tombstones AS tombstone ON tombstone.id = handle.tombstone_id
        WHERE tombstone.person_id = ? ORDER BY handle.id
      `).all(personId),
      cycles: database.raw.prepare(`SELECT * FROM sales_cycles WHERE person_id = ? ORDER BY id`).all(personId),
      actions: database.raw.prepare(`
        SELECT action.* FROM next_actions AS action
        JOIN sales_cycles AS cycle ON cycle.id = action.sales_cycle_id
        WHERE cycle.person_id = ? ORDER BY action.id
      `).all(personId),
      contactMethods: database.raw.prepare(`
        SELECT * FROM person_contact_methods WHERE person_id = ? ORDER BY id
      `).all(personId),
      prospects: database.raw.prepare(`
        SELECT * FROM prospects WHERE person_id = ? ORDER BY id
      `).all(personId),
      sources: database.raw.prepare(`
        SELECT * FROM source_events WHERE person_id = ? ORDER BY id
      `).all(personId),
      stageEvents: database.raw.prepare(`
        SELECT event.* FROM stage_events AS event
        JOIN sales_cycles AS cycle ON cycle.id = event.sales_cycle_id
        WHERE cycle.person_id = ? ORDER BY event.id
      `).all(personId),
      enrollments: database.raw.prepare(`
        SELECT enrollment.* FROM cadence_enrollments AS enrollment
        JOIN sales_cycles AS cycle ON cycle.id = enrollment.sales_cycle_id
        WHERE cycle.person_id = ? ORDER BY enrollment.id
      `).all(personId),
      reactivationRules: database.raw.prepare(`
        SELECT rule.* FROM reactivation_rules AS rule
        JOIN sales_cycles AS cycle ON cycle.id = rule.sales_cycle_id
        WHERE cycle.person_id = ? ORDER BY rule.id
      `).all(personId),
      wonTerms: database.raw.prepare(`
        SELECT terms.* FROM won_terms AS terms
        JOIN sales_cycles AS cycle ON cycle.id = terms.sales_cycle_id
        WHERE cycle.person_id = ? ORDER BY terms.sales_cycle_id
      `).all(personId),
    };
  }
});
