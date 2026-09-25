import type { SessionQueryable } from '@fss/domain/db';
import { DatabaseBusyError } from './connections.ts';
import type { Logger } from './log.ts';
import {
  LIVENESS_PATH,
  READINESS_PATH,
  buildReadinessReport,
  type NotReadyReason,
  type ReadinessReport,
} from './readiness.ts';
import type { ReadinessInputs } from './routeRegistry.ts';

/**
 * Readiness on the request path (lane g86, the other half of audit S14).
 *
 * Since lane g81 the load balancer asks `/readyz`, so a task whose database cannot
 * answer, whose schema is outside the range this binary declares, or whose system
 * generation is not the pinned one is taken out of rotation. Out of rotation is not the
 * same as refusing. The target group needs consecutive failed checks before it stops
 * routing to a task, so for tens of seconds after the database moved the routes still
 * ran against it — a restored copy included, which is exactly what Appendix E step 1's
 * pin exists to keep a task from serving. So every request except the four below asks
 * this gate first, and a task that is not ready answers 503 `not_ready` without
 * authenticating anybody or running the route.
 *
 * **The verdict is cached**, for `READINESS_GATE_TTL_MILLISECONDS`. The check is the one
 * `/readyz` answers with (`buildReadinessReport`), made at most once per window per
 * process whatever the request rate, on the connection of the request that found the
 * cache stale; requests arriving while it runs wait for that one check rather than
 * starting their own. Inside the window a request costs a clock read and nothing on the
 * database. A task that has just turned unfit keeps serving for at most one window, and
 * one that has recovered keeps refusing for at most one: a few seconds either way,
 * against the load balancer's tens.
 *
 * **A busy pool is not a verdict.** When the check could not get a connection inside the
 * checkout timeout it proves nothing about the schema or the generation, so nothing is
 * cached and the request is answered exactly as any request whose checkout timed out:
 * 503 `database_busy`, which the caller may retry. The next request checks again.
 *
 * **Exempt, and only these.** `/healthz` must answer from the process alone, `/readyz`
 * *is* the check, `/health` is the operator's degraded-but-answering report, and
 * `/auth/client-version` is what an outdated Mac is allowed to read whatever else is
 * true (5.3). None of them mutates anything.
 */

export const READINESS_GATE_TTL_MILLISECONDS = 5_000;

/** Answered whatever the readiness verdict says. Exact paths; nothing beneath them. */
export const READINESS_EXEMPT_PATHS: readonly string[] = Object.freeze([
  LIVENESS_PATH,
  READINESS_PATH,
  '/health',
  '/auth/client-version',
]);

/** Why a request was refused. `database_busy` never appears: it is thrown, not cached. */
export type GateRefusalReason = Exclude<NotReadyReason, 'database_busy'>;

export type ReadinessAdmission =
  | { readonly admitted: true }
  | { readonly admitted: false; readonly reason: GateRefusalReason };

export interface ReadinessGate {
  /**
   * Whether a request for `path` may run. `session` is that request's own connection,
   * used only when the cached verdict has expired. Throws `DatabaseBusyError` when the
   * check could not get a connection in time.
   */
  admit(path: string, session: SessionQueryable): Promise<ReadinessAdmission>;
}

export interface ReadinessGateOptions {
  readonly expectedSystemGeneration: number | null;
  readonly ttlMilliseconds?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly log?: Logger | undefined;
  /** The check. `buildReadinessReport`, the one `/readyz` answers with, unless a test says otherwise. */
  readonly check?: ((inputs: ReadinessInputs) => Promise<ReadinessReport>) | undefined;
}

interface Verdict {
  readonly ready: boolean;
  readonly reason: GateRefusalReason | null;
  readonly at: number;
}

const ADMITTED: ReadinessAdmission = Object.freeze({ admitted: true });

export function createReadinessGate(options: ReadinessGateOptions): ReadinessGate {
  const ttl = options.ttlMilliseconds ?? READINESS_GATE_TTL_MILLISECONDS;
  const now = options.now ?? ((): number => Date.now());
  const check = options.check ?? buildReadinessReport;
  let verdict: Verdict | null = null;
  let pending: Promise<Verdict> | null = null;

  const record = (next: Verdict): void => {
    const previous = verdict;
    verdict = next;
    // One line when the answer changes, not one per window: an operator reading the log
    // sees when this task stopped serving and why, and when it started again.
    const changed = previous === null ? !next.ready : previous.ready !== next.ready || previous.reason !== next.reason;
    if (changed) {
      options.log?.log(next.ready ? 'info' : 'warn', 'api_readiness_changed', { ready: next.ready, reason: next.reason });
    }
  };

  const refresh = (session: SessionQueryable): Promise<Verdict> => {
    pending ??= (async (): Promise<Verdict> => {
      try {
        const report = await check({ session, expectedSystemGeneration: options.expectedSystemGeneration });
        if (report.reason === 'database_busy') {
          throw new DatabaseBusyError('no database connection came free in time for the readiness check');
        }
        const next: Verdict = { ready: report.ready, reason: report.ready ? null : report.reason, at: now() };
        record(next);
        return next;
      } finally {
        pending = null;
      }
    })();
    return pending;
  };

  const fresh = (): Verdict | null => {
    if (verdict === null) return null;
    const age = now() - verdict.at;
    // A clock that went backwards is not a reason to trust an old answer.
    return age >= 0 && age < ttl ? verdict : null;
  };

  return {
    admit: async (path, session) => {
      if (READINESS_EXEMPT_PATHS.includes(path)) return ADMITTED;
      const current = fresh() ?? (await refresh(session));
      // Fails closed: a not-ready report always names a reason, and one that somehow did
      // not is the database not answering rather than a pass.
      return current.ready ? ADMITTED : { admitted: false, reason: current.reason ?? 'database_unreachable' };
    },
  };
}
