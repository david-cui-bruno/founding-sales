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

// -------------------------------------------------------------------- catalogue shape

/**
 * What a table *is*, as against what it *holds*.
 *
 * The content snapshot above hashes rows, and a GPT-6 review found the hole that leaves:
 * **changing columns on a zero-row table leaves the same empty hash.** A migration that
 * drops a column, widens a type, removes a NOT NULL or deletes an index on a table that
 * happens to be empty in the fixture is invisible to `differences`, which is precisely
 * the table a fixture is least likely to have populated.
 *
 * So the shape is read out of the catalogue as well: every column rendered with its
 * type, nullability and default, every constraint by `pg_get_constraintdef`, every index
 * by `pg_get_indexdef`. Those are the server's own renderings, so a change the server
 * considers a change shows up and a purely textual difference in the migration file does
 * not.
 *
 * `schema_versions` is left out for the same reason `snapshot()` leaves it out.
 */

export interface TableShape {
  /** `name type NOT NULL DEFAULT …`, one per column, in ordinal order. */
  readonly columns: readonly string[];
  /** Constraint name → its definition, from `pg_get_constraintdef`. */
  readonly constraints: readonly string[];
  /** Index name → its definition, from `pg_get_indexdef`. */
  readonly indexes: readonly string[];
}

export type ShapeSnapshot = ReadonlyMap<string, TableShape>;

export async function shapeSnapshot(session: SessionQueryable): Promise<ShapeSnapshot> {
  const columns = await session.query<{ table_name: string; rendered: string }>(
    `SELECT c.relname AS table_name,
            a.attname
              || ' ' || format_type(a.atttypid, a.atttypmod)
              || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
              || coalesce(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), '')
              || CASE WHEN a.attidentity <> '' THEN ' IDENTITY ' || a.attidentity::text ELSE '' END
              || CASE WHEN a.attgenerated <> '' THEN ' GENERATED ' || a.attgenerated::text ELSE '' END
              AS rendered
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid
       LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum`,
  );
  const constraints = await session.query<{ table_name: string; rendered: string }>(
    `SELECT c.relname AS table_name, k.conname || ' ' || pg_get_constraintdef(k.oid) AS rendered
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname, k.conname`,
  );
  const indexes = await session.query<{ table_name: string; rendered: string }>(
    `SELECT c.relname AS table_name, i.relname || ' ' || pg_get_indexdef(i.oid) AS rendered
       FROM pg_index x
       JOIN pg_class c ON c.oid = x.indrelid
       JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname, i.relname`,
  );

  const gather = (rows: readonly { table_name: string; rendered: string }[]): Map<string, string[]> => {
    const byTable = new Map<string, string[]>();
    for (const row of rows) {
      if (SNAPSHOT_EXEMPT_TABLES.includes(row.table_name)) continue;
      const list = byTable.get(row.table_name);
      if (list === undefined) byTable.set(row.table_name, [row.rendered]);
      else list.push(row.rendered);
    }
    return byTable;
  };
  const byColumn = gather(columns.rows);
  const byConstraint = gather(constraints.rows);
  const byIndex = gather(indexes.rows);

  const result = new Map<string, TableShape>();
  for (const table of await tableNames(session)) {
    if (SNAPSHOT_EXEMPT_TABLES.includes(table)) continue;
    result.set(table, {
      // Columns keep their ordinal order — a reordering is a rewrite and worth seeing.
      // The other two are sorted, because the catalogue's order for them means nothing.
      columns: byColumn.get(table) ?? [],
      constraints: [...(byConstraint.get(table) ?? [])].sort(),
      indexes: [...(byIndex.get(table) ?? [])].sort(),
    });
  }
  return result;
}

export interface ShapeDifference {
  readonly table: string;
  /** One line per difference, human-readable: '+ column …', '- constraint …'. */
  readonly changes: readonly string[];
}

/** The leading token of a rendered line: the column, constraint or index name. */
function renderedName(line: string): string {
  return line.split(' ')[0] ?? line;
}

/**
 * Added, removed and changed columns, constraints and indexes, matched by name so that
 * a type or default change reads as one `~` line rather than as an unrelated pair.
 */
function diffRendered(what: string, before: readonly string[], after: readonly string[]): readonly string[] {
  const was = new Map(before.map(line => [renderedName(line), line]));
  const now = new Map(after.map(line => [renderedName(line), line]));
  const changes: string[] = [];
  for (const [name, line] of was) {
    const current = now.get(name);
    if (current === undefined) changes.push(`- ${what} ${line}`);
    else if (current !== line) changes.push(`~ ${what} ${name}: ${line} -> ${current}`);
  }
  for (const [name, line] of now) if (!was.has(name)) changes.push(`+ ${what} ${line}`);
  return changes.sort();
}

/**
 * Shape changes to tables present in **both** snapshots.
 *
 * A table only in `after` is a new table, not a difference: that is what an additive
 * migration does, and the caller has `addedTables` for it.
 */
export function shapeDifferences(before: ShapeSnapshot, after: ShapeSnapshot): readonly ShapeDifference[] {
  const found: ShapeDifference[] = [];
  for (const table of [...before.keys()].sort()) {
    const was = before.get(table);
    const now = after.get(table);
    if (was === undefined) continue;
    if (now === undefined) {
      found.push({ table, changes: ['- table (removed)'] });
      continue;
    }
    const changes = [
      ...diffRendered('column', was.columns, now.columns),
      ...diffRendered('constraint', was.constraints, now.constraints),
      ...diffRendered('index', was.indexes, now.indexes),
    ];
    if (changes.length > 0) found.push({ table, changes });
  }
  return found;
}

// ------------------------------------------------------------------ view definitions

