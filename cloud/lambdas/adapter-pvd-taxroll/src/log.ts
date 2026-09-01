/**
 * Structured JSON logging.
 *
 * PII rule: log nothing about people beyond public-record owner names, and
 * prefer counts/keys over row content.
 */

export type LogLevel = "info" | "warn" | "error";

export function log(
  level: LogLevel,
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  console.log(
    JSON.stringify({
      level,
      msg,
      ...fields,
      timestamp: new Date().toISOString(),
    }),
  );
}
