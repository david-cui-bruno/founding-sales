/**
 * The narrow database surface the greenfield code is written against.
 *
 * `node-postgres` clients and pools satisfy it structurally, so nothing in the domain
 * package imports `pg` types; a test double satisfies it with eight lines. Everything
 * that needs a transaction or a session-level advisory lock takes a `SessionQueryable`,
 * which the caller guarantees is one connection rather than a pool that may hand out a
 * different backend for each statement.
 */

export interface QueryResultRowLike {
  readonly [column: string]: unknown;
}

export interface QueryOutcome<Row extends QueryResultRowLike> {
  readonly rows: Row[];
  readonly rowCount: number | null;
}

export interface Queryable {
  query<Row extends QueryResultRowLike = QueryResultRowLike>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryOutcome<Row>>;
}

/**
 * A `Queryable` the caller promises is a single backend connection for its whole
 * lifetime. Transactions and `pg_advisory_lock` are only correct on one of these.
 */
export interface SessionQueryable extends Queryable {
  readonly __session?: never;
}

/** Values a parameter placeholder may carry. Anything else has to be serialized by the caller. */
export type SqlParameter = string | number | boolean | Date | null;

/** Run `work` inside one transaction on `session`, rolling back on any throw. */
export async function withTransaction<T>(session: SessionQueryable, work: () => Promise<T>): Promise<T> {
  await session.query('BEGIN');
  try {
    const result = await work();
    await session.query('COMMIT');
    return result;
  } catch (error) {
    await session.query('ROLLBACK');
    throw error;
  }
}
