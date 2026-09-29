import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { statementsOf } from './sql.ts';

/**
 * The privileges the migrations *declare*, against the ones the database *has*.
 *
 * `packages/domain/test/db/privileges.test.ts` asserts a hand-written allow/deny matrix
 * for the tables somebody thought to write a case for. This is the generic half of the
 * same question: replay every `GRANT` and `REVOKE` in the migrations in order, and
 * compare the result with `information_schema.role_table_grants`.
 *
 * ## Why a replay alone is not enough, and what the baseline adds
 *
 * The first version of this file replayed from nothing and compared the result with the
 * catalogue. A GPT-6 review found the hole: **a new application table with no grant
 * passes.** With no grant declared and none present, the comparison puts two empty sets
 * side by side and reports no difference — so a table the runtime cannot reach at all
 * looks exactly like a table whose grants are correct. A declared `REVOKE` of an
 * existing permission has the same shape: the revoke *becomes* the new expectation, so
 * an untested feature can lose its access and the check still passes.
 *
 * So the expectation is no longer "what the files say from zero". It is
 *
 *     privileges at M  ==  (committed baseline at version B)
 *                          + (the GRANT/REVOKE statements of migrations B+1..M)
 *
 * with the baseline a file in this directory, generated once per schema release by
 * `grantsBaselineMain.ts` and reviewed as a diff. A `REVOKE` of something the baseline
 * held is now a visible change to a committed file rather than a silent adjustment of
 * the expectation, and a new table with no grant is caught by the second rule below
 * rather than by the matrix comparison, which cannot see it.
 *
 * ## The three rules
 *
 * 1. **`grant_differs`** — the matrix above, for the two group roles' table and column
 *    grants, and for the four things the replay cannot speak about at all: grants to
 *    `PUBLIC`, sequence grants, routine grants and the schema-level grants on `public`.
 *    Those four are compared against the baseline directly. A *loss* is always a
 *    finding; a *gain* is a finding only on an object the baseline already had, because
 *    a brand-new sequence or function is the business of the migration that added it
 *    and of the baseline regeneration that follows a schema release.
 * 2. **`new_table_without_access`** — every table that is new at M relative to the
 *    baseline must carry an explicit `GRANT … TO app_runtime` naming it, or be named in
 *    its migration's `-- runtime-access: none` header. "It inherited something from an
 *    `ON ALL TABLES`" does not count: that is the accident this rule exists to refuse.
 * 3. **`effective_access_differs`** — the two roles above are `NOLOGIN` groups. What
 *    production actually connects as is a login role that is a *member* of
 *    `app_runtime`, and membership is not privilege: a membership granted
 *    `INHERIT FALSE` carries nothing (see `migrate.ts`, which was bitten by exactly
 *    that). So a deterministic sample of tables is asked
 *    `has_table_privilege('fss_runtime', …)` directly and the answer is held against
 *    what the expected matrix says `app_runtime` holds.
 *
 * Only `app_runtime` and `migration` are compared in the matrix: they are the two roles
 * the migrations name, and the owner's privileges are ownership rather than a grant.
 */

export const COMPARED_ROLES: readonly string[] = ['app_runtime', 'migration'];

/** The group role a runtime login is a member of, and the login the upgrade test makes. */
export const RUNTIME_GROUP_ROLE = 'app_runtime';
export const DEFAULT_RUNTIME_LOGIN_ROLE = 'fss_runtime';

/** `SELECT`, `UPDATE(detail)` and the rest, as `information_schema` spells them. */
const PRIVILEGES: readonly string[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];

/** role → table → set of privilege names (column privileges are recorded as `UPDATE(col)`). */
type Matrix = Map<string, Map<string, Set<string>>>;

/** The same map, for callers that need to name the type. */
export type GrantMatrix = Matrix;

const FILE_NAME = /^(\d{4})_([a-z0-9_]+)\.sql$/u;

function bare(raw: string): string {
  const trimmed = raw.trim().replace(/[,;]+$/u, '');
  const last = trimmed.split('.').pop() ?? trimmed;
  return last.startsWith('"') ? last.slice(1, -1) : last.toLowerCase();
}

