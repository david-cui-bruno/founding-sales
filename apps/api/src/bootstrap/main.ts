import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import pg from 'pg';
import type { QueryResultRowLike, SessionQueryable } from '@fss/domain/db';
import { clientVersionRangeSchema, type ClientVersionRange } from '@fss/contracts';
import { ApiConfigError, describeApiConfig, readApiConfig, type ApiConfig } from './config.ts';
import {
  DeploymentConfigError,
  describeDeployment,
  loadJournalPutObject,
  readApiDeployment,
  type ApiDeployment,
} from './deployment.ts';
import type { AuthDeps } from '../auth/index.ts';
import { JournalConfigurationError } from '../journal/index.ts';
import { startApiHeartbeat } from './heartbeat.ts';
import { createLogger, errorFields } from './log.ts';
import { createApiServer } from '../server.ts';

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

/**
 * The client-version range this container publishes (5.3).
 *
 * The range is what `/auth/client-version` says, and since G12b wired sign-in it is
 * also what every command is checked against: a client outside it may read the
 * upgrade instruction and mutate nothing. The release lane replaces this constant
 * with the range of the signed builds it has actually shipped.
 *
 * The maximum was raised to 1.0.1 for the build that carries the Mailbox row
 * (docs/greenfield/release.md 8.0x), and to 1.0.2 for the build that carries "Your
 * calling number" on the Settings screen (lane g60, 8.0ab) — the control without which
 * no salesperson has a verified number and Today offers no Call button. A client
 * *above* the maximum is `api_behind_client`, which is refused exactly like one below
 * the minimum — every sign-in, renewal and command — so an API still publishing 1.0.1
 * would refuse the very build that lets David call. This API must therefore be
 * deployed before desktop 1.0.2 is published to the channel. The minimum stays 1.0.0,
 * so the installed 1.0.0 and 1.0.1 keep working until they take the update.
 *
 * 1.0.3 is the Home build (lane g65, 8.0ad): Today as the main window's first screen,
 * with the status sidebar, the last seven days and the Needs-you list. It needs no new
 * route and no migration, only this maximum, and the order is the same: the API that
 * publishes 1.0.3 is deployed first, and desktop 1.0.3 is published after it. Until
 * then 1.0.2 and older keep working, and a 1.0.3 Mac would be refused everything.
 *
 * 1.0.4 is the sending-section fix (lane g69, 8.0ae): Administration's "Sending domain
 * and caps" parses the API's `personalGmailRecipients` object at last, a failed sending
 * read says so with Retry, a renewal applies the role the server gives, and Home says
 * Attest when a number is saved. No route changes shape and no migration; the API's
 * only other change is the refusal code in its `refusal` log line. The order is the
 * same again: this API is deployed first, then desktop 1.0.4 is published.
 */
export const CONTAINER_CLIENT_VERSIONS: ClientVersionRange = clientVersionRangeSchema.parse({
  minimum: '1.0.0',
  maximum: '1.0.4',
});

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

  // Everything the deployment was given, decided before a socket or a database is
  // opened. A live deployment missing any part — the Gmail client bundle, the envelope
  // key, the push audience, the object-locked journal bucket — refuses here. That is
  // the difference between an API that answers `not_found` on four mail paths because
  // it has no Google configuration and one that was meant to have one and lost it.
  let deployment: ApiDeployment;
  try {
    // The S3 client is loaded only when a bucket is named, so a laptop never imports
    // it and `--selftest` in the image build never reaches for a credential.
    const bucket = environment['FSS_JOURNAL_BUCKET']?.trim() ?? '';
    deployment = await readApiDeployment(environment, {
      ...(bucket.length === 0
        ? {}
        : { putObject: await loadJournalPutObject(environment['AWS_REGION']?.trim() ?? '') }),
    });
  } catch (error) {
    log.log('error', 'api_deployment_refused', {
      ...errorFields(error),
      code:
        error instanceof DeploymentConfigError
          ? error.code
          : error instanceof JournalConfigurationError
            ? 'JOURNAL_NOT_DURABLE'
            : null,
    });
    return API_EXIT_CODES.configurationInvalid;
  }

  if (argv.includes('--selftest')) {
    log.log('info', 'api_selftest', { ...describeApiConfig(config), ...describeDeployment(deployment) });
    return API_EXIT_CODES.ok;
  }
  log.log('info', 'api_configuration', { ...describeApiConfig(config), ...describeDeployment(deployment) });

  // One connection for requests, one for the heartbeat: a heartbeat that waits behind
  // a slow query is a heartbeat that reports the queue rather than the process.
  const requestClient = new pg.Client({ connectionString: config.database.connectionString, application_name: 'fss-api' });
  const heartbeatClient = new pg.Client({
    connectionString: config.database.connectionString,
    application_name: 'fss-api-heartbeat',
  });
  await requestClient.connect();
  await heartbeatClient.connect();

  // 5.1: identity, assembled from what the deployment decided and the connection that
  // was just opened. `deployment.auth` is absent only when `FSS_DEPENDENCIES=none`,
  // which a production environment refuses, so a production API always mounts sign-in
  // or never started.
  const auth: AuthDeps | undefined =
    deployment.auth === undefined
      ? undefined
      : {
          db: asSession(requestClient),
          config: {
            oidc: deployment.auth.oidc,
            sessions: deployment.auth.sessions,
            supportedClientVersions: CONTAINER_CLIENT_VERSIONS,
            stateSigningKey: deployment.auth.stateSigningKey,
          },
          google: deployment.auth.google,
          now: () => new Date(),
          randomSecret: () => randomBytes(32).toString('base64url'),
          log,
        };

  const server = createApiServer({
    session: asSession(requestClient),
    expectedSystemGeneration: config.expectedSystemGeneration,
    supportedClientVersions: CONTAINER_CLIENT_VERSIONS,
    ...(auth === undefined ? {} : { auth }),
    // Specification 16.2's deployment half: the release process's statement that the
    // rehearsal gate passed on these digests. It is ANDed with the admin's stored
    // attestation by `effectiveSendingEnabled`, and it is false unless the variable
    // says otherwise — so an unset deployment is a deployment that cannot send.
    sendingEnabled: deployment.sendingEnabled,
    // 10.2: a live deployment has a durable one or `readApiDeployment` refused above.
    suppressionJournal: deployment.suppressionJournal,
    ...(deployment.mail === undefined ? {} : { mail: deployment.mail }),
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
