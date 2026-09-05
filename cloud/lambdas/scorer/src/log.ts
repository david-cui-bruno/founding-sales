import { createSafeLogger, defineLogPolicy, type LogLevel } from "@callie-sourcing/shared";
type LogEvents = {
  "scored event failed schema validation, dropping": { eventId: string; idempotencyKey: string; error: unknown };
  "scorer run complete": { scored: number; unscored: number; durationMs: number };
};
const safeLog = createSafeLogger(defineLogPolicy({ component: "scorer", events: { SCHEDULED_RUN_COMPLETED: ["durationMs", "count", "unprocessedCount"], SCORER_EVENT_INVALID: ["errorClass"] } }));
export { type LogLevel };
export function log<M extends keyof LogEvents>(level: LogLevel, message: M, fields: LogEvents[M]): void { if (message === "scorer run complete") { const value = fields as LogEvents["scorer run complete"]; safeLog(level, "SCHEDULED_RUN_COMPLETED", { durationMs: value.durationMs, count: value.scored, unprocessedCount: Math.max(0, value.unscored - value.scored) }); return; } safeLog(level, "SCORER_EVENT_INVALID", { errorClass: (fields as LogEvents["scored event failed schema validation, dropping"]).error }); }