function entry(matrix: Matrix, role: string, table: string): Set<string> {
  let byTable = matrix.get(role);
  if (byTable === undefined) {
    byTable = new Map();
    matrix.set(role, byTable);
  }
  let set = byTable.get(table);
  if (set === undefined) {
    set = new Set();
    byTable.set(table, set);
  }
  return set;
}

/** `SELECT, INSERT, UPDATE (detail)` → `['SELECT', 'INSERT', 'UPDATE(detail)']`. */
function privilegeList(raw: string): readonly string[] {
  if (/^\s*ALL\b/iu.test(raw)) return PRIVILEGES;
  const out: string[] = [];
  for (const part of raw.split(/,(?![^(]*\))/u)) {
    const match = /^\s*([A-Za-z ]+?)\s*(?:\(([^)]*)\))?\s*$/u.exec(part);
    const name = match?.[1]?.trim().toUpperCase();
    if (name === undefined || name.length === 0) continue;
    const columns = match?.[2];
    if (columns === undefined) {
      out.push(name);
      continue;
    }
    for (const column of columns.split(',')) out.push(`${name}(${column.trim()})`);
  }
  return out;
}

interface ReplayStart {
  /** Only files numbered strictly above this are replayed. */
  readonly after: number;
  /** The privileges already held when the replay starts. Copied, never mutated. */
  readonly matrix: Matrix;
  /** The tables that already exist, so `ON ALL TABLES IN SCHEMA public` can be resolved. */
  readonly tables: readonly string[];
}

interface ReplayResult {
  readonly matrix: Matrix;
  /** Tables named one by one in a `GRANT … TO app_runtime`, never via `ON ALL TABLES`. */
  readonly explicitRuntimeGrants: ReadonlySet<string>;
}

function copyMatrix(source: Matrix): Matrix {
  const copy: Matrix = new Map();
  for (const [role, byTable] of source) {
    copy.set(role, new Map([...byTable].map(([table, set]) => [table, new Set(set)])));
  }
  return copy;
}

/**
 * The replay itself. `declaredGrants` and `expectedGrants` are the two ways in; the body
 * is shared so that the rule for `ON ALL TABLES` cannot drift between them.
 */
function replay(directory: string, through: number, start: ReplayStart): ReplayResult {
  const matrix = copyMatrix(start.matrix);
  const present: string[] = [...start.tables];
  const explicitRuntimeGrants = new Set<string>();

  const forget = (table: string): void => {
    for (const byTable of matrix.values()) byTable.delete(table);
  };

  for (const fileName of readdirSync(directory).sort()) {
    const match = FILE_NAME.exec(fileName);
    if (match === null) continue;
    const version = Number(match[1]);
    if (version > through || version <= start.after) continue;
    for (const statement of statementsOf(readFileSync(join(directory, fileName), 'utf8'))) {
      const sql = statement.normalized;

      const created = /^CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)/iu.exec(sql);
      if (created?.[1] !== undefined) {
        const name = bare(created[1]);
        if (!present.includes(name)) present.push(name);
        forget(name);
        continue;
      }
      const dropped = /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^;]+)/iu.exec(sql);
      if (dropped?.[1] !== undefined) {
        for (const name of dropped[1].split(',').map(bare)) {
          const at = present.indexOf(name);
          if (at !== -1) present.splice(at, 1);
          forget(name);
        }
        continue;
      }

      // The target may be a list — 0003 grants on three tables in one statement — so
      // it is taken as everything between `ON` and the `TO`/`FROM` that closes it.
      const grant = /^(GRANT|REVOKE)\s+([\s\S]+?)\s+ON\s+([\s\S]+?)\s+(?:TO|FROM)\s+([^;]+);?$/iu.exec(sql);
      if (grant === null) continue;
      const verb = (grant[1] ?? '').toUpperCase();
      const privileges = privilegeList(grant[2] ?? '');
      const target = (grant[3] ?? '').trim();
      if (/^SCHEMA\b/iu.test(target) || /^ALL\s+(SEQUENCES|FUNCTIONS|ROUTINES)/iu.test(target)) continue;
      const wholeSchema = /^ALL\s+TABLES/iu.test(target);
      const tables = wholeSchema
        ? [...present]
        : target.replace(/^TABLE\s+/iu, '').split(',').map(bare).filter(name => name.length > 0);
      const roles = (grant[4] ?? '')
        .split(',')
        .map(role => bare(role))
        .filter(role => COMPARED_ROLES.includes(role));

      for (const role of roles) {
        for (const table of tables) {
          if (verb === 'GRANT' && !wholeSchema && role === RUNTIME_GROUP_ROLE && privileges.length > 0) {
            explicitRuntimeGrants.add(table);
          }
          const set = entry(matrix, role, table);
          for (const privilege of privileges) {
            if (verb === 'GRANT') {
              set.add(privilege);
              continue;
            }
            set.delete(privilege);
            // `REVOKE UPDATE` takes the column grants with it.
            for (const held of [...set]) if (held.startsWith(`${privilege}(`)) set.delete(held);
          }
        }
      }
    }
  }
  return { matrix, explicitRuntimeGrants };
}

