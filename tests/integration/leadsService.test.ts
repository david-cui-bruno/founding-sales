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
  createLeadsService,
  type LeadsProvider,
} from '../../src/main/leads/leadsService';
import {
  insertOpenCycleWithAction,
  insertPerson,
  insertProspect,
  insertSourceEvent,
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

describe('leadsService over a real encrypted domain', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let services: DomainServices;
  let domain: FounderSalesDomain;
  let leads: LeadsProvider;
  let ruleVersionId: string;

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
      ruleVersionId = installed.id;
      services.prioritizationRepository.activateRuleVersion({
        ruleVersionId: installed.id, expectedActiveRuleVersionId: null,
      });
      services.cadences.installBuiltins();
    });
    domain = createFounderSalesDomain({ services, database, clock, ids });
    leads = createLeadsService(domain);
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  function seedLead(prefix: string): SeededProspect {
    const prospect = seedProspect(database.raw, prefix);
    insertOpenCycleWithAction({ database: database.raw, prefix, prospect });
    return prospect;
  }

  const listAll = (overrides: Partial<Parameters<LeadsProvider['list']>[0]> = {}) =>
    leads.list({
      query: '', stages: [], priorities: [], sort: 'person_name',
      cursor: null, limit: 50, ...overrides,
    });

  it('lists seeded people as strict lead rows', async () => {
    seedLead('alpha');
    seedLead('beta');

    const page = await listAll();

    expect(page.total).toBe(2);
    expect(page.rows.map((row) => row.personName)).toEqual([
      'Person alpha-person',
      'Person beta-person',
    ]);
    for (const row of page.rows) {
      expect(row.initials.length).toBeGreaterThan(0);
      expect(Object.keys(row)).not.toContain('score');
    }
  });

  it('paginates with a stable cursor and no repeated people', async () => {
    seedLead('alpha');
    seedLead('beta');
    seedLead('gamma');

    const first = await listAll({ limit: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await listAll({ limit: 2, cursor: first.nextCursor });
    expect(second.rows).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    const seen = [...first.rows, ...second.rows].map((row) => row.personId);
    expect(new Set(seen).size).toBe(3);
  });

  it('filters by query text', async () => {
    seedLead('alpha');
    seedLead('beta');

    const page = await listAll({ query: 'alpha' });

    expect(page.total).toBe(1);
    expect(page.rows[0]?.personName).toBe('Person alpha-person');
  });

  it('updates an allowed field and reflects it in the next list read', async () => {
    const prospect = seedLead('alpha');
    const before = await listAll();

    const receipt = await leads.updateField({
      personId: prospect.personId, field: 'person_name', value: 'Renamed Person',
    });

    expect(receipt.affectedPersonIds).toEqual([prospect.personId]);
    expect(receipt.revision).toBeGreaterThan(before.revision);
    const after = await listAll();
    expect(after.rows[0]?.personName).toBe('Renamed Person');
    expect(after.revision).toBeGreaterThan(before.revision);
  });

  it('assigns one person without renaming a shared organization', () => {
    const alice = seedLead('alice');
    const bob = seedLead('bob');
    services.unitOfWork.immediate(() => {
      const shared = services.identities.createOrganization({ canonicalName: 'Shared Org' });
      services.identities.addOrganizationAlias({ organizationId: shared.id, alias: 'shared org' });
      services.identities.linkOrganization({ prospectId: alice.prospectId, organizationId: shared.id });
      services.identities.linkOrganization({ prospectId: bob.prospectId, organizationId: shared.id });
    });
    const receipt = domain.updateLeadField({
      personId: alice.personId, field: 'organization_label', value: 'New Employer',
    });
    const page = domain.listLeadRows({
      query: '', stages: [], priorities: [], sort: 'person_name', cursor: null, limit: 200,
    });
    expect(page.rows.find((row) => row.personId === alice.personId)?.organization).toBe('New Employer');
    expect(page.rows.find((row) => row.personId === bob.personId)?.organization).toBe('Shared Org');
    expect(receipt.affectedPersonIds).toEqual([alice.personId]);
    expect(receipt.affectedSalesCycleIds).toEqual(['alice-cycle']);
  });

  it('bulk-updates the organization label for many people', async () => {
    const alpha = seedLead('alpha');
    const beta = seedLead('beta');

    const receipt = await leads.bulkUpdate({
      personIds: [alpha.personId, beta.personId],
      field: 'organization_label',
      value: 'Shared Holdings',
    });

    expect(receipt.affectedPersonIds.sort()).toEqual(
      [alpha.personId, beta.personId].sort(),
    );
    const page = await listAll();
    expect(page.rows.map((row) => row.organization)).toEqual([
      'Shared Holdings',
      'Shared Holdings',
    ]);
  });

  it('rejects an update for an unknown person without corrupting reads', async () => {
    seedLead('alpha');

    await expect(
      leads.updateField({
        personId: 'missing-person', field: 'person_name', value: 'Nope',
      }),
    ).rejects.toThrow(/does not exist/);
    const page = await listAll();
    expect(page.total).toBe(1);
  });

  /** Sets the prospect's cloud axes exactly as the sourcing sync would. */
  function setCloudScores(
    prospectId: string,
    fit: number | null,
    timing: number | null,
  ): void {
    database.raw.prepare(
      'UPDATE prospects SET cloud_fit = ?, cloud_timing = ? WHERE id = ?',
    ).run(fit, timing, prospectId);
  }

  /**
   * Installs a local priority projection through a faithful evaluation copy
   * (the fidelity trigger demands both rows agree on every axis).
   */
  function insertPriorityProjection(
    prospect: SeededProspect,
    priority: 'p1' | 'p2' | 'p3',
  ): void {
    const evaluationId = `${prospect.prospectId}-evaluation`;
    database.raw.prepare(`
      INSERT INTO prioritization_evaluations (
        id, prospect_id, rule_version_id, decision_kind, evaluated_at,
        fit_points, fit_band, timing_millipoints, timing_band, reachability,
        data_confidence, priority, earliest_trigger_expires_at, verify_first,
        last_contact_activity_id, last_contact_at, qualification_json,
        command_json, input_snapshot_json, result_json, explanation_json,
        created_at
      ) VALUES (?, ?, ?, 'evaluated', ?, 25, 'high', 30000, 'hot', 'indirect',
                8, ?, NULL, 0, NULL, NULL, NULL, '{}', '{}', '{}', '[]', ?)
    `).run(
      evaluationId, prospect.prospectId, ruleVersionId,
      CLOCK_NOW, priority, CLOCK_NOW,
    );
    database.raw.prepare(`
      INSERT INTO prospect_priority_projection (
        prospect_id, rule_version_id, evaluation_id, decision_kind, fit_points,
        fit_band, timing_millipoints, timing_band, reachability,
        data_confidence, priority, earliest_trigger_expires_at, verify_first,
        last_contact_activity_id, last_contact_at, version, evaluated_at,
        updated_at
      ) VALUES (?, ?, ?, 'evaluated', 25, 'high', 30000, 'hot', 'indirect', 8,
                ?, NULL, 0, NULL, NULL, 1, ?, ?)
    `).run(
      prospect.prospectId, ruleVersionId, evaluationId,
      priority, CLOCK_NOW, CLOCK_NOW,
    );
  }

  it('ranks cloud-scored leads above unscored within the same priority band', async () => {
    // Insertion (and cycle.id) order is the reverse of the expected output so
    // an accidental id-order pass cannot slip through.
    const cloudNull = seedLead('alpha');
    const cloudZero = seedLead('beta');
    const cloudHigh = seedLead('gamma');
    for (const lead of [cloudNull, cloudZero, cloudHigh]) {
      insertPriorityProjection(lead, 'p1');
    }
    setCloudScores(cloudZero.prospectId, 0, 0);
    setCloudScores(cloudHigh.prospectId, 71, 40);

    const page = await listAll({ sort: 'priority' });

    expect(page.rows.map((row) => row.personId)).toEqual([
      cloudHigh.personId,
      cloudZero.personId,
      cloudNull.personId,
    ]);
  });

  it('never lets cloud scores outrank the local priority band', async () => {
    const higherBand = seedLead('alpha');
    const scoredLowerBand = seedLead('beta');
    insertPriorityProjection(higherBand, 'p1');
    insertPriorityProjection(scoredLowerBand, 'p2');
    setCloudScores(scoredLowerBand.prospectId, 100, 100);

    const page = await listAll({ sort: 'priority' });

    expect(page.rows.map((row) => row.personId)).toEqual([
      higherBand.personId,
      scoredLowerBand.personId,
    ]);
  });

  /** Seeds a lead whose original SourceEvent uses a public-record channel. */
  function seedChannelLead(
    prefix: string,
    channel: 'parcel' | 'violation',
  ): SeededProspect {
    const personId = `${prefix}-person`;
    const prospectId = `${prefix}-prospect`;
    const sourceEventId = `${prefix}-source`;
    insertPerson(database.raw, personId);
    insertSourceEvent({ database: database.raw, id: sourceEventId, personId, channel });
    insertProspect({ database: database.raw, id: prospectId, personId, sourceEventId });
    insertOpenCycleWithAction({
      database: database.raw, prefix, prospect: { personId, prospectId, sourceEventId },
    });
    return { personId, prospectId, sourceEventId };
  }

  describe('within-source percentile ordering (F10)', () => {
    it('interleaves sources whose raw cloud scores are systematically offset', async () => {
      // Violation leads score systematically higher raw fit than parcel
      // leads, yet the grid must interleave them: raw axes from different
      // observable signal subsets are not comparable across sources.
      const violationTop = seedChannelLead('v-top', 'violation');
      const violationMid = seedChannelLead('v-mid', 'violation');
      const violationLow = seedChannelLead('v-low', 'violation');
      const parcelTop = seedChannelLead('p-top', 'parcel');
      const parcelLow = seedChannelLead('p-low', 'parcel');
      const unscored = seedChannelLead('p-none', 'parcel');
      setCloudScores(violationTop.prospectId, 95, 5);
      setCloudScores(violationMid.prospectId, 85, 5);
      setCloudScores(violationLow.prospectId, 75, 5);
      setCloudScores(parcelTop.prospectId, 63, 5);
      setCloudScores(parcelLow.prospectId, 40, 5);

      const page = await listAll({ sort: 'priority' });
      const ordered = page.rows.map((row) => row.personId);

      // Before the fix the raw cloud_fit sort would put all three violation
      // leads first. With within-source percentiles both sources reach the
      // top: both source tops share percentile 100.
      const topThree = ordered.slice(0, 3);
      expect(topThree).toContain(violationTop.personId);
      expect(topThree).toContain(parcelTop.personId);

      // Within-source relative order is preserved.
      const positionOf = (personId: string) => ordered.indexOf(personId);
      expect(positionOf(violationTop.personId))
        .toBeLessThan(positionOf(violationMid.personId));
      expect(positionOf(violationMid.personId))
        .toBeLessThan(positionOf(violationLow.personId));
      expect(positionOf(parcelTop.personId))
        .toBeLessThan(positionOf(parcelLow.personId));

      // Unscored still sorts last.
      expect(ordered.at(-1)).toBe(unscored.personId);
    });

    it('keeps showing the raw cloud fit and timing, never the percentile', async () => {
      const lead = seedChannelLead('raw', 'violation');
      setCloudScores(lead.prospectId, 63, 41);

      const page = await listAll({ sort: 'priority' });
      const row = page.rows.find((entry) => entry.personId === lead.personId)!;

      expect(row.cloudScores).toEqual({ fit: 63, timing: 41 });
      expect(JSON.stringify(row)).not.toContain('ercentile');
    });
  });
});
