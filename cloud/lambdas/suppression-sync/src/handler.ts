/**
 * Suppression-sync Lambda handler (EventBridge-invoked, every 15 min when
 * enabled — same cadence as the enricher it protects).
 *
 * Flow:
 *   1. List s3://<inbox>/upstream/suppressions/*.ndjson. A per-FILE ledger
 *      (snapshots table, natural key `suppression-sync:<s3 key>`, snapshot
 *      date "ledger") skips files already fully processed.
 *   2. Parse lines against suppressionUploadLineSchema; invalid lines are
 *      counted and skipped (a malformed line can never corrupt the table).
 *   3. PutItem each hash into the suppression table (idempotent overwrite:
 *      the key IS the hash; latest reason/timestamp wins). The enricher
 *      GetItems this table before any contact-bearing event reaches the
 *      inbox (CONTRACT.md compliance invariant).
 *   4. Mark the file done ONLY when every line was written.
 *
 * Logging: structured JSON — counts only, never hashes (a hash is not PII
 * but logging it invites correlation; counts are enough to operate).
 */
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  suppressionUploadLineSchema,
  type SuppressionUploadLine,
} from "@callie-sourcing/shared";
import { log } from "./log";

export const UPLOADS_PREFIX = "upstream/suppressions/";
const LEDGER_SNAPSHOT_DATE = "ledger";

export interface HandlerDeps {
  s3: Pick<S3Client, "send">;
  dynamo: Pick<DynamoDBClient, "send">;
  env: {
    INBOX_BUCKET: string;
    SNAPSHOTS_TABLE: string;
    SUPPRESSION_TABLE: string;
  };
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
      INBOX_BUCKET: envOrThrow("INBOX_BUCKET"),
      SNAPSHOTS_TABLE: envOrThrow("SNAPSHOTS_TABLE"),
      SUPPRESSION_TABLE: envOrThrow("SUPPRESSION_TABLE"),
    },
  };
}

function ledgerKey(s3Key: string): string {
  return `suppression-sync:${s3Key}`;
}

async function ledgerHas(deps: HandlerDeps, s3Key: string): Promise<boolean> {
  const result = await deps.dynamo.send(
    new GetItemCommand({
      TableName: deps.env.SNAPSHOTS_TABLE,
      Key: {
        source_natural_key: { S: ledgerKey(s3Key) },
        snapshot_date: { S: LEDGER_SNAPSHOT_DATE },
      },
    }),
  );
  return result.Item !== undefined;
}

async function ledgerMark(
  deps: HandlerDeps,
  s3Key: string,
  now: Date,
): Promise<void> {
  await deps.dynamo.send(
    new PutItemCommand({
      TableName: deps.env.SNAPSHOTS_TABLE,
      Item: {
        source_natural_key: { S: ledgerKey(s3Key) },
        snapshot_date: { S: LEDGER_SNAPSHOT_DATE },
        processed_at: { S: now.toISOString() },
      },
    }),
  );
}

async function listUploadKeys(deps: HandlerDeps): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await deps.s3.send(
      new ListObjectsV2Command({
        Bucket: deps.env.INBOX_BUCKET,
        Prefix: UPLOADS_PREFIX,
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of page.Contents ?? []) {
      if (object.Key?.endsWith(".ndjson")) keys.push(object.Key);
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys.sort();
}

interface ParsedFile {
  lines: SuppressionUploadLine[];
  invalidLines: number;
}

async function readLines(deps: HandlerDeps, key: string): Promise<ParsedFile> {
  const raw = await deps.s3.send(
    new GetObjectCommand({ Bucket: deps.env.INBOX_BUCKET, Key: key }),
  );
  const body = raw.Body;
  if (!body) return { lines: [], invalidLines: 0 };
  const text = await (
    body as { transformToString(): Promise<string> }
  ).transformToString();

  const lines: SuppressionUploadLine[] = [];
  let invalidLines = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = suppressionUploadLineSchema.safeParse(JSON.parse(line));
      if (parsed.success) lines.push(parsed.data);
      else invalidLines += 1;
    } catch {
      invalidLines += 1;
    }
  }
  return { lines, invalidLines };
}

async function writeSuppression(
  deps: HandlerDeps,
  line: SuppressionUploadLine,
  now: Date,
): Promise<void> {
  await deps.dynamo.send(
    new PutItemCommand({
      TableName: deps.env.SUPPRESSION_TABLE,
      Item: {
        contact_hash: { S: line.contact_hmac },
        kind: { S: line.kind },
        reason: { S: line.reason },
        observed_at: { S: line.observed_at },
        synced_at: { S: now.toISOString() },
      },
    }),
  );
}

export interface HandlerResult {
  filesSeen: number;
  filesProcessed: number;
  filesSkipped: number;
  linesWritten: number;
  invalidLines: number;
}

export async function runHandler(
  deps: HandlerDeps,
  event: { maxFiles?: number } = {},
): Promise<HandlerResult> {
  const now = deps.now ? deps.now() : new Date();
  const allKeys = await listUploadKeys(deps);
  const keys =
    typeof event.maxFiles === "number" ? allKeys.slice(0, event.maxFiles) : allKeys;

  const result: HandlerResult = {
    filesSeen: keys.length,
    filesProcessed: 0,
    filesSkipped: 0,
    linesWritten: 0,
    invalidLines: 0,
  };

  for (const key of keys) {
    if (await ledgerHas(deps, key)) {
      result.filesSkipped += 1;
      continue;
    }
    const { lines, invalidLines } = await readLines(deps, key);
    result.invalidLines += invalidLines;
    for (const line of lines) {
      await writeSuppression(deps, line, now);
      result.linesWritten += 1;
    }
    await ledgerMark(deps, key, now);
    result.filesProcessed += 1;
  }

  log("info", "suppression_sync_run", {
    files_seen: result.filesSeen,
    files_processed: result.filesProcessed,
    files_skipped: result.filesSkipped,
    lines_written: result.linesWritten,
    invalid_lines: result.invalidLines,
  });
  return result;
}

export async function handler(event: { maxFiles?: number } = {}): Promise<HandlerResult> {
  return runHandler(defaultDeps(), event);
}
