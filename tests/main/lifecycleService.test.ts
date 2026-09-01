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
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import {
  DOMAIN_TIMESTAMP,
  insertClosedCycle,
  insertOpenCycleWithAction,
  seedProspect,
} from '../fixtures/domainRows';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';

const WARM_CADENCE = BUILTIN_CADENCES.find(({ family }) => family === 'cadence_c')!;
const WARM_CADENCE_IDENTITY = {
  definitionId: WARM_CADENCE.id, family: 'cadence_c' as const,
  version: WARM_CADENCE.version, contentHash: WARM_CADENCE.contentHash,
} as const;

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
    expectOwnedLifecycleAuditClean(database, 'cycle');

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
    expectOwnedLifecycleAuditClean(database, 'cycle');
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
      id: 'sent-only-activity', personId: prospect.personId, prospectId: prospect.prospectId,
      salesCycleId: 'cycle', kind: 'text', direction: 'outbound', channel: 'text',
      occurredAt: DOMAIN_TIMESTAMP, observedOutcome: 'sent', metadata: {},
    }));
    expect(() => service.recordQualifyingContact({
      cycleId: 'cycle', expectedCycleVersion: 2, expectedCurrentActionId: 'ready-action',
      activityId: 'sent-only-activity', effectiveAt: DOMAIN_TIMESTAMP,
    })).toThrow();
    unitOfWork.immediate(() => events.appendActivity({
      id: 'contact-activity', personId: prospect.personId, prospectId: prospect.prospectId,
      salesCycleId: 'cycle', kind: 'text', direction: 'inbound', channel: 'text',
      occurredAt: DOMAIN_TIMESTAMP, observedOutcome: 'replied', metadata: {},
    }));
    const contacted = service.recordQualifyingContact({
      cycleId: 'cycle', expectedCycleVersion: 2, expectedCurrentActionId: 'ready-action',
      activityId: 'contact-activity', effectiveAt: DOMAIN_TIMESTAMP,
    });
    expect(contacted).toMatchObject({ stage: 'contacted', currentNextActionId: 'ready-action', version: 3 });
    expectOwnedLifecycleAuditClean(database, 'cycle');

    unitOfWork.immediate(() => events.appendActivity({
      id: 'interview-suggestion', personId: prospect.personId, prospectId: prospect.prospectId,
      salesCycleId: 'cycle', kind: 'call', direction: 'outbound', channel: 'phone',
      occurredAt: DOMAIN_TIMESTAMP, durationSeconds: 240, observedOutcome: 'answered', metadata: {},
    }));
    unitOfWork.immediate(() => events.appendActivity({
      id: 'explicit-interview', personId: prospect.personId, prospectId: prospect.prospectId,
      salesCycleId: 'cycle', kind: 'interview', direction: 'outbound', channel: 'phone',
      occurredAt: DOMAIN_TIMESTAMP, durationSeconds: 240,
      observedOutcome: 'substantive', metadata: {},
    }));
    unitOfWork.immediate(() => events.appendActivity({
      id: 'phone-tag-not-interview', personId: prospect.personId, prospectId: prospect.prospectId,
      salesCycleId: 'cycle', kind: 'call', direction: 'outbound', channel: 'phone',
      occurredAt: DOMAIN_TIMESTAMP, durationSeconds: 420, observedOutcome: 'no_answer', metadata: {},
    }));
    expect(() => service.confirmInterviewed({
      cycleId: 'cycle', expectedCycleVersion: 3, expectedCurrentActionId: 'ready-action',
      suggestionActivityId: 'phone-tag-not-interview', effectiveAt: DOMAIN_TIMESTAMP,
      confirmedAt: DOMAIN_TIMESTAMP,
    })).toThrow();
    expect(() => service.confirmInterviewed({
      cycleId: 'cycle', expectedCycleVersion: 3, expectedCurrentActionId: 'ready-action',
      suggestionActivityId: 'interview-suggestion',
      effectiveAt: '2026-08-30T11:59:59.999Z',
      confirmedAt: '2026-08-30T11:59:59.999Z',
    })).toThrow();
    const interviewed = service.confirmInterviewed({
      cycleId: 'cycle', expectedCycleVersion: 3, expectedCurrentActionId: 'ready-action',
      suggestionActivityId: 'explicit-interview', effectiveAt: DOMAIN_TIMESTAMP,
      confirmedAt: DOMAIN_TIMESTAMP,
    });
    expect(interviewed).toMatchObject({
      stage: 'interviewed', currentNextActionId: 'interview-action', version: 4,
    });
    expectOwnedLifecycleAuditClean(database, 'cycle');
    const fitted = service.setDesignPartnerFitness({
      cycleId: 'cycle', expectedCycleVersion: 4, fitness: 5,
      updatedAt: DOMAIN_TIMESTAMP,
    });
    expect(fitted).toMatchObject({ designPartnerFitness: 5, version: 5 });
    const dimension = { value: 'moderate' as const, evidenceActivityIds: ['explicit-interview'] };
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
      id: 'offer-without-price', personId: prospect.personId, prospectId: prospect.prospectId,
      salesCycleId: 'cycle', kind: 'offer', direction: 'outbound', channel: 'phone',
      occurredAt: DOMAIN_TIMESTAMP, observedOutcome: 'sent', metadata: {},
    }));
    expect(() => service.confirmOffered({
      cycleId: 'cycle', expectedCycleVersion: 5, expectedCurrentActionId: 'interview-action',
      suggestionActivityId: 'offer-without-price', effectiveAt: DOMAIN_TIMESTAMP,
      confirmedAt: DOMAIN_TIMESTAMP,
    })).toThrow();
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
    expectOwnedLifecycleAuditClean(database, 'cycle');

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
    expectOwnedLifecycleAuditClean(database, 'cycle');
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
    expectOwnedLifecycleAuditClean(database, 'cycle');
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
      UPDATE prospects SET qualification_state = 'unreviewed', segment = 'hot' WHERE id = ?
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
      SELECT cadence_enrollment_id, cadence_step_id, cadence_component_id, version,
        work_intent
      FROM next_actions WHERE id = 'voicemail-action'
    `).get() as {
      cadence_enrollment_id: string; cadence_step_id: string;
      cadence_component_id: string; version: number; work_intent: string;
    };
    expect(voicemail.work_intent).toBe('discretionary_prospecting');
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
      SELECT status, version, due_at, updated_at
      FROM next_actions WHERE id = 'voicemail-action'
    `).get()).toEqual({
      status: 'pending', version: 2,
      due_at: '2026-08-30T17:00:00.000Z',
      updated_at: DOMAIN_TIMESTAMP,
    });
    expect(database.raw.prepare(`
      SELECT scheduled_step_count, version FROM cadence_enrollments WHERE id = 'ready-enrollment'
    `).get()).toEqual({ scheduled_step_count: 1, version: 3 });
    expect(database.raw.prepare(`
      SELECT work_intent FROM next_actions WHERE id = 'voicemail-action'
    `).get()).toEqual({ work_intent: 'discretionary_prospecting' });
  });

  it('atomically emits Contacted when a cadence completion has qualifying evidence', async () => {
    workspace = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: workspace.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${workspace.path}.backups`, workspaceKey: key,
    });
    unitOfWork = new DomainUnitOfWork(database);
    const prospect = seedProspect(database.raw, 'cadence-contacted');
    database.raw.prepare(`
      UPDATE prospects SET qualification_state = 'unreviewed', segment = 'hot' WHERE id = ?
    `).run(prospect.prospectId);
    const clock = { now: () => DOMAIN_TIMESTAMP };
    const allocated = [
      'contact-cycle', 'contact-review-action', 'contact-unreviewed-event',
      'contact-enrollment', 'contact-first-action', 'contact-ready-event',
      'contacted-event', 'contact-next-action',
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
      cycleId: 'contact-cycle', expectedCycleVersion: 1,
      expectedCurrentActionId: 'contact-review-action', expectedProspectVersion: 1,
      effectiveAt: DOMAIN_TIMESTAMP,
    });
    const binding = database.raw.prepare(`
      SELECT cadence_enrollment_id, cadence_step_id, cadence_component_id
      FROM next_actions WHERE id = 'contact-first-action'
    `).get() as {
      cadence_enrollment_id: string; cadence_step_id: string; cadence_component_id: string;
    };
    unitOfWork.immediate(() => events.appendActivity({
      id: 'answered-call', personId: prospect.personId, prospectId: prospect.prospectId,
      salesCycleId: 'contact-cycle', cadenceEnrollmentId: binding.cadence_enrollment_id,
      cadenceStepId: binding.cadence_step_id, cadenceComponentId: binding.cadence_component_id,
      kind: 'call', direction: 'outbound', channel: 'phone', occurredAt: DOMAIN_TIMESTAMP,
      observedOutcome: 'answered', durationSeconds: 45, metadata: {},
    }));

    const result = service.completeCurrentAction({
      cycleId: 'contact-cycle', expectedCycleVersion: 2,
      expectedCurrentActionId: 'contact-first-action', expectedActionVersion: 1,
      expectedEnrollmentVersion: 1, outcome: 'answered', activityId: 'answered-call',
      impossibleDisposition: null, evaluationAt: DOMAIN_TIMESTAMP,
      manualReactivationDueAt: null,
    });
    expect(result).toMatchObject({
      stage: 'contacted', workflowStatus: 'active',
      currentNextActionId: 'contact-next-action', version: 4,
    });
    expect(events.listCycleStageEvents('contact-cycle').map(({ toStage }) => toStage))
      .toEqual(['unreviewed', 'ready', 'contacted']);
    expect(database.raw.prepare(`
      SELECT work_intent FROM next_actions WHERE id = 'contact-next-action'
    `).get()).toEqual({ work_intent: 'promised_follow_up' });
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
      'reactivated-contact-event',
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
      expectedCurrentActionId: 'ready-action', reason: 'bad_timing', qualificationGateReason: null, notes: null,
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
      ruleType: 'manual',
      trigger: { kind: 'due', dueAt: '2026-10-01T13:00:00.000Z' },
      cadence: WARM_CADENCE_IDENTITY,
    } as const;
    expect(() => service.reactivateFromRule({
      ...activation, trigger: { kind: 'due', dueAt: '2026-10-01T13:00:01.000Z' },
    })).toThrow();
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
    unitOfWork.immediate(() => events.appendActivity({
      id: 'reactivated-contact', personId: prospect.personId, prospectId: prospect.prospectId,
      salesCycleId: 'reactivated-cycle', kind: 'text', direction: 'inbound', channel: 'text',
      occurredAt: '2026-10-01T13:00:00.000Z', observedOutcome: 'replied', metadata: {},
    }));
    service.recordQualifyingContact({
      cycleId: 'reactivated-cycle', expectedCycleVersion: 1,
      expectedCurrentActionId: 'reactivated-action', activityId: 'reactivated-contact',
      effectiveAt: '2026-10-01T13:00:00.000Z',
    });
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
    const allocated = [
      'inbound-enrollment', 'inbound-action', 'inbound-event',
      'inbound-resolver-action', 'inbound-retry-action',
    ];
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
      evidence: {
        kind: 'source_event', sourceEventId: 'inbound-demo', channel: 'inbound_demo',
      },
      personId: prospect.personId,
      prospectId: prospect.prospectId, sourceCycleId,
      newCycleId: 'inbound-cycle', activatedAt: DOMAIN_TIMESTAMP,
      cadence: WARM_CADENCE_IDENTITY,
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

    const inboundBinding = database.raw.prepare(`
      SELECT cadence_enrollment_id, cadence_step_id, cadence_component_id
      FROM next_actions WHERE id = 'inbound-action'
    `).get() as {
      cadence_enrollment_id: string; cadence_step_id: string; cadence_component_id: string;
    };
    unitOfWork.immediate(() => events.appendActivity({
      id: 'inbound-channel-unavailable', personId: prospect.personId,
      prospectId: prospect.prospectId, salesCycleId: 'inbound-cycle',
      cadenceEnrollmentId: inboundBinding.cadence_enrollment_id,
      cadenceStepId: inboundBinding.cadence_step_id,
      cadenceComponentId: inboundBinding.cadence_component_id,
      kind: 'text', direction: 'outbound', channel: 'text', occurredAt: DOMAIN_TIMESTAMP,
      observedOutcome: 'channel_unavailable', metadata: {},
    }));
    const withResolver = service.completeCurrentAction({
      cycleId: 'inbound-cycle', expectedCycleVersion: 1,
      expectedCurrentActionId: 'inbound-action', expectedActionVersion: 1,
      expectedEnrollmentVersion: 1, outcome: 'channel_unavailable',
      activityId: 'inbound-channel-unavailable', impossibleDisposition: null,
      evaluationAt: DOMAIN_TIMESTAMP, manualReactivationDueAt: null,
    });
    expect(withResolver).toMatchObject({
      currentNextActionId: 'inbound-resolver-action', version: 2,
    });
    const inboundEvidence = {
      work_intent: 'inbound_response',
      inbound_sla_kind: 'inbound_demo_permitted_minutes',
      inbound_sla_due_at: '2026-08-30T17:15:00.000Z',
      inbound_sla_source_event_id: 'inbound-demo',
    };
    expect(database.raw.prepare(`
      SELECT work_intent, inbound_sla_kind, inbound_sla_due_at, inbound_sla_source_event_id
      FROM next_actions WHERE id = 'inbound-resolver-action'
    `).get()).toEqual(inboundEvidence);

    const retried = service.completeCurrentAction({
      cycleId: 'inbound-cycle', expectedCycleVersion: 2,
      expectedCurrentActionId: 'inbound-resolver-action', expectedActionVersion: 1,
      expectedEnrollmentVersion: 2, outcome: 'resolved', activityId: null,
      impossibleDisposition: null, evaluationAt: DOMAIN_TIMESTAMP,
      manualReactivationDueAt: null,
    });
    expect(retried).toMatchObject({
      currentNextActionId: 'inbound-retry-action', version: 3,
    });
    expect(database.raw.prepare(`
      SELECT work_intent, inbound_sla_kind, inbound_sla_due_at, inbound_sla_source_event_id
      FROM next_actions WHERE id = 'inbound-retry-action'
    `).get()).toEqual(inboundEvidence);
  });

  it('requires rule-specific owned SourceEvent proof for event-driven reactivation', async () => {
    workspace = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: workspace.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${workspace.path}.backups`, workspaceKey: key,
    });
    unitOfWork = new DomainUnitOfWork(database);
    const prospect = seedProspect(database.raw, 'event-reactivation');
    const sourceCycleId = insertClosedCycle({
      database: database.raw, prefix: 'event-reactivation-source', prospect,
    });
    const clock = { now: () => DOMAIN_TIMESTAMP };
    const allocated = ['event-enrollment', 'event-action', 'event-stage'];
    const ids = { next: () => {
      const id = allocated.shift();
      if (id === undefined) throw new Error('Event reactivation consumed an unexpected ID.');
      return id;
    } };
    const identities = new IdentityRepository({ database, unitOfWork, clock, ids });
    const events = new EventRepository({ database, unitOfWork, clock, ids });
    const sources = new SourceRepository({ database, unitOfWork, clock });
    const cadences = new CadenceRepository({ database, unitOfWork, clock });
    const reactivations = new ReactivationRepository({ database, unitOfWork });
    unitOfWork.immediate(() => {
      cadences.installBuiltins();
      reactivations.insertRule({
        id: 'new-frbo-rule', salesCycleId: sourceCycleId,
        ruleType: 'new-frbo-listing', dueAt: null,
        matcher: { version: 1, eventType: 'new-frbo-listing', personWide: true },
        version: 1, createdAt: DOMAIN_TIMESTAMP,
      });
      sources.append({
        id: 'wrong-registry-trigger', personId: prospect.personId,
        prospectId: prospect.prospectId, channel: 'registry', observedAt: DOMAIN_TIMESTAMP,
        sourceRecord: { event: 'not-a-frbo-listing' },
      });
      sources.append({
        id: 'owned-frbo-trigger', personId: prospect.personId,
        prospectId: prospect.prospectId, channel: 'frbo', observedAt: DOMAIN_TIMESTAMP,
        sourceRecord: {
          reactivationTrigger: { version: 1, eventType: 'new-frbo-listing' },
        },
      });
    });
    const service = new LifecycleService({
      database, unitOfWork, identities, events, sources, cadences, clock, ids,
      timezone: 'America/New_York', policies: FOUNDER_CHANNEL_POLICIES_V1,
    });
    const common = {
      ruleId: 'new-frbo-rule', expectedRuleVersion: 1,
      personId: prospect.personId, prospectId: prospect.prospectId, sourceCycleId,
      newCycleId: 'event-reactivated-cycle', activatedAt: DOMAIN_TIMESTAMP,
      ruleType: 'new-frbo-listing' as const,
      cadence: WARM_CADENCE_IDENTITY,
    };
    expect(() => service.reactivateFromRule({
      ...common, entrySourceEventId: 'wrong-registry-trigger',
      trigger: {
        kind: 'source_event', eventType: 'new-frbo-listing',
        sourceEventId: 'wrong-registry-trigger',
      },
    })).toThrow();
    expect(reactivations.getRule('new-frbo-rule')?.consumedAt).toBeNull();

    expect(service.reactivateFromRule({
      ...common, entrySourceEventId: 'owned-frbo-trigger',
      trigger: {
        kind: 'source_event', eventType: 'new-frbo-listing',
        sourceEventId: 'owned-frbo-trigger',
      },
    })).toMatchObject({
      kind: 'reactivated', cycle: { id: 'event-reactivated-cycle', stage: 'ready' },
    });
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
      UPDATE prospects SET qualification_state = 'unreviewed', segment = 'cold'
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

  it('preserves Won while stopping onboarding for opt-out and rejects manual Lost-Nurture', async () => {
    workspace = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: workspace.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${workspace.path}.backups`, workspaceKey: key,
    });
    unitOfWork = new DomainUnitOfWork(database);
    const optedOutProspect = seedProspect(database.raw, 'won-opt-out');
    const manualCloseProspect = seedProspect(database.raw, 'won-manual-close');
    const insertWonOnboarding = (
      cycleId: string,
      actionId: string,
      prospect: typeof optedOutProspect,
    ): void => {
      database!.raw.exec('BEGIN IMMEDIATE');
      try {
        database!.raw.prepare(`
          INSERT INTO sales_cycles (
            id, person_id, prospect_id, entry_source_event_id, stage, workflow_status,
            current_next_action_id, stage_entered_at, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'won', 'onboarding', ?, ?, 1, ?, ?)
        `).run(
          cycleId, prospect.personId, prospect.prospectId, prospect.sourceEventId,
          actionId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP,
        );
        database!.raw.prepare(`
          INSERT INTO next_actions (
            id, sales_cycle_id, action_type, channel, status, due_at, timezone,
            work_intent, created_at, updated_at
          ) VALUES (?, ?, 'onboard_customer', 'text', 'pending', ?,
            'America/New_York', 'promised_follow_up', ?, ?)
        `).run(actionId, cycleId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
        database!.raw.prepare(`
          INSERT INTO won_terms (
            sales_cycle_id, doors_committed, billing_model, unit_rate_cents,
            projected_mrr_cents, projection_formula_version, manual_projection_reason,
            founding_customer, effective_at, created_at
          ) VALUES (?, 12, 'per_door_monthly', 2500, 30000, 'v1', NULL, 1, ?, ?)
        `).run(cycleId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
        database!.raw.exec('COMMIT');
      } catch (error) {
        if (database!.raw.inTransaction) database!.raw.exec('ROLLBACK');
        throw error;
      }
    };
    insertWonOnboarding('won-opt-out-cycle', 'won-opt-out-action', optedOutProspect);
    insertWonOnboarding('won-manual-cycle', 'won-manual-action', manualCloseProspect);

    const clock = { now: () => DOMAIN_TIMESTAMP };
    let nextId = 0;
    const ids = { next: () => `unexpected-${nextId += 1}` };
    const identities = new IdentityRepository({ database, unitOfWork, clock, ids });
    const events = new EventRepository({ database, unitOfWork, clock, ids });
    const sources = new SourceRepository({ database, unitOfWork, clock });
    const cadences = new CadenceRepository({ database, unitOfWork, clock });
    unitOfWork.immediate(() => cadences.installBuiltins());
    const service = new LifecycleService({
      database, unitOfWork, identities, events, sources, cadences, clock, ids,
      timezone: 'America/New_York', policies: FOUNDER_CHANNEL_POLICIES_V1,
    });
    unitOfWork.immediate(() => events.appendActivity({
      id: 'won-opt-out-evidence', personId: optedOutProspect.personId,
      prospectId: optedOutProspect.prospectId, salesCycleId: 'won-opt-out-cycle',
      kind: 'text', direction: 'inbound', channel: 'text', occurredAt: DOMAIN_TIMESTAMP,
      observedOutcome: 'opted_out', metadata: {},
    }));

    const result = unitOfWork.immediate(() => service.scopedWriter().closeForOptOut({
      personId: optedOutProspect.personId, evidenceActivityId: 'won-opt-out-evidence',
      effectiveAt: DOMAIN_TIMESTAMP, terminalStageEventId: null,
    }));
    expect(result.cycle).toMatchObject({
      stage: 'won', workflowStatus: 'closed', currentNextActionId: null,
      closeReason: null, onboardingStopReason: 'opt_out', version: 2,
    });
    expect(result.cancelledActionIds).toEqual(['won-opt-out-action']);
    expect(events.listCycleStageEvents('won-opt-out-cycle')).toEqual([]);

    expect(() => service.closeLostNurture({
      cycleId: 'won-manual-cycle', expectedCycleVersion: 1,
      expectedCurrentActionId: 'won-manual-action', reason: 'bad_timing', qualificationGateReason: null, notes: null,
      effectiveAt: DOMAIN_TIMESTAMP, manualReactivationDueAt: '2026-10-01T13:00:00.000Z',
      expectedProspectVersion: null,
    })).toThrow();
    expect(database.raw.prepare(`
      SELECT stage, workflow_status, current_next_action_id
      FROM sales_cycles WHERE id = 'won-manual-cycle'
    `).get()).toEqual({
      stage: 'won', workflow_status: 'onboarding', current_next_action_id: 'won-manual-action',
    });
  });

  it('validates no-cycle opt-out evidence and cancels every Person-owned outbound action stably', async () => {
    workspace = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: workspace.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${workspace.path}.backups`, workspaceKey: key,
    });
    unitOfWork = new DomainUnitOfWork(database);
    const prospect = seedProspect(database.raw, 'person-wide-opt-out');
    const historicalCycleId = insertClosedCycle({
      database: database.raw, prefix: 'person-wide-history', prospect,
    });
    const open = insertOpenCycleWithAction({
      database: database.raw, prefix: 'person-wide-open', prospect, stage: 'ready',
    });
    database.raw.prepare(`
      INSERT INTO next_actions (
        id, sales_cycle_id, action_type, channel, status, due_at, timezone,
        work_intent, created_at, updated_at
      ) VALUES ('a-supplemental-outbound', ?, 'send_follow_up', 'text', 'pending', ?,
        'America/New_York', 'promised_follow_up', ?, ?)
    `).run(historicalCycleId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
    const noCycleProspect = seedProspect(database.raw, 'no-cycle-opt-out');
    const clock = { now: () => DOMAIN_TIMESTAMP };
    const ids = { next: () => 'unused-id' };
    const identities = new IdentityRepository({ database, unitOfWork, clock, ids });
    const events = new EventRepository({ database, unitOfWork, clock, ids });
    const sources = new SourceRepository({ database, unitOfWork, clock });
    const cadences = new CadenceRepository({ database, unitOfWork, clock });
    unitOfWork.immediate(() => cadences.installBuiltins());
    const service = new LifecycleService({
      database, unitOfWork, identities, events, sources, cadences, clock, ids,
      timezone: 'America/New_York', policies: FOUNDER_CHANNEL_POLICIES_V1,
    });
    unitOfWork.immediate(() => {
      events.appendActivity({
        id: 'historical-opt-out-evidence', personId: prospect.personId,
        prospectId: prospect.prospectId, salesCycleId: historicalCycleId,
        kind: 'text', direction: 'inbound', channel: 'text', occurredAt: DOMAIN_TIMESTAMP,
        observedOutcome: 'opted_out', metadata: {},
      });
      events.appendActivity({
        id: 'invalid-no-cycle-evidence', personId: noCycleProspect.personId,
        prospectId: noCycleProspect.prospectId, kind: 'text', direction: 'inbound',
        channel: 'text', occurredAt: DOMAIN_TIMESTAMP, observedOutcome: 'received', metadata: {},
      });
      events.appendActivity({
        id: 'valid-no-cycle-evidence', personId: noCycleProspect.personId,
        prospectId: noCycleProspect.prospectId, kind: 'text', direction: 'inbound',
        channel: 'text', occurredAt: DOMAIN_TIMESTAMP, observedOutcome: 'opted_out', metadata: {},
      });
    });

    expect(() => unitOfWork.immediate(() => service.scopedWriter().closeForOptOut({
      personId: noCycleProspect.personId, evidenceActivityId: 'invalid-no-cycle-evidence',
      effectiveAt: DOMAIN_TIMESTAMP, terminalStageEventId: null,
    }))).toThrow();
    expect(() => unitOfWork.immediate(() => service.scopedWriter().closeForOptOut({
      personId: noCycleProspect.personId, evidenceActivityId: 'valid-no-cycle-evidence',
      effectiveAt: DOMAIN_TIMESTAMP, terminalStageEventId: 'forbidden-terminal-id',
    }))).toThrow();
    expect(unitOfWork.immediate(() => service.scopedWriter().closeForOptOut({
      personId: noCycleProspect.personId, evidenceActivityId: 'valid-no-cycle-evidence',
      effectiveAt: DOMAIN_TIMESTAMP, terminalStageEventId: null,
    }))).toEqual({ cycle: null, stoppedEnrollmentIds: [], cancelledActionIds: [] });

    const result = unitOfWork.immediate(() => service.scopedWriter().closeForOptOut({
      personId: prospect.personId, evidenceActivityId: 'historical-opt-out-evidence',
      effectiveAt: DOMAIN_TIMESTAMP, terminalStageEventId: 'person-wide-terminal',
    }));
    expect(result.cycle).toMatchObject({
      stage: 'lost_nurture', workflowStatus: 'closed', closeReason: 'opt_out',
    });
    expect(result.cancelledActionIds).toEqual(['a-supplemental-outbound', open.actionId]);
    expect(database.raw.prepare(`
      SELECT id, status, completion_activity_id FROM next_actions
      WHERE id IN ('a-supplemental-outbound', ?)
      ORDER BY id
    `).all(open.actionId)).toEqual([
      {
        id: 'a-supplemental-outbound', status: 'cancelled',
        completion_activity_id: 'historical-opt-out-evidence',
      },
      { id: open.actionId, status: 'cancelled', completion_activity_id: null },
    ]);
  });
});

function expectOwnedLifecycleAuditClean(database: AppDatabase, cycleId: string): void {
  const ownedIds = new Set<string>([cycleId]);
  for (const { id } of database.raw.prepare(`
    SELECT id FROM next_actions WHERE sales_cycle_id = ?
    UNION ALL SELECT id FROM cadence_enrollments WHERE sales_cycle_id = ?
    UNION ALL SELECT id FROM lifecycle_review_items WHERE source_cycle_id = ?
  `).all(cycleId, cycleId, cycleId) as Array<{ id: string }>) ownedIds.add(id);
  expect(auditDomainInvariants({ database, asOf: DOMAIN_TIMESTAMP })
    .filter(({ recordId }) => ownedIds.has(recordId))).toEqual([]);
}
