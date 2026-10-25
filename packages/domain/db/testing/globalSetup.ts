import { startPostgresCluster, type PostgresCluster } from './embeddedPostgres.ts';
import {
  CLUSTER_URL_ENVIRONMENT_VARIABLE,
  TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE,
  createTemplateDatabase,
  type TemplateDatabase,
} from './testDatabase.ts';

/** Attempt every owner even after rejection. Successful stages are not repeated,
 * failed stages remain retryable, concurrent callers share one attempt. */
export function createOwnedTeardown(steps: readonly (() => Promise<void>)[]): () => Promise<void> {
  const completed = new Set<number>();
  let pending: Promise<void> | undefined;
  return () => {
    if (pending) return pending;
    const attempt = async (): Promise<void> => {
      const errors: unknown[] = [];
      for (const [index, step] of steps.entries()) {
        if (completed.has(index)) continue;
        try { await step(); completed.add(index); }
        catch (error) { errors.push(error); }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Owned teardown failed');
    };
    pending = attempt().then(() => { pending = undefined; }, (error: unknown) => { pending = undefined; throw error; });
    return pending;
  };
}

/**
 * Vitest globalSetup: one PostgreSQL 16 cluster for the whole run, and one template
 * database with every migration applied, which each test database is copied from.
 *
 * Vitest runs this in the main process before it forks its workers, so setting the
 * environment variables here is enough for every test file to find both. The teardown
 * drops the template, stops the cluster and removes its directory.
 */
export default async function setup(): Promise<() => Promise<void>> {
  return await startTestDatabaseEnvironment();
}

/** Narrow owner seam for controlled local lifecycle-failure checks. */
export async function startTestDatabaseEnvironment(
  startCluster: () => Promise<PostgresCluster> = startPostgresCluster,
  createTemplate: (adminUrl: string) => Promise<TemplateDatabase> = createTemplateDatabase,
): Promise<() => Promise<void>> {
  const cluster = await startCluster();
  const template = await createTemplate(cluster.adminUrl).catch(async (error: unknown) => {
    try { await cluster.stop(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Template setup and cluster stop failed'); }
    throw error;
  });
  process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE] = cluster.adminUrl;
  process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE] = template.name;
  const teardown = createOwnedTeardown([() => template.drop(), () => cluster.stop()]);
  return async () => {
    delete process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE];
    delete process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE];
    await teardown();
  };
}
