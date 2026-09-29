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
 * "Existing" is not guessed from a name. The objects that exist at N are the ones the
 * migrations before this one create and do not drop, read out of the same directory.
 *
 * The classifier fails CLOSED. An earlier version recognised a short list of top-level
 * forms and let everything else fall through to `additive`, which meant that
 * `DO $$ BEGIN DELETE FROM sessions; END $$;` was reported as needing no rehearsal:
 * the statement was not an ALTER, an UPDATE or a DELETE at the top level, so nothing
 * matched, and a table with no fixture rows moves no content hash either. So every
 * form the classifier does not know is now `unclassified`, which the release procedure
 * must treat as at least as loud as `touches-existing`.
 */

export type MigrationClass =
  | 'additive'
  | 'replaces-routine'
  | 'touches-existing'
  | 'privilege'
  | 'destructive'
  | 'unclassified';

export interface Decision {
  readonly kind: MigrationClass;
  readonly statement: Statement;
  readonly why: string;
  /** The routine a `replaces-routine` decision is about, by bare name. */
  readonly routine?: string;
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
  /** Routines this file replaces that already existed. Empty unless `replaces-routine` applies. */
  readonly routinesReplaced: readonly string[];
  /** True when any statement was `unclassified`. */
  readonly hasUnclassified: boolean;
}

/**
 * Strongest first: a file that drops a column and grants on a new table is destructive.
 *
 * `unclassified` ranks above `touches-existing` and below `destructive` on purpose.
 * "We do not know what this statement does" must not be reported more quietly than "we
 * know it alters a table", because the unknown statement may be the DELETE above; but a
 * DROP we did recognise is still the loudest thing worth telling the operator.
 */
const RANK: readonly MigrationClass[] = [
  'destructive',
  'unclassified',
  'touches-existing',
  'privilege',
  'replaces-routine',
  'additive',
];

const FILE_NAME = /^(\d{4})_([a-z0-9_]+)\.sql$/u;

/** An unquoted or double-quoted identifier, without its schema qualification. */
function bareName(raw: string): string {
  const trimmed = raw.trim().replace(/[,;]+$/u, '');
  const last = trimmed.split('.').pop() ?? trimmed;
  return last.startsWith('"') ? last.slice(1, -1) : last.toLowerCase();
}

/**
 * A routine's bare name, with any argument list thrown away.
 *
 * `DROP FUNCTION today_refresh_card(uuid, uuid)` and
 * `CREATE OR REPLACE FUNCTION today_refresh_card(p_workspace_id uuid, ...)` have to
 * match each other, and matching on the name alone over-matches overloads. That is the
 * safe direction here: calling a replacement of an overload `replaces-routine` when it
 * is really a new overload costs a rehearsal, the other way round costs a surprise.
 */
function routineName(raw: string): string {
  return bareName(raw.split('(')[0] ?? raw);
}

/** `DROP TABLE a, b, c` names three tables, and the drop of the first is not the statement. */
function nameList(raw: string): readonly string[] {
  return raw
    .split(',')
    .map(part => bareName(part))
    .filter(name => name.length > 0 && !/^(cascade|restrict)$/u.test(name));
}

/** Every kind of object the classifier tracks across a directory of migrations. */
interface Objects {
  readonly tables: readonly string[];
  /**
   * `table\u0000constraint` for every constraint this file ADDs.
   *
   * The one narrowing in a classifier that is otherwise deliberately fail-closed: a
   * `DROP CONSTRAINT x` whose `x` the same file adds back on the same table is a
   * constraint *swap*, and a swap loses no data — it is how a CHECK is widened while
   * keeping the name its failing-insert case is written against (migrations 0014 and
   * 0020 both do exactly that). It is `touches-existing`, which still rehearses.
   * A bare `DROP CONSTRAINT` with no matching ADD stays destructive.
   */
  readonly readdedConstraints: ReadonlySet<string>;
  /** Functions, procedures and triggers, by bare name, argument lists ignored. */
  readonly routines: readonly string[];
  readonly indexes: readonly string[];
  readonly views: readonly string[];
  readonly types: readonly string[];
  readonly sequences: readonly string[];
}

/** Every constraint name a `DROP CONSTRAINT` statement names. */
function droppedConstraintNames(sql: string): readonly string[] {
  return [...sql.matchAll(/\bDROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?([^\s,;]+)/giu)].map(match =>
    bareName(match[1] ?? ''),
  );
}

