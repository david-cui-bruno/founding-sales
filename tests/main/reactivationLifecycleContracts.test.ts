import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { BUILTIN_CADENCES } from '../../src/main/domain/cadence/builtinCadences';
import { CadenceRepository } from '../../src/main/domain/cadence/cadenceRepository';
import { FOUNDER_CHANNEL_POLICIES_V1 } from '../../src/main/domain/cadence/cadenceScheduler';
import { EventRepository } from '../../src/main/domain/events/eventRepository';
import { IdentityRepository } from '../../src/main/domain/identity/identityRepository';
import { LifecycleService } from '../../src/main/domain/lifecycle/lifecycleService';
import { auditDomainInvariants } from '../../src/main/domain/lifecycle/invariantAudit';
import { ReactivationRepository } from '../../src/main/domain/lifecycle/reactivationRepository';
import { SourceRepository } from '../../src/main/domain/source/sourceRepository';
import { LifecycleIdempotencyConflictError } from '../../src/main/domain/support/domainErrors';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { DOMAIN_TIMESTAMP, insertClosedCycle, seedProspect } from '../fixtures/domainRows';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';

const BEFORE_DOMAIN = '2026-08-30T11:59:59.000Z';
const OCTOBER = '2026-10-01T13:00:00.000Z';
const AFTER_DOMAIN = '2026-08-30T12:00:01.000Z';
const REACTIVATION_FAULTS = [
  'cycle_insert', 'enrollment_insert', 'action_insert',
  'stage_event_insert', 'rule_consume', 'receipt_insert',
] as const;
const RAW_TIMESTAMP_CORRUPTIONS = [
  { target: 'source', column: 'observed_at', value: '' },
  { target: 'rule', column: 'created_at', value: '2026-08-30T12:00:00Z' },
  { target: 'stage', column: 'confirmed_at', value: '' },
  { target: 'action', column: 'created_at', value: '2026-08-30T12:00:00Z' },
  { target: 'enrollment', column: 'anchor_at', value: '' },
  { target: 'cycle', column: 'stage_entered_at', value: '2026-08-30T12:00:00Z' },
  { target: 'receipt', column: 'created_at', value: '' },
] as const;

