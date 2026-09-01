import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import {
  createDomainServices,
  type DomainServices,
} from '../../src/main/domain/createDomainServices';
import {
  createFounderSalesDomain,
  FounderSalesDomain,
} from '../../src/main/domain/founderSalesDomain';
import {
  BUILTIN_PRIORITIZATION_RULE_V1,
} from '../../src/main/domain/prioritization/builtinPrioritizationRules';
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

  set(value: string): void {
    this.value = value;
  }
}

class SequentialIds {
  private counter = 0;

  next(): string {
    this.counter += 1;
    return `generated-${this.counter}`;
  }
}

describe('FounderSalesDomain', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let services: DomainServices;
  let clock: FixedClock;
  let domain: FounderSalesDomain;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`, workspaceKey: key,
    });
    clock = new FixedClock();
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
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  function seedLead(prefix: string, stage: 'unreviewed' | 'ready' = 'unreviewed'): {
    prospect: SeededProspect;
    cycleId: string;
    actionId: string;
  } {
    const prospect = seedProspect(database.raw, prefix);
    const { cycleId, actionId } = insertOpenCycleWithAction({
      database: database.raw, prefix, prospect, stage,
    });
    return { prospect, cycleId, actionId };
  }

  const listAll = () => domain.listLeadRows({
    query: '', stages: [], priorities: [], sort: 'priority', cursor: null, limit: 50,
  });

  describe('leads', () => {
    it('lists seeded people with strict rows and no blended score', () => {
      seedLead('alpha');
      seedLead('beta');
      const page = listAll();
      expect(page.total).toBe(2);
      expect(page.rows.map((row) => row.personName)).toHaveLength(2);
      for (const row of page.rows) {
        expect(row.initials.length).toBeGreaterThan(0);
        expect(Object.keys(row)).not.toContain('score');
        if (row.priorityContext !== null) {
          expect(row.priorityContext.fitPoints).toBeLessThanOrEqual(30);
          expect(row.priorityContext.timingValue).toBeLessThanOrEqual(40);
        }
      }
    });

    it('filters by query and paginates with a stable cursor', () => {
      seedLead('alpha');
      seedLead('beta');
      const filtered = domain.listLeadRows({
        query: 'alpha', stages: [], priorities: [], sort: 'priority', cursor: null, limit: 50,
      });
      expect(filtered.total).toBe(1);
      const first = domain.listLeadRows({
        query: '', stages: [], priorities: [], sort: 'priority', cursor: null, limit: 1,
      });
      expect(first.rows).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();
      const second = domain.listLeadRows({
        query: '', stages: [], priorities: [], sort: 'priority',
        cursor: first.nextCursor, limit: 1,
      });
      expect(second.rows).toHaveLength(1);
      expect(second.rows[0]!.personId).not.toBe(first.rows[0]!.personId);
    });

    it('updates a person name through the field update command', () => {
      const { prospect } = seedLead('alpha');
      const receipt = domain.updateLeadField({
        personId: prospect.personId, field: 'person_name', value: 'Renamed Person',
      });
      expect(receipt.affectedPersonIds).toEqual([prospect.personId]);
      const page = listAll();
      expect(page.rows.some((row) => row.personName === 'Renamed Person')).toBe(true);
    });

    it('bulk-updates the same field across people', () => {
      const first = seedLead('alpha');
      const second = seedLead('beta');
      const receipt = domain.bulkUpdateLeads({
        personIds: [first.prospect.personId, second.prospect.personId],
        field: 'person_name',
        value: 'Same Name',
      });
      expect(receipt.affectedPersonIds).toHaveLength(2);
      const page = listAll();
      expect(page.rows.filter((row) => row.personName === 'Same Name')).toHaveLength(2);
    });

    it('returns a strict lead detail for a seeded person', () => {
      const { prospect, cycleId } = seedLead('alpha');
      const detail = domain.getLeadDetail({ personId: prospect.personId });
      expect(detail.personId).toBe(prospect.personId);
      expect(detail.salesCycleId).toBe(cycleId);
      expect(detail.stage).toBe('unreviewed');
      expect(detail.optedOut).toBe(false);
      expect(detail.revision).toBeGreaterThanOrEqual(0);
    });
  });

  describe('lifecycle transitions', () => {
    it('confirms review_to_ready and reflects the new stage', () => {
      const prospect = seedProspect(database.raw, 'alpha');
      database.raw.prepare(`
        UPDATE prospects SET qualification_state = 'unreviewed' WHERE id = ?
      `).run(prospect.prospectId);
      const cycle = services.lifecycle.createUnreviewedCycle({
        personId: prospect.personId, prospectId: prospect.prospectId,
        entrySourceEventId: prospect.sourceEventId, effectiveAt: DOMAIN_TIMESTAMP,
      });
      const receipt = domain.confirmTransition({
        transition: 'review_to_ready', salesCycleId: cycle.id, expectedRevision: 0,
      });
      expect(receipt.affectedSalesCycleIds).toEqual([cycle.id]);
      const detail = domain.getLeadDetail({ personId: prospect.personId });
      expect(detail.stage).toBe('ready');
    });

    it('completes the primary action through the lifecycle service', () => {
      const prospect = seedProspect(database.raw, 'alpha');
      database.raw.prepare(`
        UPDATE prospects SET qualification_state = 'unreviewed' WHERE id = ?
      `).run(prospect.prospectId);
      const cycle = services.lifecycle.createUnreviewedCycle({
        personId: prospect.personId, prospectId: prospect.prospectId,
        entrySourceEventId: prospect.sourceEventId, effectiveAt: DOMAIN_TIMESTAMP,
      });
      domain.confirmTransition({
        transition: 'review_to_ready', salesCycleId: cycle.id, expectedRevision: 0,
      });
      const current = database.raw.prepare(`
        SELECT current_next_action_id AS action_id FROM sales_cycles WHERE id = ?
      `).get(cycle.id) as { action_id: string };
      const receipt = domain.completePrimaryAction({
        salesCycleId: cycle.id,
        actionId: current.action_id,
        outcome: 'accepted',
        activityId: null,
      });
      expect(receipt.affectedSalesCycleIds).toEqual([cycle.id]);
      const after = database.raw.prepare(`
        SELECT status FROM next_actions WHERE id = ?
      `).get(current.action_id) as { status: string };
      expect(after.status).toBe('completed');
      const next = database.raw.prepare(`
        SELECT current_next_action_id AS action_id FROM sales_cycles WHERE id = ?
      `).get(cycle.id) as { action_id: string };
      expect(next.action_id).not.toBe(current.action_id);
    });
  });

  describe('today', () => {
    it('maps every internal lane to its contract id and never duplicates a cycle', () => {
      // Reviewed (ready) so the overdue promise stays in the Overdue lane;
      // unreviewed backlog is summarized separately.
      const active = seedLead('alpha', 'ready');
      const backlog = seedLead('beta');
      const onboarding = seedProspect(database.raw, 'gamma');
      database.raw.exec('BEGIN IMMEDIATE');
      try {
        database.raw.prepare(`
          INSERT INTO sales_cycles (
            id, person_id, prospect_id, entry_source_event_id, stage,
            workflow_status, current_next_action_id, stage_entered_at,
            version, created_at, updated_at
          ) VALUES ('gamma-cycle', ?, ?, ?, 'won', 'onboarding', 'gamma-action', ?, 1, ?, ?)
        `).run(
          onboarding.personId, onboarding.prospectId, onboarding.sourceEventId,
          DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP,
        );
        database.raw.prepare(`
          INSERT INTO next_actions (
            id, sales_cycle_id, action_type, channel, status, due_at,
            timezone, work_intent, created_at
          ) VALUES ('gamma-action', 'gamma-cycle', 'onboard_client', NULL, 'pending', ?,
                    'America/New_York', 'promised_follow_up', ?)
        `).run(DOMAIN_TIMESTAMP, DOMAIN_TIMESTAMP);
        database.raw.exec('COMMIT');
      } catch (error) {
        if (database.raw.inTransaction) database.raw.exec('ROLLBACK');
        throw error;
      }
      const snapshot = domain.getToday();
      expect(snapshot.lanes.map((lane) => lane.id)).toEqual([
        'onboarding', 'fresh_inbound', 'overdue', 'post_interview_offer',
        'due_cadence', 'new_p0', 'p1', 'exploration', 'later',
      ]);
      const itemsByLane = new Map(snapshot.lanes.map((lane) => [lane.id, lane.items]));
      expect(itemsByLane.get('onboarding')!.map((item) => item.salesCycleId))
        .toEqual(['gamma-cycle']);
      // The default seeded promise is past due, so it lands in Overdue.
      expect(itemsByLane.get('overdue')!.map((item) => item.salesCycleId))
        .toEqual([active.cycleId]);
      // The unreviewed overdue cycle is only a backlog count, never a row.
      expect(snapshot.unreviewedBacklogCount).toBe(1);
      const allIds = snapshot.lanes.flatMap((lane) => lane.items.map((item) => item.salesCycleId));
      expect(allIds).not.toContain(backlog.cycleId);
      expect(new Set(allIds).size).toBe(allIds.length);
    });

    it('returns a strict snapshot with dial capacity from settings', () => {
      seedLead('alpha');
      const snapshot = domain.getToday();
      expect(snapshot.dialBudget).toBeGreaterThan(0);
      expect(snapshot.lanes.length).toBeGreaterThan(0);
      const laneIds = snapshot.lanes.map((lane) => lane.id);
      expect(new Set(laneIds).size).toBe(laneIds.length);
    });

    it('logs an internal note as a plain activity', () => {
      const { prospect, cycleId } = seedLead('alpha');
      const receipt = domain.logPastActivity({
        personId: prospect.personId,
        salesCycleId: cycleId,
        kind: 'note',
        direction: 'internal',
        occurredAt: DOMAIN_TIMESTAMP,
        summary: 'Spoke at the RIREIG meetup.',
        outcome: null,
      });
      expect(receipt.affectedPersonIds).toEqual([prospect.personId]);
      const detail = domain.getLeadDetail({ personId: prospect.personId });
      expect(detail.activities.some(
        (activity) => activity.summary.includes('RIREIG'),
      )).toBe(true);
    });
  });

  describe('pipeline and review', () => {
    it('returns all seven fixed stages in order including empty ones', () => {
      seedLead('alpha');
      const snapshot = domain.getPipelineProjection();
      expect(snapshot.stages.map((stage) => stage.stage)).toEqual([
        'unreviewed', 'ready', 'contacted', 'interviewed', 'offered', 'won', 'lost_nurture',
      ]);
      expect(snapshot.stages[0]!.cards).toHaveLength(1);
      expect(snapshot.stages[5]!.cards).toEqual([]);
    });

    it('projects stages without renderer-forbidden fields', () => {
      seedLead('alpha');
      const snapshot = domain.getPipelineProjection();
      const stages = snapshot.stages.map((stage) => stage.stage);
      expect(stages).toContain('unreviewed');
      const serialized = JSON.stringify(snapshot);
      expect(serialized).not.toMatch(/normalized_value|key_envelope/);
    });

    it('lists review items as an empty strict snapshot when none exist', () => {
      const snapshot = domain.listReviewItems({ kinds: [], limit: 50 });
      expect(snapshot.items).toEqual([]);
    });
  });

  describe('friday report and founder jobs', () => {
    it('returns the strict shape with zero metrics on an empty database', () => {
      const report = domain.getFridayReport();
      expect(report.jobs).toEqual([]);
      expect(report.sourceRows).toEqual([]);
      expect(report.periodStartsAt < report.periodEndsAt).toBe(true);
      const byId = new Map(report.metrics.map((metric) => [metric.id, metric]));
      expect(byId.get('interviews')!.numericValue).toBe(0);
      expect(byId.get('wins')!.numericValue).toBe(0);
      expect(byId.get('fill_rate')!.displayValue).toBe('—');
      expect(byId.get('fill_rate')!.numericValue).toBeNull();
      expect(byId.get('offer_rate')!.displayValue).toBe('—');
    });

    it('reports metrics and manages the founder job lifecycle', () => {
      const report = domain.getFridayReport();
      expect(report.metrics.length).toBeGreaterThan(0);
      const metricIds = report.metrics.map((metric) => metric.id);
      expect(metricIds).toContain('jobs_requested');
      expect(metricIds).toContain('fill_rate');

      domain.createJobRequest({
        jobId: 'job-1', salesCycleId: null, requestedAt: CLOCK_NOW,
      });
      let jobs = domain.getFridayReport().jobs;
      expect(jobs.some((job) => job.id === 'job-1' && job.status === 'requested')).toBe(true);

      domain.markJobFilled({ jobId: 'job-1', contractorAcceptedAt: CLOCK_NOW });
      jobs = domain.getFridayReport().jobs;
      expect(jobs.some((job) => job.id === 'job-1' && job.status === 'filled')).toBe(true);

      domain.createJobRequest({
        jobId: 'job-2', salesCycleId: null, requestedAt: CLOCK_NOW,
      });
      domain.cancelJobRequest({ jobId: 'job-2' });
      jobs = domain.getFridayReport().jobs;
      expect(jobs.some((job) => job.id === 'job-2' && job.status === 'cancelled')).toBe(true);
    });

    it('drills into a metric without leaking internals', () => {
      const drilldown = domain.getMetricDrilldown({ metricId: 'interviews' });
      expect(drilldown.metricId).toBe('interviews');
      expect(Array.isArray(drilldown.rows)).toBe(true);
    });
  });

  describe('csv import', () => {
    const CSV = 'Name,Phone,Company\nPat Owner,4015550100,Oak Realty\nSam Owner,4015550101,Elm Estates\n';

    it('previews, remaps, commits, and reports the import job', () => {
      const preview = domain.previewLeadImport({ kind: 'csv', sourceName: 'leads.csv', content: CSV });
      expect(preview.rowCount).toBe(2);
      expect(preview.columns).toEqual(['Name', 'Phone', 'Company']);
      expect(preview.contentHash).toMatch(/^[a-f0-9]{64}$/);

      const remapped = domain.remapLeadImport({
        previewId: preview.previewId,
        contentHash: preview.contentHash,
        mapping: { Name: 'person_name', Phone: 'phone', Company: 'organization' },
      });
      expect(remapped.validCount).toBe(2);

      const receipt = domain.commitLeadImport({
        previewId: preview.previewId,
        contentHash: preview.contentHash,
        mapping: { Name: 'person_name', Phone: 'phone', Company: 'organization' },
        source: { channel: 'custom', referredByPersonId: null },
        duplicateDecisions: [],
      });
      expect(receipt.importedRowCount).toBe(2);
      expect(receipt.importedPersonIds).toHaveLength(2);

      const status = domain.getImportJob({ jobId: receipt.jobId });
      expect(status.state).toBe('succeeded');

      const page = listAll();
      expect(page.rows.some((row) => row.personName === 'Pat Owner')).toBe(true);
    });

    it('rejects a commit whose content hash does not match the preview', () => {
      const preview = domain.previewLeadImport({ kind: 'csv', sourceName: 'leads.csv', content: CSV });
      expect(() => domain.commitLeadImport({
        previewId: preview.previewId,
        contentHash: 'a'.repeat(64),
        mapping: { Name: 'person_name' },
        source: { channel: 'custom', referredByPersonId: null },
        duplicateDecisions: [],
      })).toThrow(/expired or changed/);
    });

    it('does not duplicate people when the same content is imported again', () => {
      const mapping = { Name: 'person_name', Phone: 'phone', Company: 'organization' } as const;
      const commit = () => {
        const preview = domain.previewLeadImport({
          kind: 'csv', sourceName: 'leads.csv', content: CSV,
        });
        return domain.commitLeadImport({
          previewId: preview.previewId,
          contentHash: preview.contentHash,
          mapping,
          source: { channel: 'custom', referredByPersonId: null },
          duplicateDecisions: [],
        });
      };
      const first = commit();
      const second = commit();
      expect(second.jobId).toBe(first.jobId);
      const persons = database.raw.prepare(
        'SELECT COUNT(*) AS count FROM persons',
      ).get() as { count: number };
      expect(persons.count).toBe(2);
      const cycles = database.raw.prepare(
        'SELECT COUNT(*) AS count FROM sales_cycles',
      ).get() as { count: number };
      expect(cycles.count).toBe(2);
    });
  });
});
