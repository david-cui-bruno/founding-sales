import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The file the container health check stats.
 *
 * `infra/modules/cluster/variables.tf` gives the worker task
 * `["CMD-SHELL", "node -e \"require('node:fs').statSync('/tmp/fss-worker-heartbeat')\""]`.
 * A worker with no HTTP surface has to say something, and a file that exists is the
 * cheapest thing ECS can ask about.
 *
 * `statSync` succeeds on a stale file, so existence alone would be a health check that
 * can never fail. The file is therefore a *statement*, not a timestamp: it exists only
 * while every loop is succeeding, and the worker removes it after a loop has failed
 * the configured number of times in a row. A worker whose database is gone loses its
 * file, fails its health check, and is replaced — which is the behaviour spec 4.2 asks
 * for when the alternative is a task that is up and doing nothing.
 */

export interface Liveness {
  readonly path: string;
  /** Record the outcome of one pass of one loop and rewrite or remove the file. */
  report(loop: string, healthy: boolean): void;
  readonly healthy: boolean;
  remove(): void;
}

export interface LivenessOptions {
  readonly path: string;
  readonly failuresBeforeRemoval: number;
  readonly instanceKey: string;
  readonly now?: (() => Date) | undefined;
}

export function createLiveness(options: LivenessOptions): Liveness {
  const consecutiveFailures = new Map<string, number>();
  const now = options.now ?? ((): Date => new Date());
  let present = false;

  const write = (): void => {
    mkdirSync(dirname(options.path), { recursive: true });
    // The content is for a human reading a stopped task, not for the health check.
    writeFileSync(options.path, `${JSON.stringify({ instance: options.instanceKey, at: now().toISOString() })}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    present = true;
  };

  const remove = (): void => {
    rmSync(options.path, { force: true });
    present = false;
  };

  const healthy = (): boolean =>
    [...consecutiveFailures.values()].every(failures => failures < options.failuresBeforeRemoval);

  return {
    path: options.path,
    get healthy() {
      return healthy();
    },
    report(loop, ok) {
      consecutiveFailures.set(loop, ok ? 0 : (consecutiveFailures.get(loop) ?? 0) + 1);
      if (healthy()) write();
      else if (present) remove();
    },
    remove,
  };
}

/** A liveness that writes nothing, for a test that does not care about the file. */
export function noLiveness(): Liveness {
  return { path: '', report: () => undefined, healthy: true, remove: () => undefined };
}
