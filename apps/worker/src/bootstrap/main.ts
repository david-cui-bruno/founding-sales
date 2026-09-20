import pg from 'pg';
import type { QueryResultRowLike, SessionQueryable } from '@fss/domain/db';
import { HandlerRegistry, canaryHandler, createCloudWatchSink, loadCloudWatchTransport } from '@fss/domain/jobs';
import { WORKER_EXIT_CODES } from '../index.ts';
import {
  classifyHandlers,
  classifyReplySource,
  classifyWorkerOptions,
  describeClassifier,
  type ClassifyWorkerOptions,
} from '../handlers/classify.ts';
import { mailHandlers } from '../handlers/mail.ts';
import { researchHandlers } from '../handlers/research.ts';
import { suppressionFinalizeJobHandler } from '../handlers/suppressionFinalize.ts';
import { todayBuildJobHandler, todayBuildSource } from '../handlers/todayBuild.ts';
import { mailSources } from '../scheduler/mailSources.ts';
import { canarySource } from '../scheduler/sources.ts';
import { ConfigError, describeWorkerConfig, readWorkerConfig, type WorkerConfig } from './config.ts';
import { createLogger, errorFields, type Logger } from './log.ts';
import { WorkerStartupRefusal, startWorker } from './worker.ts';

/**
 * Every handler this image runs.
 *
 * The research handlers are registered only for the provider kinds this process was
 * given, and in this release it was given none: the live Places, page-fetch and
 * extraction adapters are a separate reviewed change, and the only implementations in
 * the repository are the recorded fixtures the tests use. So `research.page` and
 * `research.firm` jobs wait in the queue unclaimed rather than being failed four times
 * each — which is the honest state, and the reason `enqueueDiscoveryPage` is an admin
 * command rather than a scheduler source (docs/decisions/g10-no-scheduler-source.md).
 *
 * The three `mail.*` handlers are registered on the same terms and for the same
 * reason: `mailHandlers` is given no Gmail configuration in this release, so
 * `mail.sync`, `mail.recover` and `mail.watch_renew` wait in the queue unclaimed. The
 * adapters they need are real — `createGmailHttpClient` speaks the Gmail API and
 * `kmsDataKeyWrapper` unwraps the envelope key — but the change that reads a
 * deployment's client secret and KMS key and hands them over is the one that
 * introduces live credentials, and it is reviewed on its own.
 *
 * The mail *scheduler sources* are registered unconditionally, and that is not an
 * inconsistency. A source only inserts rows: with no mailboxes connected it finds
 * nothing, and with mailboxes connected it keeps the queue truthful about what is
 * owed whether or not this image can claim it.
 *
 * `classify.reply` (G7b) follows the same shape with one difference worth naming:
 * its adapter is built here, from `FSS_LLM_CLASSIFIER_API_KEY`, because there is
 * exactly one secret and no second configuration object to review. A deployment
 * without the key registers no handler; a deployment with `FSS_CLASSIFIER=off`
 * registers it and each job records a `disabled` attempt having sent nothing.
 */
function registerHandlers(
  registry: HandlerRegistry,
  classifier: ClassifyWorkerOptions | undefined,
): HandlerRegistry {
  registry.register(canaryHandler());
  registry.register(suppressionFinalizeJobHandler());
  registry.register(todayBuildJobHandler());
  for (const handler of researchHandlers({ providers: {} })) registry.register(handler);
  for (const handler of mailHandlers(undefined)) registry.register(handler);
  for (const handler of classifyHandlers(classifier)) registry.register(handler);
  return registry;
}

/**
 * The worker container's entry point.
 *
 * Everything decidable without a database is decided before one is opened: the
 * environment is read, the declared schema range is compared with the range this image
 * accepts, and the metric transport is built. `--selftest` stops there and prints what
 * it decided, which is what the image build in CI runs to prove the container can load
 * its own code without reaching a database or a cloud API.
 */

/** Adapt one `node-postgres` client to the narrow session the domain code takes. */
function asSession(client: pg.Client): SessionQueryable {
  return {
    async query<Row extends QueryResultRowLike = QueryResultRowLike>(text: string, values?: readonly unknown[]) {
      const result = await client.query(text, values === undefined ? undefined : [...values]);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    },
  };
}

