/**
 * Structured JSON logging.
 *
 * PII rule: NEVER log email body content (may contain PII about people the
 * pipeline observed). Subject lines and message IDs are OK.
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
