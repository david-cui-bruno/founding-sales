import pg from 'pg';
import type { QueryResultRowLike, SessionQueryable } from '@fss/domain/db';
import { HandlerRegistry, canaryHandler, createCloudWatchSink, loadCloudWatchTransport } from '@fss/domain/jobs';
import { defaultTodaySources } from '@fss/domain/today';
import { dueSequenceWorkSource } from '@fss/domain/sequences';
import { WORKER_EXIT_CODES } from '../index.ts';
import {
  classifyHandlers,
  classifyReplySource,
  classifyWorkerOptions,
  describeClassifier,
  type ClassifyWorkerOptions,
} from '../handlers/classify.ts';
import type { OutboundSendDeps } from '@fss/domain/outbound';
import type { SuppressionJournal } from '@fss/domain/suppression';
import { mailHandlers, todayReplyPromoter, type MailWorkerOptions } from '../handlers/mail.ts';
import { outboundSendHandoff } from '../handlers/outboundSendHandoff.ts';
import { researchHandlers } from '../handlers/research.ts';
import { sequenceActionJobHandler, sequenceActionSource } from '../handlers/sequenceAction.ts';
import { retentionBatchJobHandler, retentionSource } from '../handlers/retention.ts';
import { suppressionFinalizeJobHandler } from '../handlers/suppressionFinalize.ts';
import { todayBuildJobHandler, todayBuildSource } from '../handlers/todayBuild.ts';
import { mailSources } from '../scheduler/mailSources.ts';
import type { DueWorkSource } from '../scheduler/schedulerPass.ts';
import { canarySource } from '../scheduler/sources.ts';
import { ConfigError, describeWorkerConfig, readWorkerConfig, type WorkerConfig } from './config.ts';
import {
  DeploymentConfigError,
  describeDeployment,
  loadS3SuppressionJournal,
  readWorkerDeployment,
  type WorkerDeployment,
} from './deployment.ts';
import { createLogger, errorFields, type Logger } from './log.ts';
import { WorkerStartupRefusal, startWorker } from './worker.ts';

/**
 * Every handler this image runs, and the deployment decides which.
 *
 * Until G12 this function registered `mailHandlers(undefined)` and
 * `researchHandlers({ providers: {} })` unconditionally, and the long comment here
 * explained — honestly — that the change which reads a deployment's client secret and
 * KMS key was reviewed on its own. `bootstrap/deployment.ts` is that change. The
 * shape it preserves is the one that was right: a kind whose adapter this process was
 * not given is left **unclaimed in the queue** rather than failed four times into a
 * dead job and a critical alarm. The queue is durable; the work waits.
 *
 * What is new is that the absence is now always a decision somebody made.
 * `FSS_DEPENDENCIES=none` is a value an operator typed, and a production deployment
 * cannot have it: `readWorkerDeployment` refuses to return at all. So the difference
 * between "this laptop has no Gmail" and "production lost its Gmail configuration" is
 * the difference between a worker that starts and a worker that does not.
 *
 * The mail *scheduler sources* stay registered unconditionally, and that is still not
 * an inconsistency. A source only inserts rows: with no mailboxes connected it finds
 * nothing, and with mailboxes connected it keeps the queue truthful about what is owed
 * whether or not this image can claim it.
 *
 * `classify.reply` (G7b) keeps its own switch as well as the deployment's, because the
 * two say different things: `FSS_CLASSIFIER=off` is an operator who has decided not to
 * spend, and each job then records a `disabled` attempt having sent nothing.
 *
 * `retention.batch` (G14) is registered unconditionally and needs no configuration at
 * all: every horizon in section 10.3 is a row in `retention_policies` and every sweep is
 * a statement against this database. It is the one job kind in this image that reaches
 * nothing outside PostgreSQL, so the deployment has nothing to say about it.
 */
export interface HandlerComposition {
  readonly classifier: ClassifyWorkerOptions | undefined;
  readonly mail: MailWorkerOptions | undefined;
  readonly send: OutboundSendDeps | undefined;
}