/**
 * The sink the worker publishes through.
 *
 * `off` and a missing region both give a validating no-op. `on` with no reachable SDK
 * is a refusal: an operator who asked for metrics and silently got none would be
 * watching alarms that can never fire.
 */
export async function createSink(
  config: WorkerConfig,
  log: Logger,
): Promise<ReturnType<typeof createCloudWatchSink>> {
  const wanted = config.metrics.mode !== 'off' && config.metrics.region !== null;
  if (!wanted) {
    log.log('info', 'metrics_disabled', { mode: config.metrics.mode, has_region: config.metrics.region !== null });
    return createCloudWatchSink({ namespace: config.metrics.namespace, transport: null });
  }
  try {
    const transport = await loadCloudWatchTransport(config.metrics.region ?? '');
    return createCloudWatchSink({ namespace: config.metrics.namespace, transport });
  } catch (error) {
    if (config.metrics.mode === 'on') throw error;
    log.log('warn', 'metrics_transport_unavailable', errorFields(error));
    return createCloudWatchSink({ namespace: config.metrics.namespace, transport: null });
  }
}

async function connect(connectionString: string, count: number): Promise<pg.Client[]> {
  const clients: pg.Client[] = [];
  for (let index = 0; index < count; index += 1) {
    const client = new pg.Client({ connectionString, application_name: 'fss-worker' });
    await client.connect();
    clients.push(client);
  }
  return clients;
}

export async function main(argv: readonly string[], environment: NodeJS.ProcessEnv): Promise<number> {
  let config: WorkerConfig;
  const bootLog = createLogger({ component: 'worker', instanceKey: 'boot' });
  try {
    config = readWorkerConfig(environment);
  } catch (error) {
    bootLog.log('error', 'worker_configuration_refused', {
      ...errorFields(error),
      code: error instanceof ConfigError ? error.code : null,
    });
    return WORKER_EXIT_CODES.configurationInvalid;
  }

  const log = createLogger({ component: 'worker', instanceKey: config.instanceKey });
  if (argv.includes('--selftest')) {
    // No database, no AWS, no signal handler: this is the image smoke test.
    log.log('info', 'worker_selftest', describeWorkerConfig(config));
    return WORKER_EXIT_CODES.ok;
  }

  // Lane G7b. Absent unless the deployment injected `FSS_LLM_CLASSIFIER_API_KEY`,
  // in which case `classify.reply` stays unclaimed in the queue; the source still
  // runs, so the backlog is truthful about what is owed. `describeClassifier` says
  // whether a key is configured and never what it is.
  const classifier = await classifyWorkerOptions(environment);
  log.log('info', 'worker_configuration', { ...describeWorkerConfig(config), ...describeClassifier(classifier) });

  const sink = await createSink(config, log);
  // One connection for the scheduler's advisory lock, one per runner slot, one for the
  // metric reads. A pool would hand the advisory lock to whichever backend answered.
  const clients = await connect(config.database.connectionString, config.concurrency + 2);
  const sessions = clients.map(asSession);

  try {
    const runtime = await startWorker({
      config,
      sessions: {
        scheduler: sessions[0] as SessionQueryable,
        runners: sessions.slice(1, 1 + config.concurrency),
        metrics: sessions[1 + config.concurrency] as SessionQueryable,
      },
      registry: registerHandlers(new HandlerRegistry(), classifier),
      sources: [canarySource(), todayBuildSource(), ...mailSources(), classifyReplySource()],
      sink,
      log,
    });

    await new Promise<void>(resolve => {
      const shutdown = (signal: NodeJS.Signals): void => {
        void runtime.stop(signal).then(() => resolve());
      };
      process.once('SIGTERM', shutdown);
      process.once('SIGINT', shutdown);
    });
    return WORKER_EXIT_CODES.ok;
  } catch (error) {
    if (error instanceof WorkerStartupRefusal) return error.exitCode;
    log.log('error', 'worker_failed', errorFields(error));
    return WORKER_EXIT_CODES.databaseUnreachable;
  } finally {
    for (const client of clients) await client.end().catch(() => undefined);
  }
}

// `import.meta.url` equals the resolved entry point only when this file was run
// directly, which is how the container starts it and how a test may import it.
if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
