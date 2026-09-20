import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { QueryResultRowLike, SessionQueryable } from '../queryable.ts';
import { applyMigrations } from '../migrationRunner.ts';

/**
 * One database per test file, created from the migrations and dropped afterwards.
 *
 * The cluster is shared for the whole Vitest run (db/testing/globalSetup.ts); each
 * test file gets its own database so a failing insert in one file can never leave a
 * constraint half-tested in another, and so two files may hold the migration
 * advisory lock at the same time without waiting on each other.
 */

/** Where globalSetup leaves the superuser URL of the run's cluster. */
export const CLUSTER_URL_ENVIRONMENT_VARIABLE = 'FSS_TEST_CLUSTER_URL';

/** The application role; every privilege test runs as this rather than as the superuser. */
export const APP_RUNTIME_ROLE = 'app_runtime';
/** The role that applies migrations. */
export const MIGRATION_ROLE = 'migration';

export interface TestDatabase {
  readonly name: string;
  /** A superuser session on this database. One backend connection, so transactions work. */
  readonly session: SessionQueryable;
  /**
   * A second session on this database that has already done `SET ROLE app_runtime`,
   * so it is subject to the application role's privileges rather than the owner's.
   */
  appRuntimeSession(): Promise<SessionQueryable>;
  /** Disconnect every session this database handed out and drop the database. */
  drop(): Promise<void>;
}

type RawClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number | null }>;
  connect: () => Promise<void>;
  end: () => Promise<void>;
};

/** Adapt a `node-postgres` client to the narrow `SessionQueryable` the domain code uses. */
export function asSession(client: RawClient): SessionQueryable {
  return {
    async query<Row extends QueryResultRowLike = QueryResultRowLike>(text: string, values?: readonly unknown[]) {
      const result = await client.query(text, values === undefined ? undefined : [...values]);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    },
  };
}

function clusterUrl(): string {
  const url = process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE];
  if (url === undefined || url.trim().length === 0) {
    throw new Error(
      `${CLUSTER_URL_ENVIRONMENT_VARIABLE} is unset. The Vitest globalSetup in @fss/domain/db/testing starts the cluster; run these tests through vitest.`,
    );
  }
  return url.trim();
}

function databaseUrl(adminUrl: string, database: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

export interface CreateTestDatabaseOptions {
  /** Stop after this migration version, for the seeded-previous-version compatibility test. */
  readonly throughVersion?: number;
}

/** Create a database, apply the migrations to it, and hand back a superuser session. */
export async function createTestDatabase(options: CreateTestDatabaseOptions = {}): Promise<TestDatabase> {
  const adminUrl = clusterUrl();
  const name = `fss_test_${randomUUID().replaceAll('-', '')}`;

  const admin = new pg.Client({ connectionString: adminUrl }) as unknown as RawClient;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }

  const url = databaseUrl(adminUrl, name);
  const owner = new pg.Client({ connectionString: url }) as unknown as RawClient;
  await owner.connect();
  const session = asSession(owner);
  const extra: RawClient[] = [];

  try {
    await applyMigrations(
      session,
      options.throughVersion === undefined ? {} : { throughVersion: options.throughVersion },
    );
  } catch (error) {
    await owner.end();
    throw error;
  }

  return {
    name,
    session,
    async appRuntimeSession() {
      const client = new pg.Client({ connectionString: url }) as unknown as RawClient;
      await client.connect();
      extra.push(client);
      const runtime = asSession(client);
      await runtime.query(`SET ROLE ${APP_RUNTIME_ROLE}`);
      return runtime;
    },
    async drop() {
      for (const client of extra.splice(0)) await client.end();
      await owner.end();
      const dropper = new pg.Client({ connectionString: adminUrl }) as unknown as RawClient;
      await dropper.connect();
      try {
        await dropper.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await dropper.end();
      }
    },
  };
}
