/**
 * Placeholder SES inbound mail parser.
 *
 * SES receipt rule invokes this Lambda AFTER storing the full MIME message
 * in the raw-mail bucket under raw-mail/<messageId>. For now we only
 * reconstruct that S3 key, log structured JSON, and exit. The real parser
 * (MIME parse -> SourceEvent -> inbox bucket, guarded by the idempotency
 * table) comes later.
 */
import type { SESEvent } from "aws-lambda";

const RAW_MAIL_PREFIX = "raw-mail/";

interface LogEntry {
  level: "info" | "warn";
  msg: string;
  messageId?: string;
  s3Key?: string;
  rawMailBucket?: string;
  recipients?: string[];
  timestamp: string;
}

function log(entry: Omit<LogEntry, "timestamp">): void {
  console.log(JSON.stringify({ ...entry, timestamp: new Date().toISOString() }));
}

export async function handler(event: SESEvent): Promise<void> {
  const records = event.Records ?? [];

  if (records.length === 0) {
    log({ level: "warn", msg: "received event with no SES records" });
    return;
  }

  for (const record of records) {
    const mail = record.ses.mail;
    // The s3_action in the receipt rule stores the message at
    // <object_key_prefix><messageId>, so the key is derivable from the event.
    const s3Key = `${RAW_MAIL_PREFIX}${mail.messageId}`;

    log({
      level: "info",
      msg: "received inbound mail (placeholder parser, no-op)",
      messageId: mail.messageId,
      s3Key,
      rawMailBucket: process.env.RAW_MAIL_BUCKET,
      recipients: record.ses.receipt.recipients,
    });
  }
}