/**
 * What a view *says*, which neither the content snapshot nor the shape snapshot sees.
 *
 * A GPT-6 review of PR 314 found the hole: `CREATE OR REPLACE VIEW` used to classify as
 * `additive` — so the release skipped its rehearsal — and nothing downstream noticed,
 * because a view holds no rows of its own to hash and `shapeSnapshot` reads ordinary
 * tables (`relkind = 'r'`) only. `effective_suppressions`, the view the suppression
 * system answers "is this handle suppressed?" from, could therefore be replaced with one
 * whose WHERE clause is `false` and the whole upgrade test would stay green.
 *
 * So the definition is snapshotted too, as the server renders it. `pg_get_viewdef(oid,
 * true)` is the pretty-printed form: it is the server's own normalisation of the parsed
 * query, so whitespace and casing in the migration file do not move it and a change the
 * *server* considers a change does. Materialized views (`relkind = 'm'`) are covered by
 * the same read; none exists in this schema today, and one added later is snapshotted
 * without anybody having to remember to come back here.
 *
 * **Every schema the application owns, not just `public`.** A second GPT-6 review round
 * pointed out that "today's migrations happen to create their view in `public`" is a
 * coincidence, not a rule: a view the application owns in another schema would have been
 * invisible. The schema set is therefore read out of the catalogue (`applicationSchemas`)
 * rather than written down here, and the keys are schema-qualified so that two views of
 * the same name in different schemas cannot collide into one entry.
 */

/**
 * The schemas this application owns, in name order.
 *
 * Derived, not listed. Everything in the cluster's catalogue that is not PostgreSQL's
 * own (`pg_catalog`, `pg_toast`, the `pg_temp_*`/`pg_toast_temp_*` pairs a backend
 * creates, `information_schema`) and was not created by an extension is the
 * application's, because on this database nobody else creates schemas: the migrations
 * are the only thing that has ever done so, and `grants.ts` checks its privileges on
 * `public` because `public` is the only one they have created so far.
 *
 * Extension-owned schemas are excluded because an extension's objects are the
 * extension's business, not a change a migration has to declare. Neither of the two
 * extensions this schema installs — `pg_trgm` and `btree_gist` — creates a schema at
 * all, so today this exclusion removes nothing; it is here so that installing one that
 * does (PostGIS's `topology`, say) does not start failing releases over views the
 * application never wrote.
 *
 * Reading it from the catalogue rather than from the migration text means a schema a
 * future migration creates is covered the moment it exists, with nobody having to come
 * back and add it to a list.
 */
export async function applicationSchemas(session: SessionQueryable): Promise<readonly string[]> {
  const { rows } = await session.query<{ schema_name: string }>(
    `SELECT n.nspname AS schema_name
       FROM pg_namespace n
      WHERE n.nspname NOT LIKE 'pg\\_%'
        AND n.nspname <> 'information_schema'
        AND NOT EXISTS (
              SELECT 1
                FROM pg_depend d
               WHERE d.classid = 'pg_namespace'::regclass
                 AND d.objid = n.oid
                 AND d.deptype = 'e')
      ORDER BY n.nspname`,
  );
  return rows.map(row => row.schema_name);
}

/**
 * A view's schema-qualified name → its server-rendered definition
 * (`pg_get_viewdef(oid, true)`). Keys read `public.effective_suppressions`.
 */
export type ViewSnapshot = ReadonlyMap<string, string>;

/**
 * Every view and materialized view in every schema the application owns, in
 * schema-then-name order, keyed `schema.view`.
 */
export async function viewSnapshot(session: SessionQueryable): Promise<ViewSnapshot> {
  const schemas = await applicationSchemas(session);
  if (schemas.length === 0) return new Map();
  const { rows } = await session.query<{ schema_name: string; view_name: string; definition: string | null }>(
    `SELECT n.nspname AS schema_name, c.relname AS view_name, pg_get_viewdef(c.oid, true) AS definition
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY($1) AND c.relkind IN ('v', 'm')
      ORDER BY n.nspname, c.relname`,
    [schemas],
  );
  const result = new Map<string, string>();
  // The definition is normalised for comparison, not for display: the pretty-printed
  // form is stable for an unchanged view, but trailing whitespace on a line is not worth
  // failing a release over, and the same definition must compare equal to itself.
  for (const row of rows) result.set(`${row.schema_name}.${row.view_name}`, (row.definition ?? '').trim());
  return result;
}

export interface ViewDifference {
  /** Schema-qualified, as `ViewSnapshot` keys it: `public.effective_suppressions`. */
  readonly view: string;
  readonly change: 'added' | 'dropped' | 'redefined';
  readonly before: string | null;
  readonly after: string | null;
}

/**
 * Views added, dropped or redefined between two snapshots, in name order.
 *
 * Unlike `shapeDifferences`, an *added* view is reported rather than passed over. A new
 * table is what `additive` means and the caller has `addedTables` for it; a new view is
 * cheap to declare in the migration's `-- changes:` header, and the caller is better off
 * being told about every view the upgrade moved than being asked to know which kind of
 * movement to ask about.
 */
export function viewDifferences(before: ViewSnapshot, after: ViewSnapshot): readonly ViewDifference[] {
  const found: ViewDifference[] = [];
  for (const view of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const was = before.get(view);
    const now = after.get(view);
    if (was === undefined && now !== undefined) found.push({ view, change: 'added', before: null, after: now });
    else if (was !== undefined && now === undefined) found.push({ view, change: 'dropped', before: was, after: null });
    else if (was !== undefined && now !== undefined && was !== now) {
      found.push({ view, change: 'redefined', before: was, after: now });
    }
  }
  return found;
}
