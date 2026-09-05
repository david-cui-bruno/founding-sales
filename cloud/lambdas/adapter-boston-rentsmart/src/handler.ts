/**
 * adapter-boston-rentsmart Lambda handler.
 *
 * Daily EventBridge invocation. Scopes each run to recent rows instead of
 * full scans: a date watermark is persisted in the snapshots table under the
 * reserved key `boston-rentsmart:__watermark__`, and each run queries
 * datastore_search_sql for rows with date >= watermark (inclusive overlap;
 * per-row snapshot diffing suppresses re-emits of unchanged rows).
 * First run (no watermark) looks back LOOKBACK_DAYS (default 7).
 *
 * Time-box: pages are processed in date-ascending order; when MAX_RUNTIME_MS
 * is exceeded the run stops and the watermark only advances to the last
 * fully-processed row's date, so the next run resumes there.
 *
 * Test payload: {"maxRows": 50} bounds the run and skips watermark writes.
 */
import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import {
  diffSnapshot,
  emitEvents,
  type CloudSourceEvent,
  SafeHandlerError,
  type ScheduledRunStatus,
} from "@callie-sourcing/shared";
import {
  ADAPTER_NAME,
  buildViolationEvent,
  contentFingerprint,
  isoDateOf,
  naturalKey,
  RESOURCE_ID,
  type RentSmartRow,
} from "./rentsmart";
import { log } from "./log";

const CKAN_SQL_URL = "https://data.boston.gov/api/3/action/datastore_search_sql";
const PAGE_SIZE = 1000;
const DEFAULT_LOOKBACK_DAYS = 7;
/** Reserved snapshots-table key holding the date watermark. */
export const WATERMARK_KEY = "boston-rentsmart:__watermark__";
const WATERMARK_SNAPSHOT_DATE = "watermark";

export interface AdapterEvent {
  /** Bound the run to ~N source rows (live testing). */
  maxRows?: number;
}

export interface HandlerDeps {
  s3: Pick<S3Client, "send">;
  dynamo: Pick<DynamoDBClient, "send">;
  fetchImpl: typeof fetch;
  env: {
    INBOX_BUCKET: string;
    IDEMPOTENCY_TABLE: string;
    SNAPSHOTS_TABLE: string;
    MAX_RUNTIME_MS: number;
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
    fetchImpl: fetch,
    env: {
      INBOX_BUCKET: envOrThrow("INBOX_BUCKET"),
      IDEMPOTENCY_TABLE: envOrThrow("IDEMPOTENCY_TABLE"),
      SNAPSHOTS_TABLE: envOrThrow("SNAPSHOTS_TABLE"),
      MAX_RUNTIME_MS: Number(process.env.MAX_RUNTIME_MS ?? "840000"),
    },
  };
}

async function readWatermark(deps: HandlerDeps): Promise<string | null> {
  const result = await deps.dynamo.send(
    new GetItemCommand({
      TableName: deps.env.SNAPSHOTS_TABLE,
      Key: {
        source_natural_key: { S: WATERMARK_KEY },
        snapshot_date: { S: WATERMARK_SNAPSHOT_DATE },
      },
    }),
  );
  return result.Item?.watermark_date?.S ?? null;
}

async function writeWatermark(deps: HandlerDeps, date: string, nowIso: string): Promise<void> {
  await deps.dynamo.send(
    new PutItemCommand({
      TableName: deps.env.SNAPSHOTS_TABLE,
      Item: {
        source_natural_key: { S: WATERMARK_KEY },
        snapshot_date: { S: WATERMARK_SNAPSHOT_DATE },
        watermark_date: { S: date },
        updated_at: { S: nowIso },
      },
    }),
  );
}

interface CkanSqlResponse {
  success: boolean;
  result?: { records?: RentSmartRow[] };
  error?: unknown;
}

async function fetchPage(
  deps: HandlerDeps,
  sinceDate: string,
  offset: number,
  limit: number,
): Promise<RentSmartRow[]> {
  // sinceDate is an internally-generated YYYY-MM-DD string, never user input.
  const sql =
    `SELECT * FROM "${RESOURCE_ID}" ` +
    `WHERE "date" >= '${sinceDate}' ` +
    `ORDER BY "date" ASC, "_id" ASC LIMIT ${limit} OFFSET ${offset}`;
  const url = `${CKAN_SQL_URL}?sql=${encodeURIComponent(sql)}`;
  const response = await deps.fetchImpl(url);
  if (!response.ok) {
    throw new Error(`CKAN fetch failed: HTTP ${response.status} at offset ${offset}`);
  }
  const body = (await response.json()) as CkanSqlResponse;
  if (!body.success) {
    throw new Error(`CKAN datastore_search_sql error: ${JSON.stringify(body.error)}`);
  }
  return body.result?.records ?? [];
}

