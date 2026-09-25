import { API_SCHEMA_RANGE, checkSchemaRange, readSystemGeneration } from '@fss/domain/db';
import { REFUSAL_STATUS, redactError } from '../limits.ts';
import { DatabaseBusyError } from './connections.ts';
import type { BootstrapResponse, ReadinessInputs, RouteModule } from './routeRegistry.ts';

/**
 * Liveness and readiness, which are different questions.
 *
 * **`/healthz`** is what the load balancer target group (`infra/modules/edge`,
 * `health_check_path` default `/healthz`) and the container health check
 * (`infra/modules/cluster`, `api_health_check_command`) call. It answers "is this
 * process running", touches no database, and cannot fail because of something outside
 * the process. A liveness check that queries a database restarts every task in the
 * fleet the moment the database hiccups, which is the opposite of what it is for.
 *
 * **`/readyz`** answers "should this task be given traffic". It fails closed when the
 * database cannot answer, when the applied schema version is outside the range this
 * binary accepts (4.2), or when the system generation is not the one the operator
 * pinned — which after a restore is how a task learns it is looking at recovered data
 * before it serves anything from it (Appendix E step 1).
 *
 * `/health` stays where G0 put it: a fuller, human-facing report that answers 200 even
 * when degraded. It is for an operator, not for a load balancer.
 *
 * Since lane g75 the two questions are asked on the request's own connection from the
 * pool, checked out for this request and released when it answers — so a ready report
 * means the pool could hand out a connection and that connection could read the
 * schema. A pool with nothing free inside the checkout timeout is `database_busy`,
 * not `database_unreachable`: the database was never asked.
 */

export const LIVENESS_PATH = '/healthz';
export const READINESS_PATH = '/readyz';

/** 503: the task is alive and deliberately not serving. Never 500, which means broken. */
export const NOT_READY_STATUS = 503;

export type NotReadyReason =
  | 'database_unreachable'
  | 'database_busy'
  | 'schema_out_of_range'
  | 'system_generation_mismatch';

export interface ReadinessReport {
  readonly ready: boolean;
  readonly component: 'api';
  readonly reason: NotReadyReason | null;
  readonly schema: {
    readonly declaredRange: { readonly minimum: number; readonly maximum: number };
    readonly databaseVersion: number | null;
    readonly accepted: boolean;
    readonly reason:
      | 'database_behind_binary'
      | 'database_ahead_of_binary'
      | 'database_unreachable'
      | 'database_busy'
      | null;
  };
  readonly generation: {
    readonly expected: number | null;
    readonly observed: number | null;
    readonly matches: boolean;
  };
}

export async function buildReadinessReport(inputs: ReadinessInputs): Promise<ReadinessReport> {
  const declaredRange = { minimum: API_SCHEMA_RANGE.minimum, maximum: API_SCHEMA_RANGE.maximum };
  let version: number | null = null;
  let accepted = false;
  let schemaReason: ReadinessReport['schema']['reason'] = 'database_unreachable';
  let generation: number | null = null;

  try {
    const check = await checkSchemaRange(inputs.session, API_SCHEMA_RANGE);
    version = check.version;
    accepted = check.accepted;
    schemaReason = check.accepted ? null : check.reason;
    generation = await readSystemGeneration(inputs.session);
  } catch (error) {
    // The cause is not carried out of the catch: it may name a host, a role or a
    // database. The operator reads it in the structured log, not over HTTP.
    const unanswered = error instanceof DatabaseBusyError ? 'database_busy' : 'database_unreachable';
    return {
      ready: false,
      component: 'api',
      reason: unanswered,
      schema: { declaredRange, databaseVersion: null, accepted: false, reason: unanswered },
      generation: { expected: inputs.expectedSystemGeneration, observed: null, matches: false },
    };
  }

  const matches = inputs.expectedSystemGeneration === null || generation === inputs.expectedSystemGeneration;
  const reason: NotReadyReason | null = !accepted
    ? 'schema_out_of_range'
    : matches
      ? null
      : 'system_generation_mismatch';

  return {
    ready: reason === null,
    component: 'api',
    reason,
    schema: { declaredRange, databaseVersion: version, accepted, reason: schemaReason },
    generation: { expected: inputs.expectedSystemGeneration, observed: generation, matches },
  };
}

export function readinessModule(): RouteModule {
  return {
    name: 'readiness',
    paths: [LIVENESS_PATH, READINESS_PATH],
    handle: async (request): Promise<BootstrapResponse | null> => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return { status: REFUSAL_STATUS.method_not_allowed, body: redactError('method_not_allowed') };
      }
      if (request.path === LIVENESS_PATH) {
        // No await, no database, nothing that can be slow: this answers while the rest
        // of the process is having its worst day.
        return Promise.resolve({ status: 200, body: { status: 'live', component: 'api' } });
      }
      const report = await buildReadinessReport(request.readiness);
      return { status: report.ready ? 200 : NOT_READY_STATUS, body: report };
    },
  };
}
