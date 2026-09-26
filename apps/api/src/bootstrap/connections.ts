import pg from 'pg';
import type { QueryResultRowLike, SessionQueryable } from '@fss/domain/db/queryable.ts';
import { errorFields, type Logger } from './log.ts';

/**
 * One database connection per request.
 *
 * Until this lane the API served every request on one `pg.Client`. node-postgres
 * serializes *statements* on a client, but not *transactions*: `withTransaction`
 * issues `BEGIN`, the work and `COMMIT` as separate statements, so two requests in
 * flight at once interleaved inside one backend transaction. A request that rolled
 * back discarded the writes of a request that had already answered 200; a request that
 * committed committed the half-done work of one that was about to fail; and a
 * `FOR UPDATE` or advisory lock taken by one request was already "held" by every
 * other, because they were the same session. The desktop's Home fires several
 * requests at once at launch, so this was live (audit item C01, 25 September 2026).
 *
 * The shape now:
 *
 * - `createRequestPool` is the process's one `pg.Pool`, bounded at
 *   `API_POOL_MAX_CONNECTIONS` (the arithmetic is in
 *   `docs/decisions/g75-one-connection-per-request.md`).
 * - `requestConnection` is what `server.ts` opens for each request. It checks nothing
 *   out until the request's first statement, then keeps that one backend for every
 *   statement after it — authentication, renewal, the command receipt, the route and
 *   the receipt's commit — and `release()` in the handler's `finally` gives it back.
 *   `/healthz` and a refusal that never reaches the database hold no connection.
 * - A checkout that cannot be satisfied inside `API_POOL_CHECKOUT_TIMEOUT_MILLISECONDS`
 *   is a `DatabaseBusyError`, which the handler answers 503 `database_busy`.
 *
 * `SessionQueryable` is the promise "one backend for the whole lifetime"; the session
 * `requestConnection` hands out keeps it for exactly one request, and refuses to be
 * used after the request has finished rather than run a straggling statement on a
 * backend another request now owns.
 */

/**
 * Per API task. Two tasks, doubled during a rolling deployment, is 4 × (8 + 1
 * heartbeat) = 36 connections against a `db.t4g.small` whose default
 * `max_connections` is roughly 200; the worker holds `FSS_WORKER_CONCURRENCY + 2`.
 */
export const API_POOL_MAX_CONNECTIONS = 8;
/** How long a request waits for a free connection before it is refused `database_busy`. */
export const API_POOL_CHECKOUT_TIMEOUT_MILLISECONDS = 5_000;
/** An idle connection is closed after a minute, so a quiet API holds almost nothing. */
export const API_POOL_IDLE_TIMEOUT_MILLISECONDS = 60_000;

/** No connection could be had in time. Answered 503 `database_busy`; the caller may retry. */
export class DatabaseBusyError extends Error {
  readonly code = 'database_busy';

  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'DatabaseBusyError';
  }
}

/** One backend, checked out for one request. */
export interface CheckedOutConnection {
  readonly session: SessionQueryable;
  /** Give the backend back. Called exactly once, by `requestConnection`. */
  release(): void;
}

/** Where each request's connection comes from. `poolConnections` in production. */
export interface RequestConnections {
  checkout(): Promise<CheckedOutConnection>;
}

/** What `server.ts` holds for the life of one request. */
export interface RequestConnection {
  /** Checks a backend out on its first statement and keeps it for every statement after. */
  readonly session: SessionQueryable;
  /** Give the backend back, if one was checked out. Idempotent; the session is dead after it. */
  release(): void;
}

/**
 * The per-request connection.
 *
 * Lazy, so that a request which never touches the database — `/healthz`, a refused
 * envelope, an unmounted path — never waits for a connection it does not need, and a
 * liveness check keeps answering while the pool is exhausted. Memoized, so two
 * statements a route happens to start together share one checkout rather than taking
 * two backends and splitting the request across them.
 */
export function requestConnection(connections: RequestConnections): RequestConnection {
  let pending: Promise<CheckedOutConnection> | null = null;
  let released = false;

  const session: SessionQueryable = {
    async query<Row extends QueryResultRowLike = QueryResultRowLike>(text: string, values?: readonly unknown[]) {
      if (released) throw new Error('this request has finished; its database connection was returned');
      pending ??= connections.checkout();
      const connection = await pending;
      if (released) throw new Error('this request has finished; its database connection was returned');
      return await connection.session.query<Row>(text, values);
    },
  };

  return {
    session,
    release: () => {
      if (released) return;
      released = true;
      // A checkout still in flight is returned the moment it arrives; a failed one
      // has nothing to return.
      pending?.then(
        connection => connection.release(),
        () => undefined,
      );
    },
  };
}

