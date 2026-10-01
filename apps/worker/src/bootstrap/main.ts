import pg from 'pg';
import type { QueryResultRowLike, SessionQueryable } from '@fss/domain/db/queryable.ts';
import { canaryHandler } from '@fss/domain/jobs/canary.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { createCloudWatchSink, loadCloudWatchTransport } from '@fss/domain/jobs/metricsCloudWatch.ts';
import { defaultTodaySources } from '@fss/domain/today/build.ts';
import { dueSequenceWorkSource } from '@fss/domain/sequences/todaySource.ts';
import { buildCommit, discoverImageDigest } from '@fss/domain/release/identity.ts';
import { isProductionEnvironmentName } from '@fss/domain/release/deployment.ts';
import { WORKER_EXIT_CODES } from '../index.ts';
import {
  classifyHandlers,
  classifyReplySource,
  classifyWorkerOptions,
  describeClassifier,
  type ClassifyWorkerOptions,
} from '../handlers/classify.ts';
import type { OutboundSendDeps } from '@fss/domain/outbound/send.ts';
import type { SuppressionJournal } from '@fss/domain/suppression/journal.ts';
import { mailHandlers, todayReplyPromoter, type MailWorkerOptions } from '../handlers/mail.ts';
import { outboundSendHandoff } from '../handlers/outboundSendHandoff.ts';
import { routeValidateJobHandler, routeValidationSource, systemMailDomainResolver } from '../handlers/routeValidate.ts';
import { sendDayCloseJobHandler, sendDayCloseSource } from '../handlers/sendDayClose.ts';
import { sequenceActionJobHandler, sequenceActionSource } from '../handlers/sequenceAction.ts';
import { retentionBatchJobHandler, retentionSource } from '../handlers/retention.ts';
import { researchHandlers, researchSweepSource, type ResearchWorkerOptions } from '../handlers/research.ts';
import { anthropicExtraction } from '../research/anthropicExtraction.ts';
import { researchPageFetch } from '../research/companyPageFetch.ts';
import { suppressionFinalizeJobHandler } from '../handlers/suppressionFinalize.ts';
import { terminalStopJobHandler, terminalStopSource } from '../handlers/terminalStop.ts';
import { telephonySweepJobHandler, telephonySweepSource } from '../handlers/telephonySweep.ts';
import { calcomReconcileJobHandler, calcomReconcileSource, type CalcomReconcileOptions } from '../handlers/calcomReconcile.ts';
import { readCalcomReconcileClient } from '../calcom/bookingsClient.ts';
import { callTranscribeJobHandler, heldTranscriptionSource, type CallTranscribeOptions } from '../handlers/callTranscribe.ts';
import { readTranscriptionProvider } from '../transcription/deepgramClient.ts';
import { readTwilioRecordingCredentials, twilioRecordingFetcher } from '@fss/domain/calls/twilioRecording.ts';
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
 * Until G12 this function registered `mailHandlers(undefined)` unconditionally, and
 * the long comment here
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
  readonly research: ResearchWorkerOptions | undefined;
  /**
   * Cal.com reconciliation (slice M1): present only when the task environment's `calcom`
   * entry carries an `api_key`. Absent, `calcom.reconcile` is not registered and its
   * source materializes nothing (`workerDueWorkSources({ calcomReconcile: false })`).
   */
  readonly calcom?: CalcomReconcileOptions | undefined;
  /**
   * Call transcription (slice C2): present only when the task environment has both the
   * `transcription` entry's key and the `twilio-voice` entry's recording credentials.
   * Absent, `call.transcribe` is not registered and its jobs wait in the queue.
   */
  readonly transcription?: CallTranscribeOptions | undefined;
}

/**
 * Lane R's two ports (`docs/greenfield/research.md`).
 *
 * The page fetch is always present: it needs no credential, and a run with nothing
 * else still records the firm's own pages as evidence. The extraction is present only
 * when the classifier transport is — the **same** transport, from the same
 * `classifyWorkerOptions` call, so the key is read once per process and this file
 * never sees a value.
 *
 * The model is `DEFAULT_RESEARCH_SETTINGS.modelName` rather than a per-workspace read,
 * because `research_settings_model_known` admits exactly one model in v1 and
 * `pricing.ts` has exactly one price row. The day a second model is added, this
 * becomes a per-run construction and the CHECK, the price table and this line move
 * together.
 */
