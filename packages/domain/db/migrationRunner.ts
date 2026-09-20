import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { SessionQueryable } from './queryable.ts';
import { withTransaction } from './queryable.ts';

/**
 * Forward-only SQL migrations, applied under one advisory lock.
 *
 * Every migration is a numbered `.sql` file in `db/migrations/`. Files are immutable
 * once applied: the runner records a checksum and refuses to continue if a recorded
 * file has changed, because "expand, migrate, contract" (docs/greenfield/migrations.md)
 * has no down migration to fall back on. There is no down migration and no `DROP` in
 * the same release as the code that stopped using a column.
 */

export const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('./migrations/', import.meta.url));

/**
 * The session-level advisory lock every migration run holds. A stable literal, not a
 * hash of anything version-dependent, so two binaries of different releases serialize.
 */
export const MIGRATION_ADVISORY_LOCK_KEY = 6_243_912_004_771_001;

const FILE_NAME_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly fileName: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

export class MigrationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

/** Every migration file in `directory`, in version order, with its checksum. */
export function loadMigrations(directory: string = MIGRATIONS_DIRECTORY): readonly Migration[] {
  const migrations: Migration[] = [];
  for (const fileName of readdirSync(directory).sort()) {
    if (!fileName.endsWith('.sql')) continue;
    const match = FILE_NAME_PATTERN.exec(fileName);
    if (match === null) {
      throw new MigrationError('MIGRATION_FILE_NAME_INVALID', `migration file name is not NNNN_snake_case.sql: ${fileName}`);
    }
    const sql = readFileSync(join(directory, fileName), 'utf8');
    migrations.push({
      version: Number(match[1]),
      name: match[2] ?? '',
      fileName,
      sql,
      checksum: checksumOf(sql),
    });
  }
  for (const [index, migration] of migrations.entries()) {
    if (migration.version !== index + 1) {
      throw new MigrationError('MIGRATION_VERSIONS_NOT_CONTIGUOUS', `expected migration ${String(index + 1)}, found ${String(migration.version)}`);
    }
  }
  return migrations;
}

/** The bootstrap table the runner owns. It is not part of any migration file. */
export const SCHEMA_VERSIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_versions (
  version integer PRIMARY KEY,
  name text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

export interface ApplyMigrationsOptions {
  /** Defaults to every file in `db/migrations/`. */
  readonly migrations?: readonly Migration[];
  /** Stop after this version. Used by the compatibility test to seed a previous version. */
  readonly throughVersion?: number;
}

/**
 * Apply every unapplied migration, in order, each in its own transaction, while holding
 * the migration advisory lock on `session`. Returns the migrations this call applied.
 */
export async function applyMigrations(
  session: SessionQueryable,
  options: ApplyMigrationsOptions = {},
): Promise<readonly AppliedMigration[]> {
  const all = options.migrations ?? loadMigrations();
  const ceiling = options.throughVersion ?? Number.MAX_SAFE_INTEGER;

  await session.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
  try {
    await session.query(SCHEMA_VERSIONS_DDL);
    const recorded = await session.query<{ version: number; name: string; checksum: string }>(
      'SELECT version, name, checksum FROM schema_versions ORDER BY version',
    );
    const byVersion = new Map(recorded.rows.map(row => [row.version, row]));

    for (const migration of all) {
      const already = byVersion.get(migration.version);
      if (already === undefined) continue;
      if (already.checksum !== migration.checksum) {
        throw new MigrationError(
          'MIGRATION_CHECKSUM_MISMATCH',
          `migration ${migration.fileName} changed after it was applied; migrations are forward-only and immutable`,
        );
      }
    }

    const applied: AppliedMigration[] = [];
    for (const migration of all) {
      if (migration.version > ceiling) break;
      if (byVersion.has(migration.version)) continue;
      await withTransaction(session, async () => {
        await session.query(migration.sql);
        await session.query('INSERT INTO schema_versions (version, name, checksum) VALUES ($1, $2, $3)', [
          migration.version,
          migration.name,
          migration.checksum,
        ]);
      });
      applied.push({ version: migration.version, name: migration.name, checksum: migration.checksum });
    }
    return applied;
  } finally {
    await session.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK_KEY]);
  }
}

/** The highest applied migration version, or 0 on a database the runner has never touched. */
export async function readAppliedSchemaVersion(session: SessionQueryable): Promise<number> {
  const present = await session.query<{ present: boolean }>(
    "SELECT to_regclass('public.schema_versions') IS NOT NULL AS present",
  );
  if (present.rows[0]?.present !== true) return 0;
  const result = await session.query<{ version: number | null }>('SELECT max(version) AS version FROM schema_versions');
  return result.rows[0]?.version ?? 0;
}
