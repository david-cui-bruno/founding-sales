import { startPostgresCluster } from './embeddedPostgres.ts';
import {
  CLUSTER_URL_ENVIRONMENT_VARIABLE,
  TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE,
  createTemplateDatabase,
} from './testDatabase.ts';

/**
 * Vitest globalSetup: one PostgreSQL 16 cluster for the whole run, and one template
 * database with every migration applied, which each test database is copied from.
 *
 * Vitest runs this in the main process before it forks its workers, so setting the
 * environment variables here is enough for every test file to find both. The teardown
 * drops the template, stops the cluster and removes its directory.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const cluster = await startPostgresCluster();
  const template = await createTemplateDatabase(cluster.adminUrl).catch(async (error: unknown) => {
    await cluster.stop();
    throw error;
  });
  process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] = cluster.adminUrl;
  process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE] = template.name;
  return async () => {
    delete process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE];
    delete process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE];
    await template.drop();
    await cluster.stop();
  };
}