/**
 * Replay the declared grants of migrations 1..`through` in `directory`.
 *
 * `ON ALL TABLES IN SCHEMA public` is resolved against the tables that exist at that
 * point, tracked from the `CREATE TABLE` and `DROP TABLE` statements of the files
 * themselves — the same rule the classifier uses for "existing".
 *
 * This is verified to reproduce the real catalogue exactly at schema 22 with zero
 * disagreements; the baseline is generated from a database, not from this function, so
 * the two stay independent checks of each other.
 */
export function declaredGrants(directory: string, through: number): Matrix {
  // The runner's own bootstrap table exists before any migration runs, so migration
  // 0001's `ON ALL TABLES` covers it; nothing creates it with a `CREATE TABLE`
  // statement a file-reading replay could see.
  return replay(directory, through, { after: 0, matrix: new Map(), tables: ['schema_versions'] }).matrix;
}

// ---------------------------------------------------------------------------- baseline

/**
 * The committed privilege baseline: what the catalogue held at one schema version.
 *
 * Every list is a sorted array of `grantee | object | privilege` lines, because that is
 * the shape a reviewer can read in a pull-request diff without rendering anything. The
 * object's owner is written as the literal `OWNER` rather than by name: the owner is the
 * RDS master in production and `fss_migrator` in the test cluster, and a baseline that
 * disagreed between the two would be a baseline about the wrong thing.
 */
export interface GrantsBaseline {
  readonly schemaVersion: number;
  readonly _why: string;
  /** Ordinary tables in `public` at that version, sorted. `schema_versions` included. */
  readonly tables: readonly string[];
  /** `role | table | privilege`, for `app_runtime` and `migration`. `UPDATE(detail)` for a column grant. */
  readonly tableGrants: readonly string[];
  /** `PUBLIC | object | privilege` — anything any role on the instance can reach. */
  readonly publicGrants: readonly string[];
  /** `grantee | sequence | privilege`. */
  readonly sequenceGrants: readonly string[];
  /** `grantee | routine(identity args) | privilege`, functions and procedures alike. */
  readonly routineGrants: readonly string[];
  /** `grantee | public | privilege` — the schema-level `USAGE`/`CREATE`. */
  readonly schemaGrants: readonly string[];
}

const BASELINE_WHY =
  'Generated by tools/upgrade/grantsBaselineMain.ts and committed so that the upgrade ' +
  'test can ask "baseline + the GRANT/REVOKE statements of the migrations since it" ' +
  'rather than "whatever the files replay to", which cannot see a table that was never ' +
  'granted or a permission a migration quietly revoked. Regenerate by hand when a ' +
  'schema release changes it; the diff is the review artefact. See the header of ' +
  'tools/upgrade/grants.ts.';

/** The four ACL categories the grant replay cannot speak about, read straight out of the catalogue. */
type AclCategory = 'publicGrants' | 'sequenceGrants' | 'routineGrants' | 'schemaGrants';

/**
 * `aclexplode` over the four categories, in one query per category.
 *
 * `coalesce(acl, acldefault(...))` matters: a `NULL` ACL column does not mean "no
 * privileges", it means "the built-in default", and for a function that default includes
 * `EXECUTE` to `PUBLIC`. Reading the column raw would record a routine nobody may call.
 */
