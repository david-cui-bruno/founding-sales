import { createSafeLogger, defineLogPolicy, type LogLevel, type ScheduledRunStatus } from "@callie-sourcing/shared";
type LogEvents = {
  "run starting": { sinceDate: string; storedWatermark: string | null; maxRows: number | null };
  "run time-boxed, watermark advanced to last processed date": { watermark: string };
  "run finished": { status: ScheduledRunStatus; written: number; fetched: number; durationMs: number };
};
const safeLog = createSafeLogger(defineLogPolicy({ component: "adapter-boston-rentsmart", events: { SCHEDULED_RUN_COMPLETED: ["status", "durationMs", "count", "unprocessedCount"], RUN_NOTICE: [] } }));
export { type LogLevel };
export function log<M extends keyof LogEvents>(level: LogLevel, message: M, fields: LogEvents[M]): void {
  if (message === "run starting") return;
  if (message === "run finished") { const value = fields as LogEvents["run finished"]; safeLog(level, "SCHEDULED_RUN_COMPLETED", { status: value.status, durationMs: value.durationMs, count: value.written, unprocessedCount: 0 }); return; }
  safeLog(level, "RUN_NOTICE");
}
