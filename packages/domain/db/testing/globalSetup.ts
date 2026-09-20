import { startPostgresCluster } from './embeddedPostgres.ts';
import { CLUSTER_URL_ENVIRONMENT_VARIABLE } from './testDatabase.ts';

/**
 * Vitest globalSetup: one PostgreSQL 16 cluster for the whole run.
 *
 * Vitest runs this in the main process before it forks its workers, so setting the
 * environment variable here is enough for every test file to find the cluster. The
 * teardown stops the cluster and removes its directory.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const cluster = await startPostgresCluster();
  process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] = cluster.adminUrl;
  return async () => {
    delete process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE];
    await cluster.stop();
  };
}