async function aclRows(
  session: SessionQueryable,
  sql: string,
): Promise<readonly string[]> {
  const { rows } = await session.query<{ grantee: string; object: string; privilege: string }>(sql);
  return rows.map(row => `${row.grantee} | ${row.object} | ${row.privilege}`).sort();
}

const ACL_QUERIES: Readonly<Record<AclCategory, string>> = {
  // Table-like objects anything on the instance can reach. `PUBLIC` is grantee oid 0.
  publicGrants: `
    SELECT 'PUBLIC' AS grantee, c.relname AS object, a.privilege_type AS privilege
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN aclexplode(coalesce(c.relacl, acldefault((CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END)::"char", c.relowner))) a
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'v', 'm', 'p', 'S') AND a.grantee = 0`,
  sequenceGrants: `
    SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                WHEN a.grantee = c.relowner THEN 'OWNER'
                ELSE pg_get_userbyid(a.grantee) END AS grantee,
           c.relname AS object, a.privilege_type AS privilege
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN aclexplode(coalesce(c.relacl, acldefault('s', c.relowner))) a
     WHERE n.nspname = 'public' AND c.relkind = 'S'`,
  routineGrants: `
    SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                WHEN a.grantee = p.proowner THEN 'OWNER'
                ELSE pg_get_userbyid(a.grantee) END AS grantee,
           p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS object,
           a.privilege_type AS privilege
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     CROSS JOIN aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     WHERE n.nspname = 'public'`,
  schemaGrants: `
    SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                WHEN a.grantee = n.nspowner THEN 'OWNER'
                ELSE pg_get_userbyid(a.grantee) END AS grantee,
           n.nspname AS object, a.privilege_type AS privilege
      FROM pg_namespace n
     CROSS JOIN aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
     WHERE n.nspname = 'public'`,
};

/** Every ordinary table in `public`, in name order. */
async function catalogueTables(session: SessionQueryable): Promise<readonly string[]> {
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
 * Read the live privilege state in the baseline's shape.
 *
 * Used twice: by the generator to write the committed file, and by `checkPrivileges` to
 * read what the database has now. One reader, so "the baseline" and "the state" cannot
 * mean subtly different queries.
 */
export async function capturePrivileges(session: SessionQueryable, schemaVersion: number): Promise<GrantsBaseline> {
  const matrix = await actualGrants(session);
  const tableGrants: string[] = [];
  for (const [role, byTable] of matrix) {
    for (const [table, set] of byTable) for (const privilege of set) tableGrants.push(`${role} | ${table} | ${privilege}`);
  }
  return {
    schemaVersion,
    _why: BASELINE_WHY,
    tables: [...(await catalogueTables(session))].sort(),
    tableGrants: tableGrants.sort(),
    publicGrants: await aclRows(session, ACL_QUERIES.publicGrants),
    sequenceGrants: await aclRows(session, ACL_QUERIES.sequenceGrants),
    routineGrants: await aclRows(session, ACL_QUERIES.routineGrants),
    schemaGrants: await aclRows(session, ACL_QUERIES.schemaGrants),
  };
}

/** The baseline's `tableGrants` lines back as the matrix the replay starts from. */
export function baselineMatrix(baseline: GrantsBaseline): Matrix {
  const matrix: Matrix = new Map();
  for (const line of baseline.tableGrants) {
    const parts = line.split(' | ');
    const role = parts[0];
    const table = parts[1];
    const privilege = parts[2];
    if (role === undefined || table === undefined || privilege === undefined) {
      throw new Error(`grants-baseline.json: '${line}' is not 'role | table | privilege'`);
    }
    entry(matrix, role, table).add(privilege);
  }
  return matrix;
}

function stringList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`grants-baseline.json: ${field} is not an array of strings`);
  }
  return value as readonly string[];
}

/**
 * The committed baseline, from `grants-baseline.json` beside this file unless told
 * otherwise. Resolved against `import.meta.url` so it does not depend on the working
 * directory the test was started from.
 */
