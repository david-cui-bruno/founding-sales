/**
 * The job system (specification 13). Shared by the worker, which runs it, and the API,
 * which exposes the admin views and commands over it.
 *
 * It lives in `@fss/domain` rather than in `apps/worker` for the same reason the
 * database conventions do (docs/decisions/g0-database-conventions.md): the alternative
 * is one service importing the other.
 */

export {
  CANARY_PERIOD_MILLISECONDS,
  IDEMPOTENCY_PROTECTIONS,
  JOB_KINDS,
  JOB_KIND_PROTECTION,
  isJobKind,
  jobIdempotencyKey,
  quarterHourOf,
  type IdempotencyProtection,
  type JobKind,
} from './jobKinds.ts';

export { DEFAULT_BACKOFF, backoffSeconds, isExhausted, type BackoffPolicy } from './backoff.ts';

export {
  JobStoreError,
  archiveCompletedPayloads,
  assertKnownKind,
  claimJobs,
  completeJob,
  enqueueJob,
  failJob,
  listDeadJobs,
  reclaimExpiredLeases,
  renewLease,
  requeueDeadJob,
  type ClaimOptions,
  type ClaimedJob,
  type DeadJob,
  type EnqueueOutcome,
  type FailOutcome,
  type JobFailure,
  type JobSpecification,
  type RequeueOutcome,
} from './jobStore.ts';

export {
  HandlerRegistry,
  HandlerRegistryError,
  scopeForJob,
  type JobHandler,
  type JobHandlerInput,
} from './handlerRegistry.ts';

export {
  runTwiceUnderStolenLease,
  type JobRunOutcome,
  type RunClaimedJob,
  type StolenLeaseProbe,
  type StolenLeaseReport,
} from './atLeastOnce.ts';

export {
  COUNTER_SUBJECT_KINDS,
  incrementDailyCounter,
  readDailyCounter,
  type CounterKey,
  type CounterOutcome,
  type CounterSubjectKind,
} from './counters.ts';

export {
  DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
  readHeartbeats,
  recordHeartbeat,
  type HeartbeatComponent,
  type HeartbeatInput,
  type HeartbeatStatus,
} from './heartbeats.ts';

export {
  canaryCompletionAgeSeconds,
  canaryHandler,
  canaryJobKey,
  completeCanaryRun,
  insertCanaryRun,
  type CanaryInsertion,
} from './canary.ts';

export {
  acknowledgeCriticalAlert,
  listOpenAlerts,
  raiseCriticalAlert,
  resolveCriticalAlert,
  unacknowledgedCriticalAlertAgeSeconds,
  type AcknowledgeOutcome,
  type OpenAlert,
  type RaiseAlertInput,
  type RaisedAlert,
} from './criticalAlerts.ts';

export {
  JOB_METRIC_NAMES,
  METRIC_OWNERS,
  MetricError,
  collectJobMetrics,
  createMetricSink,
  recordingMetricSink,
  validateMetricDatum,
  type MetricDatum,
  type MetricOwner,
  type MetricSink,
  type MetricSinkOptions,
  type MetricUnit,
  type PutMetricData,
} from './metrics.ts';

/**
 * The real CloudWatch publisher. The only module in the tree that loads an AWS SDK,
 * and it loads it lazily inside `loadCloudWatchTransport`, so importing this index
 * costs nothing in a process that never publishes.
 */
export {
  CLOUDWATCH_MAX_DATA_PER_REQUEST,
  cloudWatchPutMetricData,
  createCloudWatchSink,
  loadCloudWatchTransport,
  toCloudWatchDatum,
  type CloudWatchDatum,
  type CloudWatchDimension,
  type CloudWatchOptions,
  type CloudWatchSinkOptions,
  type CloudWatchTransport,
  type PutMetricDataInput,
} from './metricsCloudWatch.ts';

/**
 * The transaction advisory lock the one-minute scheduler pass holds (13.1).
 *
 * A stable literal, not a hash of a version, a deployment id or a table name: two
 * binaries of different releases must collide on it, which is the whole point of
 * "overlapping deployments serialize on the same key". Deliberately not the migration
 * runner's key, so a migration and a scheduler pass do not block each other.
 */
export const SCHEDULER_ADVISORY_LOCK_KEY = 6_243_912_004_771_002;
