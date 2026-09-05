import { createSafeLogger, defineLogPolicy, type LogLevel } from "@callie-sourcing/shared";

const safeLog = createSafeLogger(
  defineLogPolicy({
    component: 'enricher',
    events: {
      SCHEDULED_RUN_COMPLETED: ["durationMs", "count", "unprocessedCount"],
      RUN_NOTICE: ["count", "status"],
    },
  }),
);


function numberField(fields: Record<string, unknown>, keys: readonly string[]): number {
  for (const key of keys) {
    const value = fields[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  }
  return 0;
}

export { type LogLevel };

export function log(
  level: LogLevel,
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  if (msg === 'enricher run complete') {
    const count = numberField(fields, ["eventsWritten"]);
    const seen = numberField(fields, ["requestsSeen"]);
    safeLog(level, "SCHEDULED_RUN_COMPLETED", {
      durationMs: numberField(fields, ["durationMs"]),
      count,
      unprocessedCount: Math.max(0, seen - count),
    });
    return;
  }

  safeLog(level, "RUN_NOTICE", {
    count: numberField(fields, ["count", "dropped", "invalid_lines", "status"]),
    status: typeof fields.status === "string" ? fields.status : undefined,
  });
}
