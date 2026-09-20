/**
 * One repeating piece of work that never runs twice at once and can be asked to stop.
 *
 * The scheduler timer, the runner slots and the metric publication are all the same
 * shape: do the work, wait, do it again, and when a stop is requested finish what is
 * in flight rather than abandoning it. `SIGTERM` on Fargate means "you have
 * `stopTimeout` seconds", so the stop is a promise that resolves when the in-flight
 * pass is over, not a flag someone hopes is read.
 *
 * `setInterval` is deliberately not used. It fires on a wall-clock cadence regardless
 * of how long the previous pass took, so a pass that runs longer than its interval
 * overlaps itself — which for the scheduler means two passes competing for the same
 * advisory lock, and for the runner means two claims on one connection.
 */

export type PassOutcome = 'busy' | 'idle';

export interface LoopOptions {
  readonly name: string;
  readonly intervalMilliseconds: number;
  /** `busy` skips the wait: a runner that just did work asks for more immediately. */
  run(): Promise<PassOutcome>;
  onError(error: unknown): void;
}

export interface Loop {
  readonly name: string;
  readonly passes: number;
  readonly failures: number;
  /** Resolves when the pass in flight has finished. Safe to call more than once. */
  stop(): Promise<void>;
}

export function startLoop(options: LoopOptions): Loop {
  let stopping = false;
  let passes = 0;
  let failures = 0;
  let wake: (() => void) | null = null;

  const sleep = async (milliseconds: number): Promise<void> => {
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, milliseconds);
      // Unref so a loop waiting out its interval cannot hold the process open past a
      // stop that has already been asked for.
      timer.unref?.();
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });
  };

  const finished = (async () => {
    while (!stopping) {
      let outcome: PassOutcome = 'idle';
      try {
        outcome = await options.run();
        passes += 1;
      } catch (error) {
        failures += 1;
        options.onError(error);
      }
      if (stopping) break;
      if (outcome === 'busy') continue;
      await sleep(options.intervalMilliseconds);
    }
  })();

  return {
    name: options.name,
    get passes() {
      return passes;
    },
    get failures() {
      return failures;
    },
    stop: async () => {
      stopping = true;
      wake?.();
      await finished;
    },
  };
}

/** Wait for every loop to drain, or give up at the deadline and say which it was. */
export async function drain(loops: readonly Loop[], timeoutMilliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), timeoutMilliseconds);
    timer.unref?.();
  });
  const stopped = Promise.all(loops.map(async loop => loop.stop())).then(() => 'drained' as const);
  try {
    return (await Promise.race([stopped, expired])) === 'drained';
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
