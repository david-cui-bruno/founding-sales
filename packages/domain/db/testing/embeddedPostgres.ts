import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The local PostgreSQL 16 the greenfield tests run against.
 *
 * Two sources, one interface. In CI the `postgres:16` service container is already
 * listening and its superuser URL arrives in `FSS_TEST_POSTGRES_URL`; locally the
 * `embedded-postgres` package starts a private PostgreSQL 16 cluster in a temporary
 * directory that is removed on stop. Nothing here reaches a network service other
 * than the one the caller already named, and no credential is ever written to disk
 * outside the temporary cluster directory.
 */
export interface PostgresCluster {
  /** Superuser connection URL for the cluster's `postgres` maintenance database. */
  readonly adminUrl: string;
  /** How the cluster was obtained, for diagnostics only. */
  readonly source: 'service-container' | 'embedded';
  stop(): Promise<void>;
}

/** The environment variable a CI service container uses to hand its superuser URL to the tests. */
export const POSTGRES_URL_ENVIRONMENT_VARIABLE = 'FSS_TEST_POSTGRES_URL';

/** The local cluster's superuser. Not a secret: the cluster listens on loopback and lives for one test run. */
const EMBEDDED_USER = 'fss_test_superuser';

async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close(() => { reject(new Error('EMBEDDED_POSTGRES_PORT_UNAVAILABLE')); });
        return;
      }
      const { port } = address;
      server.close(() => { resolve(port); });
    });
  });
}

/** A throwaway password for the loopback-only cluster, generated at runtime and never stored in the repository. */
function throwawayPassword(): string {
  return `p${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/** A `beforeExit` listener, in the shape `process.listeners` hands one back. */
type ExitListener = (...args: unknown[]) => void;

/**
 * The two events whose listeners this module takes back off `process`.
 *
 * Not the signals. `async-exit-hook` also hooks `SIGINT`, `SIGTERM` and `SIGHUP`, and
 * those exit with `128 + signal`, which is the right code for a signal and is what
 * stops a Ctrl-C from leaving a postgres running.
 */
export const RECLAIMED_EXIT_EVENTS = ['beforeExit', 'exit'] as const;

export type ExitListenerSnapshot = ReadonlyMap<string, ReadonlySet<ExitListener>>;

export function snapshotExitListeners(): ExitListenerSnapshot {
  return new Map(
    RECLAIMED_EXIT_EVENTS.map(event => [event, new Set(process.listeners(event) as ExitListener[])]),
  );
}

/**
 * Remove every `beforeExit` and `exit` listener added since the snapshot, and say how
 * many. Both come from one transitive dependency, and each breaks a different thing.
 *
 * `embedded-postgres` registers a cleanup hook with `async-exit-hook` at *import*
 * time. That package hooks `beforeExit` with a hard-coded exit code of zero:
 *
 * ```js
 * add.hookEvent('beforeExit', 0);                   // async-exit-hook/index.js
 * ...
 * process.nextTick(process.exit.bind(null, code));  // code === 0
 * ```
 *
 * `beforeExit` is exactly how a Vitest run ends: the reporter sets
 * `process.exitCode = 1`, the event loop drains, and the process is supposed to exit
 * with that code. The hook calls `process.exit(0)` instead, so **a failing run printed
 * its failures and exited zero** — locally, where the embedded cluster is used. CI
 * never saw it, because `FSS_TEST_POSTGRES_URL` makes `startPostgresCluster` return
 * before the import, so the hook is never registered.
 *
 * The `exit` listener has to go with it, and only removing the first one reveals why.
 * `async-exit-hook` registers `exit` with no code, so its `runHook` takes the
 * synchronous branch and calls the hook **without** the `done` callback it declares —
 * `TypeError: done is not a function`, an unhandled rejection, and a passing run that
 * fails. It was invisible only because the `beforeExit` hook ran first and set the
 * package's `called` flag. An `exit` listener cannot await anything anyway, so nothing
 * is lost by taking it off.
 *
 * See `docs/decisions/g5b-gate-exit-status.md`.
 */
export function removeExitListenersAddedSince(snapshot: ExitListenerSnapshot): number {
  let removed = 0;
  for (const event of RECLAIMED_EXIT_EVENTS) {
    const known = snapshot.get(event) ?? new Set<ExitListener>();
    for (const listener of process.listeners(event) as ExitListener[]) {
      if (known.has(listener)) continue;
      process.removeListener(event, listener);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Start (or adopt) a PostgreSQL 16 cluster for one Vitest run. Prefers the CI service
 * container named by `FSS_TEST_POSTGRES_URL` and falls back to an embedded cluster.
 */
export async function startPostgresCluster(): Promise<PostgresCluster> {
  const provided = process.env[POSTGRES_URL_ENVIRONMENT_VARIABLE];
  if (provided !== undefined && provided.trim().length > 0) {
    return { adminUrl: provided.trim(), source: 'service-container', stop: async () => { /* not ours to stop */ } };
  }

  // Snapshot first: the import itself is what registers the exit hooks that have to go.
  const listenersBeforeImport = snapshotExitListeners();
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  removeExitListenersAddedSince(listenersBeforeImport);

  const databaseDir = await mkdtemp(join(tmpdir(), 'fss-pg-'));
  const port = await freePort();
  const password = throwawayPassword();
  // initdb and postgres both narrate on stdout; the gate output stays readable unless
  // someone is debugging the cluster itself.
  const verbose = process.env['FSS_TEST_POSTGRES_VERBOSE'] === '1';
  const cluster = new EmbeddedPostgres({
    databaseDir,
    user: EMBEDDED_USER,
    password,
    port,
    persistent: false,
    // A cluster that lives for one test run needs no durability: without these three,
    // waiting on disk flushes is most of the suite's wall-clock time.
    postgresFlags: ['-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off'],
    onLog: verbose ? (message: string) => { console.error(message); } : () => undefined,
    onError: verbose ? (message: unknown) => { console.error(message); } : () => undefined,
  });
  await cluster.initialise();
  await cluster.start();

  const adminUrl = `postgresql://${EMBEDDED_USER}:${encodeURIComponent(password)}@127.0.0.1:${String(port)}/postgres`;
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await cluster.stop();
    await rm(databaseDir, { recursive: true, force: true });
  };

  // The safety net the removed hook used to be, without its exit call: a run that ends
  // without reaching the Vitest teardown still stops its cluster. Starting async work
  // in `beforeExit` keeps the loop alive for another turn, which is how the stop gets
  // to finish, and nothing here touches `process.exitCode`.
  process.once('beforeExit', () => {
    void stop().catch(() => undefined);
  });

  return { adminUrl, source: 'embedded', stop };
}
