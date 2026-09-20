import type { QueryResultRowLike } from './queryable.ts';
import type { LookupKey, LookupValue, ScopedTable } from './lookupKeys.ts';
import { matchLookupKey } from './lookupKeys.ts';
import type { RepositoryContext } from './workspaceScope.ts';

/**
 * The scoped query helpers. Every statement they build begins with
 * `WHERE workspace_id = $1`, and the value of `$1` is the scope's, never an argument.
 *
 * `selectOne(context, 'command_receipts', { device_id, command_id })` typechecks;
 * `selectOne(context, 'command_receipts', { id })` does not, because
 * `command_receipts` declares exactly one lookup key and `id` is not in it.
 */

export class ScopedQueryError extends Error {
  constructor(readonly code: 'LOOKUP_KEY_UNDECLARED' | 'LOOKUP_KEY_EMPTY', message: string) {
    super(message);
    this.name = 'ScopedQueryError';
  }
}

function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new ScopedQueryError('LOOKUP_KEY_UNDECLARED', `not an identifier: ${value}`);
  }
  return value;
}

interface BuiltPredicate {
  readonly text: string;
  readonly values: readonly LookupValue[];
}

function buildPredicate(context: RepositoryContext, table: ScopedTable, key: Readonly<Record<string, LookupValue>>): BuiltPredicate {
  const columns = Object.keys(key);
  if (columns.length === 0) {
    throw new ScopedQueryError('LOOKUP_KEY_EMPTY', `a lookup on ${table} names at least one column beside workspace_id`);
  }
  if (matchLookupKey(table, columns) === null) {
    throw new ScopedQueryError(
      'LOOKUP_KEY_UNDECLARED',
      `(${columns.join(', ')}) is not a declared unique lookup key of ${table}`,
    );
  }
  const values: LookupValue[] = [context.scope.workspaceId];
  const clauses = ['workspace_id = $1'];
  for (const column of columns) {
    const value = key[column];
    if (value === undefined) {
      throw new ScopedQueryError('LOOKUP_KEY_EMPTY', `lookup column ${column} of ${table} has no value`);
    }
    values.push(value);
    clauses.push(`${identifier(column)} = $${String(values.length)}`);
  }
  return { text: clauses.join(' AND '), values };
}

/** One row by a declared lookup key, or null. Never more than one: the key is unique. */
export async function selectOne<Row extends QueryResultRowLike, Table extends ScopedTable>(
  context: RepositoryContext,
  table: Table,
  key: LookupKey<Table>,
): Promise<Row | null> {
  const predicate = buildPredicate(context, table, key as Readonly<Record<string, LookupValue>>);
  const { rows } = await context.db.query<Row>(
    `SELECT * FROM ${identifier(table)} WHERE ${predicate.text} LIMIT 2`,
    predicate.values,
  );
  if (rows.length > 1) {
    throw new ScopedQueryError('LOOKUP_KEY_UNDECLARED', `${table} returned more than one row for a unique key`);
  }
  return rows[0] ?? null;
}

/** Every row of a table inside the scope, ordered by the caller's choice of declared column. */
export async function selectAll<Row extends QueryResultRowLike>(
  context: RepositoryContext,
  table: ScopedTable,
  options: { readonly orderBy?: string; readonly limit?: number } = {},
): Promise<Row[]> {
  const order = options.orderBy === undefined ? '' : ` ORDER BY ${identifier(options.orderBy)}`;
  const limit = options.limit === undefined ? '' : ` LIMIT ${String(Math.trunc(options.limit))}`;
  const { rows } = await context.db.query<Row>(
    `SELECT * FROM ${identifier(table)} WHERE workspace_id = $1${order}${limit}`,
    [context.scope.workspaceId],
  );
  return rows;
}

/** Delete by a declared lookup key. Returns how many rows went. */
export async function deleteByKey<Table extends ScopedTable>(
  context: RepositoryContext,
  table: Table,
  key: LookupKey<Table>,
): Promise<number> {
  const predicate = buildPredicate(context, table, key as Readonly<Record<string, LookupValue>>);
  const { rowCount } = await context.db.query(
    `DELETE FROM ${identifier(table)} WHERE ${predicate.text}`,
    predicate.values,
  );
  return rowCount ?? 0;
}

/**
 * Insert a row into a scoped table. `workspace_id` comes from the scope and may not
 * be named in `values`, so a caller cannot write into another workspace by accident.
 */
export async function insertOne<Row extends QueryResultRowLike>(
  context: RepositoryContext,
  table: ScopedTable,
  values: Readonly<Record<string, LookupValue | null>>,
): Promise<Row> {
  if (Object.hasOwn(values, 'workspace_id')) {
    throw new ScopedQueryError('LOOKUP_KEY_UNDECLARED', 'workspace_id comes from the scope, never from the caller');
  }
  const columns = ['workspace_id', ...Object.keys(values).map(identifier)];
  const parameters: (LookupValue | null)[] = [context.scope.workspaceId];
  for (const column of Object.keys(values)) parameters.push(values[column] ?? null);
  const placeholders = parameters.map((_value, index) => `$${String(index + 1)}`);
  const { rows } = await context.db.query<Row>(
    `INSERT INTO ${identifier(table)} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
    parameters,
  );
  const row = rows[0];
  if (row === undefined) throw new ScopedQueryError('LOOKUP_KEY_EMPTY', `${table} insert returned no row`);
  return row;
}