export function loadGrantsBaseline(path?: string): GrantsBaseline {
  const from = path ?? new URL('./grants-baseline.json', import.meta.url);
  const parsed: unknown = JSON.parse(readFileSync(from, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('grants-baseline.json does not hold a JSON object');
  }
  const raw = parsed as Record<string, unknown>;
  const schemaVersion = raw['schemaVersion'];
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    throw new Error('grants-baseline.json: schemaVersion is not an integer');
  }
  return {
    schemaVersion,
    _why: typeof raw['_why'] === 'string' ? raw['_why'] : BASELINE_WHY,
    tables: stringList(raw['tables'], 'tables'),
    tableGrants: stringList(raw['tableGrants'], 'tableGrants'),
    publicGrants: stringList(raw['publicGrants'], 'publicGrants'),
    sequenceGrants: stringList(raw['sequenceGrants'], 'sequenceGrants'),
    routineGrants: stringList(raw['routineGrants'], 'routineGrants'),
    schemaGrants: stringList(raw['schemaGrants'], 'schemaGrants'),
  };
}

/** The baseline as the bytes to write: stable key order, one list entry per line. */
export function serialiseGrantsBaseline(baseline: GrantsBaseline): string {
  return `${JSON.stringify(baseline, null, 2)}\n`;
}

// ------------------------------------------------------------------- runtime-access

const RUNTIME_ACCESS_LINE = /^\s*--\s*runtime-access:\s*none\s+(.+?)\s*$/imu;

export interface RuntimeAccessExceptions {
  readonly version: number;
  readonly fileName: string;
  /** Tables the file says are deliberately unreachable by `app_runtime`. */
  readonly tables: readonly string[];
}

/**
 * `-- runtime-access: none some_table, another_table` — a migration's signed statement
 * that a table it creates is meant to be unreachable by the runtime.
 *
 * Read exactly as `changes.ts` reads `-- changes:`, and for the same reason: the line is
 * a comment, so it costs the database nothing and it travels with the file's checksum,
 * which means adding one after the fact fails `MIGRATION_CHECKSUM_MISMATCH` rather than
 * quietly excusing a table. A file with no such line excuses nothing.
 *
 * The parser lives here rather than in `changes.ts` because the two headers answer
 * different questions and are checked by different rules; `changes.ts` is not edited.
 */
export function runtimeAccessExceptionsOf(fileName: string, sql: string): RuntimeAccessExceptions {
  const version = Number(FILE_NAME.exec(fileName)?.[1] ?? '0');
  const match = RUNTIME_ACCESS_LINE.exec(sql);
  if (match?.[1] === undefined) return { version, fileName, tables: [] };
  const tables = match[1]
    .split(/[\s,]+/u)
    .map(part => part.trim().toLowerCase())
    .filter(part => part.length > 0);
  return { version, fileName, tables };
}

/** Every table migrations `from`+1..`to` in `directory` excuse from the runtime-access rule. */
export function runtimeAccessExceptions(directory: string, from: number, to: number): readonly string[] {
  const excused = new Set<string>();
  for (const fileName of readdirSync(directory).sort()) {
    const match = FILE_NAME.exec(fileName);
    if (match === null) continue;
    const version = Number(match[1]);
    if (version <= from || version > to) continue;
    for (const table of runtimeAccessExceptionsOf(fileName, readFileSync(join(directory, fileName), 'utf8')).tables) {
      excused.add(table);
    }
  }
  return [...excused].sort();
}

// ------------------------------------------------------------------------- the check

/** What `information_schema` says the two roles actually hold, in the same shape. */
export async function actualGrants(session: SessionQueryable): Promise<Matrix> {
  const matrix: Matrix = new Map();
  const tables = await session.query<{ grantee: string; table_name: string; privilege_type: string }>(
    `SELECT grantee, table_name, privilege_type
       FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND grantee = ANY($1)`,
    [COMPARED_ROLES],
  );
  const columns = await session.query<{ grantee: string; table_name: string; privilege_type: string; column_name: string }>(
    `SELECT grantee, table_name, privilege_type, column_name
       FROM information_schema.role_column_grants
      WHERE table_schema = 'public' AND grantee = ANY($1)`,
    [COMPARED_ROLES],
  );
  const wholeTable = new Set(tables.rows.map(row => `${row.grantee}\u0000${row.table_name}\u0000${row.privilege_type}`));
  for (const row of tables.rows) entry(matrix, row.grantee, row.table_name).add(row.privilege_type);
  for (const row of columns.rows) {
    // A column grant that the whole-table grant already covers is not a separate fact.
    if (wholeTable.has(`${row.grantee}\u0000${row.table_name}\u0000${row.privilege_type}`)) continue;
    entry(matrix, row.grantee, row.table_name).add(`${row.privilege_type}(${row.column_name})`);
  }
  return matrix;
}

