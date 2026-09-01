/**
 * Shared adapter emit pipeline, extracted from the mail-parse pattern
 * (mail-parse keeps its own copy for now; a later refactor can unify).
 *
 * Per event:
 *   1. validateSourceEvent — THROW on invalid (an adapter emitting invalid
 *      events is a bug, not a data condition)
 *   2. conditional-put idempotency_key (attribute_not_exists) with a 90-day
 *      TTL; a conditional failure means another run already claimed it — skip
 *   3. write all surviving events as ONE ndjson object to
 *      INBOX_BUCKET/events/YYYY-MM-DD/<adapterName>-<ulid>.ndjson
 *
 * Logging: structured JSON, no PII beyond public-record owner names (which
 * live in events, not logs).
 */
import { ConditionalCheckFailedException, PutItemCommand } from "@aws-sdk/client-dynamodb";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";
import { ulid, validateSourceEvent, type CloudSourceEvent } from "./sourceEvent";

const IDEMPOTENCY_TTL_DAYS = 90;

export interface EmitEventsInput {
  s3: Pick<S3Client, "send">;
  dynamo: Pick<DynamoDBClient, "send">;
  inboxBucket: string;
  idempotencyTable: string;
  /** e.g. "pvd-taxroll" — used in the ndjson file name. */
  adapterName: string;
  events: CloudSourceEvent[];
  /** Injectable clock for tests. */
  now?: () => Date;
}

export interface EmitEventsResult {
  /** Events passed in. */
  total: number;
  /** Events skipped because their idempotency key was already claimed. */
  idempotencySkips: number;
  /** Events written to the inbox file. */
  written: number;
  /** S3 key of the ndjson file, or null when no events survived. */
  inboxKey: string | null;
}

/**
 * Try to claim an idempotency key. Returns false when another invocation
 * already claimed it (conditional check failure) — the caller must skip the
 * event. Any other Dynamo error propagates: failing open would break the
 * exactly-once guarantee the app relies on.
 */
async function claimIdempotencyKey(
  dynamo: Pick<DynamoDBClient, "send">,
  table: string,
  key: string,
  eventId: string,
  nowMs: number,
): Promise<boolean> {
  try {
    await dynamo.send(
      new PutItemCommand({
        TableName: table,
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

export async function emitEvents(input: EmitEventsInput): Promise<EmitEventsResult> {
  const { s3, dynamo, inboxBucket, idempotencyTable, adapterName, events } = input;
  const now = input.now ?? (() => new Date());

  const result: EmitEventsResult = {
    total: events.length,
    idempotencySkips: 0,
    written: 0,
    inboxKey: null,
  };
  if (events.length === 0) return result;

  const nowDate = now();
  const surviving: CloudSourceEvent[] = [];
  for (const event of events) {
    const validation = validateSourceEvent(event);
    if (!validation.success) {
      // Invalid built events are adapter bugs: fail the run loudly rather
      // than silently dropping rows.
      throw new Error(`emitEvents: invalid event ${event.id}: ${validation.error}`);
    }
    const claimed = await claimIdempotencyKey(
      dynamo,
      idempotencyTable,
      event.idempotency_key,
      event.id,
      nowDate.getTime(),
    );
    if (!claimed) {
      result.idempotencySkips += 1;
      continue;
    }
    surviving.push(validation.data);
  }

  if (surviving.length === 0) return result;

  const date = nowDate.toISOString().slice(0, 10);
  const inboxKey = `events/${date}/${adapterName}-${ulid(nowDate.getTime())}.ndjson`;
  const ndjson = surviving.map((event) => JSON.stringify(event)).join("\n") + "\n";

  await s3.send(
    new PutObjectCommand({
      Bucket: inboxBucket,
      Key: inboxKey,
      Body: ndjson,
      ContentType: "application/x-ndjson",
    }),
  );

  result.written = surviving.length;
  result.inboxKey = inboxKey;
  return result;
}
