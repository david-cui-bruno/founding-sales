import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { BUILTIN_CADENCES } from '../../src/main/domain/cadence/builtinCadences';
import { CadenceRepository } from '../../src/main/domain/cadence/cadenceRepository';
import { FOUNDER_CHANNEL_POLICIES_V1 } from '../../src/main/domain/cadence/cadenceScheduler';
import { EventRepository } from '../../src/main/domain/events/eventRepository';
import { IdentityRepository } from '../../src/main/domain/identity/identityRepository';
import { LifecycleService } from '../../src/main/domain/lifecycle/lifecycleService';
import { ReactivationRepository } from '../../src/main/domain/lifecycle/reactivationRepository';
import { SourceRepository } from '../../src/main/domain/source/sourceRepository';
import { LifecycleIdempotencyConflictError } from '../../src/main/domain/support/domainErrors';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { DOMAIN_TIMESTAMP, insertClosedCycle, seedProspect } from '../fixtures/domainRows';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';

const BEFORE_DOMAIN = '2026-08-30T11:59:59.000Z';
const OCTOBER = '2026-10-01T13:00:00.000Z';
const REACTIVATION_FAULTS = [
  'cycle_insert', 'enrollment_insert', 'action_insert',
  'stage_event_insert', 'rule_consume', 'receipt_insert',
] as const;

