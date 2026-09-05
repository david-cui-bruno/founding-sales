/**
 * adapter-pvd-taxroll Lambda handler.
 *
 * Weekly EventBridge invocation. Full pass over the Providence tax roll
 * (Socrata 6ub4-iebe) with $limit/$offset paging ordered by p_id:
 *   1. page rows
 *   2. filter to landlord-relevant classes (see taxroll.ts)
 *   3. diffSnapshot per retained row — only 'new'/'changed' rows emit events
 *   4. emitEvents (validate, idempotency, one ndjson file per run)
 *
 * Time-box: if the elapsed run time approaches MAX_RUNTIME_MS (default
 * 840000 = 14min of the 15min Lambda budget), persist the current offset
 * under the reserved snapshot key `pvd-taxroll:__cursor__` and stop; the next
 * invocation resumes from there. On a completed pass the cursor resets to 0.
 *
 * Test payload: {"maxRows": 50} bounds the number of source rows fetched.
 */
import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import {
  diffSnapshot,
  emitEvents,
  type CloudSourceEvent,
  SafeHandlerError,
} from "@callie-sourcing/shared";
import {
  ADAPTER_NAME,
  buildParcelEvent,
  contentFingerprint,
  naturalKey,
  shouldRetainRow,
  type TaxRollRow,
} from "./taxroll";
import { log } from "./log";

const SOCRATA_URL = "https://data.providenceri.gov/resource/6ub4-iebe.json";
const PAGE_SIZE = 1000;
/** Reserved snapshots-table key holding the resume offset. */
export const CURSOR_KEY = "pvd-taxroll:__cursor__";
const CURSOR_SNAPSHOT_DATE = "cursor";

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

async function readCursor(deps: HandlerDeps): Promise<number> {
  const result = await deps.dynamo.send(
    new GetItemCommand({
      TableName: deps.env.SNAPSHOTS_TABLE,
      Key: {
        source_natural_key: { S: CURSOR_KEY },
        snapshot_date: { S: CURSOR_SNAPSHOT_DATE },
      },
    }),
  );
  const offset = result.Item?.cursor_offset?.N;
  return offset ? Number(offset) : 0;
}

async function writeCursor(deps: HandlerDeps, offset: number, nowIso: string): Promise<void> {
  await deps.dynamo.send(
    new PutItemCommand({
      TableName: deps.env.SNAPSHOTS_TABLE,
      Item: {
        source_natural_key: { S: CURSOR_KEY },
        snapshot_date: { S: CURSOR_SNAPSHOT_DATE },
        cursor_offset: { N: String(offset) },
        updated_at: { S: nowIso },
      },
    }),
  );
}

async function fetchPage(
  deps: HandlerDeps,
  offset: number,
  limit: number,
): Promise<TaxRollRow[]> {
  const url = `${SOCRATA_URL}?$order=p_id&$limit=${limit}&$offset=${offset}`;
  const response = await deps.fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Socrata fetch failed: HTTP ${response.status} at offset ${offset}`);
  }
  return (await response.json()) as TaxRollRow[];
}

export interface RunResult {
  fetched: number;
  retained: number;
  new: number;
  changed: number;
  unchanged: number;
  written: number;
  idempotencySkips: number;
  inboxKey: string | null;
  completed: boolean;
  resumeOffset: number | null;
}

export async function handlerWithDeps(
  event: AdapterEvent | null | undefined,
  deps: HandlerDeps,
): Promise<RunResult> {
  const now = deps.now ?? (() => new Date());
  const startMs = now().getTime();
  const maxRows = event?.maxRows;
  const snapshotDate = now().toISOString().slice(0, 10);

  let offset = maxRows ? 0 : await readCursor(deps);
  if (offset > 0) log("info", "resuming from persisted cursor", { offset });

  const result: RunResult = {
    fetched: 0,
    retained: 0,
    new: 0,
    changed: 0,
    unchanged: 0,
    written: 0,
    idempotencySkips: 0,
    inboxKey: null,
    completed: false,
    resumeOffset: null,
  };

  const events: CloudSourceEvent[] = [];
  let timedOut = false;

  while (true) {
    const pageLimit = maxRows ? Math.min(PAGE_SIZE, maxRows - result.fetched) : PAGE_SIZE;
    if (pageLimit <= 0) break;

    const rows = await fetchPage(deps, offset, pageLimit);
    result.fetched += rows.length;

    for (const row of rows) {
      if (!row.p_id) continue;
      if (!shouldRetainRow(row)) continue;
      result.retained += 1;

      const diff = await diffSnapshot({
        dynamo: deps.dynamo,
        table: deps.env.SNAPSHOTS_TABLE,
        naturalKey: naturalKey(row),
        contentFingerprint: contentFingerprint(row),
        snapshotDate,
      });
      result[diff] += 1;
      if (diff === "unchanged") continue;

      events.push(buildParcelEvent(row, { fetchedAt: now(), snapshotDate }));
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

  // Cursor bookkeeping (skipped in bounded test runs so tests never clobber
  // production resume state).
  if (!maxRows) {
    if (timedOut) {
      result.resumeOffset = offset;
      await writeCursor(deps, offset, now().toISOString());
      log("warn", "run time-boxed, cursor persisted for resume", { offset });
    } else if (result.completed) {
      await writeCursor(deps, 0, now().toISOString());
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
    let result: RunResult | undefined;
    try {
      cachedDeps ??= depsFactory();
      result = await handlerWithDeps(event, cachedDeps);
      return result;
    } catch {
      throw new SafeHandlerError();
    } finally {
      log("info", "run finished", { written: result?.written ?? 0, fetched: result?.fetched ?? 0, completed: result?.completed ?? false, durationMs: Math.max(0, Math.round(monotonicNow() - startedAt)) });
    }
  };
}

const productionHandler = createHandler(defaultDeps);

export async function handler(event: AdapterEvent | null | undefined): Promise<RunResult> {
  return productionHandler(event);
}