/** A session with no connection behind it, for the registry `createApiServer` builds once. */
export function unconnectedSession(): SessionQueryable {
  return {
    query: () => Promise.reject(new Error('there is no request in progress, so there is no database connection')),
  };
}

function sessionOf(client: pg.PoolClient): SessionQueryable {
  return {
    async query<Row extends QueryResultRowLike = QueryResultRowLike>(text: string, values?: readonly unknown[]) {
      const result = await client.query(text, values === undefined ? undefined : [...values]);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    },
  };
}

/** pg-pool 3's words for "every connection is in use and none came free in time". */
const CHECKOUT_TIMED_OUT = 'timeout exceeded when trying to connect';
/** And for a checkout that arrives after `pool.end()` — a task that is stopping. */
const POOL_ENDED = 'Cannot use a pool after calling end on the pool';
/** SQLSTATE `too_many_connections`: PostgreSQL itself is out of connection slots. */
const TOO_MANY_CONNECTIONS = '53300';

function isBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message === CHECKOUT_TIMED_OUT || error.message === POOL_ENDED) return true;
  return (error as Error & { readonly code?: unknown }).code === TOO_MANY_CONNECTIONS;
}

async function checkoutClient(pool: pg.Pool): Promise<pg.PoolClient> {
  try {
    return await pool.connect();
  } catch (error) {
    // Anything else — a refused socket, a failed handshake, a wrong password — is the
    // database being unreachable, and propagates as itself: `/readyz` reports it as
    // `database_unreachable` and any other route as `internal_error`, as before.
    if (isBusy(error)) throw new DatabaseBusyError('no database connection came free in time', { cause: error });
    throw error;
  }
}

function leaseOf(client: pg.PoolClient, log: Logger | undefined): CheckedOutConnection {
  return {
    session: sessionOf(client),
    release: () => {
      // A connection is returned to the pool only when it is idle. One still inside a
      // transaction — a route that opened one and returned or threw without closing it
      // — would hand the next request somebody else's transaction, so it is destroyed
      // instead, which PostgreSQL rolls back.
      const status = client.getTransactionStatus();
      if (status === 'I') {
        client.release();
        return;
      }
      log?.log('warn', 'api_connection_discarded', { transaction_status: status ?? 'unknown' });
      client.release(new Error('the request left its connection inside a transaction'));
    },
  };
}

/** The production `RequestConnections`: one pool client per request. */
export function poolConnections(pool: pg.Pool, log?: Logger): RequestConnections {
  return {
    checkout: async () => leaseOf(await checkoutClient(pool), log),
  };
}

export interface RequestPoolOptions {
  readonly max?: number;
  readonly checkoutTimeoutMilliseconds?: number;
  readonly idleTimeoutMilliseconds?: number;
}

/**
 * The API's request pool.
 *
 * TLS is whatever `PGSSLMODE` says, exactly as it was for the single client this
 * replaces (`test/release/databaseTls.check.ts`): nothing here sets `ssl`.
 *
 * An idle client whose backend goes away — a Multi-AZ failover, an operator's
 * `pg_terminate_backend`, an idle timeout on the server — makes the pool emit `error`.
 * With no listener that is an uncaught exception and the task dies; with this one it
 * is a `warn` line, the pool drops the client, and the next request connects afresh.
 */
export function createRequestPool(connectionString: string, log: Logger, options: RequestPoolOptions = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    application_name: 'fss-api',
    max: options.max ?? API_POOL_MAX_CONNECTIONS,
    connectionTimeoutMillis: options.checkoutTimeoutMilliseconds ?? API_POOL_CHECKOUT_TIMEOUT_MILLISECONDS,
    idleTimeoutMillis: options.idleTimeoutMilliseconds ?? API_POOL_IDLE_TIMEOUT_MILLISECONDS,
  });
  pool.on('error', error => {
    log.log('warn', 'api_pool_client_error', errorFields(error));
  });
  return pool;
}

/**
 * Startup's one connectivity check: a client, `SELECT 1`, released. A database that
 * cannot be reached at all fails here, as `requestClient.connect()` did before this
 * lane; a database that can be reached but not used is `/readyz`'s to report.
 */
export async function verifyPoolConnectivity(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}