export interface GrantDifference {
  readonly role: string;
  readonly table: string;
  readonly missing: readonly string[];
  readonly extra: readonly string[];
}

/**
 * Compare declared with actual, over the tables the database actually has.
 *
 * Kept for callers that want the raw two-matrix comparison. On its own it cannot see a
 * table nobody granted anything on — that is what `checkPrivileges` is for.
 */
export function compareGrants(declared: Matrix, actual: Matrix, tables: readonly string[]): readonly GrantDifference[] {
  const differences: GrantDifference[] = [];
  for (const role of COMPARED_ROLES) {
    for (const table of tables) {
      const want = declared.get(role)?.get(table) ?? new Set<string>();
      const have = actual.get(role)?.get(table) ?? new Set<string>();
      const missing = [...want].filter(privilege => !have.has(privilege)).sort();
      const extra = [...have].filter(privilege => !want.has(privilege)).sort();
      if (missing.length > 0 || extra.length > 0) differences.push({ role, table, missing, extra });
    }
  }
  return differences;
}

export interface ExpectedGrants {
  readonly matrix: Matrix;
  /** Tables migrations after the baseline granted to `app_runtime` by name. */
  readonly explicitRuntimeGrants: ReadonlySet<string>;
}

/**
 * The baseline, plus the GRANT/REVOKE statements of migrations `baseline.schemaVersion`
 * +1..`toVersion`. The expectation the database is held against.
 */
export function expectedGrants(directory: string, baseline: GrantsBaseline, toVersion: number): ExpectedGrants {
  return replay(directory, toVersion, {
    after: baseline.schemaVersion,
    matrix: baselineMatrix(baseline),
    tables: baseline.tables,
  });
}

/**
 * The ten tables every run checks the login role against, whatever the range touched.
 *
 * A fixed floor, so that "the migrations in this range named nothing interesting" cannot
 * quietly reduce the effective-access rule to nothing. They are the tables a workspace
 * cannot function without, plus the two append-only ones the promises below are about.
 */
export const CORE_EFFECTIVE_TABLES: readonly string[] = [
  'audit_events',
  'contacts',
  'firms',
  'jobs',
  'mail_messages',
  'opportunities',
  'outbound_messages',
  'sequence_enrollments',
  'users',
  'workspaces',
];

/**
 * The promises that are not a matter of taste: these tables are append-only, and the
 * login role must not be able to break that however the grants were written.
 */
const APPEND_ONLY_PROMISES: readonly { readonly table: string; readonly privilege: string }[] = [
  { table: 'audit_events', privilege: 'DELETE' },
  { table: 'suppression_events', privilege: 'UPDATE' },
  { table: 'funnel_facts', privilege: 'DELETE' },
];

export interface PrivilegeFinding {
  readonly kind: 'grant_differs' | 'new_table_without_access' | 'effective_access_differs';
  readonly role: string;
  readonly object: string;
  readonly detail: string;
}

export interface PrivilegeReport {
  readonly baselineSchemaVersion: number;
  readonly tablesChecked: number;
  readonly effectiveChecks: number;
  readonly newTables: readonly string[];
  readonly exceptions: readonly string[];
  readonly findings: readonly PrivilegeFinding[];
}

export interface CheckPrivilegesOptions {
  /** The migrations directory the range was applied from. */
  readonly migrations: string;
  readonly toVersion: number;
  readonly baseline: GrantsBaseline;
  /** The login role production connects as. Defaults to the upgrade cluster's `fss_runtime`. */
  readonly runtimeLogin?: string | undefined;
}

