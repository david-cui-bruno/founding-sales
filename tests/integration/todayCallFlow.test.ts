import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { createDomainServices, type DomainServices } from '../../src/main/domain/createDomainServices';
import { createFounderSalesDomain, FounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import { BUILTIN_PRIORITIZATION_RULE_V1 } from '../../src/main/domain/prioritization/builtinPrioritizationRules';
import { DOMAIN_TIMESTAMP, insertOpenCycleWithAction, seedProspect } from '../fixtures/domainRows';
import { createTempDatabase, createTestWorkspaceKey, type TempDatabase } from '../fixtures/tempDatabase';

const NOW = '2026-08-31T15:00:00.000Z';

describe('today call flow (audit 4.7)', () => {
  let database: AppDatabase;
  let temp: TempDatabase;
  let services: DomainServices;
  let domain: FounderSalesDomain;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, { backupDirectory: `${temp.path}.backups`, workspaceKey: key });
    const clock = { now: () => NOW };
    let n = 0;
    const ids = { next: () => `gen-${++n}` };
    services = createDomainServices({ database, clock, ids });
    services.unitOfWork.immediate(() => {
      const installed = services.prioritizationRepository.installRuleVersion(BUILTIN_PRIORITIZATION_RULE_V1);
      services.prioritizationRepository.activateRuleVersion({ ruleVersionId: installed.id, expectedActiveRuleVersionId: null });
      services.cadences.installBuiltins();
    });
    domain = createFounderSalesDomain({ services, database, clock, ids });
  });

  afterEach(() => { closeDatabase(database); temp.cleanup(); });

  it('keeps independent post-stage work due when a call books a future callback', () => {
    const prospect = seedProspect(database.raw, 'post-stage');
    const cycle = insertOpenCycleWithAction({ database: database.raw, prospect, prefix: 'post-stage', stage: 'interviewed' });
    domain.logCallOutcome({ personId: prospect.personId, salesCycleId: cycle.cycleId,
      outcome: 'spoke', callbackAt: '2026-09-15T12:00:00.000Z', occurredAt: NOW });
    expect(database.raw.prepare('SELECT due_at FROM next_actions WHERE id = ?').get(cycle.actionId))
      .toEqual({ due_at: DOMAIN_TIMESTAMP });
    expect(domain.getToday().lanes.flatMap(lane => lane.items).map(item => item.salesCycleId)).toContain(cycle.cycleId);
  });

  it('replied lands in Fresh inbound; a callback outcome removes the cycle until its date', () => {
    const prospect = seedProspect(database.raw, 'alpha');
    database.raw.prepare(`UPDATE prospects SET qualification_state = 'unreviewed' WHERE id = ?`).run(prospect.prospectId);
    const cycle = services.lifecycle.createUnreviewedCycle({
      personId: prospect.personId, prospectId: prospect.prospectId,
      entrySourceEventId: prospect.sourceEventId, effectiveAt: NOW,
    });
    domain.confirmTransition({ transition: 'review_to_ready', salesCycleId: cycle.id, expectedRevision: 0 });
    const current = database.raw.prepare('SELECT current_next_action_id AS id FROM sales_cycles WHERE id = ?').get(cycle.id) as { id: string };
    domain.completePrimaryAction({ salesCycleId: cycle.id, actionId: current.id, outcome: 'replied', activityId: null });
    let snapshot = domain.getToday();
    const lanes = snapshot.lanes.filter((lane) => lane.items.some((i) => i.salesCycleId === cycle.id)).map((l) => l.id);
    expect(lanes).toEqual(['fresh_inbound']);
    // Now log a call outcome with a callback: the cycle leaves Today.
    domain.logCallOutcome({
      personId: prospect.personId, salesCycleId: cycle.id, outcome: 'spoke',
      callbackAt: '2026-09-15T12:00:00.000Z', occurredAt: NOW,
    });
    expect(database.raw.prepare(`SELECT a.due_at, a.due_source FROM sales_cycles c
      JOIN next_actions a ON a.id = c.current_next_action_id WHERE c.id = ?`).get(cycle.id))
      .toEqual({ due_at: '2026-09-15T12:00:00.000Z', due_source: 'recorded_callback' });
    snapshot = domain.getToday();
    const lanesAfter = snapshot.lanes.filter((lane) => lane.items.some((i) => i.salesCycleId === cycle.id)).map((l) => l.id);
    expect(lanesAfter).toEqual([]);
    expect(snapshot.conversationsHeld).toBe(1);
  });
});
