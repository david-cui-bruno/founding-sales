import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { statementsOf } from './sql.ts';

/**
 * The privileges the migrations *declare*, against the ones the database *has*.
 *
 * `packages/domain/test/db/privileges.test.ts` asserts a hand-written allow/deny matrix
 * for the tables somebody thought to write a case for. This is the generic half of the
 * same question and needs no snapshot committed per schema version: replay every
 * `GRANT` and `REVOKE` in migrations 1..M in order, and compare the result with
 * `information_schema.role_table_grants`. A migration that creates a table and forgets
 * its grant, or grants one the file does not declare, fails here — including migration
 * 0001's `GRANT … ON ALL TABLES IN SCHEMA public`, which covers only the tables that
 * existed when it ran.
 *
 * Only `app_runtime` and `migration` are compared: they are the two roles the
 * migrations name, and the owner's privileges are ownership rather than a grant.
 */

export const COMPARED_ROLES: readonly string[] = ['app_runtime', 'migration'];

/** `SELECT`, `UPDATE(detail)` and the rest, as `information_schema` spells them. */
const PRIVILEGES: readonly string[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];

/** role → table → set of privilege names (column privileges are recorded as `UPDATE(col)`). */
type Matrix = Map<string, Map<string, Set<string>>>;

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

/**
 * Replay the declared grants of migrations 1..`through` in `directory`.
 *
 * `ON ALL TABLES IN SCHEMA public` is resolved against the tables that exist at that
 * point, tracked from the `CREATE TABLE` and `DROP TABLE` statements of the files
 * themselves — the same rule the classifier uses for "existing".
 */
export function declaredGrants(directory: string, through: number): Matrix {
  const matrix: Matrix = new Map();
  // The runner's own bootstrap table exists before any migration runs, so migration
  // 0001's `ON ALL TABLES` covers it; nothing creates it with a `CREATE TABLE`
  // statement a file-reading replay could see.
  const present: string[] = ['schema_versions'];

  const forget = (table: string): void => {
    for (const byTable of matrix.values()) byTable.delete(table);
  };

  for (const fileName of readdirSync(directory).sort()) {
    const match = FILE_NAME.exec(fileName);
    if (match === null || Number(match[1]) > through) continue;
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
      const tables = /^ALL\s+TABLES/iu.test(target)
        ? [...present]
        : target.replace(/^TABLE\s+/iu, '').split(',').map(bare).filter(name => name.length > 0);
      const roles = (grant[4] ?? '')
        .split(',')
        .map(role => bare(role))
        .filter(role => COMPARED_ROLES.includes(role));

      for (const role of roles) {
        for (const table of tables) {
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
  return matrix;
}

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

/** Compare declared with actual, over the tables the database actually has. */
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