function registerHandlers(
  registry: HandlerRegistry,
  composition: HandlerComposition,
): HandlerRegistry {
  const { classifier } = composition;
  registry.register(canaryHandler());
  registry.register(suppressionFinalizeJobHandler());
  // 8.2's lane 3 is due sequence work, and G6 left `TodaySource` as the seam for it.
  // The source is composed here rather than added to `defaultTodaySources()` because
  // `packages/domain/sequences` already imports `packages/domain/today` for the
  // interface, and the reverse import would be a cycle between two packages that are
  // shipped in the same image.
  registry.register(
    todayBuildJobHandler({ sources: [...defaultTodaySources(), dueSequenceWorkSource()] }),
  );
  // The hand-off is G7-2's fence, adapted. `prepare` and the outcome read are real;
  // `dispatch` needs the Gmail configuration this release does not hand out, so a due
  // email step holds with the reason the fence gave rather than throwing. See
  // `handlers/outboundSendHandoff.ts`.
  registry.register(
    sequenceActionJobHandler({
      sendHandoff: outboundSendHandoff(
        composition.send === undefined ? {} : { deps: composition.send },
      ),
    }),
  );
  registry.register(retentionBatchJobHandler());
  // 7.4's providers have no live adapter in this repository, so the deployment
  // declares their absence rather than discovering it; see `deployment.ts`.
  for (const handler of researchHandlers({ providers: {} })) registry.register(handler);
  for (const handler of mailHandlers(composition.mail)) registry.register(handler);
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

/**
 * Turn the deployment into the three objects the handlers take.
 *
 * `mailHandlers` and the send hand-off want the same Gmail client, the same OAuth
 * configuration and the same envelope cipher, so they are built once and shared —
 * which is also what makes "the worker sends through the mailbox it syncs" true by
 * construction rather than by two configurations happening to agree.
 *
 * The journal is the one part built here rather than in `deployment.ts`, because it
 * needs a bucket *and* a region at once and because loading an SDK is a side effect a
 * configuration reader should not have.
 */
export async function composeHandlers(
  deployment: WorkerDeployment,
  classifier: ClassifyWorkerOptions | undefined,
  options: {
    readonly journal?: SuppressionJournal | undefined;
    readonly region?: string | undefined;
  } = {},
): Promise<HandlerComposition> {
  const gmail = deployment.gmail;
  if (gmail === undefined) return { classifier, mail: undefined, send: undefined };

  const journal =
    options.journal ??
    (deployment.journalBucket === null
      ? undefined
      : await loadS3SuppressionJournal({
          bucket: deployment.journalBucket,
          region: options.region ?? '',
        }));
  if (journal === undefined) {
    // Only reachable with `FSS_DEPENDENCIES=recorded` and no bucket: `live` refuses in
    // `readWorkerDeployment`. A rehearsal without a bucket registers no mail handler
    // rather than one that could acknowledge an opt-out it cannot journal.
    return { classifier, mail: undefined, send: undefined };
  }

  return {
    classifier,
    mail: {
      gmail: gmail.gmail,
      oauth: gmail.oauth,
      cipher: gmail.cipher,
      journal,
      replyPromoter: todayReplyPromoter(),
      pushTopicName: gmail.config.pushTopicName,
    },
    send: {
      gmail: gmail.gmail,
      oauth: gmail.oauth,
      cipher: gmail.cipher,
      actor: 'worker',
      // 16.2's deployment half. `decideSend` defaults it to false, so a composition
      // that forgot it would hold every send rather than send one.
      deploymentSendingEnabled: deployment.sendingEnabled,
    },
  };
}

/**
 * Every due-work source the one-minute pass reads (13.1).
 *
 * Exported because `src/tools/fss.ts`'s `admin scheduler run-once` is Appendix E step
 * 5's "rematerialise from business state" and has to be the *same* pass. A tool with
 * its own list would rematerialise a subset, and the difference would be whichever
 * lane's source was added after the tool was written.
 *
 * Every source inserts rows and talks to nothing outside PostgreSQL, which is what
 * makes running one from a command line safe.
 */
export function workerDueWorkSources(): readonly DueWorkSource[] {
  return [
    canarySource(),
    todayBuildSource(),
    sequenceActionSource(),
    retentionSource(),
    ...mailSources(),
    classifyReplySource(),
  ];
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

  // Everything the deployment was given, decided before a socket is opened. A live
  // deployment missing any part refuses here rather than starting a worker that claims
  // nothing and says nothing about why.
  let deployment: WorkerDeployment;
  try {
    deployment = await readWorkerDeployment(environment);
  } catch (error) {
    log.log('error', 'worker_deployment_refused', {
      ...errorFields(error),
      code: error instanceof DeploymentConfigError ? error.code : null,
    });
    return WORKER_EXIT_CODES.configurationInvalid;
  }

  if (argv.includes('--selftest')) {
    // No database, no AWS, no signal handler: this is the image smoke test. The
    // deployment line names which parts are configured and never what any of them is.
    log.log('info', 'worker_selftest', {
      ...describeWorkerConfig(config),
      ...describeDeployment(deployment),
      ...describeClassifier(await classifyWorkerOptions(environment)),
    });
    return WORKER_EXIT_CODES.ok;
  }

  // Lane G7b. Absent unless the deployment injected `FSS_LLM_CLASSIFIER_API_KEY`,
  // in which case `classify.reply` stays unclaimed in the queue; the source still
  // runs, so the backlog is truthful about what is owed. `describeClassifier` says
  // whether a key is configured and never what it is.
  const classifier = await classifyWorkerOptions(environment);
  const composition = await composeHandlers(deployment, classifier, {
    ...(config.metrics.region === null ? {} : { region: config.metrics.region }),
  });
  log.log('info', 'worker_configuration', {
    ...describeWorkerConfig(config),
    ...describeClassifier(classifier),
    ...describeDeployment(deployment),
  });

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
      registry: registerHandlers(new HandlerRegistry(), composition),
      sources: workerDueWorkSources(),
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
