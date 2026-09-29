import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { asSession } from '@fss/domain/db/testing/testDatabase.ts';
import { startPostgresCluster, type PostgresCluster } from '@fss/domain/db/testing/embeddedPostgres.ts';

/**
 * The database the upgrade test runs against, and the roles production migrates with.
 *
 * The cluster is the one the greenfield gate already uses — `FSS_TEST_POSTGRES_URL`
 * when CI's `postgres:16` service container set it, an embedded PostgreSQL 16
 * otherwise — so the test costs nothing new to run and cannot reach a real database.
 */

export interface Connection {
  readonly session: SessionQueryable;
  end(): Promise<void>;
}

export interface UpgradeCluster {
  readonly adminUrl: string;
  readonly source: PostgresCluster['source'];
  /** The host the cluster is on. A public identifier; no credential is ever printed. */
  readonly host: string;
  readonly databaseName: string;
  /**
   * The value `fss admin database-users ensure` reads out of the runtime secret. The
   * role it names does not exist until that command has been run against the database.
   */
  readonly runtimeSecretValue: string;
  /**
   * The runtime role's connection URL, for the fixture loader that runs in another
   * process. It carries a password, so it is handed over in the environment and never
   * printed or put in an argument list.
   */
  readonly runtimeUrl: string;
  /** A connection as `role`, on the test database. */
  connect(role: Role): Promise<Connection>;
  drop(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Production has three names, and they are not interchangeable.
 *
 * `app_runtime` and `migration` are the `NOLOGIN` **group** roles migration 0001
 * creates: they carry the privileges and nobody connects as them. The two login users
 * below are members — `fss_migrator` standing in for the RDS master user a release
 * migrates as, and `fss_runtime` for the user `fss admin database-users ensure`
 * creates out of the runtime secret. The brief names the migrator `fss_migrator`; in
 * this repository the *group* it is a member of is called `migration`
 * (`apps/worker/src/tools/fss/migrate.ts`), and both names appear here for that reason.
 */
export const MIGRATOR_LOGIN_ROLE = 'fss_migrator';
export const RUNTIME_LOGIN_ROLE = 'fss_runtime';
export type Role = 'owner' | typeof MIGRATOR_LOGIN_ROLE | typeof RUNTIME_LOGIN_ROLE;

/**
 * A throwaway password for a loopback cluster that exists for one run, generated here
 * and never written anywhere but the connection string it is used in.
 */
function throwawayPassword(): string {
  return `u${randomUUID().replaceAll('-', '')}`;
}

function urlFor(adminUrl: string, database: string, role?: { user: string; password: string }): string {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  if (role !== undefined) {
    url.username = role.user;
    url.password = role.password;
  }
  return url.toString();
}

async function onCluster(adminUrl: string, statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

/**
 * The hosts an adopted cluster may be on.
 *
 * `FSS_TEST_POSTGRES_URL` is how CI hands its `postgres:16` service container to the
 * tests, and the tool adopts it. Nothing stops that variable naming a real database
 * (GPT-6 review, P2-2), and this tool creates roles, applies migrations and then
 * deliberately fails one — so it refuses anything that is not loopback unless the
 * operator says otherwise out loud.
 */
const LOCAL_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '::1', '[::1]'];

export class ClusterRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClusterRefused';
  }
}

/** Refuse an adopted cluster that is not on this machine. */
export function assertLocalCluster(adminUrl: string, allowRemote: boolean): string {
  let host: string;
  try {
    host = new URL(adminUrl).hostname;
  } catch {
    throw new ClusterRefused('the test cluster URL could not be parsed');
  }
  if (allowRemote || LOCAL_HOSTS.includes(host.toLowerCase())) return host;
  throw new ClusterRefused(
    `the test cluster is on ${host}, which is not this machine; this tool creates roles, migrates and deliberately fails a migration. Pass --allow-remote-test-cluster if that is really what you want.`,
  );
}

/**
 * A fresh database on the run's cluster, with the migrator login role production
 * migrates as. `fss_runtime` is not created here: on a real instance it does not exist
 * until `fss admin database-users ensure` runs, which is after the first migration,
 * and the point of this test is to do it in that order.
 */
