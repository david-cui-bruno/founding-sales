/**
 * Scoring engine handler (EventBridge-invoked, every 15 min when enabled).
 *
 * Flow:
 *   1. List inbox objects under events/<today>/ and events/<yesterday>/
 *   2. Read each ndjson file, parse events, keep scores === null
 *   3. Skip events already scored at this scores_version (snapshots table,
 *      natural key `scorer:<idempotency_key>`) — the scorer does NOT claim
 *      new idempotency keys; the scored event reuses the original key and
 *      the app treats (idempotency_key, scores_version) as an update.
 *   4. Group triggers by cloud_entity_id for compound detection.
 *   5. Score (fit + timing + reasons), re-emit enriched events to
 *      events/YYYY-MM-DD/scorer-<ulid>.ndjson with scores_version = 2.
 *   6. Record scored state in the snapshots table.
 *
 * Logging: structured JSON, never person fields or free text.
 */
import { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  cloudSourceEventSchema,
  mailingAddressCompareKey,
  normalizeOwnerName,
  normalizeZip5,
  ulid,
  validateSourceEvent,
  SafeHandlerError,
  type CloudSourceEvent,
  type ScheduledRunStatus,
} from "@callie-sourcing/shared";
import { scoreEvent, type EntityContext, type TriggerInstance } from "./scoring";
import { log } from "./log";

export const SCORES_VERSION = 2;

export interface HandlerDeps {
  s3: Pick<S3Client, "send">;
  dynamo: Pick<DynamoDBClient, "send">;
  env: {
    INBOX_BUCKET: string;
    SNAPSHOTS_TABLE: string;
    ENTITIES_TABLE: string;
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
      ENTITIES_TABLE: envOrThrow("ENTITIES_TABLE"),
    },
  };
}

function datePrefixes(now: Date): string[] {
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return [`events/${yesterday}/`, `events/${today}/`];
}

