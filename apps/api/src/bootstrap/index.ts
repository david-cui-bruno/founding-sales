/**
 * The API process bootstrap.
 *
 * G5b wrote these while `apps/api/src/server.ts` belonged to the identity lane, and
 * kept a second HTTP surface (`bootstrap/server.ts`) so the image had something to
 * run. Lane G3b did the wiring `docs/greenfield/processes.md` described and deleted
 * that duplicate: `createApiServer` in `apps/api/src/server.ts` is now the only
 * server, it mounts this registry, and `bootstrap/main.ts` is what the image runs.
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
export {
  API_POOL_CHECKOUT_TIMEOUT_MILLISECONDS,
  API_POOL_IDLE_TIMEOUT_MILLISECONDS,
  API_POOL_MAX_CONNECTIONS,
  DatabaseBusyError,
  createRequestPool,
  poolConnections,
  requestConnection,
  unconnectedSession,
  verifyPoolConnectivity,
  type CheckedOutConnection,
  type RequestConnection,
  type RequestConnections,
  type RequestPoolOptions,
} from './connections.ts';
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
export { IDLE_SWEEP_MILLISECONDS, drainApi, type DrainParts, type DrainReport } from './shutdown.ts';