export async function createUpgradeDatabase(
  options: { readonly allowRemoteCluster?: boolean } = {},
): Promise<UpgradeCluster> {
  const cluster = await startPostgresCluster();
  try {
    assertLocalCluster(cluster.adminUrl, options.allowRemoteCluster === true);
  } catch (error) {
    await cluster.stop();
    throw error;
  }
  const databaseName = `fss_upgrade_${randomUUID().replaceAll('-', '')}`;
  const passwords: Record<string, string> = {
    [MIGRATOR_LOGIN_ROLE]: throwawayPassword(),
    [RUNTIME_LOGIN_ROLE]: throwawayPassword(),
  };

  await onCluster(cluster.adminUrl, `CREATE DATABASE "${databaseName}"`);
  // CREATEROLE, and not a superuser: `ensureRuntimeDatabaseUser` refuses a session that
  // may not create roles, and `runMigrate`'s membership check is only a real check when
  // the connected role is not a superuser that passes `pg_has_role` for free.
  await onCluster(
    cluster.adminUrl,
    `DO $$ BEGIN
       IF to_regrole('${MIGRATOR_LOGIN_ROLE}') IS NULL THEN
         CREATE ROLE ${MIGRATOR_LOGIN_ROLE} LOGIN CREATEROLE PASSWORD ${pgLiteral(passwords[MIGRATOR_LOGIN_ROLE] ?? '')};
       ELSE
         ALTER ROLE ${MIGRATOR_LOGIN_ROLE} WITH LOGIN CREATEROLE PASSWORD ${pgLiteral(passwords[MIGRATOR_LOGIN_ROLE] ?? '')};
       END IF;
     END $$`,
  );
  // The migrator owns the database and the schema, as the RDS master does: every object
  // a migration creates is then owned by it and not by a superuser that production has
  // none of.
  await onCluster(cluster.adminUrl, `ALTER DATABASE "${databaseName}" OWNER TO ${MIGRATOR_LOGIN_ROLE}`);
  await onCluster(urlFor(cluster.adminUrl, databaseName), `ALTER SCHEMA public OWNER TO ${MIGRATOR_LOGIN_ROLE}`);

  const open: Connection[] = [];
  const connect = async (role: Role): Promise<Connection> => {
    const password = passwords[role];
    const client = new pg.Client({
      connectionString:
        role === 'owner' || password === undefined
          ? urlFor(cluster.adminUrl, databaseName)
          : urlFor(cluster.adminUrl, databaseName, { user: role, password }),
    });
    await client.connect();
    const connection: Connection = {
      // The same cast `db/testing/testDatabase.ts` makes: `pg.Client.connect` is
      // overloaded and its promise resolves to the client, which the narrow shape
      // `asSession` takes does not describe.
      session: asSession(client as unknown as Parameters<typeof asSession>[0]),
      end: async () => {
        await client.end();
      },
    };
    open.push(connection);
    return connection;
  };

  return {
    adminUrl: cluster.adminUrl,
    source: cluster.source,
    host: new URL(cluster.adminUrl).hostname,
    databaseName,
    runtimeSecretValue: JSON.stringify({ username: RUNTIME_LOGIN_ROLE, password: passwords[RUNTIME_LOGIN_ROLE] ?? '' }),
    runtimeUrl: urlFor(cluster.adminUrl, databaseName, {
      user: RUNTIME_LOGIN_ROLE,
      password: passwords[RUNTIME_LOGIN_ROLE] ?? '',
    }),
    connect,
    async drop() {
      for (const connection of open.splice(0)) await connection.end().catch(() => undefined);
      await onCluster(cluster.adminUrl, `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await onCluster(cluster.adminUrl, `DROP ROLE IF EXISTS ${RUNTIME_LOGIN_ROLE}`).catch(() => undefined);
      await onCluster(cluster.adminUrl, `DROP ROLE IF EXISTS ${MIGRATOR_LOGIN_ROLE}`).catch(() => undefined);
    },
    async stop() {
      await cluster.stop();
    },
  };
}

/** Quote a string as a PostgreSQL literal. Used only for a password generated in this process. */
function pgLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
