import type { Server } from 'node:http';
import type { ApiHeartbeat } from './heartbeat.ts';
import type { Logger } from './log.ts';

/**
 * How the API stops on `SIGTERM` (lane g75).
 *
 * In order, inside one budget (`FSS_API_SHUTDOWN_TIMEOUT_MS`, 20 s by default, under
 * the task's 30 s `stopTimeout`):
 *
 * 1. **Stop accepting.** `server.close()` refuses new connections. A keep-alive socket
 *    whose request has finished is closed as soon as it is idle — swept every
 *    `IDLE_SWEEP_MILLISECONDS` — rather than lingering for the keep-alive timeout,
 *    which is what `close()` alone does on Node 24 and which cost five seconds a stop.
 * 2. **Wait for the requests in flight** until the last socket closes.
 * 3. **The heartbeat** stops, so the last beat is not written by a process that is no
 *    longer serving.
 * 4. **`pool.end()`**, which resolves when every checked-out connection has come back
 *    — the one wait that covers a request whose caller hung up while it was still
 *    holding a backend.
 * 5. **The heartbeat's connection** ends.
 *
 * A step that has not finished at the deadline is not waited for; the stop reports
 * `drained: false` and the process ends anyway. The exit code does not change.
 */

export const IDLE_SWEEP_MILLISECONDS = 50;

export interface DrainParts {
  readonly server: Server;
  readonly pool: { end(): Promise<void> };
  readonly heartbeat: ApiHeartbeat;
  readonly heartbeatClient: { end(): Promise<void> };
  readonly timeoutMilliseconds: number;
  readonly log: Logger;
}

export interface DrainReport {
  /** False when requests or connections were still out at the deadline. */
  readonly drained: boolean;
}

/** Resolves true if `work` settles before `deadline`, false otherwise. Never rejects. */
async function beforeDeadline(work: Promise<unknown>, deadline: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<boolean>(resolve => {
    timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
    timer.unref?.();
  });
  try {
    return await Promise.race([work.then(
      () => true,
      () => true,
    ), expired]);
  } finally {
    clearTimeout(timer);
  }
}

export async function drainApi(parts: DrainParts): Promise<DrainReport> {
  const deadline = Date.now() + parts.timeoutMilliseconds;

  const closed = new Promise<void>(resolve => {
    parts.server.close(() => resolve());
  });
  parts.server.closeIdleConnections();
  const sweep = setInterval(() => parts.server.closeIdleConnections(), IDLE_SWEEP_MILLISECONDS);
  sweep.unref?.();
  const requestsDrained = await beforeDeadline(closed, deadline);
  clearInterval(sweep);

  await parts.heartbeat.stop();

  const connectionsDrained = await beforeDeadline(parts.pool.end(), deadline);
  await parts.heartbeatClient.end().catch(() => undefined);

  const drained = requestsDrained && connectionsDrained;
  parts.log.log(drained ? 'info' : 'warn', 'api_drained', {
    drained,
    requests_drained: requestsDrained,
    connections_drained: connectionsDrained,
  });
  return { drained };
}
