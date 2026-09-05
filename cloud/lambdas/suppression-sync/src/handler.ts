/**
 * Suppression-sync Lambda handler (EventBridge-invoked only when enabled).
 *
 * Production acquisition is sealed inside atomic mode-specific workflows.
 * Exported handler seams accept only capability-free object sources.
 *
 * Logging never includes row bodies, contact HMACs, or other contact data.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { SafeHandlerError, ulid } from "@callie-sourcing/shared";
import { log } from "./log";
import {
  iterateProductionIncrementalObjects,
  loadProductionReconciliationSource,
  loadProductionReplaySource,
} from "./productionSuppressionWorkflow";
import {
  assertReportKey,
  ledgerHas,
  ledgerMark,
  listUploadObjects,
  persistSuppressionMonotonically,
  readValidatedObject,
  runReconciliation,
  runReconciliationFromLoadedSource,
  runReplay,
  runReplayFromLoadedSource,
  type HandlerDeps,
  type ProductionHandlerDeps,
  type SuppressionReplayResult,
  type SuppressionSyncEvent,
} from "./replay";
import {
  SuppressionObjectValidationError,
  type ValidatedSuppressionObject,
} from "./suppressionObject";

export {
  REPORTS_PREFIX,
  UPLOADS_PREFIX,
  type CapabilityFreeSuppressionObjectSource,
  type HandlerDeps,
  type ProductionHandlerDeps,
  type ProductionReplaySource,
  type ReplayEvidenceObject,
  type ReplayQuarantineEntry,
  type SuppressionReplayReport,
  type SuppressionReplayResult,
  type SuppressionSyncEvent,
} from "./replay";

function envOrThrow(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

function defaultDeps(): ProductionHandlerDeps {
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

function invalidEvent(): never {
  throw new Error("invalid suppression sync event");
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function parseSuppressionSyncEvent(value: unknown): SuppressionSyncEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidEvent();
  }
  const event = value as Record<string, unknown>;
  const mode = event.mode;

  if (mode === undefined || mode === "incremental") {
    if (!hasOnlyKeys(event, ["mode", "maxObjects"])) return invalidEvent();
    if (
      event.maxObjects !== undefined &&
      (typeof event.maxObjects !== "number" ||
        !Number.isSafeInteger(event.maxObjects) ||
        event.maxObjects <= 0)
    ) {
      return invalidEvent();
    }
    return {
      ...(mode === "incremental" ? { mode } : {}),
      ...(event.maxObjects === undefined
        ? {}
        : { maxObjects: event.maxObjects }),
    };
  }

  if (mode === "replay") {
    if (
      !hasOnlyKeys(event, ["mode", "dryRun"]) ||
      typeof event.dryRun !== "boolean"
    ) {
      return invalidEvent();
    }
    return { mode, dryRun: event.dryRun };
  }

  if (mode === "reconcile") {
    if (
      !hasOnlyKeys(event, ["mode", "reportKey"]) ||
      typeof event.reportKey !== "string"
    ) {
      return invalidEvent();
    }
    assertReportKey(event.reportKey);
    return { mode, reportKey: event.reportKey };
  }

  return invalidEvent();
}

export interface HandlerResult {
  filesSeen: number;
  filesProcessed: number;
  filesSkipped: number;
  linesWritten: number;
  invalidLines: number;
}

async function processIncrementalObjects(
  deps: HandlerDeps,
  objects: AsyncIterable<ValidatedSuppressionObject>,
  now: Date,
): Promise<HandlerResult> {
  const result: HandlerResult = {
    filesSeen: 0,
    filesProcessed: 0,
    filesSkipped: 0,
    linesWritten: 0,
    invalidLines: 0,
  };

  for await (const object of objects) {
    result.filesSeen += 1;
    if (await ledgerHas(deps, object)) {
      result.filesSkipped += 1;
      continue;
    }
    for (const line of object.lines) {
      if (await persistSuppressionMonotonically(deps, line, now)) {
        result.linesWritten += 1;
      }
    }
    await ledgerMark(deps, object, now);
    result.filesProcessed += 1;
  }

  return result;
}

async function* iterateCapabilityFreeIncrementalObjects(
  deps: HandlerDeps,
  maxObjects?: number,
): AsyncIterable<ValidatedSuppressionObject> {
  const descriptors = await listUploadObjects(deps);
  const selected = maxObjects === undefined
    ? descriptors
    : descriptors.slice(0, maxObjects);
  for (const descriptor of selected) {
    try {
      yield await readValidatedObject(deps, descriptor);
    } catch (error) {
      if (error instanceof SuppressionObjectValidationError) {
        log("error", "suppression_object_invalid_aggregate", {
          invalid_line_numbers: error.invalidLineNumbers,
          invalid_line_count: error.invalidLineNumbers.length,
        });
      }
      throw error;
    }
  }
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
export function runHandler(
  deps: HandlerDeps,
  event: unknown,
): Promise<HandlerResult | SuppressionReplayResult>;
export async function runHandler(
  deps: HandlerDeps,
  event: unknown = {},
): Promise<HandlerResult | SuppressionReplayResult> {
  const parsedEvent = parseSuppressionSyncEvent(event);
  const now = deps.now ? deps.now() : new Date();
  const runId = deps.runId ? deps.runId(now.getTime()) : ulid(now.getTime());

  if (parsedEvent.mode === "replay") {
    return runReplay(deps, { dryRun: parsedEvent.dryRun, now, runId });
  }
  if (parsedEvent.mode === "reconcile") {
    return runReconciliation(deps, { reportKey: parsedEvent.reportKey, now });
  }
  return processIncrementalObjects(
    deps,
    iterateCapabilityFreeIncrementalObjects(deps, parsedEvent.maxObjects),
    now,
  );
}

async function runProductionHandler(
  deps: ProductionHandlerDeps,
  event: unknown = {},
): Promise<HandlerResult | SuppressionReplayResult> {
  const parsedEvent = parseSuppressionSyncEvent(event);
  const now = deps.now ? deps.now() : new Date();
  const runId = deps.runId ? deps.runId(now.getTime()) : ulid(now.getTime());

  if (parsedEvent.mode === "replay") {
    const source = await loadProductionReplaySource(deps.env.INBOX_BUCKET);
    return runReplayFromLoadedSource(deps, {
      dryRun: parsedEvent.dryRun,
      now,
      runId,
    }, source);
  }
  if (parsedEvent.mode === "reconcile") {
    const source = await loadProductionReconciliationSource(
      deps.env.INBOX_BUCKET,
    );
    return runReconciliationFromLoadedSource(deps, {
      reportKey: parsedEvent.reportKey,
      now,
    }, source);
  }
  return processIncrementalObjects(
    deps,
    iterateProductionIncrementalObjects(
      deps.env.INBOX_BUCKET,
      parsedEvent.maxObjects,
    ),
    now,
  );
}

function logScheduledCompletion(
  result: HandlerResult | SuppressionReplayResult | undefined,
  event: unknown,
  durationMs: number,
): void {
  const incremental = result && "filesSeen" in result ? result : undefined;
  const maintenance = result && "report" in result ? result.report : undefined;
  if (maintenance) {
    const reconcile = typeof event === "object" &&
      event !== null &&
      (event as { mode?: unknown }).mode === "reconcile";
    log("info", "suppression_scheduled_maintenance_run", {
      count: maintenance.objectsValid,
      unprocessed_count: reconcile
        ? maintenance.missingMemberships
        : maintenance.objectsQuarantined,
      durationMs,
    });
    return;
  }
  log("info", "suppression_sync_run", {
    files_seen: incremental?.filesSeen ?? 0,
    files_processed: incremental?.filesProcessed ?? 0,
    files_skipped: incremental?.filesSkipped ?? 0,
    lines_written: incremental?.linesWritten ?? 0,
    invalid_lines: incremental?.invalidLines ?? 0,
    durationMs,
  });
}

function createSafeInvocation(
  run: (event: unknown) => Promise<HandlerResult | SuppressionReplayResult>,
  monotonicNow: () => number,
): (event?: unknown) => Promise<HandlerResult | SuppressionReplayResult> {
  return async (event = {}) => {
    const startedAt = monotonicNow();
    let result: HandlerResult | SuppressionReplayResult | undefined;
    try {
      result = await run(event);
      return result;
    } catch {
      throw new SafeHandlerError();
    } finally {
      logScheduledCompletion(
        result,
        event,
        Math.max(0, Math.round(monotonicNow() - startedAt)),
      );
    }
  };
}

export function createHandler(
  depsFactory: () => HandlerDeps,
  monotonicNow: () => number = () => performance.now(),
): (event?: unknown) => Promise<HandlerResult | SuppressionReplayResult> {
  return createSafeInvocation(
    (event) => runHandler(depsFactory(), event),
    monotonicNow,
  );
}

export function createProductionHandler(
  depsFactory: () => ProductionHandlerDeps,
  monotonicNow: () => number = () => performance.now(),
): (event?: unknown) => Promise<HandlerResult | SuppressionReplayResult> {
  return createSafeInvocation(
    (event) => runProductionHandler(depsFactory(), event),
    monotonicNow,
  );
}

const productionHandler = createProductionHandler(defaultDeps);

export async function handler(
  event: unknown = {},
): Promise<HandlerResult | SuppressionReplayResult> {
  return productionHandler(event);
}
