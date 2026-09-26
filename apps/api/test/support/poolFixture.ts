import type pg from 'pg';
import { CLUSTER_URL_ENVIRONMENT_VARIABLE, type TestDatabase } from '@fss/domain/db/testing/testDatabase.ts';
import { createRequestPool, type RequestPoolOptions } from '../../src/bootstrap/connections.ts';
import { recordingLogger, type Logger } from '../../src/bootstrap/log.ts';

/**
 * A request pool over a test database: what `bootstrap/main.ts` builds, pointed at the
 * database this test file created.
 *
 * `TestDatabase` hands out single sessions; a server needs a connection string it can
 * open as many backends on as the pool asks for. The cluster URL globalSetup published
 * names the superuser, and the test database is that cluster with another path.
 */
export function databaseUrlOf(database: TestDatabase): string {
  const cluster = process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE];
  if (cluster === undefined || cluster.trim().length === 0) {
    throw new Error(`${CLUSTER_URL_ENVIRONMENT_VARIABLE} is unset; run this through vitest`);
  }
  const url = new URL(cluster.trim());
  url.pathname = `/${database.name}`;
  return url.toString();
}

export function testRequestPool(
  database: TestDatabase,
  options: RequestPoolOptions & { readonly log?: Logger } = {},
): pg.Pool {
  return createRequestPool(databaseUrlOf(database), options.log ?? recordingLogger(), options);
}

/** Connections checked out and not yet given back. */
export function leased(pool: pg.Pool): number {
  return pool.totalCount - pool.idleCount;
}
