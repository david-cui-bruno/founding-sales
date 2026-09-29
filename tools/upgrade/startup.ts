import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { checkSchemaRange, type SchemaRange } from '@fss/domain/db/schemaRange.ts';
import { HandlerRegistry, HandlerRegistryError } from '@fss/domain/jobs/handlerRegistry.ts';
import { buildReadinessReport, NOT_READY_STATUS } from '../../apps/api/src/bootstrap/readiness.ts';
import { checkWorkerStartup, WORKER_EXIT_CODES } from '../../apps/worker/src/index.ts';

/**
 * Would the two images start against this database?
 *
 * The step the old rehearsal never performed on real data. It started from an empty
 * database, so "the images accept the schema" was a statement about a number rather
 * than about the database the release was going to run on.
 *
 * Both checks are the ones the processes themselves make: `checkWorkerStartup` is what
 * `apps/worker/src/bootstrap/worker.ts` calls before it registers a handler, and
 * `buildReadinessReport` is what the API's readiness gate calls before it answers a
 * request. The asymmetry between them is real and is reported rather than smoothed
 * over — the worker *exits* with `WORKER_EXIT_CODES.schemaOutOfRange`, the API stays up
 * and refuses traffic with `503`.
 *
 * The refusal matters more than the acceptance. An image built for schema N refuses a
 * database at M, which is why redeploying the previous image after a migration is not a
 * rollback: `docs/greenfield/release.md` 4.1 names the two paths that are.
 */

export interface StartupOutcome {
  readonly component: 'api' | 'worker';
  readonly range: SchemaRange;
  readonly accepted: boolean;
  readonly databaseVersion: number;
  readonly reason: string | null;
  /** What the process does about it: an exit code, or the HTTP status the API answers. */
  readonly effect: string;
}

/**
 * The worker's refusal, for an arbitrary declared range.
 *
 * `checkWorkerStartup` hard-codes `WORKER_SCHEMA_RANGE` because that is the only range
 * a real worker process can be asked about — an image cannot be persuaded to accept
 * somebody else's. It is called unconditionally so the report carries the process's own
 * outcome and exit code; the `{N,N}` case is the same comparison made against the range
 * the *previous* image declared, which is the question a rollback asks.
 */
export async function workerStartup(session: SessionQueryable, range: SchemaRange): Promise<StartupOutcome> {
  const own = await checkWorkerStartup({ session });
  const check = await checkSchemaRange(session, range);
  const sameAsImage = range.minimum === own.declaredRange.minimum && range.maximum === own.declaredRange.maximum;
  return {
    component: 'worker',
    range,
    accepted: check.accepted,
    databaseVersion: check.version,
    reason: check.accepted ? null : check.reason,
    effect: check.accepted
      ? `starts (exit ${String(WORKER_EXIT_CODES.ok)})`
      : `exits ${String(sameAsImage ? own.exitCode : WORKER_EXIT_CODES.schemaOutOfRange)} (schemaOutOfRange)`,
  };
}

/** The API's refusal, for an arbitrary declared range. */
export async function apiStartup(session: SessionQueryable, range: SchemaRange): Promise<StartupOutcome> {
  const readiness = await buildReadinessReport({ session });
  const check = await checkSchemaRange(session, range);
  return {
    component: 'api',
    range,
    accepted: check.accepted,
    databaseVersion: check.version,
    reason: check.accepted ? null : check.reason,
    effect: check.accepted
      ? `ready (${readiness.ready ? 'readyz 200' : 'readyz ' + String(NOT_READY_STATUS)})`
      : `refuses traffic (readyz ${String(NOT_READY_STATUS)}, ${String(readiness.reason ?? 'schema_out_of_range')})`,
  };
}

export interface RegistryReport {
  readonly kinds: readonly string[];
  readonly classes: Readonly<Record<string, number>>;
  /** Proved rather than asserted: a kind with no class is refused. */
  readonly refusesKindWithoutClass: boolean;
  /** Empty when the registry was built; otherwise why it could not be. */
  readonly unavailable: string;
}

/** The shape `apps/worker/src/bootstrap/main.ts` exports for this test to call. */
interface WorkerBootstrap {
  readonly registerHandlers?: (
    registry: HandlerRegistry,
    composition: { classifier: undefined; mail: undefined; send: undefined },
  ) => HandlerRegistry;
}

/**
 * Build the registry the worker's bootstrap builds, with no provider adapters — the
 * composition a worker deployed without Gmail or a classifier key gets, which is every
 * kind that reaches nothing outside PostgreSQL. Then prove the refusal the registry
 * exists for: a kind with no job class is `CLASS_MISSING` and stops the process,
 * because a worker that cannot say whether a job is urgent or bulk cannot schedule it.
 */
export async function buildWorkerRegistry(): Promise<RegistryReport> {
  // Imported at run time, from this tree, because the tool is also run from a checkout
  // cut before `registerHandlers` was exported (this lane's own change). A checkout
  // without it is said so out loud rather than substituted for with a hand-written
  // list, which would make the step assert the list rather than the bootstrap.
  const bootstrap = (await import('../../apps/worker/src/bootstrap/main.ts')) as WorkerBootstrap;
  if (bootstrap.registerHandlers === undefined) {
    return {
      kinds: [],
      classes: {},
      refusesKindWithoutClass: false,
      unavailable:
        "this checkout's apps/worker/src/bootstrap/main.ts does not export registerHandlers, so the registry could not be built the way its own bootstrap builds it",
    };
  }
  const registry = bootstrap.registerHandlers(new HandlerRegistry(), {
    classifier: undefined,
    mail: undefined,
    send: undefined,
  });
  const classes: Record<string, number> = {};
  for (const [name, kinds] of Object.entries(registry.classes())) classes[name] = kinds.length;

  let refused = false;
  const unclassified = new HandlerRegistry({ classOf: () => undefined });
  const first = registry.all()[0];
  if (first !== undefined) {
    try {
      unclassified.register(first);
    } catch (error) {
      refused = error instanceof HandlerRegistryError && error.code === 'CLASS_MISSING';
    }
  }
  return { kinds: registry.kinds(), classes, refusesKindWithoutClass: refused, unavailable: '' };
}
