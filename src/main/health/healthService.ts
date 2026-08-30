import { appHealthSchema, type AppHealth } from '../../shared/healthContract';
import { checkFts5, type AppDatabase } from '../db/database';
import type { JobRepository } from '../jobs/jobRepository';

export type HealthServiceOptions = {
  appVersion: string;
  databasePath: string;
  database: AppDatabase;
  jobs: Pick<JobRepository, 'listActive'>;
  interruptedJobsRecovered: number;
};

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

    return appHealthSchema.parse({
      appVersion: this.options.appVersion,
      schemaVersion: metadata.schema_version,
      databasePath: this.options.databasePath,
      fts5Available: checkFts5(this.options.database),
      pendingJobs: this.options.jobs.listActive().length,
      interruptedJobsRecovered: this.options.interruptedJobsRecovered,
    });
  }
}