describe('reactivation lifecycle contracts', () => {
  let database: AppDatabase | undefined;
  let workspace: TempDatabase | undefined;

  afterEach(() => {
    if (database !== undefined) closeDatabase(database);
    workspace?.cleanup();
  });

  async function setup(allocatedIds: string[]) {
    workspace = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: workspace.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${workspace.path}.backups`, workspaceKey: key,
    });
    const unitOfWork = new DomainUnitOfWork(database);
    const clock = { now: () => DOMAIN_TIMESTAMP };
    const remaining = [...allocatedIds];
    const ids = { next: () => {
      const id = remaining.shift();
      if (id === undefined) throw new Error('Unexpected reactivation ID allocation.');
      return id;
    } };
    const identities = new IdentityRepository({ database, unitOfWork, clock, ids });
    const events = new EventRepository({ database, unitOfWork, clock, ids });
    const sources = new SourceRepository({ database, unitOfWork, clock });
    const cadences = new CadenceRepository({ database, unitOfWork, clock });
    const reactivations = new ReactivationRepository({ database, unitOfWork });
    unitOfWork.immediate(() => cadences.installBuiltins());
    const service = new LifecycleService({
      database, unitOfWork, identities, events, sources, cadences, clock, ids,
      timezone: 'America/New_York', policies: FOUNDER_CHANNEL_POLICIES_V1,
    });
    return { database, unitOfWork, identities, sources, cadences, reactivations, service };
  }

  it('requires named durable event evidence after rule creation and pins cadence identity', async () => {
    const harness = await setup(['reactivated-enrollment', 'reactivated-action', 'reactivated-event']);
    const prospect = seedProspect(harness.database.raw, 'typed-event');
    const sourceCycleId = insertClosedCycle({
      database: harness.database.raw, prefix: 'typed-event-source', prospect,
    });
    const cadence = BUILTIN_CADENCES.find(({ family }) => family === 'cadence_c')!;
    const cadenceIdentity = {
      definitionId: cadence.id, family: cadence.family,
      version: cadence.version, contentHash: cadence.contentHash,
    };
    harness.unitOfWork.immediate(() => {
      harness.reactivations.insertRule({
        id: 'event-rule', salesCycleId: sourceCycleId,
        ruleType: 'new-frbo-listing', dueAt: null,
        matcher: { version: 1, eventType: 'new-frbo-listing', personWide: true },
        version: 1, createdAt: DOMAIN_TIMESTAMP,
      });
      harness.sources.append({
        id: 'untyped-frbo', personId: prospect.personId, prospectId: prospect.prospectId,
        channel: 'frbo', observedAt: DOMAIN_TIMESTAMP, sourceRecord: { listingId: 'untyped' },
      });
      harness.sources.append({
        id: 'predates-rule', personId: prospect.personId, prospectId: prospect.prospectId,
        channel: 'frbo', observedAt: BEFORE_DOMAIN,
        sourceRecord: {
          reactivationTrigger: { version: 1, eventType: 'new-frbo-listing' },
        },
      });
      harness.sources.append({
        id: 'typed-frbo', personId: prospect.personId, prospectId: prospect.prospectId,
        channel: 'frbo', observedAt: DOMAIN_TIMESTAMP,
        sourceRecord: {
          reactivationTrigger: { version: 1, eventType: 'new-frbo-listing' },
        },
      });
    });
    const common = {
      ruleId: 'event-rule', expectedRuleVersion: 1,
      personId: prospect.personId, prospectId: prospect.prospectId,
      sourceCycleId, newCycleId: 'typed-event-cycle', activatedAt: DOMAIN_TIMESTAMP,
      ruleType: 'new-frbo-listing', cadence: cadenceIdentity,
    } as const;
    const commandFor = (sourceEventId: string) => ({
      ...common, entrySourceEventId: sourceEventId,
      trigger: {
        kind: 'source_event' as const, eventType: 'new-frbo-listing' as const, sourceEventId,
      },
    });

    expect(() => harness.service.reactivateFromRule(commandFor('untyped-frbo') as never)).toThrow();
    expect(() => harness.service.reactivateFromRule(commandFor('predates-rule') as never)).toThrow();
    expect(harness.reactivations.getRule('event-rule')?.consumedAt).toBeNull();

    const command = commandFor('typed-frbo');
    const result = harness.service.reactivateFromRule(command as never);
    expect(result).toMatchObject({
      kind: 'reactivated', cycle: { id: 'typed-event-cycle', stage: 'ready' },
    });
    harness.database.raw.prepare(`
      UPDATE prospects SET segment = 'hot_frbo', version = version + 1 WHERE id = ?
    `).run(prospect.prospectId);
    expect(harness.service.reactivateFromRule(command as never)).toEqual(result);
    const wrongCadence = BUILTIN_CADENCES.find(({ family }) => family === 'cadence_a')!;
    expect(() => harness.service.reactivateFromRule({
      ...command,
      cadence: {
        definitionId: wrongCadence.id, family: wrongCadence.family,
        version: wrongCadence.version, contentHash: wrongCadence.contentHash,
      },
    } as never)).toThrow(LifecycleIdempotencyConflictError);
  });

  it('discriminates exact owned inbound evidence from an unknown normalized handle Review', async () => {
    const harness = await setup([
      'unknown-handle-review', 'inbound-enrollment', 'inbound-action', 'inbound-event',
    ]);
    const prospect = seedProspect(harness.database.raw, 'inbound-union');
    const sourceCycleId = insertClosedCycle({
      database: harness.database.raw, prefix: 'inbound-union-source', prospect,
    });
    const cadence = BUILTIN_CADENCES.find(({ family }) => family === 'cadence_c')!;
    const cadenceIdentity = {
      definitionId: cadence.id, family: cadence.family,
      version: cadence.version, contentHash: cadence.contentHash,
    };
    const unknownCommand = {
      evidence: {
        kind: 'unknown_handle', handleKind: 'phone', normalizedValue: '+14015550100',
      },
      personId: prospect.personId, prospectId: prospect.prospectId,
      sourceCycleId, newCycleId: 'unknown-must-not-create',
      activatedAt: DOMAIN_TIMESTAMP, cadence: cadenceIdentity,
    } as const;
    const review = harness.service.reactivateFromInboundResponse(unknownCommand as never);
    expect(review).toMatchObject({
      kind: 'review_required',
      reviewItem: {
        id: 'unknown-handle-review',
        activationKey: 'inbound-handle:phone:+14015550100',
        reason: 'unknown_inbound_handle', sourceEventId: null,
        payload: {
          version: 1, kind: 'reactivation_blocked', blocker: 'unknown_inbound_handle',
          command: unknownCommand,
        },
      },
    });
    expect(harness.database.raw.prepare(`
      SELECT id FROM sales_cycles WHERE id = 'unknown-must-not-create'
    `).get()).toBeUndefined();
    expect(harness.service.reactivateFromInboundResponse(unknownCommand as never)).toEqual(review);

    harness.unitOfWork.immediate(() => harness.sources.append({
      id: 'owned-inbound', personId: prospect.personId, prospectId: prospect.prospectId,
      channel: 'inbound_demo', observedAt: DOMAIN_TIMESTAMP,
      sourceRecord: { message: 'DEMO' },
    }));
    const ownedCommand = {
      evidence: {
        kind: 'source_event', sourceEventId: 'owned-inbound', channel: 'inbound_demo',
      },
      personId: prospect.personId, prospectId: prospect.prospectId,
      sourceCycleId, newCycleId: 'owned-inbound-cycle',
      activatedAt: DOMAIN_TIMESTAMP, cadence: cadenceIdentity,
    } as const;
    expect(harness.service.reactivateFromInboundResponse(ownedCommand as never)).toMatchObject({
      kind: 'reactivated', cycle: { id: 'owned-inbound-cycle', stage: 'contacted' },
    });
  });

  it.each(REACTIVATION_FAULTS)(
    'rolls rule activation back after injected %s failure',
    async (faultPoint) => {
      const harness = await setup(['fault-enrollment', 'fault-action', 'fault-stage']);
      const prospect = seedProspect(harness.database.raw, `reactivation-fault-${faultPoint}`);
      const sourceCycleId = insertClosedCycle({
        database: harness.database.raw, prefix: `reactivation-fault-source-${faultPoint}`, prospect,
      });
      harness.unitOfWork.immediate(() => harness.reactivations.insertRule({
        id: 'fault-rule', salesCycleId: sourceCycleId, ruleType: 'manual',
        dueAt: OCTOBER, matcher: null, version: 1, createdAt: DOMAIN_TIMESTAMP,
      }));
      const cadenceDefinition = BUILTIN_CADENCES.find(({ family }) => family === 'cadence_c')!;
      const cadence = {
        definitionId: cadenceDefinition.id, family: 'cadence_c' as const,
        version: cadenceDefinition.version, contentHash: cadenceDefinition.contentHash,
      };
      const before = reactivationSnapshot(harness.database, prospect.personId);
      const when = faultPoint === 'cycle_insert'
        ? `AFTER INSERT ON sales_cycles WHEN NEW.id = 'fault-cycle'`
        : faultPoint === 'enrollment_insert'
          ? `AFTER INSERT ON cadence_enrollments WHEN NEW.id = 'fault-enrollment'`
          : faultPoint === 'action_insert'
            ? `AFTER INSERT ON next_actions WHEN NEW.id = 'fault-action'`
            : faultPoint === 'stage_event_insert'
              ? `AFTER INSERT ON stage_events WHEN NEW.id = 'fault-stage'`
              : faultPoint === 'rule_consume'
                ? `AFTER UPDATE OF consumed_at ON reactivation_rules WHEN NEW.id = 'fault-rule'`
                : `AFTER INSERT ON cycle_reactivation_receipts
                    WHEN NEW.activation_key = 'rule:fault-rule'`;
      harness.database.raw.exec(`
        CREATE TRIGGER fault_reactivation_${faultPoint} ${when}
        BEGIN SELECT RAISE(ABORT, 'fault:${faultPoint}'); END
      `);
      try {
        expect(() => harness.service.reactivateFromRule({
          ruleId: 'fault-rule', expectedRuleVersion: 1,
          personId: prospect.personId, prospectId: prospect.prospectId,
          sourceCycleId, entrySourceEventId: prospect.sourceEventId,
          newCycleId: 'fault-cycle', activatedAt: OCTOBER,
          ruleType: 'manual', trigger: { kind: 'due', dueAt: OCTOBER }, cadence,
        })).toThrow(`fault:${faultPoint}`);
      } finally {
        harness.database.raw.exec(`DROP TRIGGER fault_reactivation_${faultPoint}`);
      }
      expect(reactivationSnapshot(harness.database, prospect.personId)).toEqual(before);
    },
  );
});

function reactivationSnapshot(database: AppDatabase, personId: string): unknown {
  return {
    cycles: database.raw.prepare(`
      SELECT * FROM sales_cycles WHERE person_id = ? ORDER BY id
    `).all(personId),
    enrollments: database.raw.prepare(`
      SELECT enrollment.* FROM cadence_enrollments AS enrollment
      JOIN sales_cycles AS cycle ON cycle.id = enrollment.sales_cycle_id
      WHERE cycle.person_id = ? ORDER BY enrollment.id
    `).all(personId),
    actions: database.raw.prepare(`
      SELECT action.* FROM next_actions AS action
      JOIN sales_cycles AS cycle ON cycle.id = action.sales_cycle_id
      WHERE cycle.person_id = ? ORDER BY action.id
    `).all(personId),
    events: database.raw.prepare(`
      SELECT event.* FROM stage_events AS event
      JOIN sales_cycles AS cycle ON cycle.id = event.sales_cycle_id
      WHERE cycle.person_id = ? ORDER BY event.id
    `).all(personId),
    rules: database.raw.prepare(`
      SELECT rule.* FROM reactivation_rules AS rule
      JOIN sales_cycles AS cycle ON cycle.id = rule.sales_cycle_id
      WHERE cycle.person_id = ? ORDER BY rule.id
    `).all(personId),
    receipts: database.raw.prepare(`
      SELECT * FROM cycle_reactivation_receipts WHERE person_id = ? ORDER BY activation_key
    `).all(personId),
  };
}
