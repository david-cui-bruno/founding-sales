import type { SessionQueryable } from '@fss/domain/db/queryable.ts';
import { HandlerRegistry, HandlerRegistryError } from '@fss/domain/jobs/handlerRegistry.ts';
import { buildReadinessReport, NOT_READY_STATUS } from '../../apps/api/src/bootstrap/readiness.ts';
import { checkWorkerStartup, WORKER_EXIT_CODES } from '../../apps/worker/src/index.ts';

/**
 * Would *this checkout's* images start against this database?
 *
 * Every range here is the checkout's own. There is no argument for it, deliberately:
 * an image cannot be persuaded to accept somebody else's schema, and a generic
 * comparison against an invented range is a statement about arithmetic rather than
 * about a binary (GPT-6 review, P1-2). The rollback refusal is therefore obtained by
 * running this module *in the base checkout*, where the declared range is {N,N} and
 * the refusal is the previous image's own.
 *
 * Both answers are the processes' own: `buildReadinessReport` is what the API's
 * readiness gate calls before it answers a request, `checkWorkerStartup` is what
 * `apps/worker/src/bootstrap/worker.ts` calls before it registers a handler. The
 * asymmetry between them is real — the worker exits, the API stays up and refuses
 * traffic with 503 — and is reported rather than smoothed over.
 */

export interface StartupOutcome {
  readonly component: 'api' | 'worker';
  readonly declaredRange: { readonly minimum: number; readonly maximum: number };
  readonly databaseVersion: number | null;
  /** The component's own verdict, not a re-derived one. */
  readonly ready: boolean;
  readonly reason: string | null;
  /** What the process does about it: an exit code, or the status the API answers. */
  readonly effect: string;
}

/** The API's own readiness report. */
export async function apiStartupHere(session: SessionQueryable): Promise<StartupOutcome> {
  const readiness = await buildReadinessReport({ session });
  return {
    component: 'api',
    declaredRange: readiness.schema.declaredRange,
    databaseVersion: readiness.schema.databaseVersion,
    ready: readiness.ready,
    reason: readiness.reason,
    effect: readiness.ready ? 'ready (readyz 200)' : `refuses traffic (readyz ${String(NOT_READY_STATUS)})`,
  };
}

/** The worker's own startup check, with the exit code it would exit with. */
export async function workerStartupHere(session: SessionQueryable): Promise<StartupOutcome> {
  const startup = await checkWorkerStartup({ session });
  return {
    component: 'worker',
    declaredRange: startup.declaredRange,
    databaseVersion: startup.databaseVersion,
    ready: startup.outcome === 'ready',
    reason: startup.reason,
    effect:
      startup.outcome === 'ready'
        ? `starts (exit ${String(WORKER_EXIT_CODES.ok)})`
        : `exits ${String(startup.exitCode)} (${startup.outcome})`,
  };
}

export interface RegistryReport {
  readonly built: boolean;
  readonly kinds: readonly string[];
  readonly classes: Readonly<Record<string, number>>;
  /** Proved rather than asserted: a kind with no class is refused. */
  readonly refusesKindWithoutClass: boolean;
  /** Empty when the registry was built; otherwise why it could not be. */
  readonly detail: string;
}

/** The shape `apps/worker/src/bootstrap/main.ts` exports for this test to call. */
interface WorkerBootstrap {
  readonly registerHandlers?: (
    registry: HandlerRegistry,
    composition: { classifier: undefined; mail: undefined; send: undefined; research: undefined },
  ) => HandlerRegistry;
}

/**
 * Build the registry this checkout's bootstrap builds, with no provider adapters — the
 * composition a worker deployed without Gmail or a classifier key gets, which is every
 * kind that reaches nothing outside PostgreSQL. Then prove the refusal the registry
 * exists for: a kind with no job class is `CLASS_MISSING` and stops the process,
 * because a worker that cannot say whether a job is urgent or bulk cannot schedule it.
 *
 * A checkout whose bootstrap does not export `registerHandlers` cannot answer this, and
 * that is a failure rather than a note (P1-2): the alternative is a hand-written list
 * here, which would assert the list rather than the bootstrap.
 */
export function buildWorkerRegistrySync(bootstrap: WorkerBootstrap): RegistryReport {
  if (bootstrap.registerHandlers === undefined) {
    return {
      built: false,
      kinds: [],
      classes: {},
      refusesKindWithoutClass: false,
      detail:
        "this checkout's apps/worker/src/bootstrap/main.ts does not export registerHandlers, so the registry cannot be built the way its own bootstrap builds it",
    };
  }
  const registry = bootstrap.registerHandlers(new HandlerRegistry(), {
    classifier: undefined,
    mail: undefined,
    send: undefined,
    // Lane R's ports. `pageFetch` needs no credential, so a deployed worker always has
    // them — but they are `apps/worker` adapters over `node:https` and the Anthropic
    // transport, and this test composes no provider adapter at all. So the two research
    // kinds are absent from the registry this step reports, which is the same treatment
    // Gmail and the classifier get.
    research: undefined,
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
  return { built: true, kinds: registry.kinds(), classes, refusesKindWithoutClass: refused, detail: '' };
}

/** Load this checkout's worker bootstrap and build its registry. */
export async function buildWorkerRegistry(): Promise<RegistryReport> {
  return buildWorkerRegistrySync((await import('../../apps/worker/src/bootstrap/main.ts')) as WorkerBootstrap);
}
