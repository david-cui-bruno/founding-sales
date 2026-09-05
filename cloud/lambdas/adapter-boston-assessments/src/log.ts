import { createSafeLogger, defineLogPolicy, type LogLevel, type ScheduledRunStatus } from "@callie-sourcing/shared";

type LogEvents = {
  "run starting": { entitiesScanned: number; entitiesToSweep: number };
  "run time-boxed; remaining entities picked up next monthly run": { swept: number; total: number };
  "run finished": {
    status: ScheduledRunStatus;
    written: number;
    entitiesScanned: number;
    entitiesSwept: number;
    durationMs: number;
  };
};

const safeLog = createSafeLogger(defineLogPolicy({
  component: "adapter-boston-assessments",
  events: {
    SCHEDULED_RUN_COMPLETED: ["status", "durationMs", "count", "unprocessedCount"],
    RUN_NOTICE: [],
  },
}));

export { type LogLevel };

export function log<Message extends keyof LogEvents>(
  level: LogLevel,
  message: Message,
  fields: LogEvents[Message],
): void {
  if (message === "run starting") return;
  if (message === "run finished") {
    const completion = fields as LogEvents["run finished"];
    safeLog(level, "SCHEDULED_RUN_COMPLETED", {
      status: completion.status,
      durationMs: completion.durationMs,
      count: completion.written,
      unprocessedCount: Math.max(0, completion.entitiesScanned - completion.entitiesSwept),
    });
    return;
  }
  safeLog(level, "RUN_NOTICE");
}