/** Every constraint name an `ADD CONSTRAINT` in this file gives to `table`. */
function readdedConstraintsOf(sql: string): ReadonlySet<string> {
  const readded = new Set<string>();
  for (const statement of statementsOf(sql)) {
    const table = /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([^\s]+)/iu.exec(statement.normalized);
    if (table?.[1] === undefined) continue;
    const name = bareName(table[1]);
    for (const match of statement.normalized.matchAll(/\bADD\s+CONSTRAINT\s+([^\s(]+)/giu)) {
      readded.add(`${name}\u0000${bareName(match[1] ?? '')}`);
    }
  }
  return readded;
}

function add(into: string[], name: string): void {
  if (name.length > 0 && !into.includes(name)) into.push(name);
}

function remove(from: string[], name: string): void {
  const at = from.indexOf(name);
  if (at !== -1) from.splice(at, 1);
}

/** Fold one statement into the running picture of what exists. */
function applyToObjects(sql: string, objects: {
  tables: string[];
  routines: string[];
  indexes: string[];
  views: string[];
  types: string[];
  sequences: string[];
}): void {
  const created = /^CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)/iu.exec(sql);
  if (created?.[1] !== undefined) {
    add(objects.tables, bareName(created[1]));
    return;
  }
  const droppedTable = /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^;]+)/iu.exec(sql);
  if (droppedTable?.[1] !== undefined) {
    for (const name of nameList(droppedTable[1])) remove(objects.tables, name);
    return;
  }

  const routine = /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?(FUNCTION|PROCEDURE|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)/iu.exec(sql);
  if (routine?.[2] !== undefined) {
    add(objects.routines, routineName(routine[2]));
    return;
  }
  const droppedRoutine = /^DROP\s+(?:FUNCTION|PROCEDURE|ROUTINE|TRIGGER)\s+(?:IF\s+EXISTS\s+)?([^\s(;]+)/iu.exec(sql);
  if (droppedRoutine?.[1] !== undefined) {
    remove(objects.routines, routineName(droppedRoutine[1]));
    return;
  }

  const index = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)\s+ON\b/iu.exec(sql);
  if (index?.[1] !== undefined) {
    add(objects.indexes, bareName(index[1]));
    return;
  }
  const droppedIndex = /^DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?([^;]+)/iu.exec(sql);
  if (droppedIndex?.[1] !== undefined) {
    for (const name of nameList(droppedIndex[1])) remove(objects.indexes, name);
    return;
  }

  const view = /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(]+)/iu.exec(sql);
  if (view?.[1] !== undefined) {
    add(objects.views, bareName(view[1]));
    return;
  }
  const droppedView = /^DROP\s+(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+EXISTS\s+)?([^;]+)/iu.exec(sql);
  if (droppedView?.[1] !== undefined) {
    for (const name of nameList(droppedView[1])) remove(objects.views, name);
    return;
  }

  const type = /^CREATE\s+(?:TYPE|DOMAIN)\s+([^\s(]+)/iu.exec(sql);
  if (type?.[1] !== undefined) {
    add(objects.types, bareName(type[1]));
    return;
  }
  const droppedType = /^DROP\s+(?:TYPE|DOMAIN)\s+(?:IF\s+EXISTS\s+)?([^;]+)/iu.exec(sql);
  if (droppedType?.[1] !== undefined) {
    for (const name of nameList(droppedType[1])) remove(objects.types, name);
    return;
  }

  const sequence = /^CREATE\s+(?:TEMPORARY\s+|TEMP\s+|UNLOGGED\s+)?SEQUENCE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s(;]+)/iu.exec(sql);
  if (sequence?.[1] !== undefined) {
    add(objects.sequences, bareName(sequence[1]));
    return;
  }
  const droppedSequence = /^DROP\s+SEQUENCE\s+(?:IF\s+EXISTS\s+)?([^;]+)/iu.exec(sql);
  if (droppedSequence?.[1] !== undefined) {
    for (const name of nameList(droppedSequence[1])) remove(objects.sequences, name);
  }
}

/** Everything migrations 1..`through` in `directory` leave behind. */
export function objectsAt(directory: string, through: number): Objects {
  const objects = {
    tables: [] as string[],
    routines: [] as string[],
    indexes: [] as string[],
    views: [] as string[],
    types: [] as string[],
    sequences: [] as string[],
    // Filled in by `classifyMigration` from the file it is about to classify: a swap is
    // a property of that file, not of the schema it is applied to.
    readdedConstraints: new Set<string>() as ReadonlySet<string>,
  };
  for (const fileName of readdirSync(directory).sort()) {
    const match = FILE_NAME.exec(fileName);
    if (match === null) continue;
    if (Number(match[1]) > through) continue;
    for (const statement of statementsOf(readFileSync(join(directory, fileName), 'utf8'))) {
      applyToObjects(statement.normalized, objects);
    }
  }
  return objects;
}

