import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `-- changes: table_a, table_b` — what a migration says it will touch.
 *
 * The upgrade test compares every pre-upgrade table's row count and content hash
 * before and after the apply. A difference is a failure *unless* the migration
 * declared that table in this header line, which is what turns "additive" from a claim
 * in a paragraph into something a machine checks. `-- changes: none` is the explicit
 * form of "this file touches nothing that already exists", and a migration with no
 * header line at all is read as `none`, so an old file does not become a new failure.
 *
 * The line is a comment, so it costs the database nothing and travels with the file's
 * checksum: changing it after the migration is applied fails `MIGRATION_CHECKSUM_MISMATCH`
 * like any other edit.
 */

const FILE_NAME = /^(\d{4})_([a-z0-9_]+)\.sql$/u;
const CHANGES_LINE = /^\s*--\s*changes:\s*(.+?)\s*$/imu;

export interface DeclaredChanges {
  readonly version: number;
  readonly fileName: string;
  /** Empty when the file declares `none` or carries no header line. */
  readonly tables: readonly string[];
  readonly declared: boolean;
}

export function declaredChangesOf(fileName: string, sql: string): DeclaredChanges {
  const version = Number(FILE_NAME.exec(fileName)?.[1] ?? '0');
  const match = CHANGES_LINE.exec(sql);
  if (match?.[1] === undefined) return { version, fileName, tables: [], declared: false };
  const body = match[1].trim();
  if (/^none$/iu.test(body)) return { version, fileName, tables: [], declared: true };
  const tables = body
    .split(',')
    .map(part => part.trim().toLowerCase())
    .filter(part => part.length > 0);
  return { version, fileName, tables, declared: true };
}

/** What migrations `from`+1..`to` in `directory` declare they change. */
export function changesBetween(directory: string, from: number, to: number): readonly DeclaredChanges[] {
  const out: DeclaredChanges[] = [];
  for (const fileName of readdirSync(directory).sort()) {
    const match = FILE_NAME.exec(fileName);
    if (match === null) continue;
    const version = Number(match[1]);
    if (version <= from || version > to) continue;
    out.push(declaredChangesOf(fileName, readFileSync(join(directory, fileName), 'utf8')));
  }
  return out;
}

export interface ChangeBudget {
  /** Every table any migration in the range named. */
  readonly permitted: ReadonlySet<string>;
  readonly perMigration: readonly DeclaredChanges[];
}

export function changeBudget(directory: string, from: number, to: number): ChangeBudget {
  const perMigration = changesBetween(directory, from, to);
  const permitted = new Set<string>();
  for (const migration of perMigration) for (const table of migration.tables) permitted.add(table);
  return { permitted, perMigration };
}
