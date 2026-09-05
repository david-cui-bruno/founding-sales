import { createSafeLogger, defineLogPolicy, type LogLevel } from "@callie-sourcing/shared";

type LogEvents = {
  suppression_sync_run: { files_seen: number; files_processed: number; files_skipped: number; lines_written: number; invalid_lines: number; durationMs: number };
  suppression_scheduled_maintenance_run: { count: number; unprocessed_count: number; durationMs: number };
  suppression_replay_run: { report_key: string; dry_run: boolean; objects_seen: number; objects_valid: number; objects_quarantined: number; unique_memberships: number; applied_memberships: number; missing_memberships: number; unexpected_memberships: number; source_union_checksum_sha256: string };
  suppression_reconciliation_run: { report_key: string; objects_seen: number; objects_valid: number; unique_memberships: number; missing_memberships: number; unexpected_memberships: number; source_union_checksum_sha256: string };
};

const safeLog = createSafeLogger(defineLogPolicy({ component: "suppression-sync", events: {
  SCHEDULED_RUN_COMPLETED: ["durationMs", "count", "unprocessedCount"],
  SUPPRESSION_MAINTENANCE_COMPLETED: ["count", "unprocessedCount"],
} }));

export { type LogLevel };

export function log<M extends keyof LogEvents>(level: LogLevel, message: M, fields: LogEvents[M]): void {
  if (message === "suppression_sync_run") {
    const value = fields as LogEvents["suppression_sync_run"];
    safeLog(level, "SCHEDULED_RUN_COMPLETED", { durationMs: value.durationMs, count: value.files_processed, unprocessedCount: Math.max(0, value.files_seen - value.files_processed - value.files_skipped) });
    return;
  }
  if (message === "suppression_scheduled_maintenance_run") {
    const value = fields as LogEvents["suppression_scheduled_maintenance_run"];
    safeLog(level, "SCHEDULED_RUN_COMPLETED", { durationMs: value.durationMs, count: value.count, unprocessedCount: value.unprocessed_count });
    return;
  }
  const value = fields as LogEvents["suppression_replay_run"] | LogEvents["suppression_reconciliation_run"];
  safeLog(level, "SUPPRESSION_MAINTENANCE_COMPLETED", {
    count: value.objects_valid,
    unprocessedCount: "objects_quarantined" in value ? value.objects_quarantined : value.missing_memberships,
  });
}
