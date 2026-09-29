import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QueryResultRowLike, SessionQueryable } from '@fss/domain/db/queryable.ts';
import { applyMigrations } from '@fss/domain/db/migrationRunner.ts';
import { startPostgresCluster, type PostgresCluster } from '@fss/domain/db/testing/embeddedPostgres.ts';
import { asSession } from '@fss/domain/db/testing/testDatabase.ts';
import { ensureRuntimeDatabaseUser } from '../src/tools/fss/databaseUsers.ts';
import { APP_RUNTIME_ROLE, MIGRATION_ROLE, runMigrate } from '../src/tools/fss/migrate.ts';

/**
 * `fss admin database-users ensure` and `fss migrate` have to mean the same thing by
 * "is a member of `migration`", and on PostgreSQL 16 they did not.
 *
 * A role created by a non-superuser `CREATEROLE` user is granted back to its creator
 * with `ADMIN TRUE, INHERIT FALSE, SET FALSE`. Migration 0001 creates `migration`, and
 * on a real instance it runs as the RDS master, which is such a user. So the creator is
 * a `MEMBER` of `migration` without inheriting it: `ensure` asked `MEMBER`, answered
 * `already`, granted nothing, and every `fss migrate` after the first was refused with
 * `not_migration_role`, because `readMigrationRole` asks `USAGE`.
 *
 * ## Why this file has a cluster of its own
 *
 * `app_runtime` and `migration` are **cluster-global** objects, and the run's shared
 * cluster already has both: its globalSetup migrated the template database as the
 * cluster superuser. On that cluster no later role can ever be their creator, so the
 * automatic grant this test is about cannot happen. `startPostgresCluster` is therefore
 * called here as `tools/upgrade/cluster.ts` calls it, and locally hands back a private
 * embedded PostgreSQL 16 where the migrator really does create the two roles.
 *
 * In CI that same call returns the shared `postgres:16` service container, whose roles
 * were created by globalSetup before this file ran. There the automatic grants are
 * written out instead, with the exact options PostgreSQL 16 gives them — one per group
 * role 0001 creates, because `ensure` needs `ADMIN OPTION` on `app_runtime` to put the
 * runtime user in it, as well as on `migration` for the grant under test. That is the
 * one thing this file will stage rather than observe, and `pristine` below says which
 * happened. Everything after it is the real command against the real server either way.
 *
 * ## The vacuous-pass traps, named
 *
 * **A superuser.** A superuser passes every `pg_has_role` for free, so the whole test
 * would prove nothing. The database is owned and migrated by a *non-superuser*
 * `CREATEROLE` login role, built the way `tools/upgrade/cluster.ts` builds production's
 * `fss_migrator`.
 *
 * **A database migrated once.** The refusal is on the *second* migration, so the
 * sequence is the real one: migrate, ensure, migrate again. The first case also asserts
 * the precondition — `MEMBER` true, `USAGE` false, before `ensure` runs — so that a
 * server which stops behaving this way fails the test loudly rather than leaving a
 * check that can no longer catch anything.
 *
 * **A mock.** Every statement goes to a real server. The only wrapper is a recorder
 * that passes each statement through, so the second `ensure` can be shown to issue no
 * further `GRANT`.
 */

const MIGRATOR_LOGIN_ROLE = 'fss_migrator';
const RUNTIME_LOGIN_ROLE = 'fss_runtime';

type RawClient = Parameters<typeof asSession>[0];

interface Recorder {
  readonly session: SessionQueryable;
  readonly statements: readonly string[];
}

/** A session that remembers the text of everything sent through it. Nothing is faked. */
function recording(inner: SessionQueryable): Recorder {
  const statements: string[] = [];
  return {
    statements,
    session: {
      async query<Row extends QueryResultRowLike = QueryResultRowLike>(text: string, values?: readonly unknown[]) {
        statements.push(text);
        return await inner.query<Row>(text, values);
      },
    },
  };
}

