import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, openDatabase, type AppDatabase } from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { DomainUnitOfWork } from '../../src/main/domain/support/domainUnitOfWork';
import { CadenceRepository } from '../../src/main/domain/cadence/cadenceRepository';
import { EventRepository } from '../../src/main/domain/events/eventRepository';
import { IdentityRepository } from '../../src/main/domain/identity/identityRepository';
import { LifecycleService } from '../../src/main/domain/lifecycle/lifecycleService';
import { OptOutService } from '../../src/main/domain/optOut/optOutService';
import {
  OutboundPermissionService,
} from '../../src/main/domain/optOut/outboundPermissionService';
import {
  PrioritizationRepository,
} from '../../src/main/domain/prioritization/prioritizationRepository';
import {
  PrioritizationService,
} from '../../src/main/domain/prioritization/prioritizationService';
import { SourceService } from '../../src/main/domain/source/sourceService';
import { TodayRepository } from '../../src/main/domain/today/todayRepository';
import { TodayService } from '../../src/main/domain/today/todayService';
import {
  WorkspaceSettingsRepository,
} from '../../src/main/domain/workspace/workspaceSettingsRepository';
import { JobRepository } from '../../src/main/jobs/jobRepository';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

describe('createDomainServices', () => {
  let database: AppDatabase;
  let temp: TempDatabase;

  beforeEach(async () => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    database = openDatabase({ path: temp.path, key });
    await migrateToLatest(database, {
      backupDirectory: `${temp.path}.backups`, workspaceKey: key,
    });
  });

  afterEach(() => {
    closeDatabase(database);
    temp.cleanup();
  });

  function build() {
    let clockReads = 0;
    let idReads = 0;
    const clock = {
      now: () => {
        clockReads += 1;
        return '2026-08-30T12:00:00.000Z';
      },
    };
    const ids = {
      next: () => {
        idReads += 1;
        return `id-${idReads}`;
      },
    };
    const services = createDomainServices({ database, clock, ids });
    return { services, clockReads: () => clockReads, idReads: () => idReads };
  }

  it('constructs the exact final Task 9-12 graph with one shared UoW instance', () => {
    const { services } = build();
    expect(services.unitOfWork).toBeInstanceOf(DomainUnitOfWork);
    expect(services.jobs).toBeInstanceOf(JobRepository);
    expect(services.identities).toBeInstanceOf(IdentityRepository);
    expect(services.events).toBeInstanceOf(EventRepository);
    expect(services.sources).toBeInstanceOf(SourceService);
    expect(services.cadences).toBeInstanceOf(CadenceRepository);
    expect(services.lifecycle).toBeInstanceOf(LifecycleService);
    expect(services.optOut).toBeInstanceOf(OptOutService);
    expect(services.outboundPermission).toBeInstanceOf(OutboundPermissionService);
    expect(services.prioritizationRepository).toBeInstanceOf(PrioritizationRepository);
    expect(services.prioritization).toBeInstanceOf(PrioritizationService);
    expect(services.todayRepository).toBeInstanceOf(TodayRepository);
    expect(services.today).toBeInstanceOf(TodayService);
    expect(services.workspaceSettings).toBeInstanceOf(WorkspaceSettingsRepository);
    expect(Object.isFrozen(services)).toBe(true);

    // Every binding assertion succeeds against the one shared UoW.
    for (const bound of [
      services.identities, services.events, services.sourceRepository,
      services.intakeReceipts, services.cadences, services.lifecycle,
      services.outboundPermission, services.prioritizationRepository,
      services.todayRepository, services.workspaceSettings,
    ]) {
      expect(() => bound.assertBoundTo(database, services.unitOfWork)).not.toThrow();
    }
    // A substitute UoW is rejected everywhere.
    const otherUnit = new DomainUnitOfWork(database);
    expect(() => services.identities.assertBoundTo(database, otherUnit)).toThrow();
    expect(() => services.prioritizationRepository.assertBoundTo(database, otherUnit)).toThrow();
    expect(() => services.todayRepository.assertBoundTo(database, otherUnit)).toThrow();
  });

  it('is construction-only: no query, mutation, transaction, clock, or ID access', () => {
    const changesBefore = database.raw.prepare('SELECT total_changes() AS c').get() as { c: number };
    const { clockReads, idReads } = build();
    const changesAfter = database.raw.prepare('SELECT total_changes() AS c').get() as { c: number };
    expect(changesAfter.c).toBe(changesBefore.c);
    expect(clockReads()).toBe(0);
    expect(idReads()).toBe(0);
    expect(database.raw.inTransaction).toBe(false);
  });

  it('workspace settings read the canonical singleton and reject corruption', () => {
    const { services } = build();
    const settings = services.workspaceSettings.read();
    expect(settings).toMatchObject({
      timezone: 'America/New_York',
      dailyDialCapacity: 40,
      dailyConversationTarget: 5,
      explorationSlots: 2,
      activePrioritizationRuleVersionId: null,
    });
    database.raw.prepare("UPDATE workspace_settings SET timezone = 'Nowhere/Invalid'").run();
    expect(() => services.workspaceSettings.read()).toThrow();
  });
});
