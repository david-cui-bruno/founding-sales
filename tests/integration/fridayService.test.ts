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
  createFridayService,
  type FridayProvider,
} from '../../src/main/friday/fridayService';
import {
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

describe('fridayService over a real encrypted domain', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let services: DomainServices;
  let domain: FounderSalesDomain;
  let friday: FridayProvider;

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
    friday = createFridayService(domain);
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  function seedLead(prefix: string): { prospect: SeededProspect; cycleId: string } {
    const prospect = seedProspect(database.raw, prefix);
    const { cycleId } = insertOpenCycleWithAction({
      database: database.raw, prefix, prospect,
    });
    return { prospect, cycleId };
  }

  function insertStageEvent(input: {
    id: string;
    cycleId: string;
    toStage: string;
    effectiveAt: string;
    sequence: number;
  }): void {
    database.raw.prepare(`
      INSERT INTO stage_events (
        id, sales_cycle_id, from_stage, to_stage, effective_at, confirmed_at,
        confirmation_kind, transition_sequence, backfill_provenance_json,
        created_at
      ) VALUES (?, ?, NULL, ?, ?, ?, 'founder', ?, NULL, ?)
    `).run(
      input.id, input.cycleId, input.toStage, input.effectiveAt,
      input.effectiveAt, input.sequence, input.effectiveAt,
    );
  }

  const metricById = (report: { metrics: { id: string }[] }, id: string) => {
    const found = report.metrics.find((candidate) => candidate.id === id);
    if (found === undefined) throw new Error(`metric ${id} missing`);
    return found as {
      id: string; displayValue: string; numericValue: number | null;
      numerator: number | null; denominator: number | null; drilldownCount: number;
    };
  };

  it('reports current-week bounds and all thirteen approved metrics', async () => {
    const report = await friday.getCurrent();

    expect(report.asOf).toBe(CLOCK_NOW);
    expect(report.periodStartsAt).toBe('2026-08-31T04:00:00.000Z');
    expect(report.periodEndsAt).toBe('2026-09-05T04:00:00.000Z');
    expect(report.metrics.map((metric) => metric.id)).toEqual([
      'interviews', 'offers', 'wins', 'offer_rate', 'win_rate',
      'jobs_requested', 'jobs_filled', 'fill_rate', 'new_mrr',
      'founding_customers', 'design_partner_fitness', 'overdue_actions',
      'invalid_action_cycles',
    ]);
  });

  it('renders an em dash for zero-denominator rates instead of dividing', async () => {
    const report = await friday.getCurrent();

    const fillRate = metricById(report, 'fill_rate');
    expect(fillRate.displayValue).toBe('—');
    expect(fillRate.numericValue).toBeNull();
    expect(fillRate.numerator).toBe(0);
    expect(fillRate.denominator).toBe(0);
  });

  it('counts in-window stage events into funnel metrics and source rows', async () => {
    const { cycleId } = seedLead('alpha');
    insertStageEvent({
      id: 'stage-1', cycleId, toStage: 'interviewed',
      effectiveAt: CLOCK_NOW, sequence: 1,
    });
    insertStageEvent({
      id: 'stage-2', cycleId, toStage: 'offered',
      effectiveAt: CLOCK_NOW, sequence: 2,
    });

    const report = await friday.getCurrent();

    expect(metricById(report, 'interviews').numericValue).toBe(1);
    expect(metricById(report, 'offers').numericValue).toBe(1);
    const offerRate = metricById(report, 'offer_rate');
    expect(offerRate.displayValue).toBe('100%');
    expect(offerRate.numerator).toBe(1);
    expect(offerRate.denominator).toBe(1);
    expect(report.sourceRows).toEqual([
      { source: 'custom', interviews: 1, offers: 1, wins: 0 },
    ]);
  });

  it('walks a job through requested, filled, and cancelled with exact fill evidence', async () => {
    await friday.createJob({
      jobId: 'job-1', salesCycleId: null, requestedAt: CLOCK_NOW,
    });
    await friday.createJob({
      jobId: 'job-2', salesCycleId: null, requestedAt: CLOCK_NOW,
    });
    await friday.createJob({
      jobId: 'job-3', salesCycleId: null, requestedAt: CLOCK_NOW,
    });

    let report = await friday.getCurrent();
    expect(report.jobs.map((job) => [job.id, job.status])).toEqual([
      ['job-1', 'requested'], ['job-2', 'requested'], ['job-3', 'requested'],
    ]);
    expect(metricById(report, 'jobs_requested').numericValue).toBe(3);

    await friday.fillJob({
      jobId: 'job-1', contractorAcceptedAt: CLOCK_NOW,
    });
    await friday.cancelJob({ jobId: 'job-3' });

    report = await friday.getCurrent();
    const jobsById = new Map(report.jobs.map((job) => [job.id, job]));
    expect(jobsById.get('job-1')?.status).toBe('filled');
    expect(jobsById.get('job-1')?.contractorAcceptedAt).toBe(CLOCK_NOW);
    expect(jobsById.get('job-2')?.status).toBe('requested');
    expect(jobsById.get('job-3')?.status).toBe('cancelled');

    const fillRate = metricById(report, 'fill_rate');
    expect(metricById(report, 'jobs_requested').numericValue).toBe(2);
    expect(metricById(report, 'jobs_filled').numericValue).toBe(1);
    expect(fillRate.numerator).toBe(1);
    expect(fillRate.denominator).toBe(2);
    expect(fillRate.displayValue).toBe('50%');
  });

  it('fills idempotently and keeps the first acceptance timestamp', async () => {
    await friday.createJob({
      jobId: 'job-1', salesCycleId: null, requestedAt: CLOCK_NOW,
    });
    await friday.fillJob({
      jobId: 'job-1', contractorAcceptedAt: CLOCK_NOW,
    });
    await friday.fillJob({
      jobId: 'job-1', contractorAcceptedAt: '2026-08-31T18:00:00.000Z',
    });

    const report = await friday.getCurrent();
    const job = report.jobs.find((candidate) => candidate.id === 'job-1');
    expect(job?.status).toBe('filled');
    expect(job?.contractorAcceptedAt).toBe(CLOCK_NOW);
    expect(metricById(report, 'jobs_filled').numericValue).toBe(1);
  });

  it('creates a job against a Won cycle and rejects a missing cycle', async () => {
    const { cycleId } = seedLead('alpha');

    const receipt = await friday.createJob({
      jobId: 'job-1', salesCycleId: cycleId, requestedAt: CLOCK_NOW,
    });
    expect(receipt.affectedSalesCycleIds).toEqual([cycleId]);

    await expect(friday.createJob({
      jobId: 'job-2', salesCycleId: 'missing-cycle', requestedAt: CLOCK_NOW,
    })).rejects.toThrow();
  });

  it('returns drilldown provenance rows that reference the seeded person', async () => {
    const { prospect, cycleId } = seedLead('alpha');
    insertStageEvent({
      id: 'stage-1', cycleId, toStage: 'interviewed',
      effectiveAt: CLOCK_NOW, sequence: 1,
    });

    const drilldown = await friday.getDrilldown({ metricId: 'interviews' });

    expect(drilldown.metricId).toBe('interviews');
    expect(drilldown.rows).toHaveLength(1);
    expect(drilldown.rows[0]).toMatchObject({
      personId: prospect.personId,
      salesCycleId: cycleId,
      occurredAt: CLOCK_NOW,
    });
  });
});
