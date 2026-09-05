/**
 * adapter-boston-assessments Lambda handler.
 *
 * Monthly EventBridge invocation. ENTITY-DRIVEN sweep (never a bulk import):
 *   1. Scan the entities table (env ENTITIES_TABLE, same table the resolver
 *      writes) — ~353 resolved entities today, one Scan page or two.
 *   2. Per entity, query the Boston FY2026 assessment roll via CKAN
 *      datastore_search_sql for rows whose UPPER(OWNER) equals the entity's
 *      canonical name OR normalized name (LIMIT 50 parcels per owner).
 *   3. Rows are re-checked with ownerMatchesEntity (token-set match), then
 *      diffSnapshot per PID — only 'new'/'changed' rows emit parcel events.
 *   4. emitEvents (validate, idempotency claim, one ndjson file per run).
 *
 * Time-box: entities are processed one at a time; when MAX_RUNTIME_MS is
 * exceeded the run stops after the current entity. No cursor: the monthly
 * sweep is cheap (~353 CKAN queries) and re-runs are idempotent.
 *
 * Test payload: {"maxEntities": 5} bounds the number of entities swept.
 */
import { DynamoDBClient, ScanCommand } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import {
  diffSnapshot,
  emitEvents,
  isAmbiguousName,
  type CloudSourceEvent,
} from "@callie-sourcing/shared";
import {
  ADAPTER_NAME,
  buildParcelEvent,
  contentFingerprint,
  MAX_PARCELS_PER_OWNER,
  naturalKey,
  ownerMatchesEntity,
  RESOURCE_ID,
  SELECTED_FIELDS,
  type AssessmentRow,
} from "./assessments";
import { log } from "./log";

const CKAN_SQL_URL = "https://data.boston.gov/api/3/action/datastore_search_sql";

export interface AdapterEvent {
  /** Bound the run to N entities (live testing). */
  maxEntities?: number;
}

export interface SweptEntity {
  canonicalName: string;
  normalizedName: string;
}

export interface HandlerDeps {
  s3: Pick<S3Client, "send">;
  dynamo: Pick<DynamoDBClient, "send">;
  fetchImpl: typeof fetch;
  env: {
    INBOX_BUCKET: string;
    IDEMPOTENCY_TABLE: string;
    SNAPSHOTS_TABLE: string;
    ENTITIES_TABLE: string;
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
      ENTITIES_TABLE: envOrThrow("ENTITIES_TABLE"),
      MAX_RUNTIME_MS: Number(process.env.MAX_RUNTIME_MS ?? "840000"),
    },
  };
}

