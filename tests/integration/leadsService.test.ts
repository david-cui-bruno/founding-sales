import { productionDomainGate } from '../fixtures/productionDomainGate';
import { createLeadsProvider } from '../../src/main/ipc/registerApplicationIpc';
import type { LeadsProvider } from '../../src/main/leads/leadsService';
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
    leads = createLeadsProvider(productionDomainGate(domain));
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

  /** The same committed rename the removed field-update command performed. */
  function renamePerson(personId: string, displayName: string): void {
    database.raw.prepare('UPDATE persons SET display_name = ?, version = version + 1, updated_at = ? WHERE id = ?')
      .run(displayName, CLOCK_NOW, personId);
  }

  const listAll = (overrides: Partial<Parameters<LeadsProvider['list']>[0]> = {}) =>
    leads.list({
      query: '', stages: [], priorities: [], sort: 'person_name',
      cursor: null, limit: 50, ...overrides,
    });

  type ReliabilityLeadsRequest = Parameters<LeadsProvider['list']>[0];

  function seedReliabilityLeads(withFilters = false, count = 208) {
    return Array.from({ length: count }, (_, index) => {
      const prefix = `reliability-${String(index).padStart(4, '0')}`;
      const prospect = seedProspect(database.raw, prefix);
      insertOpenCycleWithAction({
        database: database.raw, prefix, prospect,
        stage: withFilters && index % 2 === 1 ? 'contacted' : 'ready',
      });
      if (withFilters) insertPriorityProjection(prospect, index % 2 === 0 ? 'p1' : 'p2');
      return prospect;
    });
  }

  async function walkReliabilityLeads(expectedIds: string[], overrides: Partial<ReliabilityLeadsRequest> = {}) {
    const seen: string[] = [];
    let cursor: string | null = null;
    const changes = database.raw.prepare('SELECT total_changes() AS count').get();
    for (let pageNumber = 0; pageNumber < 3; pageNumber += 1) {
      const page = await listAll({ ...overrides, cursor, limit: 200 });
      expect(page.total).toBe(expectedIds.length);
      seen.push(...page.rows.map(row => row.personId));
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
    expect(cursor).toBeNull(); // Bound the draft:208/209 fixtures never need more than2 pages.
    expect(seen).toHaveLength(expectedIds.length);
    expect(new Set(seen).size).toBe(expectedIds.length);
    expect([...seen].sort()).toEqual([...expectedIds].sort());
    expect(database.raw.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
    return seen;
  }

  describe('reliability: full-projection guarded Leads continuation', () => {
    it.each(['person_name', 'priority', 'last_contact'] as const)('reaches all208 rows and preserves query/stage/priority filters with %s sort', async sort => {
        const fixtures = seedReliabilityLeads(true);
        const allIds = fixtures.map(row => row.personId);
        const first = await listAll({ sort, limit: 200 });
        expect(first.rows).toHaveLength(200);
        expect(first.total).toBe(208);
        expect(first.nextCursor).not.toBeNull();
        const last = await listAll({ sort, limit: 200, cursor: first.nextCursor });
        expect(last.rows).toHaveLength(8);
        expect(last.nextCursor).toBeNull();
        await walkReliabilityLeads(allIds, { sort });
        const readyIds = fixtures.filter((_, index) => index % 2 === 0).map(row => row.personId);
        expect(readyIds).toHaveLength(104);
        await walkReliabilityLeads(readyIds, { sort, stages: ['ready'] });
        await walkReliabilityLeads(readyIds, { sort, priorities: ['P1'] });
        const queriedIds = fixtures.slice(0, 100).map(row => row.personId);
        await walkReliabilityLeads(queriedIds, { sort, query: 'reliability-00' });
        const intersectedIds = fixtures.slice(0, 100).filter((_, index) => index % 2 === 0).map(row => row.personId);
        expect(intersectedIds).toHaveLength(50);
        await walkReliabilityLeads(intersectedIds, { sort, query: 'reliability-00', stages: ['ready'], priorities: ['P1'] });
        await walkReliabilityLeads([], { sort, stages: ['offered'] });
      }, 30_000);

    it.each(['person_name', 'priority', 'last_contact'] as const)('rejects the old cursor when a %s ordering key moves an unseen row earlier', async sort => {
        const fixtures = seedReliabilityLeads();
        const target = fixtures[207]!;
        const first = await listAll({ sort, limit: 200 });
        expect(first.rows.some(row => row.personId === target.personId)).toBe(false);
        expect(first.nextCursor).not.toBeNull();
        if (sort === 'person_name') {
          renamePerson(target.personId, 'AAA moved earlier');
        } else if (sort === 'priority') {
          setCloudScores(target.prospectId, 100, 100);
        } else {
          database.raw.prepare('UPDATE prospects SET last_contact_at = ? WHERE id = ?')
            .run(CLOCK_NOW, target.prospectId);
        }
        await expect(listAll({ sort, limit: 200, cursor: first.nextCursor }))
          .rejects.toThrow('LIST_CURSOR_STALE');
        const fresh = await listAll({ sort, limit: 200 });
        expect(fresh.rows[0]?.personId).toBe(target.personId);
        await walkReliabilityLeads(fixtures.map(row => row.personId), { sort });
      }, 30_000);

    it('rejects a continuation when a matching person leaves the selected query', async () => {
      const fixtures = seedReliabilityLeads();
      const first = await listAll({ query: 'Person', limit: 200 });
      expect(first.nextCursor).not.toBeNull();
      const target = fixtures[207]!;
      renamePerson(target.personId, 'Outside selected text');
      await expect(listAll({ query: 'Person', limit: 200, cursor: first.nextCursor }))
        .rejects.toThrow('LIST_CURSOR_STALE');
      await walkReliabilityLeads(fixtures.slice(0, 207).map(row => row.personId), { query: 'Person' });
    }, 30_000);

    it('rejects a continuation after insertion before the loaded page boundary', async () => {
      const fixtures = seedReliabilityLeads();
      const first = await listAll({ sort: 'person_name', limit: 200 });
      const inserted = seedLead('aaa-earlier');
      await expect(listAll({ sort: 'person_name', limit: 200, cursor: first.nextCursor }))
        .rejects.toThrow('LIST_CURSOR_STALE');
      await walkReliabilityLeads([...fixtures.map(row => row.personId), inserted.personId], { sort: 'person_name' });
    }, 30_000);

    it('detects a committed external-connection edit without relying on local total_changes', async () => {
      const fixtures = seedReliabilityLeads();
      const first = await listAll({ sort: 'person_name', limit: 200 });
      expect(first.nextCursor).not.toBeNull();
      const localChanges = database.raw.prepare('SELECT total_changes() AS count').get();
      // createTestWorkspaceKey() is the same explicit fixed test key used by this suite's setup.
      const other = openDatabase({ path: temp.path, key: createTestWorkspaceKey() });
      try {
        other.raw.prepare('UPDATE persons SET display_name = ?, version = version + 1, updated_at = ? WHERE id = ?')
          .run('AAA external change', CLOCK_NOW, fixtures[207]!.personId);
        expect(other.raw.inTransaction).toBe(false); // .run completed its autocommit.
        expect(database.raw.prepare('SELECT total_changes() AS count').get()).toEqual(localChanges);
        await expect(listAll({ sort: 'person_name', limit: 200, cursor: first.nextCursor }))
          .rejects.toThrow('LIST_CURSOR_STALE');
        const fresh = await listAll({ sort: 'person_name', limit: 200 });
        expect(fresh.rows[0]?.personId).toBe(fixtures[207]!.personId);
        await walkReliabilityLeads(fixtures.map(row => row.personId), { sort: 'person_name' });
      } finally {
        closeDatabase(other);
      }
    }, 30_000);

    it.each(['1', '200junk', '-1', 'not-a-cursor', 'a'.repeat(1025)])('rejects malformed or legacy cursor %s without a read-side write', async cursor => {
        seedLead('one');
        seedLead('two');
        const changes = database.raw.prepare('SELECT total_changes() AS count').get();
        await expect(listAll({ cursor, limit: 1 })).rejects.toThrow('LIST_CURSOR_INVALID');
        expect(database.raw.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
      });

    it('rejects reuse under different query controls rather than treating cursor as an offset', async () => {
      seedLead('one');
      seedLead('two');
      const first = await listAll({ limit: 1 });
      expect(first.nextCursor).not.toBeNull();
      await expect(listAll({ limit: 1, cursor: first.nextCursor, query: 'one' }))
        .rejects.toThrow('LIST_CURSOR_INVALID');
      await expect(listAll({ limit: 1, cursor: first.nextCursor, sort: 'priority' }))
        .rejects.toThrow('LIST_CURSOR_INVALID');
      await expect(listAll({ limit: 2, cursor: first.nextCursor }))
        .rejects.toThrow('LIST_CURSOR_INVALID');
    });
  });

  // Explicit parent-only opt-in. No benchmark runs or skipped cases in ordinary regression commands.
  if (process.env.FSS_LIST_BENCHMARK === '1') {
    it.each([208, 2080])('benchmark: complete fictional Leads projection with %i records', async count => {
      const setupStart = performance.now();
      const fixtures = seedReliabilityLeads(true, count);
      fixtures.forEach((fixture, index) => setCloudScores(fixture.prospectId, index % 101, (index * 3) % 101));
      const setupMs = performance.now() - setupStart;
      const expectedIds = fixtures.map(row => row.personId).sort();
      const changes = database.raw.prepare('SELECT total_changes() AS count').get();
      const samples: { firstMs: number; continuationMs: number[]; walkMs: number }[] = [];
      for (let sample = 0; sample < 5; sample += 1) {
        const start = performance.now();
        const first = await listAll({ sort: 'priority', limit: 200 });
        const firstMs = performance.now() - start;
        const seen = first.rows.map(row => row.personId);
        const continuationMs: number[] = [];
        let cursor = first.nextCursor;
        for (let page = 1; cursor !== null && page < Math.ceil(count / 200); page += 1) {
          const pageStart = performance.now();
          const next = await listAll({ sort: 'priority', limit: 200, cursor });
          continuationMs.push(performance.now() - pageStart);
          expect(next.total).toBe(count);
          seen.push(...next.rows.map(row => row.personId));
          cursor = next.nextCursor;
        }
        const walkMs = performance.now() - start;
        expect(cursor).toBeNull();
        expect(seen.sort()).toEqual(expectedIds);
        expect(new Set(seen).size).toBe(count);
        expect(database.raw.prepare('SELECT total_changes() AS count').get()).toEqual(changes);
        samples.push({ firstMs, continuationMs, walkMs });
      }
      console.log(JSON.stringify({ benchmark: 'full-projection-leads', fictionalRecords: count, setupMs, samples }));
    }, 120_000);
  }

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
