import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { CadenceRepository } from '../../src/main/domain/cadence/cadenceRepository';
import { FOUNDER_CHANNEL_POLICIES_V1 } from '../../src/main/domain/cadence/cadenceScheduler';
import { EventRepository } from '../../src/main/domain/events/eventRepository';
import { IdentityRepository } from '../../src/main/domain/identity/identityRepository';
import { LifecycleService } from '../../src/main/domain/lifecycle/lifecycleService';
import { SourceRepository } from '../../src/main/domain/source/sourceRepository';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { DOMAIN_TIMESTAMP, insertClosedCycle, seedProspect } from '../fixtures/domainRows';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';

describe('LifecycleService', () => {
  let database: AppDatabase | undefined;
  let workspace: TempDatabase | undefined;
  let unitOfWork: DomainUnitOfWork;

  afterEach(() => {
    if (database !== undefined) closeDatabase(database);
    workspace?.cleanup();
  });

  it('atomically creates durable Unreviewed review work then reviews it into Ready cadence work', async () => {
    workspace = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: workspace.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${workspace.path}.backups`, workspaceKey: key,
    });
    unitOfWork = new DomainUnitOfWork(database);
    const prospect = seedProspect(database.raw, 'lifecycle');
    database.raw.prepare(`
      UPDATE prospects SET qualification_state = 'unreviewed' WHERE id = ?
    `).run(prospect.prospectId);
    const clock = { now: () => DOMAIN_TIMESTAMP };
    const allocated = [
      'cycle', 'review-action', 'initial-stage-event',
      'ready-enrollment', 'ready-action', 'ready-stage-event',
    ];
    const ids = { next: () => {
      const id = allocated.shift();
      if (id === undefined) throw new Error('Test ID sequence exhausted.');
      return id;
    } };
    const identities = new IdentityRepository({ database, unitOfWork, clock, ids });
    const events = new EventRepository({ database, unitOfWork, clock, ids });
    const sources = new SourceRepository({ database, unitOfWork, clock });
    const cadences = new CadenceRepository({ database, unitOfWork, clock });
    unitOfWork.immediate(() => cadences.installBuiltins());
    const service = new LifecycleService({
      database, unitOfWork, identities, events, sources, cadences, clock, ids,
      timezone: 'America/New_York', policies: FOUNDER_CHANNEL_POLICIES_V1,
    });

    expect(() => service.scopedWriter()).toThrow();
    expect(() => service.createUnreviewedCycle({
      personId: prospect.personId, prospectId: prospect.prospectId,
      entrySourceEventId: prospect.sourceEventId, effectiveAt: DOMAIN_TIMESTAMP,
      unexpected: true,
    } as never)).toThrow();
    expect(database.raw.prepare('SELECT COUNT(*) AS count FROM sales_cycles').get())
      .toEqual({ count: 0 });

    const unreviewed = service.createUnreviewedCycle({
      personId: prospect.personId, prospectId: prospect.prospectId,
      entrySourceEventId: prospect.sourceEventId, effectiveAt: DOMAIN_TIMESTAMP,
    });
    expect(unreviewed).toMatchObject({
      id: 'cycle', stage: 'unreviewed', workflowStatus: 'active',
      currentNextActionId: 'review-action', version: 1,
    });
    expect(database.raw.prepare(`
      SELECT work_intent, status FROM next_actions WHERE id = 'review-action'
    `).get()).toEqual({ work_intent: 'internal_review', status: 'pending' });
    expect(events.listCycleStageEvents('cycle')).toMatchObject([
      { fromStage: null, toStage: 'unreviewed', transitionSequence: 1 },
    ]);

    const ready = service.reviewToReady({
      cycleId: 'cycle', expectedCycleVersion: 1,
      expectedCurrentActionId: 'review-action', expectedProspectVersion: 1,
      effectiveAt: DOMAIN_TIMESTAMP,
    });
    expect(ready).toMatchObject({
      stage: 'ready', workflowStatus: 'active',
      currentNextActionId: 'ready-action', version: 2,
    });
    expect(database.raw.prepare(`
      SELECT work_intent, status, cadence_enrollment_id
      FROM next_actions WHERE id = 'ready-action'
    `).get()).toEqual({
      work_intent: 'discretionary_prospecting', status: 'pending',
      cadence_enrollment_id: 'ready-enrollment',
    });
    expect(database.raw.prepare(`
      SELECT status FROM next_actions WHERE id = 'review-action'
    `).get()).toEqual({ status: 'completed' });
    expect(events.listCycleStageEvents('cycle').map(({ toStage, transitionSequence }) => ({
      toStage, transitionSequence,
    }))).toEqual([
      { toStage: 'unreviewed', transitionSequence: 1 },
      { toStage: 'ready', transitionSequence: 2 },
    ]);
    expect(identities.getCanonicalProspect(prospect.personId)).toMatchObject({
      qualificationState: 'eligible', version: 2,
      originalSourceEventId: prospect.sourceEventId,
    });
  });

  it('mechanically records Contacted, requires founder confirmations, and counts Won once through onboarding', async () => {
    workspace = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: workspace.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${workspace.path}.backups`, workspaceKey: key,
    });
    unitOfWork = new DomainUnitOfWork(database);
    const prospect = seedProspect(database.raw, 'full-lifecycle');
    database.raw.prepare(`UPDATE prospects SET qualification_state = 'unreviewed' WHERE id = ?`)
      .run(prospect.prospectId);
    const clock = { now: () => DOMAIN_TIMESTAMP };
    const allocated = [
      'cycle', 'review-action', 'event-unreviewed',
      'ready-enrollment', 'ready-action', 'event-ready',
      'event-contacted',
      'interview-enrollment', 'interview-action', 'event-interviewed',
      'offer-enrollment', 'offer-action', 'event-offered',
      'onboarding-enrollment', 'onboarding-action', 'event-won',
    ];
    const ids = { next: () => {
      const id = allocated.shift();
      if (id === undefined) throw new Error('Test ID sequence exhausted.');
      return id;
    } };
    const identities = new IdentityRepository({ database, unitOfWork, clock, ids });
    const events = new EventRepository({ database, unitOfWork, clock, ids });
    const sources = new SourceRepository({ database, unitOfWork, clock });
    const cadences = new CadenceRepository({ database, unitOfWork, clock });
    unitOfWork.immediate(() => cadences.installBuiltins());
    const service = new LifecycleService({
      database, unitOfWork, identities, events, sources, cadences, clock, ids,
      timezone: 'America/New_York', policies: FOUNDER_CHANNEL_POLICIES_V1,
    });

    service.createUnreviewedCycle({
      personId: prospect.personId, prospectId: prospect.prospectId,
      entrySourceEventId: prospect.sourceEventId, effectiveAt: DOMAIN_TIMESTAMP,
    });
    service.reviewToReady({
      cycleId: 'cycle', expectedCycleVersion: 1, expectedCurrentActionId: 'review-action',
      expectedProspectVersion: 1, effectiveAt: DOMAIN_TIMESTAMP,
    });
    unitOfWork.immediate(() => events.appendActivity({
      id: 'contact-activity', personId: prospect.personId, prospectId: prospect.prospectId,
      salesCycleId: 'cycle', kind: 'text', direction: 'inbound', channel: 'text',
      occurredAt: DOMAIN_TIMESTAMP, observedOutcome: 'received', metadata: {},
    }));
    const contacted = service.recordQualifyingContact({
      cycleId: 'cycle', expectedCycleVersion: 2, expectedCurrentActionId: 'ready-action',
      activityId: 'contact-activity', effectiveAt: DOMAIN_TIMESTAMP,
    });
    expect(contacted).toMatchObject({ stage: 'contacted', currentNextActionId: 'ready-action', version: 3 });

    unitOfWork.immediate(() => events.appendActivity({
      id: 'interview-suggestion', personId: prospect.personId, prospectId: prospect.prospectId,
      salesCycleId: 'cycle', kind: 'call', direction: 'outbound', channel: 'phone',
      occurredAt: DOMAIN_TIMESTAMP, durationSeconds: 301, observedOutcome: 'answered', metadata: {},
    }));
    expect(() => service.confirmInterviewed({
      cycleId: 'cycle', expectedCycleVersion: 3, expectedCurrentActionId: 'ready-action',
      suggestionActivityId: 'interview-suggestion',
      effectiveAt: '2026-08-30T11:59:59.999Z',
      confirmedAt: '2026-08-30T11:59:59.999Z',
    })).toThrow();
    const interviewed = service.confirmInterviewed({
      cycleId: 'cycle', expectedCycleVersion: 3, expectedCurrentActionId: 'ready-action',
      suggestionActivityId: 'interview-suggestion', effectiveAt: DOMAIN_TIMESTAMP,
      confirmedAt: DOMAIN_TIMESTAMP,
    });
    expect(interviewed).toMatchObject({
      stage: 'interviewed', currentNextActionId: 'interview-action', version: 4,
    });
    const fitted = service.setDesignPartnerFitness({
      cycleId: 'cycle', expectedCycleVersion: 4, fitness: 5,
      updatedAt: DOMAIN_TIMESTAMP,
    });
    expect(fitted).toMatchObject({ designPartnerFitness: 5, version: 5 });
    const dimension = { value: 'moderate' as const, evidenceActivityIds: ['interview-suggestion'] };
    const readiness = service.setCloseReadiness({
      cycleId: 'cycle', expectedReadinessVersion: 0, assessedAt: DOMAIN_TIMESTAMP,
      readiness: {
        version: 1, demonstratedPain: dimension, activeTimeline: dimension,
        decisionAuthority: dimension, willingnessToTryOrPay: dimension,
        concreteNextStep: dimension,
      },
    });
    expect(readiness).toMatchObject({
      painConfirmed: true, decisionAuthorityConfirmed: true,
      concreteTrialIdentified: true, version: 1,
    });

    unitOfWork.immediate(() => events.appendActivity({
      id: 'offer-suggestion', personId: prospect.personId, prospectId: prospect.prospectId,
      salesCycleId: 'cycle', kind: 'offer', direction: 'outbound', channel: 'phone',
      occurredAt: DOMAIN_TIMESTAMP, observedOutcome: 'price_said', metadata: {},
    }));
    const offered = service.confirmOffered({
      cycleId: 'cycle', expectedCycleVersion: 5, expectedCurrentActionId: 'interview-action',
      suggestionActivityId: 'offer-suggestion', effectiveAt: DOMAIN_TIMESTAMP,
      confirmedAt: DOMAIN_TIMESTAMP,
    });
    expect(offered).toMatchObject({ stage: 'offered', currentNextActionId: 'offer-action', version: 6 });

    const wonCommand = {
      cycleId: 'cycle', expectedCycleVersion: 6, expectedCurrentActionId: 'offer-action',
      effectiveAt: DOMAIN_TIMESTAMP, confirmedAt: DOMAIN_TIMESTAMP,
      terms: {
        billingModel: 'per_door_monthly', doorsCommitted: 12, unitRateCents: 2500,
        foundingCustomer: true, effectiveAt: DOMAIN_TIMESTAMP,
      },
    } as const;
    const won = service.confirmWon(wonCommand);
    expect(won).toMatchObject({
      stage: 'won', workflowStatus: 'onboarding',
      currentNextActionId: 'onboarding-action', version: 7,
    });
    expect(database.raw.prepare(`
      SELECT projected_mrr_cents FROM won_terms WHERE sales_cycle_id = 'cycle'
    `).get()).toEqual({ projected_mrr_cents: 30000 });
    expect(service.confirmWon(wonCommand)).toEqual(won);
    expect(() => service.confirmWon({
      ...wonCommand, terms: { ...wonCommand.terms, doorsCommitted: 13 },
    })).toThrow();

    expect(() => service.completeOnboarding({
      cycleId: 'cycle', expectedCycleVersion: 7,
      expectedCurrentActionId: 'onboarding-action', effectiveAt: DOMAIN_TIMESTAMP,
      waived: false, waiverReason: null,
    })).toThrow();
    const closed = service.completeOnboarding({
      cycleId: 'cycle', expectedCycleVersion: 7,
      expectedCurrentActionId: 'onboarding-action', effectiveAt: DOMAIN_TIMESTAMP,
      waived: true, waiverReason: 'Founder completed onboarding live.',
    });
    expect(closed).toMatchObject({ stage: 'won', workflowStatus: 'closed', currentNextActionId: null, version: 8 });
    expect(events.listCycleStageEvents('cycle').filter(({ toStage }) => toStage === 'won')).toHaveLength(1);
  });

  it('persists Task 8 component advancement and failed reschedule without double-counting a step', async () => {
    workspace = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: workspace.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${workspace.path}.backups`, workspaceKey: key,
    });
    unitOfWork = new DomainUnitOfWork(database);
    const prospect = seedProspect(database.raw, 'outcome');
    database.raw.prepare(`
      UPDATE prospects SET qualification_state = 'unreviewed', segment = 'hot_frbo' WHERE id = ?
    `)
      .run(prospect.prospectId);
    const clock = { now: () => DOMAIN_TIMESTAMP };
    const allocated = [
      'cycle', 'review-action', 'event-unreviewed',
      'ready-enrollment', 'ready-action', 'event-ready',
      'voicemail-action',
    ];
    const ids = { next: () => {
      const id = allocated.shift();
      if (id === undefined) throw new Error('Test ID sequence exhausted.');
      return id;
    } };
    const identities = new IdentityRepository({ database, unitOfWork, clock, ids });
    const events = new EventRepository({ database, unitOfWork, clock, ids });
    const sources = new SourceRepository({ database, unitOfWork, clock });
    const cadences = new CadenceRepository({ database, unitOfWork, clock });
    unitOfWork.immediate(() => cadences.installBuiltins());
    const service = new LifecycleService({
      database, unitOfWork, identities, events, sources, cadences, clock, ids,
      timezone: 'America/New_York', policies: FOUNDER_CHANNEL_POLICIES_V1,
    });
    service.createUnreviewedCycle({
      personId: prospect.personId, prospectId: prospect.prospectId,
      entrySourceEventId: prospect.sourceEventId, effectiveAt: DOMAIN_TIMESTAMP,
    });
    service.reviewToReady({
      cycleId: 'cycle', expectedCycleVersion: 1, expectedCurrentActionId: 'review-action',
      expectedProspectVersion: 1, effectiveAt: DOMAIN_TIMESTAMP,
    });
    const current = database.raw.prepare(`
      SELECT cadence_enrollment_id, cadence_step_id, cadence_component_id
      FROM next_actions WHERE id = 'ready-action'
    `).get() as { cadence_enrollment_id: string; cadence_step_id: string; cadence_component_id: string };
    unitOfWork.immediate(() => events.appendActivity({
      id: 'no-answer', personId: prospect.personId, prospectId: prospect.prospectId,
      salesCycleId: 'cycle', cadenceEnrollmentId: current.cadence_enrollment_id,
      cadenceStepId: current.cadence_step_id, cadenceComponentId: current.cadence_component_id,
      kind: 'call', direction: 'outbound', channel: 'phone', occurredAt: DOMAIN_TIMESTAMP,
      observedOutcome: 'no_answer', metadata: {},
    }));
    const advanced = service.completeCurrentAction({
      cycleId: 'cycle', expectedCycleVersion: 2, expectedCurrentActionId: 'ready-action',
      expectedActionVersion: 1, expectedEnrollmentVersion: 1,
      outcome: 'no_answer', activityId: 'no-answer', impossibleDisposition: null,
      evaluationAt: DOMAIN_TIMESTAMP, manualReactivationDueAt: null,
    });
    expect(advanced).toMatchObject({ currentNextActionId: 'voicemail-action', version: 3 });
    expect(database.raw.prepare(`
      SELECT status FROM next_actions WHERE id = 'ready-action'
    `).get()).toEqual({ status: 'completed' });
    const voicemail = database.raw.prepare(`
      SELECT cadence_enrollment_id, cadence_step_id, cadence_component_id, version
      FROM next_actions WHERE id = 'voicemail-action'
    `).get() as {
      cadence_enrollment_id: string; cadence_step_id: string;
      cadence_component_id: string; version: number;
    };
    expect(database.raw.prepare(`
      SELECT scheduled_step_count FROM cadence_enrollments WHERE id = 'ready-enrollment'
    `).get()).toEqual({ scheduled_step_count: 1 });

    unitOfWork.immediate(() => events.appendActivity({
      id: 'voicemail-failed', personId: prospect.personId, prospectId: prospect.prospectId,
      salesCycleId: 'cycle', cadenceEnrollmentId: voicemail.cadence_enrollment_id,
      cadenceStepId: voicemail.cadence_step_id, cadenceComponentId: voicemail.cadence_component_id,
      kind: 'voicemail', direction: 'outbound', channel: 'voicemail', occurredAt: DOMAIN_TIMESTAMP,
      observedOutcome: 'failed', metadata: {},
    }));
    const rescheduled = service.completeCurrentAction({
      cycleId: 'cycle', expectedCycleVersion: 3, expectedCurrentActionId: 'voicemail-action',
      expectedActionVersion: voicemail.version, expectedEnrollmentVersion: 2,
      outcome: 'failed', activityId: 'voicemail-failed', impossibleDisposition: null,
      evaluationAt: DOMAIN_TIMESTAMP, manualReactivationDueAt: null,
    });
    expect(rescheduled).toMatchObject({ currentNextActionId: 'voicemail-action', version: 3 });
    expect(database.raw.prepare(`
      SELECT status, version FROM next_actions WHERE id = 'voicemail-action'
    `).get()).toEqual({ status: 'pending', version: 2 });
    expect(database.raw.prepare(`
      SELECT scheduled_step_count, version FROM cadence_enrollments WHERE id = 'ready-enrollment'
    `).get()).toEqual({ scheduled_step_count: 1, version: 3 });
  });

  it('closes Lost-Nurture atomically with a durable future reactivation rule', async () => {
    workspace = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: workspace.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${workspace.path}.backups`, workspaceKey: key,
    });
    unitOfWork = new DomainUnitOfWork(database);
    const prospect = seedProspect(database.raw, 'lost');
    database.raw.prepare(`UPDATE prospects SET qualification_state = 'unreviewed' WHERE id = ?`)
      .run(prospect.prospectId);
    const clock = { now: () => DOMAIN_TIMESTAMP };
    const allocated = [
      'cycle', 'review-action', 'event-unreviewed',
      'ready-enrollment', 'ready-action', 'event-ready',
      'manual-rule', 'event-lost',
      'reactivated-enrollment', 'reactivated-action', 'event-reactivated',
    ];
    const ids = { next: () => {
      const id = allocated.shift();
      if (id === undefined) throw new Error('Test ID sequence exhausted.');
      return id;
    } };
    const identities = new IdentityRepository({ database, unitOfWork, clock, ids });
    const events = new EventRepository({ database, unitOfWork, clock, ids });
    const sources = new SourceRepository({ database, unitOfWork, clock });
    const cadences = new CadenceRepository({ database, unitOfWork, clock });
    unitOfWork.immediate(() => cadences.installBuiltins());
    const service = new LifecycleService({
      database, unitOfWork, identities, events, sources, cadences, clock, ids,
      timezone: 'America/New_York', policies: FOUNDER_CHANNEL_POLICIES_V1,
    });
    service.createUnreviewedCycle({
      personId: prospect.personId, prospectId: prospect.prospectId,
      entrySourceEventId: prospect.sourceEventId, effectiveAt: DOMAIN_TIMESTAMP,
    });
    service.reviewToReady({
      cycleId: 'cycle', expectedCycleVersion: 1, expectedCurrentActionId: 'review-action',
      expectedProspectVersion: 1, effectiveAt: DOMAIN_TIMESTAMP,
    });
    const closed = service.closeLostNurture({
      cycleId: 'cycle', expectedCycleVersion: 2,
      expectedCurrentActionId: 'ready-action', reason: 'bad_timing', notes: null,
      effectiveAt: DOMAIN_TIMESTAMP,
      manualReactivationDueAt: '2026-10-01T13:00:00.000Z',
      expectedProspectVersion: null,
    });
    expect(closed).toMatchObject({
      stage: 'lost_nurture', workflowStatus: 'closed', currentNextActionId: null,
      closeReason: 'bad_timing', version: 3,
    });
    expect(database.raw.prepare(`
      SELECT rule_type, due_at, consumed_at FROM reactivation_rules WHERE id = 'manual-rule'
    `).get()).toEqual({
      rule_type: 'manual', due_at: '2026-10-01T13:00:00.000Z', consumed_at: null,
    });
    expect(database.raw.prepare(`
      SELECT status FROM cadence_enrollments WHERE id = 'ready-enrollment'
    `).get()).toEqual({ status: 'stopped' });
    expect(database.raw.prepare(`
      SELECT status FROM next_actions WHERE id = 'ready-action'
    `).get()).toEqual({ status: 'cancelled' });

    const activation = {
      ruleId: 'manual-rule', expectedRuleVersion: 1,
      personId: prospect.personId, prospectId: prospect.prospectId,
      sourceCycleId: 'cycle', entrySourceEventId: prospect.sourceEventId,
      newCycleId: 'reactivated-cycle', activatedAt: '2026-10-01T13:00:00.000Z',
    } as const;
    const reactivated = service.reactivateFromRule(activation);
    expect(reactivated).toMatchObject({
      kind: 'reactivated', cycle: {
        id: 'reactivated-cycle', stage: 'ready', workflowStatus: 'active',
        currentNextActionId: 'reactivated-action',
      },
    });
    expect(database.raw.prepare(`
      SELECT consumed_at FROM reactivation_rules WHERE id = 'manual-rule'
    `).get()).toEqual({ consumed_at: '2026-10-01T13:00:00.000Z' });
    expect(service.reactivateFromRule(activation)).toEqual(reactivated);
  });

  it('rolls cycle and action inserts back when the final StageEvent phase fails', async () => {
    workspace = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: workspace.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${workspace.path}.backups`, workspaceKey: key,
    });
    unitOfWork = new DomainUnitOfWork(database);
    const prospect = seedProspect(database.raw, 'rollback');
    database.raw.prepare(`UPDATE prospects SET qualification_state = 'unreviewed' WHERE id = ?`)
      .run(prospect.prospectId);
    const clock = { now: () => DOMAIN_TIMESTAMP };
    const allocated = ['rollback-cycle', 'rollback-action', ''];
    const ids = { next: () => allocated.shift() ?? 'unexpected-id' };
    const identities = new IdentityRepository({ database, unitOfWork, clock, ids });
    const events = new EventRepository({ database, unitOfWork, clock, ids });
    const sources = new SourceRepository({ database, unitOfWork, clock });
    const cadences = new CadenceRepository({ database, unitOfWork, clock });
    unitOfWork.immediate(() => cadences.installBuiltins());
    const service = new LifecycleService({
      database, unitOfWork, identities, events, sources, cadences, clock, ids,
      timezone: 'America/New_York', policies: FOUNDER_CHANNEL_POLICIES_V1,
    });
    expect(() => service.createUnreviewedCycle({
      personId: prospect.personId, prospectId: prospect.prospectId,
      entrySourceEventId: prospect.sourceEventId, effectiveAt: DOMAIN_TIMESTAMP,
    })).toThrow();
    expect(database.raw.prepare(`SELECT id FROM sales_cycles WHERE id = 'rollback-cycle'`).get())
      .toBeUndefined();
    expect(database.raw.prepare(`SELECT id FROM next_actions WHERE id = 'rollback-action'`).get())
      .toBeUndefined();
  });

  it('stores the inbound-demo permitted-minutes SLA once and replays by source receipt', async () => {
    workspace = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: workspace.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${workspace.path}.backups`, workspaceKey: key,
    });
    unitOfWork = new DomainUnitOfWork(database);
    const prospect = seedProspect(database.raw, 'inbound-reactivation');
    const sourceCycleId = insertClosedCycle({
      database: database.raw, prefix: 'inbound-source', prospect,
    });
    const clock = { now: () => DOMAIN_TIMESTAMP };
    const allocated = ['inbound-enrollment', 'inbound-action', 'inbound-event'];
    const ids = { next: () => {
      const id = allocated.shift();
      if (id === undefined) throw new Error('Receipt replay consumed an ID.');
      return id;
    } };
    const identities = new IdentityRepository({ database, unitOfWork, clock, ids });
    const events = new EventRepository({ database, unitOfWork, clock, ids });
    const sources = new SourceRepository({ database, unitOfWork, clock });
    unitOfWork.immediate(() => sources.append({
      id: 'inbound-demo', personId: prospect.personId, prospectId: prospect.prospectId,
      channel: 'inbound_demo', observedAt: DOMAIN_TIMESTAMP,
      sourceRecord: { message: 'DEMO' },
    }));
    const cadences = new CadenceRepository({ database, unitOfWork, clock });
    unitOfWork.immediate(() => cadences.installBuiltins());
    const service = new LifecycleService({
      database, unitOfWork, identities, events, sources, cadences, clock, ids,
      timezone: 'America/New_York', policies: FOUNDER_CHANNEL_POLICIES_V1,
    });
    const command = {
      sourceEventId: 'inbound-demo', personId: prospect.personId,
      prospectId: prospect.prospectId, sourceCycleId,
      newCycleId: 'inbound-cycle', activatedAt: DOMAIN_TIMESTAMP,
    } as const;
    const result = service.reactivateFromInboundResponse(command);
    expect(result).toMatchObject({
      kind: 'reactivated', cycle: { id: 'inbound-cycle', stage: 'contacted' },
    });
    expect(database.raw.prepare(`
      SELECT work_intent, inbound_sla_kind, inbound_sla_due_at,
        inbound_sla_source_event_id
      FROM next_actions WHERE id = 'inbound-action'
    `).get()).toEqual({
      work_intent: 'inbound_response',
      inbound_sla_kind: 'inbound_demo_permitted_minutes',
      inbound_sla_due_at: '2026-08-30T17:15:00.000Z',
      inbound_sla_source_event_id: 'inbound-demo',
    });
    expect(service.reactivateFromInboundResponse(command)).toEqual(result);
  });

  it('upgrades a cold cadence to live-vacancy cadence without moving old evidence', async () => {
    workspace = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: workspace.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${workspace.path}.backups`, workspaceKey: key,
    });
    unitOfWork = new DomainUnitOfWork(database);
    const prospect = seedProspect(database.raw, 'upgrade');
    database.raw.prepare(`
      UPDATE prospects SET qualification_state = 'unreviewed', segment = 'cold_registry'
      WHERE id = ?
    `).run(prospect.prospectId);
    const clock = { now: () => DOMAIN_TIMESTAMP };
    const allocated = [
      'cycle', 'review-action', 'event-unreviewed',
      'cold-enrollment', 'cold-action', 'event-ready',
      'hot-enrollment', 'hot-action',
    ];
    const ids = { next: () => {
      const id = allocated.shift();
      if (id === undefined) throw new Error('Test ID sequence exhausted.');
      return id;
    } };
    const identities = new IdentityRepository({ database, unitOfWork, clock, ids });
    const events = new EventRepository({ database, unitOfWork, clock, ids });
    const sources = new SourceRepository({ database, unitOfWork, clock });
    const cadences = new CadenceRepository({ database, unitOfWork, clock });
    unitOfWork.immediate(() => cadences.installBuiltins());
    const service = new LifecycleService({
      database, unitOfWork, identities, events, sources, cadences, clock, ids,
      timezone: 'America/New_York', policies: FOUNDER_CHANNEL_POLICIES_V1,
    });
    service.createUnreviewedCycle({
      personId: prospect.personId, prospectId: prospect.prospectId,
      entrySourceEventId: prospect.sourceEventId, effectiveAt: DOMAIN_TIMESTAMP,
    });
    service.reviewToReady({
      cycleId: 'cycle', expectedCycleVersion: 1, expectedCurrentActionId: 'review-action',
      expectedProspectVersion: 1, effectiveAt: DOMAIN_TIMESTAMP,
    });
    unitOfWork.immediate(() => sources.append({
      id: 'live-vacancy', personId: prospect.personId, prospectId: prospect.prospectId,
      channel: 'frbo', observedAt: DOMAIN_TIMESTAMP, sourceRecord: { listing: 'new' },
    }));
    const upgraded = service.applyProspectingTrigger({
      cycleId: 'cycle', expectedCycleVersion: 2, expectedCurrentActionId: 'cold-action',
      expectedActionVersion: 1, expectedEnrollmentVersion: 1,
      triggerSourceEventId: 'live-vacancy', trigger: 'live_vacancy',
      evaluationAt: DOMAIN_TIMESTAMP,
    });
    expect(upgraded).toMatchObject({ currentNextActionId: 'hot-action', version: 3 });
    expect(database.raw.prepare(`
      SELECT cadence_definition_id, status FROM cadence_enrollments
      WHERE id = 'cold-enrollment'
    `).get()).toEqual({ cadence_definition_id: 'cadence-b-v1', status: 'stopped' });
    expect(database.raw.prepare(`
      SELECT cadence_definition_id, status FROM cadence_enrollments
      WHERE id = 'hot-enrollment'
    `).get()).toEqual({ cadence_definition_id: 'cadence-a-v1', status: 'active' });
    expect(database.raw.prepare(`
      SELECT status FROM next_actions WHERE id = 'cold-action'
    `).get()).toEqual({ status: 'cancelled' });
  });
});
