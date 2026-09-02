import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  closeDatabase,
  openDatabase,
  type AppDatabase,
} from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import {
  createDomainServices,
  type DomainServices,
} from '../../src/main/domain/createDomainServices';
import {
  createFounderSalesDomain,
  type FounderSalesDomain,
} from '../../src/main/domain/founderSalesDomain';
import {
  BUILTIN_PRIORITIZATION_RULE_V1,
} from '../../src/main/domain/prioritization/builtinPrioritizationRules';
import {
  createLeadDetailService,
  type LeadDetailProvider,
} from '../../src/main/leads/leadDetailService';
import { leadDetailSchema } from '../../src/shared/contracts/leadDetailContract';
import {
  DOMAIN_TIMESTAMP,
  insertOpenCycleWithAction,
  seedProspect,
  type SeededProspect,
} from '../fixtures/domainRows';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

const CLOCK_NOW = '2026-08-31T15:00:00.000Z';

class FixedClock {
  constructor(private value: string = CLOCK_NOW) {}

  now(): string {
    return this.value;
  }
}

class SequentialIds {
  private counter = 0;

  next(): string {
    this.counter += 1;
    return `generated-${this.counter}`;
  }
}

describe('leadDetailService over a real encrypted domain', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let services: DomainServices;
  let domain: FounderSalesDomain;
  let leadDetail: LeadDetailProvider;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`, workspaceKey: key,
    });
    const clock = new FixedClock();
    const ids = new SequentialIds();
    services = createDomainServices({ database, clock, ids });
    services.unitOfWork.immediate(() => {
      const installed = services.prioritizationRepository
        .installRuleVersion(BUILTIN_PRIORITIZATION_RULE_V1);
      services.prioritizationRepository.activateRuleVersion({
        ruleVersionId: installed.id, expectedActiveRuleVersionId: null,
      });
      services.cadences.installBuiltins();
    });
    domain = createFounderSalesDomain({ services, database, clock, ids });
    leadDetail = createLeadDetailService(domain);
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  function seedLead(prefix: string): {
    prospect: SeededProspect;
    cycleId: string;
    actionId: string;
  } {
    const prospect = seedProspect(database.raw, prefix);
    const { cycleId, actionId } = insertOpenCycleWithAction({
      database: database.raw, prefix, prospect,
    });
    return { prospect, cycleId, actionId };
  }

  function addPhone(prospect: SeededProspect, id: string): void {
    database.raw.prepare(`
      INSERT INTO person_contact_methods (
        id, person_id, kind, normalized_value, validation_state, reachability,
        is_primary, created_at, updated_at
      ) VALUES (?, ?, 'phone', '+14015550100', 'valid', 'direct', 1, ?, ?)
    `).run(id, prospect.personId, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
  }

  it('returns the strict detail DTO for a seeded lead', async () => {
    const { prospect, cycleId } = seedLead('alpha');
    addPhone(prospect, 'alpha-phone');

    const detail = await leadDetail.get({ personId: prospect.personId });

    expect(() => leadDetailSchema.parse(detail)).not.toThrow();
    expect(detail.personId).toBe(prospect.personId);
    expect(detail.salesCycleId).toBe(cycleId);
    expect(detail.personName).toBe(`Person ${prospect.personId}`);
    expect(detail.stage).toBe('ready');
    expect(detail.workflowStatus).toBe('active');
    expect(detail.optedOut).toBe(false);
    expect(detail.phones).toHaveLength(1);
    expect(detail.phones[0]).toEqual({
      id: 'alpha-phone',
      kind: 'phone',
      value: '+14015550100',
      label: null,
      valid: true,
      dncListed: false,
      tcpaFlag: false,
    });
    expect(detail.emails).toEqual([]);
    expect(detail.nextAction).not.toBeNull();
    expect(detail.revision).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(detail)).not.toMatch(/leadScore|blended|combined/);
  });

  it('rejects an unknown person', async () => {
    await expect(
      leadDetail.get({ personId: 'missing-person' }),
    ).rejects.toThrow();
  });

  it('begins an outbound call and logs the activity in the detail', async () => {
    const { prospect, cycleId } = seedLead('alpha');
    addPhone(prospect, 'alpha-phone');

    const receipt = await leadDetail.beginOutbound({
      channel: 'call',
      personId: prospect.personId,
      salesCycleId: cycleId,
      contactMethodId: 'alpha-phone',
    });

    expect(receipt.affectedPersonIds).toEqual([prospect.personId]);
    expect(receipt.affectedSalesCycleIds).toEqual([cycleId]);

    const detail = await leadDetail.get({ personId: prospect.personId });
    expect(detail.activities.some((activity) => activity.kind === 'call')).toBe(
      true,
    );
  });

  it('refuses outbound to an opted-out person', async () => {
    const { prospect, cycleId } = seedLead('alpha');
    addPhone(prospect, 'alpha-phone');
    services.optOut.apply({
      personId: prospect.personId,
      tombstoneId: 'alpha-tombstone',
      requestedAt: CLOCK_NOW,
      policyVersion: 'founder_opt_out_v1',
      decision: { kind: 'structured_written', channel: 'imessage' },
      evidence: {
        kind: 'append_activity',
        activity: {
          id: 'alpha-opt-out-activity',
          personId: prospect.personId,
          kind: 'text',
          direction: 'inbound',
          channel: 'imessage',
          occurredAt: CLOCK_NOW,
          observedOutcome: 'opted_out',
          adapter: 'messages',
          providerIdempotencyKey: 'alpha-provider',
          metadata: { structuredOptOut: true },
        },
      },
      terminalStageEventId: 'alpha-terminal-event',
    });

    await expect(
      leadDetail.beginOutbound({
        channel: 'call',
        personId: prospect.personId,
        salesCycleId: cycleId,
        contactMethodId: 'alpha-phone',
      }),
    ).rejects.toThrow();

    const detail = await leadDetail.get({ personId: prospect.personId });
    expect(detail.optedOut).toBe(true);
  });

  it('confirms review_to_ready through the guarded transition', async () => {
    const prospect = seedProspect(database.raw, 'alpha');
    database.raw.prepare(`
      UPDATE prospects SET qualification_state = 'unreviewed' WHERE id = ?
    `).run(prospect.prospectId);
    const cycle = services.lifecycle.createUnreviewedCycle({
      personId: prospect.personId,
      prospectId: prospect.prospectId,
      entrySourceEventId: prospect.sourceEventId,
      effectiveAt: DOMAIN_TIMESTAMP,
    });

    const receipt = await leadDetail.confirmTransition({
      transition: 'review_to_ready',
      salesCycleId: cycle.id,
      expectedRevision: 0,
    });

    expect(receipt.affectedSalesCycleIds).toEqual([cycle.id]);
    const detail = await leadDetail.get({ personId: prospect.personId });
    expect(detail.stage).toBe('ready');
    expect(detail.history.length).toBeGreaterThan(0);
  });

  it('dismisses an unreviewed lead through the disqualification path', async () => {
    const prospect = seedProspect(database.raw, 'alpha');
    database.raw.prepare(`
      UPDATE prospects SET qualification_state = 'unreviewed' WHERE id = ?
    `).run(prospect.prospectId);
    const cycle = services.lifecycle.createUnreviewedCycle({
      personId: prospect.personId,
      prospectId: prospect.prospectId,
      entrySourceEventId: prospect.sourceEventId,
      effectiveAt: DOMAIN_TIMESTAMP,
    });

    const receipt = await leadDetail.dismissLead({
      salesCycleId: cycle.id,
      personId: prospect.personId,
      qualificationGateReason: 'out_of_area',
      expectedRevision: 0,
    });

    expect(receipt.affectedPersonIds).toEqual([prospect.personId]);
    expect(receipt.affectedSalesCycleIds).toEqual([cycle.id]);
    // The prospect is disqualified with the exact gate reason.
    expect(database.raw.prepare(`
      SELECT qualification_state, qualification_gate_reason
      FROM prospects WHERE id = ?
    `).get(prospect.prospectId)).toEqual({
      qualification_state: 'disqualified',
      qualification_gate_reason: 'out_of_area',
    });
    // The cycle closes into Lost-Nurture and leaves the actionable list.
    expect(database.raw.prepare(`
      SELECT stage, workflow_status, current_next_action_id, close_reason
      FROM sales_cycles WHERE id = ?
    `).get(cycle.id)).toEqual({
      stage: 'lost_nurture',
      workflow_status: 'closed',
      current_next_action_id: null,
      close_reason: 'disqualified',
    });
  });

  it('rejects a dismissal whose person does not own the cycle', async () => {
    const prospect = seedProspect(database.raw, 'alpha');
    database.raw.prepare(`
      UPDATE prospects SET qualification_state = 'unreviewed' WHERE id = ?
    `).run(prospect.prospectId);
    const cycle = services.lifecycle.createUnreviewedCycle({
      personId: prospect.personId,
      prospectId: prospect.prospectId,
      entrySourceEventId: prospect.sourceEventId,
      effectiveAt: DOMAIN_TIMESTAMP,
    });

    await expect(
      leadDetail.dismissLead({
        salesCycleId: cycle.id,
        personId: 'someone-else',
        qualificationGateReason: 'out_of_area',
        expectedRevision: 0,
      }),
    ).rejects.toThrow();
    expect(database.raw.prepare(
      'SELECT qualification_state FROM prospects WHERE id = ?',
    ).get(prospect.prospectId)).toEqual({ qualification_state: 'unreviewed' });
  });
});
