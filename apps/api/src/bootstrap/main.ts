import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import pg from 'pg';
import type { QueryResultRowLike, SessionQueryable } from '@fss/domain/db';
import { clientVersionPolicySchema, type ClientVersionPolicy } from '@fss/contracts';
import { ApiConfigError, describeApiConfig, readApiConfig, type ApiConfig } from './config.ts';
import {
  DeploymentConfigError,
  describeDeployment,
  loadJournalPutObject,
  readApiDeployment,
  type ApiDeployment,
} from './deployment.ts';
import { discoverImageDigest } from '@fss/domain/release';
import type { AuthDeps } from '../auth/index.ts';
import { JournalConfigurationError } from '../journal/index.ts';
import { createRequestPool, poolConnections, verifyPoolConnectivity } from './connections.ts';
import { startApiHeartbeat } from './heartbeat.ts';
import { createLogger, errorFields } from './log.ts';
import { drainApi } from './shutdown.ts';
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
 * The client versions this container admits (5.3), as a compatibility ceiling (lane
 * g78, audit item O04; `docs/decisions/g78-version-ceiling.md`).
 *
 * Every sign-in, renewal and command is checked against this policy, and a client
 * outside it may read the upgrade instruction and mutate nothing. It has three parts:
 *
 *   * `minimum` — below it, `upgrade_required`. Unchanged: raising it is how a release
 *     forces every Mac onto a newer build.
 *   * `ceiling` — the highest release line this API serves. `1.x` admits every 1.*
 *     build from the minimum up, including ones built after this API was deployed. The
 *     promise behind it is that this API keeps every route, and every response field,
 *     that an admitted build reads; a change that cannot keep it moves the ceiling or
 *     the minimum instead (`docs/decisions/g78-one-wire-contract.md`).
 *   * `incompatible` — builds on the line that are known to be bad, refused exactly
 *     like one below the minimum (`client_upgrade_required`) until the Mac takes the
 *     next update. Empty today.
 *
 * What the API publishes is not this object but the range derived from it:
 * `{ minimum: '1.0.0', maximum: '1.999.999' }` on `/auth/client-version`, in every
 * sign-in and renewal grant, and on `/diagnostics`. Desktops 1.0.0 to 1.0.4 parse all
 * three with a strict `{ minimum, maximum }` schema, so the ceiling reaches them as a
 * maximum they already understand: 1.0.4 compares itself with `1.999.999`, finds itself
 * admitted, and needs no change. The incompatible list is never published — an
 * installed Mac could not parse the key, and the API refuses a listed build itself.
 *
 * Until lane g78 this was `{ minimum, maximum }` with the maximum pinned to the exact
 * latest desktop — 1.0.1 for the Mailbox row (release.md 8.0x), 1.0.2 for "Your
 * calling number" (8.0ab), 1.0.3 for Home (8.0ad), 1.0.4 for the sending section
 * (8.0ae) — so every desktop-only release needed an API deployment first, and a Mac
 * one patch ahead of the API was refused everything. Desktop 1.0.5 is the last build
 * that needs it: the API that carries this policy is deployed first, once, because the
 * API in production still publishes 1.0.4 as its maximum. From then on a 1.x desktop
 * publishes directly, and the API goes first only when a desktop needs a route or a
 * field the deployed API does not have yet.
 */
export const CONTAINER_CLIENT_VERSIONS: ClientVersionPolicy = clientVersionPolicySchema.parse({
  minimum: '1.0.0',
  ceiling: '1.x',
  incompatible: [],
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
  // Lane g71: which API image this is, from the ECS task metadata (or FSS_IMAGE_DIGEST
  // outside ECS), once, before anything can ask. An enable of production sending is
  // refused unless the release record it names carries this digest, and `unknown`
  // refuses every enable. Public, so it is in the startup line an operator reads.
  const identity = await discoverImageDigest(environment);
  log.log('info', 'api_configuration', {
    ...describeApiConfig(config),
    ...describeDeployment(deployment),
    image_digest: identity.digest,
    image_digest_source: identity.source,
    image_digest_detail: identity.detail,
  });

  // A pool for requests, one connection of its own for the heartbeat: a heartbeat that
  // waits behind a slow query — or for a free pool connection — is a heartbeat that
  // reports the queue rather than the process.
  //
  // Each request checks out its own connection from the pool and holds it until it has
  // answered (lane g75). Until then every request shared one `pg.Client`, and two
  // requests in flight at once ran inside each other's transactions.
  const pool = createRequestPool(config.database.connectionString, log);
  const heartbeatClient = new pg.Client({
    connectionString: config.database.connectionString,
    application_name: 'fss-api-heartbeat',
  });
  await verifyPoolConnectivity(pool);
  await heartbeatClient.connect();

  // 5.1: identity, assembled from what the deployment decided. `deployment.auth` is
  // absent only when `FSS_DEPENDENCIES=none`, which a production environment refuses,
  // so a production API always mounts sign-in or never started. Its database is not
  // here: `createApiServer` gives every request's identity work that request's own
  // connection.
  const auth: Omit<AuthDeps, 'db'> | undefined =
    deployment.auth === undefined
      ? undefined
      : {
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
    connections: poolConnections(pool, log),
    expectedSystemGeneration: config.expectedSystemGeneration,
    supportedClientVersions: CONTAINER_CLIENT_VERSIONS,
    ...(auth === undefined ? {} : { auth }),
    // Specification 16.2's deployment half: the release process's statement that the
    // rehearsal gate passed on these digests. It is ANDed with the admin's stored
    // attestation by `effectiveSendingEnabled`, and it is false unless the variable
    // says otherwise — so an unset deployment is a deployment that cannot send.
    sendingEnabled: deployment.sendingEnabled,
    imageDigest: identity.digest,
    // 10.2: a live deployment has a durable one or `readApiDeployment` refused above.
    suppressionJournal: deployment.suppressionJournal,
    ...(deployment.mail === undefined ? {} : { mail: deployment.mail }),
    // Lane g86: the root's `desktop_upgrade_url` in production, the placeholder elsewhere.
    upgradeUrl: deployment.upgradeUrl,
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
    await pool.end().catch(() => undefined);
    await heartbeatClient.end().catch(() => undefined);
    return API_EXIT_CODES.listenFailed;
  }
  log.log('info', 'api_listening', { port: config.port });

  const signal = await new Promise<NodeJS.Signals>(resolve => {
    process.once('SIGTERM', resolve);
    process.once('SIGINT', resolve);
  });
  log.log('info', 'api_stopping', { reason: signal });
  // Stop accepting, let the requests in flight finish and give their connections
  // back, then end the pool and the heartbeat — all inside the drain budget.
  const { drained } = await drainApi({
    server,
    pool,
    heartbeat,
    heartbeatClient,
    timeoutMilliseconds: config.shutdownTimeoutMilliseconds,
    log,
  });
  log.log('info', 'api_stopped', { drained });
  return API_EXIT_CODES.ok;
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
