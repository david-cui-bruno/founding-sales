import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { QueryResultRowLike, SessionQueryable } from '../queryable.ts';
import { applyMigrations } from '../migrationRunner.ts';

/**
 * One database per test file, dropped afterwards.
 *
 * The cluster is shared for the whole Vitest run (db/testing/globalSetup.ts), and so is
 * one template database the migrations are applied to once, at the start of the run.
 * Each test file gets its own copy of it (`CREATE DATABASE … TEMPLATE …`), so a failing
 * insert in one file can never leave a constraint half-tested in another, and no file
 * pays for the migrations again. A migration that fails, fails the run in globalSetup.
 *
 * A database at an older schema (`throughVersion`) is not a copy: it starts empty and
 * the migrations are applied to it up to that version, as before.
 */

/** Where globalSetup leaves the superuser URL of the run's cluster. */
export const CLUSTER_URL_ENVIRONMENT_VARIABLE = 'FSS_TEST_CLUSTER_URL';
/** Where globalSetup leaves the name of the run's migrated template database. */
export const TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE = 'FSS_TEST_TEMPLATE_DATABASE';

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

function fromGlobalSetup(variable: string): string {
  const value = process.env[variable];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      `${variable} is unset. The Vitest globalSetup in @fss/domain/db/testing starts the cluster and migrates the template; run these tests through vitest.`,
    );
  }
  return value.trim();
}

function databaseUrl(adminUrl: string, database: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/** One statement on the cluster's maintenance database, on a connection of its own. */
async function onCluster(adminUrl: string, statement: string): Promise<void> {
  const admin = new pg.Client({ connectionString: adminUrl }) as unknown as RawClient;
  await admin.connect();
  try {
    await admin.query(statement);
  } finally {
    await admin.end();
  }
}

export interface TemplateDatabase {
  readonly name: string;
  drop(): Promise<void>;
}

/**
 * Create the run's template: a database with every migration applied, closed to new
 * connections afterwards, because `CREATE DATABASE … TEMPLATE` refuses a source that
 * any other session is connected to. globalSetup calls this once per Vitest run.
 */
export async function createTemplateDatabase(adminUrl: string): Promise<TemplateDatabase> {
  const name = `fss_template_${randomUUID().replaceAll('-', '')}`;
  const drop = async (): Promise<void> => {
    await onCluster(adminUrl, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  };
  await onCluster(adminUrl, `CREATE DATABASE "${name}"`);
  try {
    const owner = new pg.Client({ connectionString: databaseUrl(adminUrl, name) }) as unknown as RawClient;
    await owner.connect();
    try {
      await applyMigrations(asSession(owner));
    } finally {
      await owner.end();
    }
    await onCluster(adminUrl, `ALTER DATABASE "${name}" WITH ALLOW_CONNECTIONS false`);
  } catch (error) {
    await drop();
    throw error;
  }
  return { name, drop };
}

export interface CreateTestDatabaseOptions {
  /**
   * Stop after this migration version: an empty database migrated up to it rather than
   * a copy of the template. For the tests that need an older schema (0 is an empty
   * database with only the runner's `schema_versions`).
   */
  readonly throughVersion?: number;
}

/**
 * Create a database at the current schema (a copy of the run's template) or, with
 * `throughVersion`, at an older one, and hand back a superuser session.
 */
export async function createTestDatabase(options: CreateTestDatabaseOptions = {}): Promise<TestDatabase> {
  const adminUrl = fromGlobalSetup(CLUSTER_URL_ENVIRONMENT_VARIABLE);
  const name = `fss_test_${randomUUID().replaceAll('-', '')}`;

  await onCluster(
    adminUrl,
    options.throughVersion === undefined
      ? `CREATE DATABASE "${name}" TEMPLATE "${fromGlobalSetup(TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE)}"`
      : `CREATE DATABASE "${name}"`,
  );

  const url = databaseUrl(adminUrl, name);
  const owner = new pg.Client({ connectionString: url }) as unknown as RawClient;
  await owner.connect();
  const session = asSession(owner);
  const extra: RawClient[] = [];

  if (options.throughVersion !== undefined) {
    try {
      await applyMigrations(session, { throughVersion: options.throughVersion });
    } catch (error) {
      await owner.end();
      throw error;
    }
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
      await onCluster(adminUrl, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    },
  };
}