export function composeResearch(classifier: ClassifyWorkerOptions | undefined): ResearchWorkerOptions {
  const pageFetch = researchPageFetch();
  if (classifier === undefined) return { pageFetch };
  return {
    pageFetch,
    // No model here: the model and the output bound travel with each request, from the
    // `provider_reservations` row that priced it. A model fixed at composition was a
    // second answer to "what is this call?" that the money did not know about.
    extraction: anthropicExtraction({ transport: classifier.transport }),
  };
}

/** The startup line. Says whether the extraction port is configured, never with what. */
export function describeResearch(options: ResearchWorkerOptions | undefined): {
  readonly research_extraction_configured: boolean;
} {
  return { research_extraction_configured: options?.extraction !== undefined };
}

/**
 * Exported for the upgrade test (`npm run upgrade:test`), which builds the registry
 * this function builds rather than a list of its own: "the worker starts" is not a
 * claim worth making about a registry nobody assembles the way the bootstrap does.
 */
export function registerHandlers(
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
  // Lane G15. Both need no configuration at all and reach nothing outside PostgreSQL,
  // so like `retention.batch` the deployment has nothing to say about them: one drains
  // the terminal stops G3a, G4 and G8 left for whoever ran the worker, the other
  // closes a send day so 12.7's ramp can advance past five a day.
  registry.register(terminalStopJobHandler());
  registry.register(sendDayCloseJobHandler());
  // Call-to-booking (slice W). The telephony reservations' backstop: PostgreSQL only,
  // no provider call, so like `retention.batch` it is registered in every deployment.
  registry.register(telephonySweepJobHandler());
  // Slice M1. The one handler here that calls Cal.com, so only with a key.
  if (composition.calcom !== undefined) registry.register(calcomReconcileJobHandler(composition.calcom));
  // Slice C2. Calls Twilio for the recording and Deepgram for the transcript, so only with both.
  if (composition.transcription !== undefined) registry.register(callTranscribeJobHandler(composition.transcription));
  // Lane g90. An address's technical validation (7.4) asks the process's own DNS
  // resolver for the domain's MX, and nothing else: no credential, no provider, no
  // deployment switch to consult, so like `retention.batch` it is registered in every
  // deployment. See `handlers/routeValidate.ts`.
  registry.register(routeValidateJobHandler({ resolver: systemMailDomainResolver() }));
  for (const handler of mailHandlers(composition.mail)) registry.register(handler);
  for (const handler of classifyHandlers(classifier)) registry.register(handler);
  // Lane R. Registered whenever the page fetch is, which is always: a run with no
  // extraction port records the firm's pages and completes with three of the four
  // judgments `unknown`, which is a smaller answer rather than a failure. That is
  // the opposite of `classify.reply`, and the difference is that a classification
  // with no model has nothing at all to record.
  for (const handler of researchHandlers(composition.research)) registry.register(handler);
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
 *
 * The namespace is the environment's own, `FSS/<name prefix>`; `readWorkerConfig` has
 * already refused a worker that would publish without one, so the null case below is
 * only ever a sink with no transport, which names no namespace to anybody.
 */
export async function createSink(
  config: WorkerConfig,
  log: Logger,
): Promise<ReturnType<typeof createCloudWatchSink>> {
  const { mode, region, namespace } = config.metrics;
  if (mode === 'off' || region === null || namespace === null) {
    log.log('info', 'metrics_disabled', { mode, has_region: region !== null, has_namespace: namespace !== null });
    return createCloudWatchSink({ namespace: namespace ?? '', transport: null });
  }
  try {
    const transport = await loadCloudWatchTransport(region);
    return createCloudWatchSink({ namespace, transport });
  } catch (error) {
    if (mode === 'on') throw error;
    log.log('warn', 'metrics_transport_unavailable', errorFields(error));
    return createCloudWatchSink({ namespace, transport: null });
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
    /**
     * Which worker image this is (lane g71), from `discoverImageDigest`. The send gate
     * compares it with the worker digest of the release record the attestation names;
     * absent is unknown, and unknown holds every send.
     */
    readonly imageDigest?: string | undefined;
  } = {},
): Promise<HandlerComposition> {
  const research = composeResearch(classifier);
  const gmail = deployment.gmail;
  if (gmail === undefined) return { classifier, mail: undefined, send: undefined, research };

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
    return { classifier, mail: undefined, send: undefined, research };
  }

  return {
    classifier,
    research,
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
      // And the image this worker is, which the attested release record must name
      // (lane g71). Same default, same direction: absent holds every send.
      workerImageDigest: options.imageDigest,
      // And whether this is production, where only the CI gate's release records bind.
      production: isProductionEnvironmentName(deployment.environmentName),
    },
  };
}

/**
 * The transcription job's two ports from the task environment (slice C2), or why not, as
 * `transcription:<field>` or `twilio:<field>` — a field name, never a value.
 */
