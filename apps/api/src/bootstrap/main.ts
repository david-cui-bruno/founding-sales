import type { Server } from 'node:http';
import pg from 'pg';
import type { QueryResultRowLike, SessionQueryable } from '@fss/domain/db';
import { ApiConfigError, describeApiConfig, readApiConfig, type ApiConfig } from './config.ts';
import { startApiHeartbeat } from './heartbeat.ts';
import { createLogger, errorFields } from './log.ts';
import { createBootstrapServer } from './server.ts';

/**
 * The API container's entry point.
 *
 * `--selftest` reads the environment, prints what it decided and exits, without
 * opening a database or a socket. The image build in CI runs it to prove the container
 * can load its own code; it is the cheapest test that catches a missing dependency in
 * a production image, and it reaches nothing.
 *
 * The process does not refuse to start on a database it cannot use. That is the one
 * place where the API and the worker differ deliberately: a worker that does not
 * understand the schema must not write, so it exits, while an API that cannot serve
 * still has to answer `/healthz` and fail `/readyz` so the load balancer takes it out
 * of rotation and an operator can read its logs rather than a crash loop.
 */

export const API_EXIT_CODES = Object.freeze({
  ok: 0,
  configurationInvalid: 12,
  listenFailed: 13,
});

function asSession(client: pg.Client): SessionQueryable {
  return {
    async query<Row extends QueryResultRowLike = QueryResultRowLike>(text: string, values?: readonly unknown[]) {
      const result = await client.query(text, values === undefined ? undefined : [...values]);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    },
  };
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolve);
  });
}

export async function main(argv: readonly string[], environment: NodeJS.ProcessEnv): Promise<number> {
  let config: ApiConfig;
  const bootLog = createLogger({ component: 'api', instanceKey: 'boot' });
  try {
    config = readApiConfig(environment);
  } catch (error) {
    bootLog.log('error', 'api_configuration_refused', {
      ...errorFields(error),
      code: error instanceof ApiConfigError ? error.code : null,
    });
    return API_EXIT_CODES.configurationInvalid;
  }

  const log = createLogger({ component: 'api', instanceKey: config.instanceKey });
  if (argv.includes('--selftest')) {
    log.log('info', 'api_selftest', describeApiConfig(config));
    return API_EXIT_CODES.ok;
  }
  log.log('info', 'api_configuration', describeApiConfig(config));

  // One connection for requests, one for the heartbeat: a heartbeat that waits behind
  // a slow query is a heartbeat that reports the queue rather than the process.
  const requestClient = new pg.Client({ connectionString: config.database.connectionString, application_name: 'fss-api' });
  const heartbeatClient = new pg.Client({
    connectionString: config.database.connectionString,
    application_name: 'fss-api-heartbeat',
  });
  await requestClient.connect();
  await heartbeatClient.connect();

  const server = createBootstrapServer({
    session: asSession(requestClient),
    expectedSystemGeneration: config.expectedSystemGeneration,
    log,
  });
  const heartbeat = startApiHeartbeat({
    session: asSession(heartbeatClient),
    instanceKey: config.instanceKey,
    intervalMilliseconds: config.heartbeatIntervalMilliseconds,
    log,
  });

  try {
    await listen(server, config.port);
  } catch (error) {
    log.log('error', 'api_listen_failed', { port: config.port, ...errorFields(error) });
    await heartbeat.stop();
    await requestClient.end().catch(() => undefined);
    await heartbeatClient.end().catch(() => undefined);
    return API_EXIT_CODES.listenFailed;
  }
  log.log('info', 'api_listening', { port: config.port });

  await new Promise<void>(resolve => {
    const shutdown = (signal: NodeJS.Signals): void => {
      log.log('info', 'api_stopping', { reason: signal });
      // Stop accepting, let the requests in flight finish, then close the loop.
      server.close(() => resolve());
      const deadline = setTimeout(() => resolve(), config.shutdownTimeoutMilliseconds);
      deadline.unref?.();
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  });

  await heartbeat.stop();
  await requestClient.end().catch(() => undefined);
  await heartbeatClient.end().catch(() => undefined);
  log.log('info', 'api_stopped', {});
  return API_EXIT_CODES.ok;
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