/** The tables migrations 1..`through` in `directory` leave behind. */
export function tablesAt(directory: string, through: number): readonly string[] {
  return objectsAt(directory, through).tables;
}

/** The routines (functions, procedures, triggers) migrations 1..`through` leave behind. */
export function routinesAt(directory: string, through: number): readonly string[] {
  return objectsAt(directory, through).routines;
}

/**
 * The body of a `DO` block, or null when the statement is not one.
 *
 * Read out of the raw text rather than the normalized form: normalizing collapses the
 * newlines, and a `--` comment in a body with no newlines left would swallow the rest
 * of the block. The raw text keeps the statement's leading comments, so they are
 * skipped here rather than anchoring straight at `DO`.
 */
const DO_BLOCK = /^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*DO\s+(?:LANGUAGE\s+\w+\s+)?(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)([\s\S]*?)\1/iu;

function doBody(statement: Statement): string | null {
  return DO_BLOCK.exec(statement.text)?.[2] ?? null;
}

/**
 * The statements of a `DO` block's outermost `BEGIN … END`, or null.
 *
 * A body with a `DECLARE` section, an `EXCEPTION` clause or an `IF` is deliberately not
 * unwrapped: this is not a PL/pgSQL interpreter, and a body it cannot read whole stays
 * `unclassified`.
 */
function doStatements(statement: Statement): readonly Statement[] | null {
  const body = doBody(statement);
  if (body === null) return null;
  const block = /^\s*BEGIN\b([\s\S]*)\bEND\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*)?;?\s*$/iu.exec(body);
  if (block?.[1] === undefined) return null;
  return statementsOf(block[1]);
}

