import { createSafeLogger, defineLogPolicy, type LogLevel } from "@callie-sourcing/shared";

type LogEvents = {
  "tracerfy rate limited, backing off once": { backoff_ms: number };
  "tracerfy server error, retrying once": { status: number };
  "invalid enrichment request lines skipped": { s3_key: string; invalid_lines: number };
  "monthly credit cap reached, skipping request": { cloud_entity_id: string; month: string; month_to_date_credits: number; cap: number; alarm_published: boolean };
  "tracerfy: insufficient credits, stopping run": { cloud_entity_id: string };
  "tracerfy: account suspended, stopping run": { cloud_entity_id: string };
  "tracerfy: still rate limited after backoff, stopping run": { cloud_entity_id: string };
  "tracerfy: server error after retry, stopping run": { cloud_entity_id: string; status: number };
  "tracerfy: unexpected response, stopping run": { cloud_entity_id: string; status: number; detail: string };
  "suppressed contacts dropped": { cloud_entity_id: string; dropped: number; all_dropped: boolean };
  "enricher run complete": { eventsWritten: number; requestsSeen: number; durationMs: number };
};

const safeLog = createSafeLogger(defineLogPolicy({
  component: "enricher",
  events: {
    SCHEDULED_RUN_COMPLETED: ["durationMs", "count", "unprocessedCount"],
    ENRICHER_NOTICE: ["count"],
  },
}));

export { type LogLevel };

export function log<M extends keyof LogEvents>(level: LogLevel, message: M, fields: LogEvents[M]): void {
  if (message === "enricher run complete") {
    const value = fields as LogEvents["enricher run complete"];
    safeLog(level, "SCHEDULED_RUN_COMPLETED", {
      durationMs: value.durationMs,
      count: value.eventsWritten,
      unprocessedCount: Math.max(0, value.requestsSeen - value.eventsWritten),
    });
    return;
  }
  const count = message === "suppressed contacts dropped"
    ? (fields as LogEvents["suppressed contacts dropped"]).dropped
    : message === "invalid enrichment request lines skipped"
      ? (fields as LogEvents["invalid enrichment request lines skipped"]).invalid_lines
      : undefined;
  safeLog(level, "ENRICHER_NOTICE", { count });
}
