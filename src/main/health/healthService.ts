import { appHealthSchema, type AppHealth } from '../../shared/healthContract';
import { checkFts5, type AppDatabase } from '../db/database';
import { inspectDatabaseEncryption } from '../db/databaseEncryption';
import type { DomainStartupReport } from '../domain/startup/domainStartupTypes';
import type { JobRepository } from '../jobs/jobRepository';
import type { SourcingPollHealth } from '../../shared/contracts/sourcingContract';

export type HealthServiceOptions = {
  appVersion: string;
  databasePath: string;
  database: AppDatabase;
  jobs: Pick<JobRepository, 'listActive'>;
  domainStartupReport: DomainStartupReport;
  sourcingHealth?: () => SourcingPollHealth;
};

/**
 * Health retains the immutable startup report; it never re-runs an audit or
 * scanner per request. Only safe status/count fields cross the boundary.
 */
export class HealthService {
  constructor(private readonly options: HealthServiceOptions) {}

  getHealth(): AppHealth {
    const metadata = this.options.database.raw
      .prepare<[], { schema_version: number }>(
        'SELECT schema_version FROM app_meta WHERE singleton = 1',
      )
      .get();

    if (metadata === undefined) {
      throw new Error('The app_meta singleton row is missing.');
    }
    const encryption = inspectDatabaseEncryption(this.options.database);
    const report = this.options.domainStartupReport;
    const sourcing = this.options.sourcingHealth?.() ?? {
      status: 'healthy' as const,
      reasons: [],
      state: {
        state: 'idle' as const, pollId: null, startedAt: null, lastCompletedAt: null,
        consecutiveFailures: 0, lastFailureAt: null, lastFailureCode: null,
        backlogCount: null,
      },
      lastSuccessAgeMs: null,
    };

    return appHealthSchema.parse({
      appVersion: this.options.appVersion,
      schemaVersion: metadata.schema_version,
      databasePath: this.options.databasePath,
      databaseEncrypted: encryption.encrypted,
      cipherVersion: encryption.cipherVersion,
      fts5Available: checkFts5(this.options.database),
      pendingJobs: this.options.jobs.listActive().length,
      interruptedJobsRecovered: report.interruptedJobsRecovered,
      domainStatus: report.status,
      domainReady: report.status === 'ready',
      domainBlockingViolationCount: report.blockingViolationCount,
      domainRepairableIssueCount: report.repairableIssueCount,
      domainProjectionRefreshCandidateCount: report.projectionRefreshCandidateCount,
      pendingProjectionRebuilds: report.pendingProjectionRebuilds,
      domainStartupEvaluatedAt: report.evaluatedAt,
      operationalStatus: sourcing.status === 'degraded' ? 'degraded' : 'ready',
      sourcing,
    });
  }
}
