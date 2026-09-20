import type { SessionQueryable } from '@fss/domain/db';
import { recordHeartbeat } from '@fss/domain/jobs';
import { errorFields, type Logger } from './log.ts';

/**
 * The API's heartbeat (specification 13.3: "Heartbeats cover API, scheduler, worker,
 * and every mailbox").
 *
 * The API does not publish metrics — the worker does, from the `heartbeats` table —
 * so all this process has to do is say it is here. `ApiHeartbeat` is a
 * `treat_missing_data = "breaching"` alarm in `infra/modules/alerts/main.tf`, which
 * means an API that stops writing this row pages someone after three minutes even if
 * nothing else notices. That is the intended behaviour and the reason this loop is
 * separate from serving: a process too busy to answer requests is still a process that
 * should stop claiming to be healthy.
 *
 * `expected_interval_seconds` is written with the beat, so the emitter and the alarm
 * agree through a configuration change rather than each keeping a constant.
 */

export const DEFAULT_API_HEARTBEAT_INTERVAL_MILLISECONDS = 60_000;

export interface ApiHeartbeatOptions {
  /** One connection of its own: a heartbeat must not wait behind a request's query. */
  readonly session: SessionQueryable;
  readonly instanceKey: string;
  readonly intervalMilliseconds?: number | undefined;
  readonly log: Logger;
}

export interface ApiHeartbeat {
  stop(): Promise<void>;
}

export function startApiHeartbeat(options: ApiHeartbeatOptions): ApiHeartbeat {
  const interval = options.intervalMilliseconds ?? DEFAULT_API_HEARTBEAT_INTERVAL_MILLISECONDS;
  let stopping = false;
  let wake: (() => void) | null = null;

  const finished = (async () => {
    while (!stopping) {
      try {
        await recordHeartbeat(options.session, {
          component: 'api',
          instanceKey: options.instanceKey,
          expectedIntervalSeconds: Math.max(1, Math.round(interval / 1000)),
        });
      } catch (error) {
        // A failed beat is not a failed process: the alarm is the consequence, and
        // saying so in the log is what tells the operator which of the two it is.
        options.log.log('error', 'api_heartbeat_failed', errorFields(error));
      }
      if (stopping) break;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => {
          wake = null;
          resolve();
        }, interval);
        timer.unref?.();
        wake = () => {
          clearTimeout(timer);
          wake = null;
          resolve();
        };
      });
    }
  })();

  return {
    stop: async () => {
      stopping = true;
      wake?.();
      await finished;
    },
  };
}
