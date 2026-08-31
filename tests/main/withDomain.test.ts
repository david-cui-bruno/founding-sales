import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fakeStartupReport } from '../fixtures/fakeDomainRuntime';
import {
  closeDatabase,
  openDatabase,
  type AppDatabase,
} from '../../src/main/db/database';
import { migrateToLatest } from '../../src/main/db/migrate';
import { createDomainServices } from '../../src/main/domain/createDomainServices';
import { FounderSalesDomain } from '../../src/main/domain/founderSalesDomain';
import {
  BUILTIN_PRIORITIZATION_RULE_V1,
} from '../../src/main/domain/prioritization/builtinPrioritizationRules';
import {
  DomainRuntimeBlockedError,
} from '../../src/main/domain/startup/domainStartupTypes';
import { SystemClock } from '../../src/main/domain/support/clock';
import { UuidGenerator } from '../../src/main/domain/support/idGenerator';
import { FoundationRuntime } from '../../src/main/foundation/foundationRuntime';
import type { AppHealth } from '../../src/shared/healthContract';
import {
  createTempDatabase,
  createTestWorkspaceKey,
  type TempDatabase,
} from '../fixtures/tempDatabase';

const health = {
  appVersion: '1.0.0',
  schemaVersion: 2,
  databasePath: '/tmp/withdomain/callie.sqlite3',
  databaseEncrypted: true,
  cipherVersion: 'SQLite3 Multiple Ciphers',
  fts5Available: true,
  pendingJobs: 0,
  interruptedJobsRecovered: 0,
  domainStatus: 'ready',
  domainReady: true,
  domainBlockingViolationCount: 0,
  domainRepairableIssueCount: 0,
  domainProjectionRefreshCandidateCount: 0,
  pendingProjectionRebuilds: 0,
  domainStartupEvaluatedAt: '2026-08-30T12:00:00.000Z',
} satisfies AppHealth;

describe('FoundationRuntime.withDomain', () => {
  let temp: TempDatabase;
  let openedDatabase: AppDatabase | undefined;
  let runtime: FoundationRuntime;

  beforeEach(() => {
    temp = createTempDatabase();
    const key = createTestWorkspaceKey();
    runtime = new FoundationRuntime(
      {
        appVersion: '1.0.0',
        backupDirectory: `${temp.path}.backups`,
        databasePath: temp.path,
        databaseExists: false,
        keyEnvelopePath: `${temp.path}.key-envelope.json`,
      },
      {
        loadWorkspaceKey: async () => ({
          bytes: Buffer.from(key.bytes), version: 1,
        }),
        prepareEncryptedDatabase: async () => undefined,
        openDatabase: (options) => {
          openedDatabase = openDatabase(options);
          return openedDatabase;
        },
        migrateToLatest: (database, options) => migrateToLatest(database, options),
        createDomainRuntime: (database) => {
          const services = createDomainServices({
            database, clock: new SystemClock(), ids: new UuidGenerator(),
          });
          services.unitOfWork.immediate(() => {
            const installed = services.prioritizationRepository
              .installRuleVersion(BUILTIN_PRIORITIZATION_RULE_V1);
            services.prioritizationRepository.activateRuleVersion({
              ruleVersionId: installed.id, expectedActiveRuleVersionId: null,
            });
          });
          const report = fakeStartupReport();
          return {
            initialize: () => report,
            getDiagnostics: () => report,
            getServices: () => services,
            shutdown: () => undefined,
          };
        },
        createHealthService: () => ({ getHealth: () => health }),
        closeDatabase: (database) => closeDatabase(database),
      },
    );
  });

  afterEach(async () => {
    await runtime.shutdown();
    temp.cleanup();
  });

  it('initializes lazily and runs the operation against a real facade', async () => {
    const page = await runtime.withDomain((domain) => {
      expect(domain).toBeInstanceOf(FounderSalesDomain);
      return domain.listLeadRows({
        query: '', stages: [], priorities: [], sort: 'priority', cursor: null, limit: 10,
      });
    });
    expect(page.rows).toEqual([]);
    expect(page.total).toBe(0);
  });

  it('memoizes exactly one facade instance across calls', async () => {
    const first = await runtime.withDomain((domain) => domain);
    const second = await runtime.withDomain((domain) => domain);
    expect(second).toBe(first);
  });

  it('rejects operations after shutdown instead of resurrecting the domain', async () => {
    await runtime.withDomain((domain) => domain);
    await runtime.shutdown();
    await expect(runtime.withDomain((domain) => domain)).rejects.toThrow();
  });

  it('propagates the typed blocked error without constructing a facade', async () => {
    const blockedTemp = createTempDatabase();
    const key = createTestWorkspaceKey();
    let blockedDatabase: AppDatabase | undefined;
    const blockedRuntime = new FoundationRuntime(
      {
        appVersion: '1.0.0',
        backupDirectory: `${blockedTemp.path}.backups`,
        databasePath: blockedTemp.path,
        databaseExists: false,
        keyEnvelopePath: `${blockedTemp.path}.key-envelope.json`,
      },
      {
        loadWorkspaceKey: async () => ({ bytes: Buffer.from(key.bytes), version: 1 }),
        prepareEncryptedDatabase: async () => undefined,
        openDatabase: (options) => {
          blockedDatabase = openDatabase(options);
          return blockedDatabase;
        },
        migrateToLatest: (database, options) => migrateToLatest(database, options),
        createDomainRuntime: () => {
          const report = fakeStartupReport({ status: 'blocked' });
          return {
            initialize: () => report,
            getDiagnostics: () => report,
            getServices: () => {
              throw new DomainRuntimeBlockedError();
            },
            shutdown: () => undefined,
          };
        },
        createHealthService: () => ({ getHealth: () => health }),
        closeDatabase: (database) => closeDatabase(database),
      },
    );
    try {
      await expect(blockedRuntime.withDomain((domain) => domain))
        .rejects.toBeInstanceOf(DomainRuntimeBlockedError);
    } finally {
      await blockedRuntime.shutdown();
      blockedTemp.cleanup();
    }
  });
});