/** A throwaway password for a loopback cluster that exists for one run. */
function throwawayPassword(): string {
  return `p${randomUUID().replaceAll('-', '')}`;
}

let cluster: PostgresCluster | undefined;
let databaseName = '';
let migratorClient: pg.Client | undefined;
let migrator: SessionQueryable;
/** True when the migrator itself created the group roles, as the RDS master does. */
let pristine = false;
const migratorPassword = throwawayPassword();
const runtimePassword = throwawayPassword();

function urlFor(database: string, role?: { readonly user: string; readonly password: string }): string {
  const url = new URL(cluster?.adminUrl ?? '');
  url.pathname = `/${database}`;
  if (role !== undefined) {
    url.username = role.user;
    url.password = role.password;
  }
  return url.toString();
}

async function onCluster(url: string, statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

/** `pg_has_role` as the migrator's own session sees it, both ways round. */
async function membership(): Promise<{ readonly member: boolean; readonly usage: boolean }> {
  const { rows } = await migrator.query<{ member: boolean; usage: boolean }>(
    `SELECT pg_has_role(current_user, $1, 'MEMBER') AS member,
            pg_has_role(current_user, $1, 'USAGE') AS usage`,
    [MIGRATION_ROLE],
  );
  const row = rows[0];
  return { member: row?.member === true, usage: row?.usage === true };
}

beforeAll(async () => {
  cluster = await startPostgresCluster();
  const adminUrl = cluster.adminUrl;
  databaseName = `fss_dbusers_${randomUUID().replaceAll('-', '')}`;

  const before = new pg.Client({ connectionString: adminUrl });
  await before.connect();
  try {
    const { rows } = await before.query<{ absent: boolean }>('SELECT to_regrole($1) IS NULL AS absent', [MIGRATION_ROLE]);
    pristine = rows[0]?.absent === true;
    // The migrator survives a previous run on a shared container, and its password is
    // generated afresh every time, so the role is brought to the state this file needs
    // rather than assumed into it.
    await before.query(
      `DO $$ BEGIN
         IF to_regrole('${MIGRATOR_LOGIN_ROLE}') IS NULL THEN
           CREATE ROLE ${MIGRATOR_LOGIN_ROLE} LOGIN CREATEROLE PASSWORD '${migratorPassword}';
         ELSE
           ALTER ROLE ${MIGRATOR_LOGIN_ROLE} WITH LOGIN CREATEROLE NOSUPERUSER PASSWORD '${migratorPassword}';
         END IF;
       END $$`,
    );
  } finally {
    await before.end();
  }

  await onCluster(adminUrl, `CREATE DATABASE "${databaseName}" OWNER ${MIGRATOR_LOGIN_ROLE}`);
  // The migrator owns the schema too, as the RDS master does: every object a migration
  // creates is then owned by it and not by a superuser production has none of.
  await onCluster(urlFor(databaseName), `ALTER SCHEMA public OWNER TO ${MIGRATOR_LOGIN_ROLE}`);

  migratorClient = new pg.Client({
    connectionString: urlFor(databaseName, { user: MIGRATOR_LOGIN_ROLE, password: migratorPassword }),
  });
  await migratorClient.connect();
  migrator = asSession(migratorClient as unknown as RawClient);
}, 180_000);

afterAll(async () => {
  await migratorClient?.end().catch(() => undefined);
  if (cluster !== undefined && databaseName.length > 0) {
    await onCluster(cluster.adminUrl, `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => undefined);
    // Only this file's login roles are dropped. `app_runtime` and `migration` are
    // cluster-global and, on a shared container, belong to the whole run.
    await onCluster(cluster.adminUrl, `DROP ROLE IF EXISTS ${RUNTIME_LOGIN_ROLE}`).catch(() => undefined);
    await onCluster(cluster.adminUrl, `DROP ROLE IF EXISTS ${MIGRATOR_LOGIN_ROLE}`).catch(() => undefined);
  }
  await cluster?.stop();
});

describe('ensure, then migrate again, as a non-superuser CREATEROLE owner', () => {
  it('the first migration leaves the migrator a member of migration that does not inherit', async () => {
    if (pristine) {
      // The real first run: `migration` does not exist yet, which is the only reason
      // `runMigrate`'s role check passes, and 0001 creating it is what produces the
      // automatic grant back to its non-superuser creator.
      const first = await runMigrate(migrator);
      expect(first.ok === false ? first.reason : undefined).toBeUndefined();
      expect(first.ok).toBe(true);
    } else {
      // A cluster whose group roles someone else created: the schema is still applied
      // by the migrator, and the memberships PostgreSQL 16 would have given it are
      // written out with the options it uses — one for each role 0001 creates.
      // `app_runtime` is not optional here: `ensure` runs `CREATE ROLE … IN ROLE
      // app_runtime`, and on PostgreSQL 16 a CREATEROLE user may grant membership only
      // in roles it holds `ADMIN OPTION` on. The creator holds it automatically; a
      // migrator that did not create the role has to be given it, or the shared-cluster
      // run fails at the runtime user's creation before the grant under test is reached.
      await applyMigrations(migrator);
      for (const group of [APP_RUNTIME_ROLE, MIGRATION_ROLE]) {
        await onCluster(
          cluster?.adminUrl ?? '',
          `GRANT ${group} TO ${MIGRATOR_LOGIN_ROLE} WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`,
        );
      }
    }

    // The defect's precondition, asserted rather than assumed.
    expect(await membership()).toStrictEqual({ member: true, usage: false });
  });

  it('ensure grants the inheritance the second migrate needs, and reports it granted', async () => {
    const recorder = recording(migrator);
    const result = await ensureRuntimeDatabaseUser(recorder.session, {
      secretValue: JSON.stringify({ username: RUNTIME_LOGIN_ROLE, password: runtimePassword }),
    });

    expect(result).toStrictEqual({
      ok: true,
      value: {
        user: {
          outcome: 'created',
          user: RUNTIME_LOGIN_ROLE,
          memberOf: APP_RUNTIME_ROLE,
          canLogin: true,
          passwordSet: true,
        },
        migrationMembership: 'granted',
        grantedTo: MIGRATOR_LOGIN_ROLE,
      },
    });
    expect(recorder.statements.some(statement => /^GRANT .* WITH INHERIT TRUE$/u.test(statement))).toBe(true);

    // What the whole file exists for: the predicate `fss migrate` reads is now true.
    expect(await membership()).toStrictEqual({ member: true, usage: true });
  });

  it('the second migrate is not refused', async () => {
    const second = await runMigrate(migrator);
    // The reason is named rather than implied: `not_migration_role` is what the old
    // `MEMBER` predicate left behind here, and a bare `ok` would not say so.
    expect(second.ok === false ? second.reason : undefined).toBeUndefined();
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.role.isMigrationRole).toBe(true);
      expect(second.value.role.connectedRole).toBe(MIGRATOR_LOGIN_ROLE);
    }
  });

  it('a second ensure reports already and issues no further grant', async () => {
    const recorder = recording(migrator);
    const result = await ensureRuntimeDatabaseUser(recorder.session, {
      secretValue: JSON.stringify({ username: RUNTIME_LOGIN_ROLE, password: runtimePassword }),
    });

    expect(result).toStrictEqual({
      ok: true,
      value: {
        user: {
          outcome: 'unchanged',
          user: RUNTIME_LOGIN_ROLE,
          memberOf: APP_RUNTIME_ROLE,
          canLogin: true,
          passwordSet: false,
        },
        migrationMembership: 'already',
        grantedTo: MIGRATOR_LOGIN_ROLE,
      },
    });
    expect(recorder.statements.filter(statement => /^(GRANT|CREATE ROLE|ALTER ROLE)\b/u.test(statement))).toStrictEqual([]);
  });
});
