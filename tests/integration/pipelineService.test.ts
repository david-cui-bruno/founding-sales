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
import { createPipelineService } from '../../src/main/pipeline/pipelineService';
import { pipelineSnapshotSchema } from '../../src/shared/contracts/pipelineContract';
import {
  insertClosedCycle,
  insertOpenCycleWithAction,
  seedProspect,
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

const FIXED_STAGE_ORDER = [
  'unreviewed', 'ready', 'contacted', 'interviewed', 'offered', 'won', 'lost_nurture',
];

describe('pipelineService', () => {
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

  function seedLead(
    prefix: string,
    stage?: 'unreviewed' | 'ready' | 'contacted' | 'interviewed' | 'offered',
  ): { personId: string; cycleId: string } {
    const prospect = seedProspect(database.raw, prefix);
    const { cycleId } = insertOpenCycleWithAction({
      database: database.raw, prefix, prospect, stage,
    });
    return { personId: prospect.personId, cycleId };
  }

  it('returns every approved stage in fixed order including empty stages', async () => {
    const service = createPipelineService(domain);

    const snapshot = await service.get();

    expect(snapshot.stages.map((lane) => lane.stage)).toEqual(FIXED_STAGE_ORDER);
    for (const lane of snapshot.stages) {
      expect(lane.cards).toEqual([]);
    }
    expect(() => pipelineSnapshotSchema.parse(snapshot)).not.toThrow();
  });

  it('projects seeded leads into their exact lifecycle columns', async () => {
    seedLead('alpha');
    seedLead('beta', 'contacted');
    seedLead('gamma', 'offered');
    const lost = seedProspect(database.raw, 'delta');
    insertClosedCycle({ database: database.raw, prefix: 'delta', prospect: lost });

    const service = createPipelineService(domain);
    const snapshot = await service.get();

    expect(snapshot.stages.map((lane) => lane.stage)).toEqual(FIXED_STAGE_ORDER);
    const byStage = new Map(snapshot.stages.map((lane) => [lane.stage, lane.cards]));
    expect(byStage.get('ready')?.map((card) => card.personId)).toEqual(['alpha-person']);
    expect(byStage.get('contacted')?.map((card) => card.personId)).toEqual(['beta-person']);
    expect(byStage.get('offered')?.map((card) => card.personId)).toEqual(['gamma-person']);
    expect(byStage.get('unreviewed')).toEqual([]);
    expect(byStage.get('interviewed')).toEqual([]);
    expect(byStage.get('won')).toEqual([]);

    const lostCards = byStage.get('lost_nurture');
    expect(lostCards?.map((card) => card.personId)).toEqual(['delta-person']);
    expect(lostCards?.[0]?.lostReasonCode).toBe('no_response');
    expect(lostCards?.[0]?.nextAction).toBeNull();
  });

  it('keeps the strict contract free of blended scores or internal fields', async () => {
    seedLead('alpha', 'contacted');

    const service = createPipelineService(domain);
    const snapshot = await service.get();

    const parsed = pipelineSnapshotSchema.parse(snapshot);
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toMatch(/score|normalized_value|key_envelope/);
    const card = parsed.stages.find((lane) => lane.stage === 'contacted')?.cards[0];
    expect(card?.personName).toBe('Person alpha-person');
    expect(card?.nextAction?.label).toBe('Follow up');
    expect(parsed.revision).toBeGreaterThanOrEqual(0);
  });
});
