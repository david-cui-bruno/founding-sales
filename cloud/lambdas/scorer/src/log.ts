/**
 * Structured JSON logging.
 *
 * PII rule: never log person fields or free text from events. Keys, counts,
 * classifications, and IDs are OK.
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
