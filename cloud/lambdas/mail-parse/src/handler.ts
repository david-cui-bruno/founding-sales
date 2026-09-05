/**
 * SES inbound mail parser.
 *
 * Flow per SES record:
 *   1. GetObject raw MIME from RAW_MAIL_BUCKET at raw-mail/<messageId>
 *   2. mailparser -> from/subject/html/text
 *   3. classify (zillow_frbo | apartments_frbo | f5bot | test | unknown)
 *   4. extract typed fields -> CloudSourceEvents (validated against the
 *      shared schema before writing)
 *   5. per event: conditional-put idempotency_key (attribute_not_exists)
 *      into IDEMPOTENCY_TABLE with a 90-day TTL; skip event on failure
 *   6. write all surviving events as one ndjson object to
 *      INBOX_BUCKET/events/YYYY-MM-DD/mail-parse-<ulid>.ndjson
 *
 * Logging: structured JSON, never the email body (PII). Subject is OK.
 */
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  SafeHandlerError,
  ulid,
  validateSourceEvent,
  type CloudSourceEvent,
} from "@callie-sourcing/shared";
import { simpleParser, type ParsedMail } from "mailparser";
import type { SESEvent } from "aws-lambda";
import { classifyMail, TEST_CLASSIFY_HEADER, type Classification } from "./classify";
import { buildCommunityEvent, buildFrboEvent, type MailMeta } from "./events";
import { extractF5BotHits, extractFrboListings, stripTags } from "./extract";
import { log } from "./log";
import { pushHotEvents } from "./notify";

const RAW_MAIL_PREFIX = "raw-mail/";
const IDEMPOTENCY_TTL_DAYS = 90;

