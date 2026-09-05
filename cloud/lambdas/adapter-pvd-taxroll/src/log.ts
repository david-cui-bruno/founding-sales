import { createSafeLogger, defineLogPolicy, type LogLevel, type ScheduledRunStatus } from "@callie-sourcing/shared";
type LogEvents = {
  "resuming from persisted cursor": { offset: number };
  "run time-boxed, cursor persisted for resume": { offset: number };
  "run finished": { status: ScheduledRunStatus; written: number; fetched: number; completed: boolean; durationMs: number };
};
const safeLog = createSafeLogger(defineLogPolicy({ component: "adapter-pvd-taxroll", events: { SCHEDULED_RUN_COMPLETED: ["status", "durationMs", "count", "unprocessedCount"], RUN_NOTICE: [] } }));
export { type LogLevel };
export function log<M extends keyof LogEvents>(level: LogLevel, message: M, fields: LogEvents[M]): void {
  if (message === "run finished") { const value = fields as LogEvents["run finished"]; safeLog(level, "SCHEDULED_RUN_COMPLETED", { status: value.status, durationMs: value.durationMs, count: value.written, unprocessedCount: value.completed ? 0 : 1 }); return; }
  safeLog(level, "RUN_NOTICE");
}