async function listInboxKeys(deps: HandlerDeps, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await deps.s3.send(
      new ListObjectsV2Command({
        Bucket: deps.env.INBOX_BUCKET,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const object of page.Contents ?? []) {
      if (object.Key?.endsWith(".ndjson")) keys.push(object.Key);
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
  return keys;
}

interface ParsedFile {
  key: string;
  events: CloudSourceEvent[];
  parseFailures: number;
}

async function readEvents(deps: HandlerDeps, key: string): Promise<ParsedFile> {
  const raw = await deps.s3.send(
    new GetObjectCommand({ Bucket: deps.env.INBOX_BUCKET, Key: key }),
  );
  const body = raw.Body;
  if (!body) return { key, events: [], parseFailures: 0 };
  const text = await (body as { transformToString(): Promise<string> }).transformToString();

  const events: CloudSourceEvent[] = [];
  let parseFailures = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = cloudSourceEventSchema.safeParse(JSON.parse(line));
      if (parsed.success) events.push(parsed.data);
      else parseFailures += 1;
    } catch {
      parseFailures += 1;
    }
  }
  return { key, events, parseFailures };
}

/** Natural key in the snapshots table marking (event, scores_version) scored. */
function scoredNaturalKey(idempotencyKey: string): string {
  return `scorer:${idempotencyKey}`;
}

async function alreadyScored(
  deps: HandlerDeps,
  idempotencyKey: string,
  scoresVersion: number,
): Promise<boolean> {
  const result = await deps.dynamo.send(
    new GetItemCommand({
      TableName: deps.env.SNAPSHOTS_TABLE,
      Key: {
        source_natural_key: { S: scoredNaturalKey(idempotencyKey) },
        snapshot_date: { S: `v${scoresVersion}` },
      },
    }),
  );
  return result.Item !== undefined;
}

async function markScored(
  deps: HandlerDeps,
  idempotencyKey: string,
  scoresVersion: number,
  eventId: string,
  now: Date,
): Promise<void> {
  await deps.dynamo.send(
    new PutItemCommand({
      TableName: deps.env.SNAPSHOTS_TABLE,
      Item: {
        source_natural_key: { S: scoredNaturalKey(idempotencyKey) },
        snapshot_date: { S: `v${scoresVersion}` },
        event_id: { S: eventId },
        scored_at: { S: now.toISOString() },
      },
    }),
  );
}

function triggerInstance(event: CloudSourceEvent): TriggerInstance | null {
  if (!event.trigger) return null;
  return {
    type: event.trigger.type,
    weight: event.trigger.weight,
    half_life_days: event.trigger.half_life_days,
    window: event.trigger.window,
    observed_at: event.observed_at,
  };
}

// ---------------------------------------------------------------------------
// Entities-table lookup (resolver output): entity context for scoring
// ---------------------------------------------------------------------------

interface EntityRow {
  ownerKind: "individual" | "llc" | "trust" | "other" | null;
  portfolioDoors: number | null;
  mailingCompareKey: string | null;
  zip5: string;
}

const OWNER_KINDS: ReadonlySet<string> = new Set(["individual", "llc", "trust", "other"]);

/**
 * Query the resolver's entities table by the event owner's normalized name
 * (the SAME normalizeOwnerName the resolver writes — both live in shared).
 * Among rows sharing the name, prefer an exact mailing-address match, then a
 * same-zip match (mirrors the resolver's merge rules); a lone row wins by
 * default. Results are cached per run — tax-roll batches repeat owners.
 */
async function lookupEntityContext(
  deps: HandlerDeps,
  event: CloudSourceEvent,
  cache: Map<string, EntityRow[]>,
): Promise<EntityRow | null> {
  const person = event.entity.person;
  if (!person) return null;
  const rawName = person.full_name ?? person.org_names[0] ?? "";
  const normalizedName = normalizeOwnerName(rawName);
  if (!normalizedName) return null;

  let rows = cache.get(normalizedName);
  if (rows === undefined) {
    const result = await deps.dynamo.send(
      new QueryCommand({
        TableName: deps.env.ENTITIES_TABLE,
        IndexName: "normalized_name-index",
        KeyConditionExpression: "normalized_name = :name",
        ExpressionAttributeValues: { ":name": { S: normalizedName } },
      }),
    );
    rows = (result.Items ?? []).map((item) => {
      const ownerKindRaw = item.owner_kind?.S ?? "";
      const doors = item.doors_estimate?.N;
      let mailing: { line1: string; locality: string | null; region: string | null; postal_code: string | null } | null = null;
      try {
        mailing = item.mailing_address_json?.S
          ? JSON.parse(item.mailing_address_json.S)
          : null;
      } catch {
        mailing = null;
      }
      return {
        ownerKind: OWNER_KINDS.has(ownerKindRaw)
          ? (ownerKindRaw as EntityRow["ownerKind"])
          : null,
        portfolioDoors: doors !== undefined ? Number(doors) : null,
        mailingCompareKey: mailingAddressCompareKey(mailing),
        zip5: normalizeZip5(mailing?.postal_code),
      };
    });
    cache.set(normalizedName, rows);
  }

  const eventKey = mailingAddressCompareKey(person.mailing_address);
  const eventZip = normalizeZip5(person.mailing_address?.postal_code);
  return (
    rows.find((r) => r.mailingCompareKey !== null && r.mailingCompareKey === eventKey) ??
    rows.find((r) => r.zip5 !== "" && r.zip5 === eventZip) ??
    (rows.length === 1 ? rows[0]! : null)
  );
}

export interface RunResult {
  filesRead: number;
  eventsSeen: number;
  unscored: number;
  skippedAlreadyScored: number;
  scored: number;
  parseFailures: number;
  /** Unscored person events enriched from the entities table. */
  entityContextHits: number;
  outputKey: string | null;
}

export async function runScorer(deps: HandlerDeps): Promise<RunResult> {
  const now = (deps.now ?? (() => new Date()))();

  const keys: string[] = [];
  for (const prefix of datePrefixes(now)) {
    keys.push(...(await listInboxKeys(deps, prefix)));
  }
  // Never re-read our own output.
  const inputKeys = keys.filter((key) => !key.includes("/scorer-"));

  const result: RunResult = {
    filesRead: 0,
    eventsSeen: 0,
    unscored: 0,
    skippedAlreadyScored: 0,
    scored: 0,
    parseFailures: 0,
    entityContextHits: 0,
    outputKey: null,
  };

  const allEvents: CloudSourceEvent[] = [];
  for (const key of inputKeys) {
    const file = await readEvents(deps, key);
    result.filesRead += 1;
    result.parseFailures += file.parseFailures;
    allEvents.push(...file.events);
  }
  result.eventsSeen = allEvents.length;

  // Entity-level trigger context for compound detection: group ALL seen
  // events (scored or not) by cloud_entity_id; events without an entity id
  // only see their own trigger.
  const triggersByEntity = new Map<string, TriggerInstance[]>();
  for (const event of allEvents) {
    const entityId = event.entity.cloud_entity_id;
    if (!entityId) continue;
    const trigger = triggerInstance(event);
    if (!trigger) continue;
    const list = triggersByEntity.get(entityId) ?? [];
    list.push(trigger);
    triggersByEntity.set(entityId, list);
  }

  const unscored = allEvents.filter((event) => event.scores === null);
  result.unscored = unscored.length;

  const scoredEvents: CloudSourceEvent[] = [];
  const entityCache = new Map<string, EntityRow[]>();
  for (const event of unscored) {
    if (await alreadyScored(deps, event.idempotency_key, SCORES_VERSION)) {
      result.skippedAlreadyScored += 1;
      continue;
    }

    const ownTrigger = triggerInstance(event);
    const entityTriggers = event.entity.cloud_entity_id
      ? (triggersByEntity.get(event.entity.cloud_entity_id) ?? [])
      : ownTrigger
        ? [ownTrigger]
        : [];

    // Resolved-entity context (owner kind + portfolio doors) for events that
    // carry a person; misses are free (null context = same as before).
    const entityRow = event.entity.person
      ? await lookupEntityContext(deps, event, entityCache)
      : null;
    if (entityRow) result.entityContextHits += 1;

    const context: EntityContext = {
      recentTriggers: entityTriggers,
      ...(entityRow
        ? { ownerKind: entityRow.ownerKind, portfolioDoors: entityRow.portfolioDoors }
        : {}),
    };
    const scores = scoreEvent(event, context, now);

    const scored: CloudSourceEvent = {
      ...event,
      scores: {
        fit: scores.fit,
        timing: scores.timing,
        reasons: scores.reasons,
      },
      scores_version: SCORES_VERSION,
    };

    const validation = validateSourceEvent(scored);
    if (!validation.success) {
      log("error", "scored event failed schema validation, dropping", {
        eventId: event.id,
        idempotencyKey: event.idempotency_key,
        error: validation.error,
      });
      continue;
    }
    scoredEvents.push(validation.data);
  }

  if (scoredEvents.length > 0) {
    const date = now.toISOString().slice(0, 10);
    const outputKey = `events/${date}/scorer-${ulid(now.getTime())}.ndjson`;
    const ndjson = scoredEvents.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await deps.s3.send(
      new PutObjectCommand({
        Bucket: deps.env.INBOX_BUCKET,
        Key: outputKey,
        Body: ndjson,
        ContentType: "application/x-ndjson",
      }),
    );
    result.outputKey = outputKey;
    result.scored = scoredEvents.length;

    // Mark scored AFTER the write succeeds so a failed write is retried.
    for (const event of scoredEvents) {
      await markScored(deps, event.idempotency_key, SCORES_VERSION, event.id, now);
    }
  }

  return result;
}

export async function handlerWithDeps(deps: HandlerDeps): Promise<void> {
  await runScorer(deps);
}

export function createHandler(
  depsFactory: () => HandlerDeps,
  monotonicNow: () => number = () => performance.now(),
): () => Promise<void> {
  let cachedDeps: HandlerDeps | null = null;
  return async () => {
    const startedAt = monotonicNow();
    let status: ScheduledRunStatus = "failure";
    let result: RunResult | undefined;
    try {
      cachedDeps ??= depsFactory();
      result = await runScorer(cachedDeps);
      status = "success";
    } catch {
      throw new SafeHandlerError();
    } finally {
      log("info", "scorer run complete", {
        status,
        scored: result?.scored ?? 0,
        unscored: result?.unscored ?? 0,
        durationMs: Math.max(0, Math.round(monotonicNow() - startedAt)),
      });
    }
  };
}

const productionHandler = createHandler(defaultDeps);

export async function handler(): Promise<void> {
  await productionHandler();
}
