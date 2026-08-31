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
import { serializeCanonical } from '../../src/main/domain/lifecycle/lifecycleValidation';
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
  let clockNow: string;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`, workspaceKey: key,
    });
    unitOfWork = new DomainUnitOfWork(database);
    clockNow = DOMAIN_TIMESTAMP;
    const clock = { now: () => clockNow };
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
      clock: { now: () => clockNow }, ids: { next: () => `opt-${++generated}` },
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
    expect(second).toEqual(first);
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
    expect(() => apply.apply({
      ...input,
      tombstoneId: 'changed-wrapper-tombstone',
    })).toThrow();
    expect(() => apply.apply({
      ...input,
      requestedAt: LATER,
    })).toThrow();
    const laterInput = command(prospect.personId, 'later-observation');
    if (laterInput.evidence.kind !== 'append_activity') throw new Error('Expected append evidence.');
    clockNow = LATER;
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

    const receiptRow = database.raw.prepare(`
      SELECT result_json FROM opt_out_closure_receipts WHERE source_activity_id = 'apply-activity'
    `).get() as { result_json: string };
    const forgedResult = JSON.parse(receiptRow.result_json) as { handles: unknown[] };
    forgedResult.handles.reverse();
    database.raw.exec('DROP TRIGGER immutable_opt_out_closure_receipts');
    database.raw.prepare(`
      UPDATE opt_out_closure_receipts SET result_json = ? WHERE source_activity_id = 'apply-activity'
    `).run(serializeCanonical(forgedResult));
    expect(auditDomainInvariants({ database, asOf: LATER })).toContainEqual(
      expect.objectContaining({
        kind: 'opt_out_closure_receipt_invalid', recordId: 'apply-activity',
      }),
    );
    expect(() => apply.apply(input)).toThrow();
    database.raw.prepare(`
      UPDATE opt_out_closure_receipts SET result_json = '{'
      WHERE source_activity_id = 'apply-activity'
    `).run();
    expect(auditDomainInvariants({ database, asOf: LATER })).toContainEqual(
      expect.objectContaining({
        kind: 'opt_out_closure_receipt_invalid', recordId: 'apply-activity',
      }),
    );
    expect(() => apply.apply(input)).toThrow();
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
    expect(auditDomainInvariants({ database, asOf: DOMAIN_TIMESTAMP })).not.toContainEqual(
      expect.objectContaining({
        kind: 'opt_out_closure_receipt_invalid', recordId: 'lifecycle-activity',
      }),
    );

    database.raw.exec(`
      CREATE TRIGGER reject_duplicate_opt_out_close
      BEFORE UPDATE ON sales_cycles
      WHEN OLD.id = '${cycle.cycleId}'
      BEGIN SELECT RAISE(ABORT, 'lifecycle closure replayed'); END
    `);
    expect(service().apply(input)).toEqual(result);
    expect(() => service().apply({
      ...input, terminalStageEventId: 'changed-terminal-event',
    })).toThrow();
    expect(() => service().apply({ ...input, terminalStageEventId: null })).toThrow();
    expect(database.raw.prepare(`
      SELECT COUNT(*) AS count FROM stage_events WHERE sales_cycle_id = ?
    `).get(cycle.cycleId)).toEqual({ count: 1 });
    database.raw.exec('DROP TRIGGER immutable_stage_events');
    database.raw.prepare(`
      UPDATE stage_events SET to_stage = 'offered', effective_at = ? WHERE id = ?
    `).run(LATER, 'lifecycle-terminal-event');
    expect(auditDomainInvariants({ database, asOf: LATER })).toContainEqual(
      expect.objectContaining({
        kind: 'opt_out_closure_receipt_invalid', recordId: 'lifecycle-activity',
      }),
    );
    expect(() => service().apply(input)).toThrow();
  });

  it('preserves Won and its terms in a canonical receipt without another terminal event', () => {
    const prospect = seedProspect(database.raw, 'won-receipt');
    database.raw.exec('BEGIN IMMEDIATE');
    try {
      database.raw.prepare(`
        INSERT INTO sales_cycles (
          id, person_id, prospect_id, entry_source_event_id, stage, workflow_status,
          current_next_action_id, stage_entered_at, version, created_at, updated_at
        ) VALUES ('won-receipt-cycle', ?, ?, ?, 'won', 'onboarding',
          'won-receipt-action', ?, 1, ?, ?)
      `).run(
        prospect.personId, prospect.prospectId, prospect.sourceEventId,
        DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP,
      );
      database.raw.prepare(`
        INSERT INTO next_actions (
          id, sales_cycle_id, action_type, channel, status, due_at, timezone,
          work_intent, created_at, updated_at
        ) VALUES ('won-receipt-action', 'won-receipt-cycle', 'onboard_customer',
          'text', 'pending', ?, 'America/New_York', 'promised_follow_up', ?, ?)
      `).run(DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
      database.raw.prepare(`
        INSERT INTO won_terms (
          sales_cycle_id, doors_committed, billing_model, unit_rate_cents,
          projected_mrr_cents, projection_formula_version, manual_projection_reason,
          founding_customer, effective_at, created_at
        ) VALUES ('won-receipt-cycle', 12, 'per_door_monthly', 2500, 30000,
          'founder_terms_v1', NULL, 1, ?, ?)
      `).run(DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
      database.raw.exec('COMMIT');
    } catch (error) {
      if (database.raw.inTransaction) database.raw.exec('ROLLBACK');
      throw error;
    }
    const input = command(prospect.personId, 'won-receipt');
    const result = service().apply(input);
    expect(result.cycle).toMatchObject({
      id: 'won-receipt-cycle', stage: 'won', workflowStatus: 'closed',
      closeReason: null, onboardingStopReason: 'opt_out', currentNextActionId: null,
    });
    expect(database.raw.prepare(`
      SELECT projected_mrr_cents FROM won_terms WHERE sales_cycle_id = 'won-receipt-cycle'
    `).get()).toEqual({ projected_mrr_cents: 30000 });
    expect(database.raw.prepare(`
      SELECT COUNT(*) AS count FROM stage_events WHERE sales_cycle_id = 'won-receipt-cycle'
    `).get()).toEqual({ count: 0 });
    expect(auditDomainInvariants({ database, asOf: DOMAIN_TIMESTAMP })).not.toContainEqual(
      expect.objectContaining({
        kind: 'opt_out_closure_receipt_invalid', recordId: 'won-receipt-activity',
      }),
    );
    expect(service().apply(input)).toEqual(result);
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

  it('rolls back every lifecycle phase, each handle, and deferred commit failure', () => {
    const createReadyFixture = (prefix: string, withEmail = false) => {
      const prospect = seedProspect(database.raw, prefix);
      database.raw.prepare(`
        UPDATE prospects SET qualification_state = 'unreviewed' WHERE id = ?
      `).run(prospect.prospectId);
      const unreviewed = lifecycle.createUnreviewedCycle({
        personId: prospect.personId, prospectId: prospect.prospectId,
        entrySourceEventId: prospect.sourceEventId, effectiveAt: DOMAIN_TIMESTAMP,
      });
      const ready = lifecycle.reviewToReady({
        cycleId: unreviewed.id, expectedCycleVersion: unreviewed.version,
        expectedCurrentActionId: unreviewed.currentNextActionId!,
        expectedProspectVersion: 1, effectiveAt: DOMAIN_TIMESTAMP,
      });
      addPhone(prospect.personId, `${prefix}-phone`);
      if (withEmail) {
        database.raw.prepare(`
          INSERT INTO person_contact_methods (
            id, person_id, kind, normalized_value, validation_state, reachability,
            is_primary, created_at, updated_at
          ) VALUES (?, ?, 'email', ?, 'valid', 'direct', 1, ?, ?)
        `).run(
          `${prefix}-email`, prospect.personId, `${prefix}@example.com`,
          DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP,
        );
      }
      return { prospect, ready };
    };

    const phaseFailures = [
      {
        label: 'enrollment-stop',
        trigger: `AFTER UPDATE ON cadence_enrollments WHEN NEW.status = 'stopped'`,
      },
      {
        label: 'pointer-cas',
        trigger: `AFTER UPDATE ON sales_cycles WHEN NEW.workflow_status = 'closed'`,
      },
      {
        label: 'terminal-event',
        trigger: `AFTER INSERT ON stage_events WHEN NEW.to_stage = 'lost_nurture'`,
      },
      {
        label: 'action-settlement',
        trigger: `AFTER UPDATE ON next_actions WHEN NEW.status = 'cancelled'`,
      },
    ] as const;
    for (const [index, phase] of phaseFailures.entries()) {
      const { prospect } = createReadyFixture(`phase-${phase.label}`);
      const before = snapshotPerson(prospect.personId);
      const triggerName = `fail_opt_out_phase_${index}`;
      database.raw.exec(`
        CREATE TRIGGER ${triggerName} ${phase.trigger}
        BEGIN SELECT RAISE(ABORT, 'injected opt-out phase failure'); END
      `);
      expect(() => service().apply({
        ...command(prospect.personId, `phase-${phase.label}`),
        terminalStageEventId: `phase-${phase.label}-terminal`,
      })).toThrow();
      database.raw.exec(`DROP TRIGGER ${triggerName}`);
      expect(snapshotPerson(prospect.personId)).toEqual(before);
    }

    for (const failAt of [1, 2]) {
      const { prospect } = createReadyFixture(`handle-${failAt}`, true);
      const before = snapshotPerson(prospect.personId);
      let handleCount = 0;
      expect(() => service((point) => {
        if (point === 'after_handle' && ++handleCount === failAt) {
          throw new Error(`fault:handle-${failAt}`);
        }
      }).apply({
        ...command(prospect.personId, `handle-${failAt}`),
        terminalStageEventId: `handle-${failAt}-terminal`,
      })).toThrow(`fault:handle-${failAt}`);
      expect(snapshotPerson(prospect.personId)).toEqual(before);
    }

    const { prospect: deferred } = createReadyFixture('deferred-commit');
    const beforeDeferred = snapshotPerson(deferred.personId);
    expect(() => service((point) => {
      if (point !== 'after_postcondition') return;
      database.raw.pragma('defer_foreign_keys = ON');
      database.raw.prepare(`
        INSERT INTO activities (
          id, person_id, kind, direction, channel, occurred_at,
          metadata_json, created_at
        ) VALUES ('deferred-invalid-evidence', 'missing-person', 'system',
                  'internal', 'system', ?, '{}', ?)
      `).run(DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    }).apply({
      ...command(deferred.personId, 'deferred-commit'),
      terminalStageEventId: 'deferred-commit-terminal',
    })).toThrow();
    expect(snapshotPerson(deferred.personId)).toEqual(beforeDeferred);
    expect(database.raw.prepare(`
      SELECT id FROM activities WHERE id = 'deferred-invalid-evidence'
    `).get()).toBeUndefined();
  });

  it('propagates the most restrictive tombstone and records retrospective truth only', () => {
    const source = seedProspect(database.raw, 'propagate-source');
    const target = seedProspect(database.raw, 'propagate-target');
    const targetCycle = insertOpenCycleWithAction({
      database: database.raw, prefix: 'propagate-target-cycle', prospect: target,
    });
    addPhone(source.personId, 'source-phone', '+14015550100');
    addPhone(target.personId, 'target-phone', '+14015550101');
    const apply = service();
    apply.apply(command(source.personId, 'source'));
    clockNow = LATER;

    const malformedTarget = seedProspect(database.raw, 'propagate-malformed-target');
    expect(() => apply.propagateMostRestrictiveOptOut({
      sourceTombstoneId: 'source-tombstone', targetPersonId: malformedTarget.personId,
      targetTombstoneId: 'malformed-target-tombstone', terminalStageEventId: null,
      evidenceActivity: {
        id: 'malformed-propagation-activity', personId: malformedTarget.personId,
        kind: 'system', direction: 'internal', channel: 'identity_propagation',
        occurredAt: LATER, observedOutcome: 'opted_out',
        metadata: { sourceTombstoneId: 'source-tombstone', untrusted: true },
      },
    })).toThrow();
    expect(optOuts.getForPerson(malformedTarget.personId)).toBeNull();

    const earlyTarget = seedProspect(database.raw, 'propagate-early-target');
    expect(() => apply.propagateMostRestrictiveOptOut({
      sourceTombstoneId: 'source-tombstone', targetPersonId: earlyTarget.personId,
      targetTombstoneId: 'early-target-tombstone', terminalStageEventId: null,
      evidenceActivity: {
        id: 'early-propagation-activity', personId: earlyTarget.personId,
        kind: 'system', direction: 'internal', channel: 'identity_propagation',
        occurredAt: '2026-08-30T11:59:59.999Z', observedOutcome: 'opted_out',
        metadata: { sourceTombstoneId: 'source-tombstone' },
      },
    })).toThrow();
    expect(optOuts.getForPerson(earlyTarget.personId)).toBeNull();

    const propagationInput = {
      sourceTombstoneId: 'source-tombstone', targetPersonId: target.personId,
      targetTombstoneId: 'target-tombstone', terminalStageEventId: 'propagation-terminal',
      evidenceActivity: {
        id: 'propagation-activity', personId: target.personId, kind: 'system',
        direction: 'internal', channel: 'identity_propagation', occurredAt: LATER,
        observedOutcome: 'opted_out', metadata: { sourceTombstoneId: 'source-tombstone' },
      },
    } as const;
    const propagated = apply.propagateMostRestrictiveOptOut(propagationInput);
    expect(propagated.tombstone).toMatchObject({
      id: 'target-tombstone', personId: target.personId,
      requestedAt: DOMAIN_TIMESTAMP, observedChannel: 'identity_propagation',
    });
    expect(propagated.cycle).toMatchObject({
      id: targetCycle.cycleId, workflowStatus: 'closed', closeReason: 'opt_out',
    });
    expect(propagated.handles.map(({ normalizedValue }) => normalizedValue))
      .toEqual(['+14015550100', '+14015550101']);
    expect(optOuts.getById('source-tombstone')).not.toBeNull();
    expect(service().propagateMostRestrictiveOptOut(propagationInput)).toEqual(propagated);
    expect(() => service().propagateMostRestrictiveOptOut({
      ...propagationInput, terminalStageEventId: null,
    })).toThrow();
    expect(() => service().propagateMostRestrictiveOptOut({
      ...propagationInput, terminalStageEventId: 'changed-propagation-terminal',
    })).toThrow();
    expect(auditDomainInvariants({ database, asOf: LATER })
      .filter(({ kind }) => kind.startsWith('opt_out'))).toEqual([]);
    expect(() => apply.propagateMostRestrictiveOptOut({
      sourceTombstoneId: 'source-tombstone', targetPersonId: target.personId,
      targetTombstoneId: 'changed-same-observation-target', terminalStageEventId: null,
      evidenceActivity: {
        id: 'propagation-activity', personId: target.personId, kind: 'system',
        direction: 'internal', channel: 'identity_propagation', occurredAt: LATER,
        observedOutcome: 'opted_out', metadata: { sourceTombstoneId: 'source-tombstone' },
      },
    })).toThrow();
    expect(() => apply.propagateMostRestrictiveOptOut({
      sourceTombstoneId: 'source-tombstone', targetPersonId: target.personId,
      targetTombstoneId: 'ignored-malformed-later-target', terminalStageEventId: null,
      evidenceActivity: {
        id: 'malformed-later-propagation', personId: target.personId, kind: 'system',
        direction: 'internal', channel: 'identity_propagation', occurredAt: LATER,
        observedOutcome: 'opted_out', metadata: {
          sourceTombstoneId: 'source-tombstone', inferred: true,
        },
      },
    })).toThrow();
    expect(events.getActivity('malformed-later-propagation')).toBeNull();
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
    expect(() => apply.recordPastOffAppTouch({
      personId: target.personId, reportedAt: LATER,
      activity: {
        id: 'pre-opt-out-audit-touch', personId: target.personId, kind: 'call',
        direction: 'outbound', channel: 'phone',
        occurredAt: '2026-08-30T11:59:59.999Z', observedOutcome: 'answered',
      },
    })).toThrow();
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
