import { createSafeLogger, defineLogPolicy, type LogLevel } from "@callie-sourcing/shared";

type LogEvents = {
  "classified inbound mail": { messageId: string; s3Key: string; classification: string; subject: string | null; fromDomain: string | null };
  "no events for classification, done": { messageId: string; classification: string };
  "classified mail yielded no extractable events (template drift?)": { messageId: string; classification: string };
  "built event failed schema validation, dropping": { messageId: string; classification: string; eventId: string; error: unknown };
  "idempotency key already claimed, skipping event": { messageId: string; idempotencyKey: string };
  "all events skipped or invalid, nothing to write": { messageId: string; classification: string; idempotencySkips: number; invalid: number };
  "wrote events to inbox": { messageId: string; classification: string; inboxKey: string; written: number; idempotencySkips: number; invalid: number };
  "sent hot-lead pushes": { messageId: string; pushed: number };
  "hot-lead push failed (event already in inbox)": { messageId: string; error: unknown };
  "received event with no SES records": undefined;
  "failed to process message": { messageId: string; error: unknown };
};

const safeLog = createSafeLogger(defineLogPolicy({
  component: "mail-parse",
  events: {
    MAIL_CLASSIFIED: [],
    MAIL_PROCESSING_NOTICE: ["count", "errorClass"],
  },
}));

export { type LogLevel };

export function log<M extends keyof LogEvents>(
  level: LogLevel,
  message: M,
  ...args: LogEvents[M] extends undefined ? [] : [fields: LogEvents[M]]
): void {
  const fields = args[0] as Exclude<LogEvents[M], undefined> | undefined;
  if (message === "classified inbound mail") {
    safeLog(level, "MAIL_CLASSIFIED");
    return;
  }
  const count = fields && "written" in fields
    ? fields.written
    : fields && "pushed" in fields
      ? fields.pushed
      : undefined;
  const errorClass = fields && "error" in fields ? fields.error : undefined;
  safeLog(level, "MAIL_PROCESSING_NOTICE", { count, errorClass });
}
