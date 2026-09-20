import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The local PostgreSQL 16 the greenfield tests run against.
 *
 * Two sources, one interface. In CI the `postgres:16` service container is already
 * listening and its superuser URL arrives in `FSS_TEST_POSTGRES_URL`; locally the
 * `embedded-postgres` package starts a private PostgreSQL 16 cluster in a temporary
 * directory that is removed on stop. Nothing here reaches a network service other
 * than the one the caller already named, and no credential is ever written to disk
 * outside the temporary cluster directory.
 */
export interface PostgresCluster {
  /** Superuser connection URL for the cluster's `postgres` maintenance database. */
  readonly adminUrl: string;
  /** How the cluster was obtained, for diagnostics only. */
  readonly source: 'service-container' | 'embedded';
  stop(): Promise<void>;
}

/** The environment variable a CI service container uses to hand its superuser URL to the tests. */
export const POSTGRES_URL_ENVIRONMENT_VARIABLE = 'FSS_TEST_POSTGRES_URL';

/** The local cluster's superuser. Not a secret: the cluster listens on loopback and lives for one test run. */
const EMBEDDED_USER = 'fss_test_superuser';

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => { reject(new Error('EMBEDDED_POSTGRES_PORT_UNAVAILABLE')); });
        return;
      }
      const { port } = address;
      server.close(() => { resolve(port); });
    });
  });
}

/** A throwaway password for the loopback-only cluster, generated at runtime and never stored in the repository. */
function throwawayPassword(): string {
  return `p${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/**
 * Start (or adopt) a PostgreSQL 16 cluster for one Vitest run. Prefers the CI service
 * container named by `FSS_TEST_POSTGRES_URL` and falls back to an embedded cluster.
 */
export async function startPostgresCluster(): Promise<PostgresCluster> {
  const provided = process.env[POSTGRES_URL_ENVIRONMENT_VARIABLE];
  if (provided !== undefined && provided.trim().length > 0) {
    return { adminUrl: provided.trim(), source: 'service-container', stop: async () => { /* not ours to stop */ } };
  }

  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const databaseDir = await mkdtemp(join(tmpdir(), 'fss-pg-'));
  const port = await freePort();
  const password = throwawayPassword();
  // initdb and postgres both narrate on stdout; the gate output stays readable unless
  // someone is debugging the cluster itself.
  const verbose = process.env['FSS_TEST_POSTGRES_VERBOSE'] === '1';
  const cluster = new EmbeddedPostgres({
    databaseDir,
    user: EMBEDDED_USER,
    password,
    port,
    persistent: false,
    onLog: verbose ? (message: string) => { console.error(message); } : () => undefined,
    onError: verbose ? (message: unknown) => { console.error(message); } : () => undefined,
  });
  await cluster.initialise();
  await cluster.start();

  const adminUrl = `postgresql://${EMBEDDED_USER}:${encodeURIComponent(password)}@127.0.0.1:${String(port)}/postgres`;
  return {
    adminUrl,
    source: 'embedded',
    stop: async () => {
      await cluster.stop();
      await rm(databaseDir, { recursive: true, force: true });
    },
  };
}