export interface RunResult {
  fetched: number;
  new: number;
  changed: number;
  unchanged: number;
  written: number;
  triggers: number;
  identityOnly: number;
  idempotencySkips: number;
  inboxKey: string | null;
  completed: boolean;
  watermark: string | null;
}

export async function handlerWithDeps(
  event: AdapterEvent | null | undefined,
  deps: HandlerDeps,
): Promise<RunResult> {
  const now = deps.now ?? (() => new Date());
  const startMs = now().getTime();
  const maxRows = event?.maxRows;
  const snapshotDate = now().toISOString().slice(0, 10);

  const stored = maxRows ? null : await readWatermark(deps);
  const lookback = new Date(startMs - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const sinceDate = stored ?? lookback;
  log("info", "run starting", { sinceDate, storedWatermark: stored, maxRows: maxRows ?? null });

  const result: RunResult = {
    fetched: 0,
    new: 0,
    changed: 0,
    unchanged: 0,
    written: 0,
    triggers: 0,
    identityOnly: 0,
    idempotencySkips: 0,
    inboxKey: null,
    completed: false,
    watermark: null,
  };

  const events: CloudSourceEvent[] = [];
  let offset = 0;
  let lastProcessedDate: string | null = null;
  let timedOut = false;

  while (true) {
    const pageLimit = maxRows ? Math.min(PAGE_SIZE, maxRows - result.fetched) : PAGE_SIZE;
    if (pageLimit <= 0) break;

    const rows = await fetchPage(deps, sinceDate, offset, pageLimit);
    result.fetched += rows.length;

    for (const row of rows) {
      if (row._id === undefined || row._id === null) continue;

      const diff = await diffSnapshot({
        dynamo: deps.dynamo,
        table: deps.env.SNAPSHOTS_TABLE,
        naturalKey: naturalKey(row),
        contentFingerprint: contentFingerprint(row),
        snapshotDate,
      });
      result[diff] += 1;
      lastProcessedDate = isoDateOf(row.date) ?? lastProcessedDate;
      if (diff === "unchanged") continue;

      const built = buildViolationEvent(row, { fetchedAt: now(), snapshotDate });
      if (built.trigger) result.triggers += 1;
      else result.identityOnly += 1;
      events.push(built);
    }

    offset += rows.length;
    if (rows.length < pageLimit) {
      result.completed = true;
      break;
    }
    if (maxRows && result.fetched >= maxRows) break;

    if (now().getTime() - startMs > deps.env.MAX_RUNTIME_MS) {
      timedOut = true;
      break;
    }
  }

  const emit = await emitEvents({
    s3: deps.s3,
    dynamo: deps.dynamo,
    inboxBucket: deps.env.INBOX_BUCKET,
    idempotencyTable: deps.env.IDEMPOTENCY_TABLE,
    adapterName: ADAPTER_NAME,
    events,
    now,
  });
  result.written = emit.written;
  result.idempotencySkips = emit.idempotencySkips;
  result.inboxKey = emit.inboxKey;

  // Watermark bookkeeping (skipped in bounded test runs).
  if (!maxRows) {
    if (result.completed) {
      // Full window processed: advance to today. Inclusive >= plus snapshot
      // diffing makes the boundary overlap harmless.
      result.watermark = lastProcessedDate ?? snapshotDate;
      await writeWatermark(deps, result.watermark, now().toISOString());
    } else if (timedOut && lastProcessedDate) {
      result.watermark = lastProcessedDate;
      await writeWatermark(deps, lastProcessedDate, now().toISOString());
      log("warn", "run time-boxed, watermark advanced to last processed date", {
        watermark: lastProcessedDate,
      });
    }
  }

  return result;
}

export function createHandler(
  depsFactory: () => HandlerDeps,
  monotonicNow: () => number = () => performance.now(),
): (event: AdapterEvent | null | undefined) => Promise<RunResult> {
  let cachedDeps: HandlerDeps | null = null;
  return async (event) => {
    const startedAt = monotonicNow();
    let status: ScheduledRunStatus = "failure";
    let result: RunResult | undefined;
    try {
      cachedDeps ??= depsFactory();
      result = await handlerWithDeps(event, cachedDeps);
      status = "success";
      return result;
    } catch {
      throw new SafeHandlerError();
    } finally {
      log("info", "run finished", { status, written: result?.written ?? 0, fetched: result?.fetched ?? 0, durationMs: Math.max(0, Math.round(monotonicNow() - startedAt)) });
    }
  };
}

const productionHandler = createHandler(defaultDeps);

export async function handler(event: AdapterEvent | null | undefined): Promise<RunResult> {
  return productionHandler(event);
}
