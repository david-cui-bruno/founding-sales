import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { statementsOf, type Statement } from './sql.ts';

/**
 * `infra/scripts/classify-migration.sh <file>` — what a migration does, in one word.
 *
 * The release procedure (docs/greenfield/release.md 3) asks for a rehearsal only for a
 * migration that touches something that already exists. This is the answer to that
 * question, derived from the file's statements rather than from its prose, and printed
 * with the statements that decided it so that the answer can be argued with.
 *
 * "Existing" is not guessed from a name. The tables that exist at N are the ones the
 * migrations before this one create and do not drop, read out of the same directory.
 */

export type MigrationClass = 'additive' | 'touches-existing' | 'privilege' | 'destructive';

export interface Decision {
  readonly kind: MigrationClass;
  readonly statement: Statement;
  readonly why: string;
}

export interface Classification {
  readonly file: string;
  readonly version: number;
  /** The schema version the file is applied on top of. */
  readonly appliedOn: number;
  readonly kind: MigrationClass;
  /** Every decision the statements support, strongest first. */
  readonly decisions: readonly Decision[];
  /** The tables that exist at `appliedOn`, in creation order. */
  readonly existingTables: readonly string[];
}

/** Strongest first: a file that drops a column and grants on a new table is destructive. */
const RANK: readonly MigrationClass[] = ['destructive', 'touches-existing', 'privilege', 'additive'];

const FILE_NAME = /^(\d{4})_([a-z0-9_]+)\.sql$/u;

/** An unquoted or double-quoted identifier, without its schema qualification. */
function bareName(raw: string): string {
  const trimmed = raw.trim().replace(/[,;]+$/u, '');
  const last = trimmed.split('.').pop() ?? trimmed;
  return last.startsWith('"') ? last.slice(1, -1) : last.toLowerCase();
}

/** `DROP TABLE a, b, c` names three tables, and the drop of the first is not the statement. */
function nameList(raw: string): readonly string[] {
  return raw
    .split(',')
    .map(part => bareName(part))
    .filter(name => name.length > 0 && !/^(cascade|restrict)$/u.test(name));
}

/** The tables migrations 1..`through` in `directory` leave behind. */
export function tablesAt(directory: string, through: number): readonly string[] {
  const present: string[] = [];
  for (const fileName of readdirSync(directory).sort()) {
    const match = FILE_NAME.exec(fileName);
    if (match === null) continue;
    if (Number(match[1]) > through) continue;
    for (const statement of statementsOf(readFileSync(join(directory, fileName), 'utf8'))) {
      const created = /^CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)/iu.exec(statement.normalized);
      if (created?.[1] !== undefined) {
        const name = bareName(created[1]);
        if (!present.includes(name)) present.push(name);
        continue;
      }
      const dropped = /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^;]+)/iu.exec(statement.normalized);
      if (dropped?.[1] !== undefined) {
        for (const name of nameList(dropped[1])) {
          const at = present.indexOf(name);
          if (at !== -1) present.splice(at, 1);
        }
      }
    }
  }
  return present;
}

