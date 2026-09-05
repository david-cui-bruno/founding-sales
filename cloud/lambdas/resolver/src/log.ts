import { createSafeLogger, defineLogPolicy, type LogLevel, type ScheduledRunStatus } from "@callie-sourcing/shared";
type LogEvents = { "resolver run complete": { status: ScheduledRunStatus; entitiesResolved: number; personEvents: number; durationMs: number } };
const safeLog = createSafeLogger(defineLogPolicy({ component: "resolver", events: { SCHEDULED_RUN_COMPLETED: ["status", "durationMs", "count", "unprocessedCount"] } }));
export { type LogLevel };
export function log<M extends keyof LogEvents>(level: LogLevel, message: M, fields: LogEvents[M]): void { const value = fields as LogEvents["resolver run complete"]; safeLog(level, "SCHEDULED_RUN_COMPLETED", { status: value.status, durationMs: value.durationMs, count: value.entitiesResolved, unprocessedCount: Math.max(0, value.personEvents - value.entitiesResolved) }); }