export function readTranscriptionComposition(
  environment: Readonly<Record<string, string | undefined>>,
  log?: CallTranscribeOptions['log'],
): { readonly options: CallTranscribeOptions | null; readonly problem: string | null } {
  const provider = readTranscriptionProvider(environment);
  if (provider.provider === null) return { options: null, problem: `transcription:${provider.problem ?? 'absent'}` };
  const twilio = readTwilioRecordingCredentials(environment);
  if (twilio.credentials === null) return { options: null, problem: `twilio:${twilio.problem ?? 'absent'}` };
  return {
    options: {
      provider: provider.provider,
      recordings: twilioRecordingFetcher(twilio.credentials, { timeoutMs: 30_000 }),
      ...(log === undefined ? {} : { log }),
    },
    problem: null,
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
export function workerDueWorkSources(
  options: { readonly calcomReconcile?: boolean; readonly transcription?: boolean } = {},
): readonly DueWorkSource[] {
  return [
    canarySource(),
    todayBuildSource(),
    sequenceActionSource(),
    terminalStopSource(),
    sendDayCloseSource(),
    retentionSource(),
    researchSweepSource(),
    telephonySweepSource(),
    // Slice M1. Registered always, so the list is the documented one; it materializes a
    // job only in a worker that has a Cal.com API key to run it with — a job no handler
    // here could claim would sit in the queue for ever, one more each hour.
    calcomReconcileSource({ enabled: options.calcomReconcile === true }),
    // Slice P1. Like Cal.com's: listed always, materializing only where `call.transcribe` is registered.
    heldTranscriptionSource({ enabled: options.transcription === true }),
    ...mailSources(),
    classifyReplySource(),
    routeValidationSource(),
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

  const selftestClassifier = argv.includes('--selftest') ? await classifyWorkerOptions(environment) : undefined;
  if (argv.includes('--selftest')) {
    // No database, no AWS, no signal handler: this is the image smoke test. The
    // deployment line names which parts are configured and never what any of them is.
    log.log('info', 'worker_selftest', {
      ...describeWorkerConfig(config),
      ...describeDeployment(deployment),
      ...describeClassifier(selftestClassifier),
      ...describeResearch(composeResearch(selftestClassifier)),
    });
    return WORKER_EXIT_CODES.ok;
  }

  // Lane G7b. Absent unless the deployment injected `FSS_LLM_CLASSIFIER_API_KEY`,
  // in which case `classify.reply` stays unclaimed in the queue; the source still
  // runs, so the backlog is truthful about what is owed. `describeClassifier` says
  // whether a key is configured and never what it is.
  const classifier = await classifyWorkerOptions(environment);
  // Lane g71: which worker image this is, from the ECS task metadata (or
  // FSS_IMAGE_DIGEST outside ECS), once. Public, so it is in the startup line.
  const identity = await discoverImageDigest(environment);
  const composed = await composeHandlers(deployment, classifier, {
    ...(config.metrics.region === null ? {} : { region: config.metrics.region }),
    imageDigest: identity.digest,
  });
  // Slice M1: the key is read once, here, and lives only in the client's closure.
  const calcomReconcile = readCalcomReconcileClient(environment);
  // Slice C2: the transcription key and the recording credentials, each read once, here.
  const transcription = readTranscriptionComposition(environment, (event, fields) => log.log('info', event, fields));
  const composition: HandlerComposition = {
    ...composed,
    ...(calcomReconcile.client === null
      ? {}
      : { calcom: { client: calcomReconcile.client, log: (event, fields) => log.log('info', event, fields) } }),
    ...(transcription.options === null ? {} : { transcription: transcription.options }),
  };
  log.log('info', 'worker_configuration', {
    ...describeWorkerConfig(config),
    ...describeClassifier(classifier),
    ...describeResearch(composition.research),
    ...describeDeployment(deployment),
    image_digest: identity.digest,
    image_digest_source: identity.source,
    image_digest_detail: identity.detail,
    // Which source the image was built from, beside which bytes it is. Baked in by
    // `ARG FSS_BUILD_COMMIT`; null on a laptop and on any image built before it existed.
    build_commit: buildCommit(environment),
    // Whether reconciliation runs, and if not why, by field name only.
    calcom_reconcile: calcomReconcile.problem ?? 'configured',
    // Whether transcription runs, and if not why, by field name only.
    call_transcription: transcription.problem ?? 'configured',
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
      sources: workerDueWorkSources({
        calcomReconcile: composition.calcom !== undefined,
        transcription: composition.transcription !== undefined,
      }),
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
