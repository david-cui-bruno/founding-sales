import { createSafeLogger, defineLogPolicy, type LogLevel } from "@callie-sourcing/shared";

const safeLog = createSafeLogger(
  defineLogPolicy({
    component: "mail-parse",
    events: {
      MAIL_CLASSIFIED: [],
      MAIL_PROCESSING_NOTICE: ["count", "errorClass"],
    },
  }),
);

export { type LogLevel };

export function log(
  level: LogLevel,
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  if (msg === "classified inbound mail") {
    safeLog(level, "MAIL_CLASSIFIED");
    return;
  }
  safeLog(level, "MAIL_PROCESSING_NOTICE", {
    count: typeof fields.written === "number" ? fields.written : 0,
    errorClass: fields.error,
  });
}
