/**
 * Structured JSON logging.
 *
 * PII rule: log NOTHING about people — no names, no addresses, no phone
 * numbers, no emails, no HMACs. Counts, s3 keys, entity ids and statuses
 * only. Contact data lives in events, never in logs.
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
