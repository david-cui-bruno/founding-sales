/**
 * Suppression-sync Lambda handler (EventBridge-invoked only when enabled).
 *
 * Incremental mode fails closed on invalid objects. Explicit replay mode parses
 * all retained versions, quarantines invalid history, applies the deterministic
 * source union, reconciles membership, and writes immutable private evidence.
 *
 * Logging never includes row bodies, contact HMACs, or other contact data.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { ulid } from "@callie-sourcing/shared";
import { log } from "./log";
import {
  ledgerHas,
  ledgerMark,
  listUploadObjects,
  readValidatedObject,
  runReconciliation,
  runReplay,
  writeSuppression,
  type HandlerDeps,
  type SuppressionReplayResult,
  type SuppressionSyncEvent,
} from "./replay";
import { SuppressionObjectValidationError } from "./suppressionObject";

export {
  REPORTS_PREFIX,
  UPLOADS_PREFIX,
  type HandlerDeps,
  type SuppressionReplayReport,
  type SuppressionReplayResult,
  type SuppressionSyncEvent,
} from "./replay";

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

export interface HandlerResult {
  filesSeen: number;
  filesProcessed: number;
  filesSkipped: number;
  linesWritten: number;
  invalidLines: number;
}

async function runIncremental(
  deps: HandlerDeps,
  event: Extract<SuppressionSyncEvent, { mode?: "incremental" }>,
  now: Date,
): Promise<HandlerResult> {
  const allObjects = await listUploadObjects(deps);
  const objects =
    typeof event.maxObjects === "number"
      ? allObjects.slice(0, event.maxObjects)
      : allObjects;

  const result: HandlerResult = {
    filesSeen: objects.length,
    filesProcessed: 0,
    filesSkipped: 0,
    linesWritten: 0,
    invalidLines: 0,
  };

  for (const descriptor of objects) {
    let object;
    try {
      object = await readValidatedObject(deps, descriptor);
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

export function runHandler(
  deps: HandlerDeps,
  event?: Extract<SuppressionSyncEvent, { mode?: "incremental" }>,
): Promise<HandlerResult>;
export function runHandler(
  deps: HandlerDeps,
  event: Exclude<SuppressionSyncEvent, { mode?: "incremental" }>,
): Promise<SuppressionReplayResult>;
export function runHandler(
  deps: HandlerDeps,
  event: SuppressionSyncEvent,
): Promise<HandlerResult | SuppressionReplayResult>;
export async function runHandler(
  deps: HandlerDeps,
  event: SuppressionSyncEvent = {},
): Promise<HandlerResult | SuppressionReplayResult> {
  const now = deps.now ? deps.now() : new Date();
  const runId = deps.runId ? deps.runId(now.getTime()) : ulid(now.getTime());

  if (event.mode === "replay") {
    return runReplay(deps, { dryRun: event.dryRun, now, runId });
  }
  if (event.mode === "reconcile") {
    return runReconciliation(deps, { reportKey: event.reportKey, now });
  }
  return runIncremental(deps, event, now);
}

export async function handler(
  event: SuppressionSyncEvent = {},
): Promise<HandlerResult | SuppressionReplayResult> {
  return runHandler(defaultDeps(), event);
}