function decide(statement: Statement, existing: readonly string[]): Decision | null {
  const sql = statement.normalized;
  const exists = (name: string): boolean => existing.includes(bareName(name));

  // ------------------------------------------------------------- destructive
  const dropTable = /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^;]+)/iu.exec(sql);
  if (dropTable?.[1] !== undefined) {
    return { kind: 'destructive', statement, why: `DROP TABLE ${nameList(dropTable[1]).join(', ')}` };
  }
  const dropColumn = /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([^\s]+)[\s\S]*?\bDROP\s+COLUMN\b/iu.exec(sql);
  if (dropColumn?.[1] !== undefined) {
    return { kind: 'destructive', statement, why: `DROP COLUMN on ${bareName(dropColumn[1])}` };
  }
  const truncate = /^TRUNCATE\s+(?:TABLE\s+)?([^\s;]+)/iu.exec(sql);
  if (truncate?.[1] !== undefined) {
    return { kind: 'destructive', statement, why: `TRUNCATE ${bareName(truncate[1])}` };
  }
  const del = /^DELETE\s+FROM\s+(?:ONLY\s+)?([^\s;]+)([\s\S]*)$/iu.exec(sql);
  if (del?.[1] !== undefined) {
    if (!/\bWHERE\b/iu.test(del[2] ?? '')) {
      return { kind: 'destructive', statement, why: `DELETE without a WHERE on ${bareName(del[1])}` };
    }
    return { kind: 'touches-existing', statement, why: `DELETE on ${bareName(del[1])}` };
  }

  // ---------------------------------------------------------- touches-existing
  const alter = /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([^\s]+)/iu.exec(sql);
  if (alter?.[1] !== undefined) {
    const table = bareName(alter[1]);
    if (exists(table)) {
      const check = /\bADD\s+CONSTRAINT\s+\S+\s+CHECK\b/iu.test(sql) ? 'a CHECK added to ' : '';
      return { kind: 'touches-existing', statement, why: `ALTER TABLE: ${check}${table}` };
    }
    return null;
  }
  const index = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:\S+\s+)?ON\s+(?:ONLY\s+)?([^\s(]+)/iu.exec(sql);
  if (index?.[1] !== undefined) {
    const table = bareName(index[1]);
    return exists(table) ? { kind: 'touches-existing', statement, why: `CREATE INDEX on ${table}` } : null;
  }
  const update = /^UPDATE\s+(?:ONLY\s+)?([^\s]+)/iu.exec(sql);
  if (update?.[1] !== undefined) {
    const table = bareName(update[1]);
    return exists(table) ? { kind: 'touches-existing', statement, why: `UPDATE on ${table}` } : null;
  }
  const insert = /^INSERT\s+INTO\s+([^\s(]+)/iu.exec(sql);
  if (insert?.[1] !== undefined) {
    const table = bareName(insert[1]);
    return exists(table) ? { kind: 'touches-existing', statement, why: `INSERT on ${table}` } : null;
  }

  // -------------------------------------------------------------- privilege
  const grant = /^(GRANT|REVOKE)\b([\s\S]*)$/iu.exec(sql);
  if (grant?.[1] !== undefined) {
    const on = /\bON\s+(?:TABLE\s+)?(ALL\s+TABLES\s+IN\s+SCHEMA\s+\S+|SCHEMA\s+\S+|[^\s]+)/iu.exec(grant[2] ?? '');
    const target = on?.[1] ?? '';
    if (/^ALL\s+TABLES/iu.test(target) || /^SCHEMA/iu.test(target)) {
      return { kind: 'privilege', statement, why: `${grant[1].toUpperCase()} on ${target.replace(/\s+/gu, ' ')}` };
    }
    if (target.length > 0 && exists(target)) {
      return { kind: 'privilege', statement, why: `${grant[1].toUpperCase()} on the existing ${bareName(target)}` };
    }
    // A role grant (`GRANT role TO role`) names no object.
    if (target.length === 0) return { kind: 'privilege', statement, why: 'a role membership grant' };
    return null;
  }
  if (/^ALTER\s+ROLE\b/iu.test(sql)) return { kind: 'privilege', statement, why: 'ALTER ROLE' };

  return null;
}

export function classifyMigration(file: string, options: { readonly appliedOn?: number } = {}): Classification {
  const name = basename(file);
  const match = FILE_NAME.exec(name);
  if (match === null) throw new Error(`not a migration file name: ${name}`);
  const version = Number(match[1]);
  const appliedOn = options.appliedOn ?? version - 1;
  const existing = tablesAt(dirname(file), appliedOn);

  const decisions: Decision[] = [];
  for (const statement of statementsOf(readFileSync(file, 'utf8'))) {
    const decision = decide(statement, existing);
    if (decision !== null) decisions.push(decision);
  }
  decisions.sort((left, right) => RANK.indexOf(left.kind) - RANK.indexOf(right.kind));
  const kind = decisions[0]?.kind ?? 'additive';
  return { file: name, version, appliedOn, kind, decisions, existingTables: existing };
}

/** The lines `classify-migration.sh` prints: the class, then what decided it. */
export function renderClassification(result: Classification): string {
  const lines: string[] = [result.kind];
  const deciding = result.decisions.filter(decision => decision.kind === result.kind);
  if (deciding.length === 0) {
    lines.push(
      `  no statement touches an object that exists at schema ${String(result.appliedOn)}; every object this file names is new`,
    );
  }
  for (const decision of deciding) {
    lines.push(`  ${result.file}:${String(decision.statement.line)}  ${decision.why}`);
    lines.push(`    ${decision.statement.text.split('\n').filter(text => !text.trim().startsWith('--')).join(' ').replace(/\s+/gu, ' ').slice(0, 200)}`);
  }
  return lines.join('\n');
}
