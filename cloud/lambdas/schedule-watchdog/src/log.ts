import {
  createSafeLogger,
  defineLogPolicy,
  type LogLevel,
  type ScheduledRunStatus,
} from "@callie-sourcing/shared";

interface WatchdogCompletion {
  status: ScheduledRunStatus;
  durationMs: number;
  targetsEvaluated: number;
  unhealthyGaugeCount: number;
}

const safeLog = createSafeLogger(defineLogPolicy({
  component: "schedule-watchdog",
  events: {
    SCHEDULED_RUN_COMPLETED: ["status", "durationMs", "count", "unprocessedCount"],
  },
}));

export function logScheduledRunCompleted(
  level: LogLevel,
  completion: WatchdogCompletion,
): void {
  safeLog(level, "SCHEDULED_RUN_COMPLETED", {
    status: completion.status,
    durationMs: completion.durationMs,
    count: completion.targetsEvaluated,
    unprocessedCount: completion.unhealthyGaugeCount,
  });
}
