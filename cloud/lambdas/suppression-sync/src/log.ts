import { createSafeLogger, defineLogPolicy, type LogLevel } from "@callie-sourcing/shared";

const safeLog = createSafeLogger(
  defineLogPolicy({
    component: "suppression-sync",
    events: {
      SCHEDULED_RUN_COMPLETED: ["durationMs", "count", "unprocessedCount"],
      SUPPRESSION_OBJECT_INVALID: [
        "objectKey",
        "objectVersionId",
        "objectEtag",
        "objectChecksumSha256",
        "invalidLineNumbers",
        "invalidLineCount",
        "lineNumber",
        "errorClass",
      ],
      SUPPRESSION_MAINTENANCE_COMPLETED: ["count", "unprocessedCount", "status"],
    },
  }),
);


function numberField(fields: Record<string, unknown>, ...keys: string[]): number {
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
  if (msg === "suppression_sync_run") {
    const count = numberField(fields, "files_processed");
    const seen = numberField(fields, "files_seen");
    safeLog(level, "SCHEDULED_RUN_COMPLETED", {
      durationMs: numberField(fields, "durationMs"),
      count,
      unprocessedCount: Math.max(0, seen - count),
    });
    return;
  }

  if (msg === "suppression_object_invalid" || msg === "suppression_object_quarantined") {
    safeLog(level, "SUPPRESSION_OBJECT_INVALID", {
      objectKey: fields.key,
      objectVersionId: fields.version_id,
      objectEtag: fields.etag,
      objectChecksumSha256: fields.checksum_sha256,
      invalidLineNumbers: fields.invalid_line_numbers,
      invalidLineCount: fields.invalid_line_count,
      lineNumber: fields.line_number,
      errorClass: fields.error,
    });
    return;
  }

  safeLog(level, "SUPPRESSION_MAINTENANCE_COMPLETED", {
    count: numberField(fields, "applied_memberships", "unique_memberships", "objects_valid"),
    unprocessedCount: numberField(fields, "missing_memberships", "unexpected_memberships", "objects_quarantined"),
    status: typeof fields.status === "string" ? fields.status : undefined,
  });
}
