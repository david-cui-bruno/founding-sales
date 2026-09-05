import { createSafeLogger, defineLogPolicy, type LogLevel } from "@callie-sourcing/shared";

const safeLog = createSafeLogger(
  defineLogPolicy({
    component: 'adapter-boston-assessments',
    events: {
      SCHEDULED_RUN_COMPLETED: ["durationMs", "count", "unprocessedCount"],
      RUN_NOTICE: ["count", "status"],
    },
  }),
);

let runStartedAt = Date.now();

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
  if (msg === 'run starting') {
    runStartedAt = Date.now();
    return;
  }

  if (msg === 'run finished') {
    const count = numberField(fields, ['written']);
    const seen = numberField(fields, ['entitiesScanned', 'entitiesSwept']);
    safeLog(level, "SCHEDULED_RUN_COMPLETED", {
      durationMs: Math.max(0, Date.now() - runStartedAt),
      count,
      unprocessedCount: Math.max(0, seen - count),
    });
    runStartedAt = Date.now();
    return;
  }

  safeLog(level, "RUN_NOTICE", {
    count: numberField(fields, ["count", "dropped", "invalid_lines", "status"]),
    status: typeof fields.status === "string" ? fields.status : undefined,
  });
}
