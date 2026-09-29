import type { SessionQueryable } from '@fss/domain/db/queryable.ts';

/**
 * What the database holds, in a form two schema versions can be compared by.
 *
 * Per table: the row count, and an order-independent content hash — `md5` of each row
 * cast to text, aggregated in hash order, so the hash does not depend on the physical
 * order rows happen to be returned in.
 *
 * **No column is excluded.** A row's text is every column in ordinal order, so adding a
 * column with a default, or rewriting `updated_at`, changes the table's hash — which is
 * the point: those are exactly the changes a migration has to declare in its
 * `-- changes:` header. The one table left out is `schema_versions`, the migration
 * runner's own bookkeeping, which every upgrade appends a row to by definition
 * (`COVERAGE_EXEMPT_TABLES` names it for the same reason).
 */

export const SNAPSHOT_EXEMPT_TABLES: readonly string[] = ['schema_versions'];

export interface TableSnapshot {
  readonly rows: number;
  readonly hash: string;
}

export type Snapshot = ReadonlyMap<string, TableSnapshot>;

/** Every ordinary table in `public`, in name order. */
export async function tableNames(session: SessionQueryable): Promise<readonly string[]> {
  const { rows } = await session.query<{ table_name: string }>(
    `SELECT c.relname AS table_name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname`,
  );
  return rows.map(row => row.table_name);
}

/**
 * Every column of every ordinary table in `public`, as `table.column`.
 *
 * Taken before and after the apply so that "the objects this upgrade adds" is read out
 * of the catalogue rather than parsed out of the files: a fixture part that could not
 * run because the table it writes is the one the migration creates is excused by that
 * set, and a part missing anything else still fails.
 */
export async function columnNames(session: SessionQueryable): Promise<ReadonlySet<string>> {
  const { rows } = await session.query<{ name: string }>(
    `SELECT c.relname || '.' || a.attname AS name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped`,
  );
  return new Set(rows.map(row => row.name));
}

export async function snapshot(session: SessionQueryable): Promise<Snapshot> {
  const result = new Map<string, TableSnapshot>();
  for (const table of await tableNames(session)) {
    if (SNAPSHOT_EXEMPT_TABLES.includes(table)) continue;
    const { rows } = await session.query<{ rows: string; hash: string | null }>(
      `SELECT count(*)::text AS rows, md5(coalesce(string_agg(h, '' ORDER BY h), '')) AS hash
         FROM (SELECT md5(t.*::text) AS h FROM "${table}" t) s`,
    );
    result.set(table, { rows: Number(rows[0]?.rows ?? '0'), hash: rows[0]?.hash ?? '' });
  }
  return result;
}

export interface Difference {
  readonly table: string;
  readonly before: TableSnapshot;
  readonly after: TableSnapshot | undefined;
}

/** Tables present before whose count or hash the upgrade changed, or which it removed. */
export function differences(before: Snapshot, after: Snapshot): readonly Difference[] {
  const found: Difference[] = [];
  for (const [table, was] of before) {
    const now = after.get(table);
    if (now === undefined || now.rows !== was.rows || now.hash !== was.hash) {
      found.push({ table, before: was, after: now });
    }
  }
  return found;
}

/** Tables the upgrade added. Never a failure: a new table is what `additive` means. */
export function addedTables(before: Snapshot, after: Snapshot): readonly string[] {
  return [...after.keys()].filter(table => !before.has(table));
}