/** A category comparison: a loss is always a finding, a gain only on an object the baseline knew. */
function compareAcl(
  category: string,
  was: readonly string[],
  now: readonly string[],
  findings: PrivilegeFinding[],
): void {
  const objectOf = (line: string): string => line.split(' | ')[1] ?? line;
  const known = new Set(was.map(objectOf));
  const before = new Set(was);
  const after = new Set(now);
  for (const line of was) {
    if (after.has(line)) continue;
    const parts = line.split(' | ');
    findings.push({
      kind: 'grant_differs',
      role: parts[0] ?? '?',
      object: `${category}:${parts[1] ?? '?'}`,
      detail: `the baseline holds ${parts[2] ?? '?'} and the database does not`,
    });
  }
  for (const line of now) {
    if (before.has(line)) continue;
    const parts = line.split(' | ');
    // An object that did not exist at the baseline is the business of the migration that
    // added it and of the next baseline regeneration, not of this comparison.
    if (!known.has(parts[1] ?? '')) continue;
    findings.push({
      kind: 'grant_differs',
      role: parts[0] ?? '?',
      object: `${category}:${parts[1] ?? '?'}`,
      detail: `the database holds ${parts[2] ?? '?'} and the baseline does not`,
    });
  }
}

export async function checkPrivileges(
  session: SessionQueryable,
  options: CheckPrivilegesOptions,
): Promise<PrivilegeReport> {
  const { baseline } = options;
  const login = options.runtimeLogin ?? DEFAULT_RUNTIME_LOGIN_ROLE;
  const findings: PrivilegeFinding[] = [];

  const expected = expectedGrants(options.migrations, baseline, options.toVersion);
  const live = await capturePrivileges(session, options.toVersion);
  const actual = baselineMatrix(live);

  // ---- rule 1a: the two group roles' table and column grants.
  const tables = new Set<string>(live.tables);
  for (const table of baseline.tables) tables.add(table);
  for (const byTable of expected.matrix.values()) for (const table of byTable.keys()) tables.add(table);
  const compared = [...tables].sort();
  for (const difference of compareGrants(expected.matrix, actual, compared)) {
    findings.push({
      kind: 'grant_differs',
      role: difference.role,
      object: difference.table,
      detail: [
        difference.missing.length > 0 ? `missing ${difference.missing.join(', ')}` : '',
        difference.extra.length > 0 ? `unexpected ${difference.extra.join(', ')}` : '',
      ]
        .filter(part => part.length > 0)
        .join('; '),
    });
  }

  // ---- rule 1b: the four categories the replay cannot speak about.
  compareAcl('PUBLIC', baseline.publicGrants, live.publicGrants, findings);
  compareAcl('sequence', baseline.sequenceGrants, live.sequenceGrants, findings);
  compareAcl('routine', baseline.routineGrants, live.routineGrants, findings);
  compareAcl('schema', baseline.schemaGrants, live.schemaGrants, findings);

  // ---- rule 2: a new table needs an explicit runtime grant or a written exception.
  const known = new Set(baseline.tables);
  const newTables = live.tables.filter(table => !known.has(table)).sort();
  const exceptions = runtimeAccessExceptions(options.migrations, baseline.schemaVersion, options.toVersion);
  const excused = new Set(exceptions);
  for (const table of newTables) {
    if (excused.has(table)) continue;
    if (expected.explicitRuntimeGrants.has(table)) continue;
    findings.push({
      kind: 'new_table_without_access',
      role: RUNTIME_GROUP_ROLE,
      object: table,
      detail:
        `new since schema ${String(baseline.schemaVersion)} with no \`GRANT … ON ${table} TO ${RUNTIME_GROUP_ROLE}\` ` +
        `in its migration and no \`-- runtime-access: none ${table}\` header excusing it`,
    });
  }

  // ---- rule 3: what the login role can actually do.
  const sample = new Set<string>(CORE_EFFECTIVE_TABLES);
  for (const table of newTables) sample.add(table);
  for (const byTable of expected.matrix.values()) for (const table of byTable.keys()) sample.add(table);
  for (const promise of APPEND_ONLY_PROMISES) sample.add(promise.table);
  const sampled = [...sample].filter(table => live.tables.includes(table)).sort();

  let effectiveChecks = 0;
  const loginExists = await session.query<{ present: boolean }>('SELECT to_regrole($1) IS NOT NULL AS present', [login]);
  if (loginExists.rows[0]?.present !== true) {
    findings.push({
      kind: 'effective_access_differs',
      role: login,
      object: '(role)',
      detail: 'the runtime login role does not exist, so nothing proves the group grants reach anything',
    });
    return {
      baselineSchemaVersion: baseline.schemaVersion,
      tablesChecked: compared.length,
      effectiveChecks,
      newTables,
      exceptions,
      findings,
    };
  }

  const tableAnswers = await session.query<{ table_name: string; privilege: string; held: boolean }>(
    `SELECT t.table_name, p.privilege, has_table_privilege($1, quote_ident(t.table_name), p.privilege) AS held
       FROM unnest($2::text[]) AS t(table_name)
      CROSS JOIN unnest($3::text[]) AS p(privilege)`,
    [login, sampled, PRIVILEGES],
  );
  for (const row of tableAnswers.rows) {
    effectiveChecks += 1;
    const want = expected.matrix.get(RUNTIME_GROUP_ROLE)?.get(row.table_name)?.has(row.privilege) === true;
    if (want === row.held) continue;
    findings.push({
      kind: 'effective_access_differs',
      role: login,
      object: row.table_name,
      detail: want
        ? `${RUNTIME_GROUP_ROLE} is expected to hold ${row.privilege} but the login does not`
        : `the login holds ${row.privilege}, which ${RUNTIME_GROUP_ROLE} is not expected to hold`,
    });
  }

  // Column grants are invisible to `has_table_privilege`, so `UPDATE (detail)` has to be
  // asked for by column or the one privilege 0022 grants would go unchecked.
  const columnChecks: { table: string; column: string; privilege: string }[] = [];
  for (const table of sampled) {
    for (const held of expected.matrix.get(RUNTIME_GROUP_ROLE)?.get(table) ?? []) {
      const match = /^([A-Z]+)\(([^)]+)\)$/u.exec(held);
      if (match?.[1] === undefined || match[2] === undefined) continue;
      columnChecks.push({ table, column: match[2], privilege: match[1] });
    }
  }
  if (columnChecks.length > 0) {
    const columnAnswers = await session.query<{ table_name: string; column_name: string; privilege: string; held: boolean }>(
      `SELECT c.table_name, c.column_name, c.privilege,
              has_column_privilege($1, quote_ident(c.table_name), quote_ident(c.column_name), c.privilege) AS held
         FROM unnest($2::text[], $3::text[], $4::text[]) AS c(table_name, column_name, privilege)`,
      [login, columnChecks.map(check => check.table), columnChecks.map(check => check.column), columnChecks.map(check => check.privilege)],
    );
    for (const row of columnAnswers.rows) {
      effectiveChecks += 1;
      if (row.held) continue;
      findings.push({
        kind: 'effective_access_differs',
        role: login,
        object: `${row.table_name}.${row.column_name}`,
        detail: `${RUNTIME_GROUP_ROLE} is expected to hold ${row.privilege} on this column but the login does not`,
      });
    }
  }

  // The append-only promises, asked of the login by name and not derived from anything,
  // so that a matrix that agreed with a wrong expectation still fails here.
  const promises = APPEND_ONLY_PROMISES.filter(promise => live.tables.includes(promise.table));
  if (promises.length > 0) {
    const promiseAnswers = await session.query<{ table_name: string; privilege: string; held: boolean }>(
      `SELECT c.table_name, c.privilege, has_table_privilege($1, quote_ident(c.table_name), c.privilege) AS held
         FROM unnest($2::text[], $3::text[]) AS c(table_name, privilege)`,
      [login, promises.map(promise => promise.table), promises.map(promise => promise.privilege)],
    );
    for (const row of promiseAnswers.rows) {
      effectiveChecks += 1;
      if (!row.held) continue;
      findings.push({
        kind: 'effective_access_differs',
        role: login,
        object: row.table_name,
        detail: `${row.table_name} is append-only, and the login holds ${row.privilege} on it`,
      });
    }
  }

  return {
    baselineSchemaVersion: baseline.schemaVersion,
    tablesChecked: compared.length,
    effectiveChecks,
    newTables,
    exceptions,
    findings,
  };
}
