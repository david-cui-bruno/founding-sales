import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscoveryService } from '../../src/main/domain/discovery/discoveryService';
import { DiscoveryFactWriter } from '../../src/main/domain/discovery/discoveryFactWriter';
import { DiscoveryReadService } from '../../src/main/domain/discovery/discoveryReadService';
import { SourceRepository } from '../../src/main/domain/source/sourceRepository';

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
    vi.restoreAllMocks();
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

  it('rejects substituted discovery bindings before any query, clock or ID access but accepts equivalent Pick containers', () => {
    const { services } = build();
    const clock = { now: () => { throw new Error('clock read during binding'); } };
    const ids = { next: () => { throw new Error('ID during binding'); } };
    const dependencies = { identities: services.identities, sourceRepository: services.sourceRepository,
      events: services.events, outboundPermission: services.outboundPermission,
      prioritizationRepository: services.prioritizationRepository, prioritization: services.prioritization,
      workspaceSettings: services.workspaceSettings };
    const factWriter = new DiscoveryFactWriter({ database, unitOfWork: services.unitOfWork, services: { ...dependencies } });
    const replacement = new SourceRepository({ database, unitOfWork: services.unitOfWork, clock });
    const alienWriter = new DiscoveryFactWriter({ database, unitOfWork: services.unitOfWork,
      services: { ...dependencies, sourceRepository: replacement } });
    const mutableReadServices = { ...services };
    const reader = new DiscoveryReadService({ database, unitOfWork: services.unitOfWork, clock, services: mutableReadServices });
    const alienReader = new DiscoveryReadService({ database, unitOfWork: services.unitOfWork, clock,
      services: { ...services, sourceRepository: replacement } });
    const mutableFactServices = { ...dependencies };
    const capturedWriter = new DiscoveryFactWriter({ database, unitOfWork: services.unitOfWork, services: mutableFactServices });
    mutableReadServices.sourceRepository = replacement;
    mutableFactServices.sourceRepository = replacement;
    const input = { database, unitOfWork: services.unitOfWork, clock, ids, factWriter,
      services: { ...dependencies, lifecycle: services.lifecycle, discoveryRepository: services.discoveryRepository,
        discoveryRead: services.discoveryRead } };
    const changes = database.raw.prepare('SELECT total_changes() AS n').get();
    const reads = vi.spyOn(database.raw, 'prepare').mockImplementation(() => { throw new Error('query during binding'); });
    expect(() => new DiscoveryService(input)).not.toThrow();
    expect(() => new DiscoveryService({ ...input, factWriter: capturedWriter,
      services: { ...input.services, discoveryRead: reader } })).not.toThrow();
    expect(() => new DiscoveryService({ ...input, database: { ...database } })).toThrow(/bound|database/i);
    expect(() => new DiscoveryService({ ...input, unitOfWork: new DomainUnitOfWork(database) })).toThrow(/bound|database/i);
    expect(() => new DiscoveryService({ ...input, factWriter: alienWriter })).toThrow(/bound|database/i);
    expect(() => new DiscoveryService({ ...input, services: { ...input.services, discoveryRead: alienReader } })).toThrow(/bound|database/i);
    expect(() => new DiscoveryService({ ...input, services: { ...input.services, sourceRepository: replacement } })).toThrow(/bound|database/i);
    expect(reads).not.toHaveBeenCalled();
    reads.mockRestore();
    expect(database.raw.prepare('SELECT total_changes() AS n').get()).toEqual(changes);
  });
});
