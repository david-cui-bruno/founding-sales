/**
 * Entity resolver Lambda handler (EventBridge-invoked, hourly when enabled).
 *
 * Flow:
 *   1. List inbox ndjson under events/<date>/ for the last `lookbackDays`
 *      days (default 7; event {"maxFiles": N} bounds file count for tests).
 *      Scorer output (scorer-*) is skipped: it re-emits the same events with
 *      the same cloud_entity_ids, so reading it adds nothing.
 *   2. Keep person-bearing events (entity.person !== null), project them to
 *      member records, resolve deterministically (see resolve.ts).
 *   3. Read-modify-write each entity into ENTITIES_TABLE: query the
 *      normalized_name GSI, merge with a matching stored row (union members
 *      and doors-by-parcel), PutItem. No inbox output — the scorer picks
 *      entities up via the table.
 *
 * Logging: structured JSON — counts and entity ids, never names/addresses.
 */
import { DynamoDBClient, PutItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  cloudSourceEventSchema,
  SafeHandlerError,
  type CloudSourceEvent,
} from "@callie-sourcing/shared";
import {
  matchesStored,
  mergeWithStored,
  resolveEntities,
  toMemberRecord,
  type MemberRecord,
  type ResolvedEntity,
} from "./resolve";
import { fromItem, toItem } from "./entitiesTable";
import { log } from "./log";

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_LOOKBACK_DAYS = 7;

export interface ResolverEvent {
  /** How many days of inbox prefixes to read (default 7). */
  lookbackDays?: number;
  /** Bound the number of ndjson files read (live testing). */
  maxFiles?: number;
}

export interface HandlerDeps {
  s3: Pick<S3Client, "send">;
  dynamo: Pick<DynamoDBClient, "send">;
  env: {
    INBOX_BUCKET: string;
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
      ENTITIES_TABLE: envOrThrow("ENTITIES_TABLE"),
    },
  };
}

function datePrefixes(now: Date, lookbackDays: number): string[] {
  const prefixes: string[] = [];
  for (let i = lookbackDays - 1; i >= 0; i--) {
    const date = new Date(now.getTime() - i * DAY_MS).toISOString().slice(0, 10);
    prefixes.push(`events/${date}/`);
  }
  return prefixes;
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
  events: CloudSourceEvent[];
  parseFailures: number;
}

async function readEvents(deps: HandlerDeps, key: string): Promise<ParsedFile> {
  const raw = await deps.s3.send(
    new GetObjectCommand({ Bucket: deps.env.INBOX_BUCKET, Key: key }),
  );
  const body = raw.Body;
  if (!body) return { events: [], parseFailures: 0 };
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
  return { events, parseFailures };
}

/**
 * Find the stored row this entity merges into: query the normalized_name GSI
 * and take the first row that matches under the identity rules.
 */
async function findStoredMatch(
  deps: HandlerDeps,
  entity: ResolvedEntity,
): Promise<ReturnType<typeof fromItem>> {
  const result = await deps.dynamo.send(
    new QueryCommand({
      TableName: deps.env.ENTITIES_TABLE,
      IndexName: "normalized_name-index",
      KeyConditionExpression: "normalized_name = :name",
      ExpressionAttributeValues: {
        ":name": { S: entity.normalizedName } satisfies AttributeValue,
      },
    }),
  );
  for (const item of result.Items ?? []) {
    const stored = fromItem(item);
    if (stored && matchesStored(entity, stored)) return stored;
  }
  return null;
}

export interface RunResult {
  filesRead: number;
  eventsSeen: number;
  personEvents: number;
  memberRecords: number;
  entitiesResolved: number;
  entitiesCreated: number;
  entitiesUpdated: number;
  multiParcelEntities: number;
  parseFailures: number;
}

export async function runResolver(
  event: ResolverEvent | null | undefined,
  deps: HandlerDeps,
): Promise<RunResult> {
  const now = (deps.now ?? (() => new Date()))();
  const lookbackDays = event?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const maxFiles = event?.maxFiles;

  const keys: string[] = [];
  for (const prefix of datePrefixes(now, lookbackDays)) {
    keys.push(...(await listInboxKeys(deps, prefix)));
  }
  // Scorer re-emits carry the same entities; skip them.
  let inputKeys = keys.filter((key) => !key.includes("/scorer-"));
  if (maxFiles !== undefined) inputKeys = inputKeys.slice(0, maxFiles);

  const result: RunResult = {
    filesRead: 0,
    eventsSeen: 0,
    personEvents: 0,
    memberRecords: 0,
    entitiesResolved: 0,
    entitiesCreated: 0,
    entitiesUpdated: 0,
    multiParcelEntities: 0,
    parseFailures: 0,
  };

  const records: MemberRecord[] = [];
  for (const key of inputKeys) {
    const file = await readEvents(deps, key);
    result.filesRead += 1;
    result.parseFailures += file.parseFailures;
    for (const event of file.events) {
      result.eventsSeen += 1;
      if (event.entity.person === null) continue;
      result.personEvents += 1;
      const record = toMemberRecord(event);
      if (record) records.push(record);
    }
  }
  result.memberRecords = records.length;

  const entities = resolveEntities(records);
  result.entitiesResolved = entities.length;

  const nowIso = now.toISOString();
  for (const entity of entities) {
    const stored = await findStoredMatch(deps, entity);
    const finalEntity = stored ? mergeWithStored(entity, stored) : entity;
    await deps.dynamo.send(
      new PutItemCommand({
        TableName: deps.env.ENTITIES_TABLE,
        Item: toItem(finalEntity, nowIso),
      }),
    );
    if (stored) result.entitiesUpdated += 1;
    else result.entitiesCreated += 1;
    if (finalEntity.parcelCount > 1) result.multiParcelEntities += 1;
  }

  return result;
}

export async function handlerWithDeps(
  event: ResolverEvent | null | undefined,
  deps: HandlerDeps,
): Promise<RunResult> {
  return runResolver(event, deps);
}

export function createHandler(
  depsFactory: () => HandlerDeps,
  monotonicNow: () => number = () => performance.now(),
): (event: ResolverEvent | null | undefined) => Promise<RunResult> {
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
      log("info", "resolver run complete", {
        entitiesResolved: result?.entitiesResolved ?? 0,
        personEvents: result?.personEvents ?? 0,
        durationMs: Math.max(0, Math.round(monotonicNow() - startedAt)),
      });
    }
  };
}

const productionHandler = createHandler(defaultDeps);

export async function handler(event: ResolverEvent | null | undefined): Promise<RunResult> {
  return productionHandler(event);
}