const KNOWN_ADDITIVE = [
  // `CREATE TABLE`, and every other create of an object nothing can already depend on.
  /^CREATE\s+(?:UNLOGGED\s+)?TABLE\b/iu,
  /^CREATE\s+(?:EXTENSION|SCHEMA|COLLATION|DOMAIN|TYPE|AGGREGATE|OPERATOR|CAST|TEXT\s+SEARCH)\b/iu,
  // A comment changes no behaviour, so `COMMENT ON` an existing object stays additive:
  // nothing a rehearsal could observe is different afterwards.
  /^COMMENT\s+ON\b/iu,
  // Session settings and transaction control are not schema changes.
  /^(?:SET|RESET|BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/iu,
  /^ANALYZE\b/iu,
] as const;

function decide(statement: Statement, objects: Objects, depth = 0): Decision {
  const sql = statement.normalized;
  const unknown = (): Decision => ({
    kind: 'unclassified',
    statement,
    why: `unrecognised statement form: ${sql.split(/\s+/u).slice(0, 3).join(' ')}`,
  });
  const has = (list: readonly string[], name: string): boolean => list.includes(bareName(name));
  const hasRoutine = (name: string): boolean => objects.routines.includes(routineName(name));

  // -------------------------------------------------------------- DO blocks
  // The bypass the review found. A `DO` block is an opaque program, so it is
  // unclassified unless every statement of its `BEGIN … END` is one we recognise, in
  // which case the block is as strong as the worst of them.
  if (/^DO\b/iu.test(sql)) {
    if (depth > 2) return unknown();
    const inner = doStatements(statement);
    if (inner === null || inner.length === 0) return unknown();
    const decisions = inner.map(each => decide(each, objects, depth + 1));
    if (decisions.some(each => each.kind === 'unclassified')) return unknown();
    const worst = [...decisions].sort((left, right) => RANK.indexOf(left.kind) - RANK.indexOf(right.kind))[0];
    if (worst === undefined) return unknown();
    // Report the DO block itself, so the printed line and text are the operator's.
    return { kind: worst.kind, statement, why: `inside DO $$ … $$: ${worst.why}`, ...(worst.routine === undefined ? {} : { routine: worst.routine }) };
  }

  // ------------------------------------------------------------- destructive
  const dropTable = /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([^;]+)/iu.exec(sql);
  if (dropTable?.[1] !== undefined) {
    return { kind: 'destructive', statement, why: `DROP TABLE ${nameList(dropTable[1]).join(', ')}` };
  }
  const dropColumn = /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([^\s]+)[\s\S]*?\bDROP\s+COLUMN\b/iu.exec(sql);
  if (dropColumn?.[1] !== undefined) {
    return { kind: 'destructive', statement, why: `DROP COLUMN on ${bareName(dropColumn[1])}` };
  }
  const dropConstraint = /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([^\s]+)[\s\S]*?\bDROP\s+CONSTRAINT\b/iu.exec(sql);
  if (dropConstraint?.[1] !== undefined) {
    const table = bareName(dropConstraint[1]);
    const dropped = droppedConstraintNames(sql);
    const swapped = dropped.length > 0 && dropped.every(name => objects.readdedConstraints.has(`${table}\u0000${name}`));
    if (swapped) {
      return {
        kind: 'touches-existing',
        statement,
        why: `constraint swap on ${table}: ${dropped.map(name => `DROP and ADD ${name}`).join(', ')}`,
      };
    }
    return { kind: 'destructive', statement, why: `DROP CONSTRAINT on ${table}` };
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
  // A DROP of an object no earlier migration in this directory leaves behind destroys
  // nothing this schema owns; a DROP of one that is there is the loudest thing a
  // migration can do. Routines match on the bare name, overloads and all.
  const dropRoutine = /^DROP\s+(FUNCTION|PROCEDURE|ROUTINE|TRIGGER)\s+(?:IF\s+EXISTS\s+)?([^\s(;]+)/iu.exec(sql);
  if (dropRoutine?.[2] !== undefined) {
    const name = routineName(dropRoutine[2]);
    const word = (dropRoutine[1] ?? 'ROUTINE').toUpperCase();
    return hasRoutine(name)
      ? { kind: 'destructive', statement, why: `DROP ${word} ${name}` }
      : { kind: 'additive', statement, why: `DROP ${word} of ${name}, which does not exist at this version` };
  }
  const dropOther = /^DROP\s+(INDEX|MATERIALIZED\s+VIEW|VIEW|TYPE|DOMAIN|SEQUENCE)\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?([^\s;,]+)/iu.exec(sql);
  if (dropOther?.[2] !== undefined) {
    const kindWord = (dropOther[1] ?? '').toUpperCase().replace(/\s+/gu, ' ');
    const name = bareName(dropOther[2]);
    const pool = kindWord === 'INDEX'
      ? objects.indexes
      : kindWord.endsWith('VIEW')
        ? objects.views
        : kindWord === 'SEQUENCE'
          ? objects.sequences
          : objects.types;
    return pool.includes(name)
      ? { kind: 'destructive', statement, why: `DROP ${kindWord} ${name}` }
      : { kind: 'additive', statement, why: `DROP ${kindWord} of ${name}, which does not exist at this version` };
  }

  // --------------------------------------------------------- replaces-routine
  // Replacing a routine adds no column and drops no row, but everything that calls it
  // behaves differently afterwards, which is exactly what a rehearsal is for.
  const replace = /^CREATE\s+OR\s+REPLACE\s+(?:CONSTRAINT\s+)?(FUNCTION|PROCEDURE|TRIGGER)\s+([^\s(]+)/iu.exec(sql);
  if (replace?.[2] !== undefined) {
    const name = routineName(replace[2]);
    const word = (replace[1] ?? 'ROUTINE').toUpperCase();
    return hasRoutine(name)
      ? { kind: 'replaces-routine', statement, why: `CREATE OR REPLACE ${word} ${name}, which already exists`, routine: name }
      : { kind: 'additive', statement, why: `CREATE OR REPLACE ${word} ${name}, a new routine` };
  }
  const alterRoutine = /^ALTER\s+(FUNCTION|PROCEDURE|ROUTINE)\s+([^\s(]+)/iu.exec(sql);
  if (alterRoutine?.[2] !== undefined) {
    const name = routineName(alterRoutine[2]);
    const word = (alterRoutine[1] ?? 'ROUTINE').toUpperCase();
    return hasRoutine(name)
      ? { kind: 'replaces-routine', statement, why: `ALTER ${word} ${name}, which already exists`, routine: name }
      : { kind: 'additive', statement, why: `ALTER ${word} ${name}, which does not exist at this version` };
  }

  // ---------------------------------------------------------- touches-existing
  const alter = /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([^\s]+)/iu.exec(sql);
  if (alter?.[1] !== undefined) {
    const table = bareName(alter[1]);
    if (has(objects.tables, table)) {
      const check = /\bADD\s+CONSTRAINT\s+\S+\s+CHECK\b/iu.test(sql) ? 'a CHECK added to ' : '';
      // A default is a behaviour change for every INSERT that omits the column, so it
      // belongs here rather than with the plain ADD COLUMN it often travels with.
      const def = /\bALTER\s+(?:COLUMN\s+)?\S+\s+(SET|DROP)\s+DEFAULT\b/iu.exec(sql);
      const why = def?.[1] !== undefined
        ? `ALTER TABLE: ${def[1].toUpperCase()} DEFAULT on ${table}`
        : `ALTER TABLE: ${check}${table}`;
      return { kind: 'touches-existing', statement, why };
    }
    return { kind: 'additive', statement, why: `ALTER TABLE on ${table}, which this file creates` };
  }
  const index = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:\S+\s+)?ON\s+(?:ONLY\s+)?([^\s(]+)/iu.exec(sql);
  if (index?.[1] !== undefined) {
    const table = bareName(index[1]);
    return has(objects.tables, table)
      ? { kind: 'touches-existing', statement, why: `CREATE INDEX on ${table}` }
      : { kind: 'additive', statement, why: `CREATE INDEX on ${table}, a new table` };
  }
  // A new trigger on an existing table changes what every write to it does.
  const trigger = /^CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+(\S+)[\s\S]*?\bON\s+(?:ONLY\s+)?([^\s(]+)/iu.exec(sql);
  if (trigger?.[2] !== undefined) {
    const table = bareName(trigger[2]);
    const name = bareName(trigger[1] ?? '');
    return has(objects.tables, table)
      ? { kind: 'touches-existing', statement, why: `CREATE TRIGGER ${name} on ${table}` }
      : { kind: 'additive', statement, why: `CREATE TRIGGER ${name} on ${table}, a new table` };
  }
  const alterSequence = /^ALTER\s+SEQUENCE\s+(?:IF\s+EXISTS\s+)?([^\s;]+)/iu.exec(sql);
  if (alterSequence?.[1] !== undefined) {
    const name = bareName(alterSequence[1]);
    return objects.sequences.includes(name)
      ? { kind: 'touches-existing', statement, why: `ALTER SEQUENCE ${name}` }
      : { kind: 'additive', statement, why: `ALTER SEQUENCE ${name}, which this file creates` };
  }
  const owned = /^CREATE\s+(?:TEMPORARY\s+|TEMP\s+|UNLOGGED\s+)?SEQUENCE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s;]+)[\s\S]*?\bOWNED\s+BY\s+([^\s;]+)/iu.exec(sql);
  if (owned?.[2] !== undefined) {
    const parts = owned[2].split('.');
    const table = bareName(parts.slice(0, -1).join('.'));
    const name = bareName(owned[1] ?? '');
    return has(objects.tables, table)
      ? { kind: 'touches-existing', statement, why: `CREATE SEQUENCE ${name} OWNED BY a column of ${table}` }
      : { kind: 'additive', statement, why: `CREATE SEQUENCE ${name} OWNED BY a column of ${table}, a new table` };
  }
  const update = /^UPDATE\s+(?:ONLY\s+)?([^\s]+)/iu.exec(sql);
  if (update?.[1] !== undefined) {
    const table = bareName(update[1]);
    return has(objects.tables, table)
      ? { kind: 'touches-existing', statement, why: `UPDATE on ${table}` }
      : { kind: 'additive', statement, why: `UPDATE on ${table}, a new table` };
  }
  const insert = /^INSERT\s+INTO\s+([^\s(]+)/iu.exec(sql);
  if (insert?.[1] !== undefined) {
    const table = bareName(insert[1]);
    return has(objects.tables, table)
      ? { kind: 'touches-existing', statement, why: `INSERT on ${table}` }
      : { kind: 'additive', statement, why: `INSERT on ${table}, a new table` };
  }

  // -------------------------------------------------------------- privilege
  const grant = /^(GRANT|REVOKE)\b([\s\S]*)$/iu.exec(sql);
  if (grant?.[1] !== undefined) {
    const on = /\bON\s+(?:TABLE\s+)?(ALL\s+TABLES\s+IN\s+SCHEMA\s+\S+|SCHEMA\s+\S+|[^\s]+)/iu.exec(grant[2] ?? '');
    const target = on?.[1] ?? '';
    if (/^ALL\s+TABLES/iu.test(target) || /^SCHEMA/iu.test(target)) {
      return { kind: 'privilege', statement, why: `${grant[1].toUpperCase()} on ${target.replace(/\s+/gu, ' ')}` };
    }
    if (target.length > 0 && has(objects.tables, target)) {
      return { kind: 'privilege', statement, why: `${grant[1].toUpperCase()} on the existing ${bareName(target)}` };
    }
    // A role grant (`GRANT role TO role`) names no object.
    if (target.length === 0) return { kind: 'privilege', statement, why: 'a role membership grant' };
    return { kind: 'additive', statement, why: `${grant[1].toUpperCase()} on ${bareName(target)}, a new object` };
  }
  if (/^(?:ALTER|CREATE|DROP)\s+ROLE\b/iu.test(sql)) {
    return { kind: 'privilege', statement, why: sql.split(/\s+/u).slice(0, 2).join(' ').toUpperCase() };
  }

  // ---------------------------------------------------------------- additive
  const routine = /^CREATE\s+(FUNCTION|PROCEDURE)\s+([^\s(]+)/iu.exec(sql);
  if (routine?.[2] !== undefined) {
    return { kind: 'additive', statement, why: `CREATE ${(routine[1] ?? 'ROUTINE').toUpperCase()} ${routineName(routine[2])}` };
  }
  const newObject = /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+([^\s(]+)/iu.exec(sql);
  if (newObject?.[1] !== undefined) {
    // A view holds no rows: replacing one changes what a reader sees, but nothing a
    // rehearsal of the data could lose, and the release procedure treats it as additive.
    return { kind: 'additive', statement, why: `CREATE VIEW ${bareName(newObject[1])}` };
  }
  const sequence = /^CREATE\s+(?:TEMPORARY\s+|TEMP\s+|UNLOGGED\s+)?SEQUENCE\s+(?:IF\s+NOT\s+EXISTS\s+)?([^\s;]+)/iu.exec(sql);
  if (sequence?.[1] !== undefined) {
    return { kind: 'additive', statement, why: `CREATE SEQUENCE ${bareName(sequence[1])}` };
  }
  for (const pattern of KNOWN_ADDITIVE) {
    if (pattern.test(sql)) {
      return { kind: 'additive', statement, why: sql.split(/\s+/u).slice(0, 3).join(' ') };
    }
  }

  // A bare `SELECT` is deliberately not additive: `SELECT seed_everything(...)` writes.
  return unknown();
}

export function classifyMigration(file: string, options: { readonly appliedOn?: number } = {}): Classification {
  const name = basename(file);
  const match = FILE_NAME.exec(name);
  if (match === null) throw new Error(`not a migration file name: ${name}`);
  const version = Number(match[1]);
  const appliedOn = options.appliedOn ?? version - 1;
  const sql = readFileSync(file, 'utf8');
  const objects = { ...objectsAt(dirname(file), appliedOn), readdedConstraints: readdedConstraintsOf(sql) };

  const decisions: Decision[] = [];
  const routinesReplaced: string[] = [];
  for (const statement of statementsOf(sql)) {
    const decision = decide(statement, objects);
    if (decision.kind === 'replaces-routine' && decision.routine !== undefined) add(routinesReplaced, decision.routine);
    // Every statement earns a decision now, but `additive` ones are not worth printing.
    if (decision.kind !== 'additive') decisions.push(decision);
  }
  decisions.sort((left, right) => RANK.indexOf(left.kind) - RANK.indexOf(right.kind));
  const kind = decisions[0]?.kind ?? 'additive';
  return {
    file: name,
    version,
    appliedOn,
    kind,
    decisions,
    existingTables: objects.tables,
    routinesReplaced,
    hasUnclassified: decisions.some(decision => decision.kind === 'unclassified'),
  };
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
  if (result.kind === 'unclassified') {
    lines.push(
      `  ${String(deciding.length)} statement(s) are in a form this classifier does not recognise; rehearse this migration as if each of them touched everything:`,
    );
  }
  for (const decision of deciding) {
    lines.push(`  ${result.file}:${String(decision.statement.line)}  ${decision.why}`);
    lines.push(`    ${decision.statement.text.split('\n').filter(text => !text.trim().startsWith('--')).join(' ').replace(/\s+/gu, ' ').slice(0, 200)}`);
  }
  if (result.routinesReplaced.length > 0) {
    lines.push(`  routines replaced: ${result.routinesReplaced.join(', ')}`);
  }
  return lines.join('\n');
}