describe('reactivation lifecycle contracts', () => {
  let database: AppDatabase | undefined;
  let workspace: TempDatabase | undefined;

  afterEach(() => {
    if (database !== undefined) closeDatabase(database);
    workspace?.cleanup();
  });

  async function setup(allocatedIds: string[], clockNow = DOMAIN_TIMESTAMP) {
    workspace = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: workspace.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${workspace.path}.backups`, workspaceKey: key,
    });
    const unitOfWork = new DomainUnitOfWork(database);
    const clock = { now: () => clockNow };
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
    harness.database.raw.prepare(`
      UPDATE sales_cycles SET version = version + 1, updated_at = ? WHERE id = ?
    `).run(AFTER_DOMAIN, 'typed-event-cycle');
    expect(harness.reactivations.getReceipt('rule:event-rule')).toMatchObject({
      newCycleId: 'typed-event-cycle',
      result: { result: { cycle: { version: 1, stage: 'ready' } } },
    });
    const wrongCadence = BUILTIN_CADENCES.find(({ family }) => family === 'cadence_a')!;
    expect(() => harness.service.reactivateFromRule({
      ...command,
      cadence: {
        definitionId: wrongCadence.id, family: wrongCadence.family,
        version: wrongCadence.version, contentHash: wrongCadence.contentHash,
      },
    } as never)).toThrow(LifecycleIdempotencyConflictError);
    harness.database.raw.exec('DROP TRIGGER immutable_source_events');
    harness.database.raw.prepare(`
      UPDATE source_events SET observed_at = ? WHERE id = 'typed-frbo'
    `).run(BEFORE_DOMAIN);
    expect(() => harness.reactivations.getReceipt('rule:event-rule')).toThrow();
    expect(auditDomainInvariants({ database: harness.database, asOf: OCTOBER })).toContainEqual(
      expect.objectContaining({
        kind: 'reactivation_receipt_invalid', recordId: 'rule:event-rule',
      }),
    );
  });

  it('commits and exactly replays activation when the repository clock advances past activatedAt', async () => {
    const harness = await setup([
      'advancing-clock-enrollment', 'advancing-clock-action', 'advancing-clock-event',
    ], AFTER_DOMAIN);
    const prospect = seedProspect(harness.database.raw, 'advancing-clock');
    const sourceCycleId = insertClosedCycle({
      database: harness.database.raw, prefix: 'advancing-clock-source', prospect,
    });
    harness.unitOfWork.immediate(() => harness.reactivations.insertRule({
      id: 'advancing-clock-rule', salesCycleId: sourceCycleId,
      ruleType: 'manual', dueAt: DOMAIN_TIMESTAMP, matcher: null,
      version: 1, createdAt: BEFORE_DOMAIN,
    }));
    const definition = BUILTIN_CADENCES.find(({ family }) => family === 'cadence_c')!;
    const command = {
      ruleId: 'advancing-clock-rule', expectedRuleVersion: 1,
      personId: prospect.personId, prospectId: prospect.prospectId,
      sourceCycleId, entrySourceEventId: prospect.sourceEventId,
      newCycleId: 'advancing-clock-cycle', activatedAt: DOMAIN_TIMESTAMP,
      ruleType: 'manual' as const,
      trigger: { kind: 'due' as const, dueAt: DOMAIN_TIMESTAMP },
      cadence: {
        definitionId: definition.id, family: 'cadence_c' as const,
        version: definition.version, contentHash: definition.contentHash,
      },
    };

    const committed = harness.service.reactivateFromRule(command);
    expect(committed).toMatchObject({
      kind: 'reactivated', cycle: { id: 'advancing-clock-cycle', createdAt: DOMAIN_TIMESTAMP },
    });
    expect(harness.database.raw.prepare(`
      SELECT created_at FROM stage_events
      WHERE sales_cycle_id = 'advancing-clock-cycle' AND transition_sequence = 1
    `).get()).toEqual({ created_at: AFTER_DOMAIN });
    expect(harness.service.reactivateFromRule(command)).toEqual(committed);
    expect(harness.reactivations.getReceipt('rule:advancing-clock-rule')).not.toBeNull();
    expect(auditDomainInvariants({ database: harness.database, asOf: OCTOBER })).not.toContainEqual(
      expect.objectContaining({
        kind: 'reactivation_receipt_invalid', recordId: 'rule:advancing-clock-rule',
      }),
    );
  });

  it('rejects blank and noncanonical timestamps at repository append boundaries', async () => {
    const harness = await setup([]);
    const prospect = seedProspect(harness.database.raw, 'timestamp-append');
    const sourceCycleId = insertClosedCycle({
      database: harness.database.raw, prefix: 'timestamp-append-source', prospect,
    });

    expect(() => harness.unitOfWork.immediate(() => harness.reactivations.insertRule({
      id: 'blank-rule', salesCycleId: sourceCycleId,
      ruleType: 'manual', dueAt: DOMAIN_TIMESTAMP, matcher: null,
      version: 1, createdAt: '',
    } as never))).toThrow();
    expect(() => harness.unitOfWork.immediate(() => harness.sources.append({
      id: 'noncanonical-source', personId: prospect.personId,
      prospectId: prospect.prospectId, channel: 'inbound_demo',
      observedAt: '2026-08-30T12:00:00Z', sourceRecord: { message: 'DEMO' },
    } as never))).toThrow();
  });

  it.each(RAW_TIMESTAMP_CORRUPTIONS)(
    'rejects raw $target timestamp field $column corruption on receipt read and audit',
    async ({ target, column, value }) => {
      const harness = await setup([
        'timestamp-enrollment', 'timestamp-action', 'timestamp-stage',
      ]);
      const prospect = seedProspect(harness.database.raw, `timestamp-${target}`);
      const sourceCycleId = insertClosedCycle({
        database: harness.database.raw, prefix: `timestamp-${target}-source`, prospect,
      });
      harness.unitOfWork.immediate(() => harness.reactivations.insertRule({
        id: 'timestamp-rule', salesCycleId: sourceCycleId,
        ruleType: 'manual', dueAt: DOMAIN_TIMESTAMP, matcher: null,
        version: 1, createdAt: BEFORE_DOMAIN,
      }));
      const definition = BUILTIN_CADENCES.find(({ family }) => family === 'cadence_c')!;
      harness.service.reactivateFromRule({
        ruleId: 'timestamp-rule', expectedRuleVersion: 1,
        personId: prospect.personId, prospectId: prospect.prospectId,
        sourceCycleId, entrySourceEventId: prospect.sourceEventId,
        newCycleId: 'timestamp-cycle', activatedAt: DOMAIN_TIMESTAMP,
        ruleType: 'manual', trigger: { kind: 'due', dueAt: DOMAIN_TIMESTAMP },
        cadence: {
          definitionId: definition.id, family: 'cadence_c',
          version: definition.version, contentHash: definition.contentHash,
        },
      });
      expect(harness.reactivations.getReceipt('rule:timestamp-rule')).not.toBeNull();

      const mutation = timestampCorruptionMutation({
        target, column, value, sourceEventId: prospect.sourceEventId,
      });
      for (const trigger of mutation.dropTriggers) {
        harness.database.raw.exec(`DROP TRIGGER ${trigger}`);
      }
      harness.database.raw.prepare(mutation.sql).run(value);

      expect(() => harness.reactivations.getReceipt('rule:timestamp-rule')).toThrow();
      expect(auditDomainInvariants({ database: harness.database, asOf: OCTOBER })).toContainEqual(
        expect.objectContaining({
          kind: 'reactivation_receipt_invalid', recordId: 'rule:timestamp-rule',
        }),
      );
    },
  );

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

  it('rejects noncanonical and already-known handles before creating an unknown-handle Review', async () => {
    const harness = await setup(['must-not-allocate']);
    const prospect = seedProspect(harness.database.raw, 'canonical-unknown');
    const sourceCycleId = insertClosedCycle({
      database: harness.database.raw, prefix: 'canonical-unknown-source', prospect,
    });
    const cadence = BUILTIN_CADENCES.find(({ family }) => family === 'cadence_c')!;
    const common = {
      personId: prospect.personId, prospectId: prospect.prospectId,
      sourceCycleId, newCycleId: 'canonical-unknown-cycle',
      activatedAt: DOMAIN_TIMESTAMP,
      cadence: {
        definitionId: cadence.id, family: 'cadence_c',
        version: cadence.version, contentHash: cadence.contentHash,
      },
    } as const;

    expect(() => harness.service.reactivateFromInboundResponse({
      ...common,
      evidence: {
        kind: 'unknown_handle', handleKind: 'phone', normalizedValue: '(401) 555-0100',
      },
    } as never)).toThrow();
    expect(() => harness.service.reactivateFromInboundResponse({
      ...common,
      evidence: {
        kind: 'unknown_handle', handleKind: 'email', normalizedValue: ' KEVIN@EXAMPLE.COM ',
      },
    } as never)).toThrow();

    harness.database.raw.prepare(`
      INSERT INTO person_contact_methods (
        id, person_id, kind, normalized_value, raw_value, validation_state,
        reachability, is_primary, in_contacts, created_at, updated_at
      ) VALUES ('known-handle', ?, 'phone', '+14015550100', NULL, 'valid',
        'direct', 1, 0, ?, ?)
    `).run(prospect.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    expect(() => harness.service.reactivateFromInboundResponse({
      ...common,
      evidence: {
        kind: 'unknown_handle', handleKind: 'phone', normalizedValue: '+14015550100',
      },
    } as never)).toThrow();
    expect(harness.database.raw.prepare(`SELECT id FROM lifecycle_review_items`).all()).toEqual([]);
  });

  it('requires inbound SourceEvent observation no later than activation', async () => {
    const harness = await setup(['must-not-enroll']);
    const prospect = seedProspect(harness.database.raw, 'future-inbound');
    const sourceCycleId = insertClosedCycle({
      database: harness.database.raw, prefix: 'future-inbound-source', prospect,
    });
    harness.unitOfWork.immediate(() => harness.sources.append({
      id: 'future-inbound-event', personId: prospect.personId,
      prospectId: prospect.prospectId, channel: 'inbound_demo',
      observedAt: AFTER_DOMAIN, sourceRecord: { message: 'DEMO' },
    }));
    const cadence = BUILTIN_CADENCES.find(({ family }) => family === 'cadence_c')!;

    expect(() => harness.service.reactivateFromInboundResponse({
      evidence: {
        kind: 'source_event', sourceEventId: 'future-inbound-event', channel: 'inbound_demo',
      },
      personId: prospect.personId, prospectId: prospect.prospectId,
      sourceCycleId, newCycleId: 'future-inbound-cycle', activatedAt: DOMAIN_TIMESTAMP,
      cadence: {
        definitionId: cadence.id, family: 'cadence_c',
        version: cadence.version, contentHash: cadence.contentHash,
      },
    })).toThrow();
    expect(harness.database.raw.prepare(`
      SELECT id FROM sales_cycles WHERE id = 'future-inbound-cycle'
    `).get()).toBeUndefined();
  });

  it('atomically resolves a cleared blocked Review against its committed receipt', async () => {
    const harness = await setup([
      'blocked-review', 'unblocked-enrollment', 'unblocked-action', 'unblocked-stage',
    ]);
    const prospect = seedProspect(harness.database.raw, 'unblocked-rule');
    const sourceCycleId = insertClosedCycle({
      database: harness.database.raw, prefix: 'unblocked-rule-source', prospect,
    });
    harness.database.raw.prepare(`
      UPDATE prospects SET qualification_state = 'disqualified',
        qualification_gate_reason = 'out_of_area',
        qualification_reason = 'fixture', version = 2 WHERE id = ?
    `).run(prospect.prospectId);
    harness.unitOfWork.immediate(() => harness.reactivations.insertRule({
      id: 'unblocked-rule', salesCycleId: sourceCycleId, ruleType: 'manual',
      dueAt: DOMAIN_TIMESTAMP, matcher: null, version: 1, createdAt: BEFORE_DOMAIN,
    }));
    const cadence = BUILTIN_CADENCES.find(({ family }) => family === 'cadence_c')!;
    const command = {
      ruleId: 'unblocked-rule', expectedRuleVersion: 1,
      personId: prospect.personId, prospectId: prospect.prospectId,
      sourceCycleId, entrySourceEventId: prospect.sourceEventId,
      newCycleId: 'unblocked-cycle', activatedAt: DOMAIN_TIMESTAMP,
      ruleType: 'manual', trigger: { kind: 'due', dueAt: DOMAIN_TIMESTAMP },
      cadence: {
        definitionId: cadence.id, family: 'cadence_c',
        version: cadence.version, contentHash: cadence.contentHash,
      },
    } as const;
    expect(harness.service.reactivateFromRule(command)).toMatchObject({
      kind: 'review_required', reviewItem: { id: 'blocked-review', status: 'open' },
    });
    harness.database.raw.prepare(`
      UPDATE prospects SET qualification_state = 'eligible',
        qualification_gate_reason = NULL,
        qualification_reason = NULL, version = 3 WHERE id = ?
    `).run(prospect.prospectId);

    expect(harness.service.reactivateFromRule(command)).toMatchObject({
      kind: 'reactivated', cycle: { id: 'unblocked-cycle', stage: 'ready' },
    });
    expect(harness.database.raw.prepare(`
      SELECT status, version FROM lifecycle_review_items WHERE id = 'blocked-review'
    `).get()).toEqual({ status: 'resolved', version: 2 });
    expect(harness.database.raw.prepare(`
      SELECT activation_key FROM cycle_reactivation_receipts WHERE activation_key = 'rule:unblocked-rule'
    `).get()).toEqual({ activation_key: 'rule:unblocked-rule' });
  });

  it('CAS-promotes an unknown-handle Review through durable SourceEvent evidence and exactly replays', async () => {
    const harness = await setup([
      'unknown-review', 'promoted-enrollment', 'promoted-action', 'promoted-stage-event',
    ]);
    const prospect = seedProspect(harness.database.raw, 'promote-inbound');
    const sourceCycleId = insertClosedCycle({
      database: harness.database.raw, prefix: 'promote-inbound-source', prospect,
    });
    const cadence = BUILTIN_CADENCES.find(({ family }) => family === 'cadence_c')!;
    const cadenceIdentity = {
      definitionId: cadence.id, family: 'cadence_c' as const,
      version: cadence.version, contentHash: cadence.contentHash,
    } as const;
    const unknownCommand = {
      evidence: {
        kind: 'unknown_handle', handleKind: 'phone', normalizedValue: '+14015550100',
      },
      personId: prospect.personId, prospectId: prospect.prospectId,
      sourceCycleId, newCycleId: 'promoted-cycle',
      activatedAt: DOMAIN_TIMESTAMP, cadence: cadenceIdentity,
    } as const;
    const review = harness.service.reactivateFromInboundResponse(unknownCommand);
    expect(review).toMatchObject({
      kind: 'review_required', reviewItem: { id: 'unknown-review', version: 1, status: 'open' },
    });
    harness.unitOfWork.immediate(() => harness.sources.append({
      id: 'promoted-source-event', personId: prospect.personId,
      prospectId: prospect.prospectId, channel: 'inbound_demo',
      observedAt: DOMAIN_TIMESTAMP, sourceRecord: { message: 'DEMO from +14015550100' },
    }));
    const promotion = {
      reviewId: 'unknown-review',
      activationKey: 'inbound-handle:phone:+14015550100',
      expectedReviewVersion: 1,
      sourceEventId: 'promoted-source-event', channel: 'inbound_demo',
      activatedAt: AFTER_DOMAIN, cadence: cadenceIdentity,
    } as const;

    const result = harness.service.promoteUnknownInboundReview(promotion);
    expect(result).toMatchObject({
      kind: 'reactivated', cycle: { id: 'promoted-cycle', stage: 'contacted' },
    });
    expect(harness.database.raw.prepare(`
      SELECT activation_key, source_event_id, new_cycle_id
      FROM cycle_reactivation_receipts WHERE activation_key = 'inbound:promoted-source-event'
    `).get()).toEqual({
      activation_key: 'inbound:promoted-source-event',
      source_event_id: 'promoted-source-event',
      new_cycle_id: 'promoted-cycle',
    });
    expect(harness.database.raw.prepare(`
      SELECT status, version, source_event_id, resolution_json
      FROM lifecycle_review_items WHERE id = 'unknown-review'
    `).get()).toMatchObject({
      status: 'resolved', version: 2, source_event_id: null,
      resolution_json: expect.stringContaining('promoted-source-event'),
    });
    expect(harness.service.promoteUnknownInboundReview(promotion)).toEqual(result);
    expect(harness.service.reactivateFromInboundResponse({
      evidence: {
        kind: 'source_event', sourceEventId: 'promoted-source-event', channel: 'inbound_demo',
      },
      personId: prospect.personId, prospectId: prospect.prospectId,
      sourceCycleId, newCycleId: 'promoted-cycle',
      activatedAt: AFTER_DOMAIN, cadence: cadenceIdentity,
    })).toEqual(result);
    expect(() => harness.service.promoteUnknownInboundReview({
      ...promotion, expectedReviewVersion: 2, activatedAt: OCTOBER,
    })).toThrow(LifecycleIdempotencyConflictError);

    harness.database.raw.prepare(`
      UPDATE sales_cycles SET version = version + 1, updated_at = ? WHERE id = 'promoted-cycle'
    `).run(OCTOBER);
    expect(harness.service.promoteUnknownInboundReview(promotion)).toEqual(result);
    harness.database.raw.exec('DROP TRIGGER immutable_stage_events_delete');
    harness.database.raw.prepare(`
      DELETE FROM stage_events WHERE sales_cycle_id = 'promoted-cycle' AND transition_sequence = 1
    `).run();
    expect(() => harness.service.promoteUnknownInboundReview(promotion)).toThrow();
    expect(auditDomainInvariants({ database: harness.database, asOf: OCTOBER })).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'reactivation_receipt_invalid', recordId: 'inbound:promoted-source-event',
      }),
      expect.objectContaining({ kind: 'lifecycle_review_invalid', recordId: 'unknown-review' }),
    ]));
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

function timestampCorruptionMutation(input: {
  target: typeof RAW_TIMESTAMP_CORRUPTIONS[number]['target'];
  column: string;
  value: string;
  sourceEventId: string;
}): Readonly<{ dropTriggers: readonly string[]; sql: string }> {
  if (input.target === 'source') return {
    dropTriggers: ['immutable_source_events'],
    sql: `UPDATE source_events SET observed_at = ? WHERE id = '${input.sourceEventId}'`,
  };
  if (input.target === 'rule') return {
    dropTriggers: ['protect_reactivation_rule_update'],
    sql: 'UPDATE reactivation_rules SET created_at = ? WHERE id = \'timestamp-rule\'',
  };
  if (input.target === 'stage') return {
    dropTriggers: ['immutable_stage_events'],
    sql: `UPDATE stage_events SET ${input.column} = ? WHERE id = 'timestamp-stage'`,
  };
  if (input.target === 'action') return {
    dropTriggers: [],
    sql: `UPDATE next_actions SET ${input.column} = ? WHERE id = 'timestamp-action'`,
  };
  if (input.target === 'enrollment') return {
    dropTriggers: ['protect_cadence_enrollment_identity'],
    sql: `UPDATE cadence_enrollments SET ${input.column} = ? WHERE id = 'timestamp-enrollment'`,
  };
  if (input.target === 'cycle') return {
    dropTriggers: [],
    sql: `UPDATE sales_cycles SET ${input.column} = ? WHERE id = 'timestamp-cycle'`,
  };
  return {
    dropTriggers: ['immutable_cycle_reactivation_receipts'],
    sql: `UPDATE cycle_reactivation_receipts SET ${input.column} = ?
      WHERE activation_key = 'rule:timestamp-rule'`,
  };
}