/** Full paged scan of the entities table -> name pairs to sweep. */
async function scanEntities(deps: HandlerDeps): Promise<SweptEntity[]> {
  const entities: SweptEntity[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await deps.dynamo.send(
      new ScanCommand({
        TableName: deps.env.ENTITIES_TABLE,
        ProjectionExpression: "canonical_name, normalized_name",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ExclusiveStartKey: startKey as any,
      }),
    );
    for (const item of page.Items ?? []) {
      const canonicalName = item.canonical_name?.S?.trim() ?? "";
      const normalizedName = item.normalized_name?.S?.trim() ?? "";
      if (!canonicalName && !normalizedName) continue;
      entities.push({ canonicalName, normalizedName });
    }
    startKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return entities;
}

/** Single-quote escape for CKAN SQL string literals. */
function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Owner-name candidates for the SQL equality probe: the raw canonical name
 * uppercased plus the normalized (token-sorted) form when it differs. The
 * roll stores OWNER uppercase already; normalized rarely matches raw order,
 * but it is one cheap extra literal in the IN list.
 */
export function ownerNameCandidates(entity: SweptEntity): string[] {
  const candidates = new Set<string>();
  const canonical = entity.canonicalName.toUpperCase().replace(/\s+/g, " ").trim();
  if (canonical) candidates.add(canonical);
  if (entity.normalizedName && !isAmbiguousName(entity.normalizedName)) {
    candidates.add(entity.normalizedName);
  }
  return [...candidates];
}

export function buildOwnerSql(candidates: string[]): string {
  const fields = SELECTED_FIELDS.map((f) => `"${f}"`).join(", ");
  const literals = candidates.map(sqlQuote).join(", ");
  return (
    `SELECT ${fields} FROM "${RESOURCE_ID}" ` +
    `WHERE UPPER("OWNER") IN (${literals}) ` +
    `ORDER BY "PID" ASC LIMIT ${MAX_PARCELS_PER_OWNER}`
  );
}

interface CkanSqlResponse {
  success: boolean;
  result?: { records?: AssessmentRow[] };
  error?: unknown;
}

async function fetchOwnerParcels(
  deps: HandlerDeps,
  entity: SweptEntity,
): Promise<AssessmentRow[]> {
  const candidates = ownerNameCandidates(entity);
  if (candidates.length === 0) return [];
  const sql = buildOwnerSql(candidates);
  const url = `${CKAN_SQL_URL}?sql=${encodeURIComponent(sql)}`;
  const response = await deps.fetchImpl(url);
  if (!response.ok) {
    throw new Error(`CKAN fetch failed: HTTP ${response.status} for owner sweep`);
  }
  const body = (await response.json()) as CkanSqlResponse;
  if (!body.success) {
    throw new Error(`CKAN datastore_search_sql error: ${JSON.stringify(body.error)}`);
  }
  return body.result?.records ?? [];
}

export interface RunResult {
  entitiesScanned: number;
  entitiesSwept: number;
  entitiesMatched: number;
  parcelsFetched: number;
  parcelsMatched: number;
  new: number;
  changed: number;
  unchanged: number;
  written: number;
  idempotencySkips: number;
  inboxKey: string | null;
  completed: boolean;
}

export async function handlerWithDeps(
  event: AdapterEvent | null | undefined,
  deps: HandlerDeps,
): Promise<RunResult> {
  const startedAt = performance.now();
  const now = deps.now ?? (() => new Date());
  const startMs = now().getTime();
  const maxEntities = event?.maxEntities;
  const snapshotDate = now().toISOString().slice(0, 10);

  const allEntities = await scanEntities(deps);
  const entities = maxEntities ? allEntities.slice(0, maxEntities) : allEntities;
  log("info", "run starting", {
    entitiesScanned: allEntities.length,
    entitiesToSweep: entities.length,
  });

  const result: RunResult = {
    entitiesScanned: allEntities.length,
    entitiesSwept: 0,
    entitiesMatched: 0,
    parcelsFetched: 0,
    parcelsMatched: 0,
    new: 0,
    changed: 0,
    unchanged: 0,
    written: 0,
    idempotencySkips: 0,
    inboxKey: null,
    completed: false,
  };

  const events: CloudSourceEvent[] = [];
  const seenPids = new Set<string>();
  let timedOut = false;

  for (const entity of entities) {
    if (now().getTime() - startMs > deps.env.MAX_RUNTIME_MS) {
      timedOut = true;
      break;
    }
    result.entitiesSwept += 1;

    const rows = await fetchOwnerParcels(deps, entity);
    result.parcelsFetched += rows.length;

    let matchedAny = false;
    for (const row of rows) {
      if (!row.PID) continue;
      if (seenPids.has(row.PID)) continue; // two entities can match one owner
      if (!ownerMatchesEntity(row.OWNER, entity)) continue;
      seenPids.add(row.PID);
      matchedAny = true;
      result.parcelsMatched += 1;

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
    if (matchedAny) result.entitiesMatched += 1;
  }
  result.completed = !timedOut && result.entitiesSwept === entities.length;

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

  if (timedOut) {
    log("warn", "run time-boxed; remaining entities picked up next monthly run", {
      swept: result.entitiesSwept,
      total: entities.length,
    });
  }
  log("info", "run finished", {
    ...result,
    durationMs: Math.max(0, performance.now() - startedAt),
  });
  return result;
}

let cachedDeps: HandlerDeps | null = null;

export async function handler(event: AdapterEvent | null | undefined): Promise<RunResult> {
  cachedDeps ??= defaultDeps();
  return handlerWithDeps(event, cachedDeps);
}
