/**
 * The API process bootstrap.
 *
 * `apps/api/src/server.ts` and `apps/api/src/index.ts` belong to the identity lane
 * while that is in flight, so nothing this lane wrote edits them. Everything the
 * coordinator has to mount is exported here, and `docs/greenfield/processes.md` names
 * the exact lines to add to `server.ts` once G2 has merged.
 */

export {
  ApiConfigError,
  DEFAULT_HEARTBEAT_INTERVAL_MILLISECONDS,
  DEFAULT_PORT,
  DEFAULT_SHUTDOWN_TIMEOUT_MILLISECONDS,
  describeApiConfig,
  readApiConfig,
  type ApiConfig,
  type ApiConfigErrorCode,
} from './config.ts';
export { dispatch } from './dispatch.ts';
export {
  DEFAULT_API_HEARTBEAT_INTERVAL_MILLISECONDS,
  startApiHeartbeat,
  type ApiHeartbeat,
  type ApiHeartbeatOptions,
} from './heartbeat.ts';
export {
  createLogger,
  errorFields,
  recordingLogger,
  type LogFields,
  type LogLevel,
  type LogValue,
  type Logger,
} from './log.ts';
export {
  LIVENESS_PATH,
  NOT_READY_STATUS,
  READINESS_PATH,
  buildReadinessReport,
  readinessModule,
  type NotReadyReason,
  type ReadinessReport,
} from './readiness.ts';
export { readBody, type BodyOutcome, type BodySource } from './requestBody.ts';
export {
  RouteRegistryError,
  createRouteRegistry,
  type BootstrapRequest,
  type BootstrapResponse,
  type ReadinessInputs,
  type RouteModule,
  type RouteRegistry,
} from './routeRegistry.ts';
export { adminJobsModule, mountedRoutes } from './routes.ts';
export { createBootstrapServer, type BootstrapServerOptions } from './server.ts';
