/**
 * Suppression-sync Lambda handler (EventBridge-invoked only when enabled).
 *
 * Every retained S3 object version under the suppression prefix is fetched and
 * validated as a whole before any membership write. Completion is ledgered
 * only after every idempotent membership write succeeds.
 *
 * Logging is structured and never includes row bodies, contact HMACs, or other
 * contact data.
 */
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import {
  GetObjectCommand,
  ListObjectVersionsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { SuppressionUploadLine } from "@callie-sourcing/shared";
import { log } from "./log";
import {
  SuppressionObjectValidationError,
  ledgerNaturalKey,
  parseAndValidateSuppressionObject,
  type SuppressionObjectDescriptor,
  type ValidatedSuppressionObject,
} from "./suppressionObject";

export const UPLOADS_PREFIX = "upstream/suppression/";
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

function normalizeEtag(etag: string): string {
  return etag.startsWith('"') && etag.endsWith('"') ? etag.slice(1, -1) : etag;
}

function requiredVersionMetadata(
  key: string,
  field: string,
  value: unknown,
): asserts value {
  if (value === undefined || value === null) {
    throw new Error(`listed suppression object ${key} is missing ${field}`);
  }
}

async function listUploadObjects(
  deps: HandlerDeps,
): Promise<SuppressionObjectDescriptor[]> {
  const objects: SuppressionObjectDescriptor[] = [];
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;

  while (true) {
    const page = await deps.s3.send(
      new ListObjectVersionsCommand({
        Bucket: deps.env.INBOX_BUCKET,
        Prefix: UPLOADS_PREFIX,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
      }),
    );

    for (const version of page.Versions ?? []) {
      const key = version.Key;
      if (!key?.endsWith(".ndjson")) continue;
      requiredVersionMetadata(key, "ETag", version.ETag);
      requiredVersionMetadata(key, "LastModified", version.LastModified);
      objects.push({
        bucket: deps.env.INBOX_BUCKET,
        key,
        versionId: version.VersionId ?? null,
        etag: normalizeEtag(version.ETag),
        lastModified: version.LastModified.toISOString(),
      });
    }

    if (!page.IsTruncated) break;
    if (!page.NextKeyMarker) {
      throw new Error("truncated suppression object version listing has no next key marker");
    }
    keyMarker = page.NextKeyMarker;
    versionIdMarker = page.NextVersionIdMarker;
  }

  return objects;
}

async function readObject(
  deps: HandlerDeps,
  descriptor: SuppressionObjectDescriptor,
): Promise<ValidatedSuppressionObject> {
  const raw = await deps.s3.send(
    new GetObjectCommand({
      Bucket: descriptor.bucket,
      Key: descriptor.key,
      VersionId: descriptor.versionId ?? undefined,
    }),
  );
  const text = raw.Body
    ? await (raw.Body as { transformToString(): Promise<string> }).transformToString()
    : "";
  return parseAndValidateSuppressionObject({ descriptor, text });
}

function stringAttribute(
  item: Record<string, AttributeValue>,
  name: string,
): string | undefined {
  return item[name]?.S;
}

function versionAttributeMatches(
  item: Record<string, AttributeValue>,
  expected: string | null,
): boolean {
  const value = item.object_version_id;
  return expected === null ? value?.NULL === true : value?.S === expected;
}

async function ledgerHas(
  deps: HandlerDeps,
  object: ValidatedSuppressionObject,
): Promise<boolean> {
  const result = await deps.dynamo.send(
    new GetItemCommand({
      TableName: deps.env.SNAPSHOTS_TABLE,
      Key: {
        source_natural_key: { S: ledgerNaturalKey(object) },
        snapshot_date: { S: LEDGER_SNAPSHOT_DATE },
      },
    }),
  );
  const item = result.Item;
  if (!item) return false;

  return (
    stringAttribute(item, "object_bucket") === object.descriptor.bucket &&
    stringAttribute(item, "object_key") === object.descriptor.key &&
    versionAttributeMatches(item, object.descriptor.versionId) &&
    stringAttribute(item, "object_etag") === object.descriptor.etag &&
    stringAttribute(item, "object_checksum_sha256") === object.checksumSha256
  );
}

function versionAttribute(versionId: string | null): AttributeValue {
  return versionId === null ? { NULL: true } : { S: versionId };
}

async function ledgerMark(
  deps: HandlerDeps,
  object: ValidatedSuppressionObject,
  now: Date,
): Promise<void> {
  await deps.dynamo.send(
    new PutItemCommand({
      TableName: deps.env.SNAPSHOTS_TABLE,
      Item: {
        source_natural_key: { S: ledgerNaturalKey(object) },
        snapshot_date: { S: LEDGER_SNAPSHOT_DATE },
        object_bucket: { S: object.descriptor.bucket },
        object_key: { S: object.descriptor.key },
        object_version_id: versionAttribute(object.descriptor.versionId),
        object_etag: { S: object.descriptor.etag },
        object_checksum_sha256: { S: object.checksumSha256 },
        processed_at: { S: now.toISOString() },
        valid_row_count: { N: String(object.validRowCount) },
      },
    }),
  );
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
  const allObjects = await listUploadObjects(deps);
  const objects =
    typeof event.maxFiles === "number"
      ? allObjects.slice(0, event.maxFiles)
      : allObjects;

  const result: HandlerResult = {
    filesSeen: objects.length,
    filesProcessed: 0,
    filesSkipped: 0,
    linesWritten: 0,
    invalidLines: 0,
  };

  for (const descriptor of objects) {
    let object: ValidatedSuppressionObject;
    try {
      object = await readObject(deps, descriptor);
    } catch (error) {
      if (error instanceof SuppressionObjectValidationError) {
        log("error", "suppression_object_invalid", {
          key: error.key,
          version_id: error.versionId,
          invalid_line_numbers: error.invalidLineNumbers,
          invalid_line_count: error.invalidLineNumbers.length,
        });
      }
      throw error;
    }

    if (await ledgerHas(deps, object)) {
      result.filesSkipped += 1;
      continue;
    }

    for (const line of object.lines) {
      await writeSuppression(deps, line, now);
      result.linesWritten += 1;
    }
    await ledgerMark(deps, object, now);
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