export interface HandlerDeps {
  s3: Pick<S3Client, "send">;
  dynamo: Pick<DynamoDBClient, "send">;
  env: {
    RAW_MAIL_BUCKET: string;
    INBOX_BUCKET: string;
    IDEMPOTENCY_TABLE: string;
    /** ntfy topic for hot-lead pushes. Empty/absent disables pushes. */
    NTFY_TOPIC?: string;
  };
  /** Injected fetch for push notifications (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

function envOrThrow(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

function defaultDeps(): HandlerDeps {
  return {
    s3: new S3Client({}),
    dynamo: new DynamoDBClient({}),
    env: {
      RAW_MAIL_BUCKET: envOrThrow("RAW_MAIL_BUCKET"),
      INBOX_BUCKET: envOrThrow("INBOX_BUCKET"),
      IDEMPOTENCY_TABLE: envOrThrow("IDEMPOTENCY_TABLE"),
      NTFY_TOPIC: process.env.NTFY_TOPIC,
    },
  };
}

function headerValue(mail: ParsedMail, name: string): string | null {
  const value = mail.headers.get(name);
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "value" in value) {
    const inner = (value as { value: unknown }).value;
    if (typeof inner === "string") return inner;
  }
  return null;
}

/**
 * Try to claim an idempotency key. Returns false when another invocation
 * already claimed it (conditional check failure) — the caller must skip the
 * event. Any other Dynamo error propagates: failing open would break the
 * exactly-once guarantee the app relies on.
 */
async function claimIdempotencyKey(
  deps: HandlerDeps,
  key: string,
  eventId: string,
  nowMs: number,
): Promise<boolean> {
  try {
    await deps.dynamo.send(
      new PutItemCommand({
        TableName: deps.env.IDEMPOTENCY_TABLE,
        Item: {
          idempotency_key: { S: key },
          event_id: { S: eventId },
          created_at: { S: new Date(nowMs).toISOString() },
          expires_at: {
            N: String(Math.floor(nowMs / 1000) + IDEMPOTENCY_TTL_DAYS * 24 * 60 * 60),
          },
        },
        ConditionExpression: "attribute_not_exists(idempotency_key)",
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return false;
    if (
      error &&
      typeof error === "object" &&
      (error as { name?: string }).name === "ConditionalCheckFailedException"
    ) {
      return false;
    }
    throw error;
  }
}

interface RecordResult {
  classification: Classification;
  extracted: number;
  written: number;
  idempotencySkips: number;
  invalid: number;
}

async function processMessage(
  deps: HandlerDeps,
  messageId: string,
  now: () => Date,
): Promise<RecordResult> {
  const s3Key = `${RAW_MAIL_PREFIX}${messageId}`;
  const raw = await deps.s3.send(
    new GetObjectCommand({ Bucket: deps.env.RAW_MAIL_BUCKET, Key: s3Key }),
  );
  const body = raw.Body;
  if (!body) throw new Error(`empty S3 body for ${s3Key}`);
  const rawBytes = await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();

  const mail = await simpleParser(Buffer.from(rawBytes));
  const fromAddress = mail.from?.value?.[0]?.address ?? null;
  const subject = mail.subject ?? null;

  const classification = classifyMail({
    fromAddress,
    subject,
    testClassifyHeader: headerValue(mail, TEST_CLASSIFY_HEADER),
  });

  const fetchedAt = now();
  const meta: MailMeta = {
    messageId,
    observedAt: mail.date ?? fetchedAt,
    fetchedAt,
  };

  log("info", "classified inbound mail", {
    messageId,
    s3Key,
    classification,
    subject, // subject only — never the body (PII)
    fromDomain: fromAddress?.split("@")[1] ?? null,
  });

  const result: RecordResult = {
    classification,
    extracted: 0,
    written: 0,
    idempotencySkips: 0,
    invalid: 0,
  };

  if (classification === "unknown" || classification === "test") {
    log("info", "no events for classification, done", { messageId, classification });
    return result;
  }

  const html = typeof mail.html === "string" ? mail.html : null;
  const text = mail.text ?? (html ? stripTags(html) : null);

  let candidates: CloudSourceEvent[] = [];
  if (classification === "zillow_frbo" || classification === "apartments_frbo") {
    const source = classification === "zillow_frbo" ? "zillow" : "apartments";
    const listings = extractFrboListings(classification, html, text);
    candidates = listings.map((listing) => buildFrboEvent(listing, source, meta));
  } else if (classification === "f5bot") {
    const hits = extractF5BotHits(text);
    candidates = hits.map((hit) => buildCommunityEvent(hit, meta));
  }
  result.extracted = candidates.length;

  if (candidates.length === 0) {
    log("warn", "classified mail yielded no extractable events (template drift?)", {
      messageId,
      classification,
    });
    return result;
  }

  const events: CloudSourceEvent[] = [];
  for (const candidate of candidates) {
    const validation = validateSourceEvent(candidate);
    if (!validation.success) {
      result.invalid += 1;
      log("error", "built event failed schema validation, dropping", {
        messageId,
        classification,
        eventId: candidate.id,
        error: validation.error,
      });
      continue;
    }
    const claimed = await claimIdempotencyKey(
      deps,
      candidate.idempotency_key,
      candidate.id,
      fetchedAt.getTime(),
    );
    if (!claimed) {
      result.idempotencySkips += 1;
      log("info", "idempotency key already claimed, skipping event", {
        messageId,
        idempotencyKey: candidate.idempotency_key,
      });
      continue;
    }
    events.push(validation.data);
  }

  if (events.length === 0) {
    log("info", "all events skipped or invalid, nothing to write", {
      messageId,
      classification,
      idempotencySkips: result.idempotencySkips,
      invalid: result.invalid,
    });
    return result;
  }

  const date = fetchedAt.toISOString().slice(0, 10);
  const inboxKey = `events/${date}/mail-parse-${ulid(fetchedAt.getTime())}.ndjson`;
  const ndjson = events.map((event) => JSON.stringify(event)).join("\n") + "\n";

  await deps.s3.send(
    new PutObjectCommand({
      Bucket: deps.env.INBOX_BUCKET,
      Key: inboxKey,
      Body: ndjson,
      ContentType: "application/x-ndjson",
    }),
  );
  result.written = events.length;

  log("info", "wrote events to inbox", {
    messageId,
    classification,
    inboxKey,
    written: result.written,
    idempotencySkips: result.idempotencySkips,
    invalid: result.invalid,
  });

  // Hot-lead phone push. Fire-and-forget: a push failure must never fail
  // mail processing (the event is already durably in the inbox).
  if (deps.env.NTFY_TOPIC) {
    try {
      const pushed = await pushHotEvents(
        { fetchImpl: deps.fetchImpl ?? fetch, topic: deps.env.NTFY_TOPIC },
        events,
      );
      if (pushed > 0) log("info", "sent hot-lead pushes", { messageId, pushed });
    } catch (error) {
      log("warn", "hot-lead push failed (event already in inbox)", {
        messageId,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
  }

  return result;
}

export async function handlerWithDeps(event: SESEvent, deps: HandlerDeps): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const records = event.Records ?? [];

  if (records.length === 0) {
    log("warn", "received event with no SES records");
    return;
  }

  for (const record of records) {
    const messageId = record.ses.mail.messageId;
    try {
      await processMessage(deps, messageId, now);
    } catch (error) {
      // Log and rethrow: SES lambda_action is async (Event invocation), so a
      // throw surfaces in Lambda error metrics/retries instead of vanishing.
      log("error", "failed to process message", {
        messageId,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
      throw error;
    }
  }
}

export function createHandler(depsFactory: () => HandlerDeps): (event: SESEvent) => Promise<void> {
  let cachedDeps: HandlerDeps | null = null;
  return async (event) => {
    try {
      cachedDeps ??= depsFactory();
      await handlerWithDeps(event, cachedDeps);
    } catch {
      throw new SafeHandlerError();
    }
  };
}

const productionHandler = createHandler(defaultDeps);

export async function handler(event: SESEvent): Promise<void> {
  await productionHandler(event);
}
