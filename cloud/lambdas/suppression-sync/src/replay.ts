import { createHash } from "node:crypto";
import {
  BatchGetItemCommand,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
  type AttributeValue,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  type S3Client,
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
export const REPORTS_PREFIX = "upstream/suppression-reports/";
const LEDGER_SNAPSHOT_DATE = "ledger";
const BATCH_GET_LIMIT = 100;
const MAX_UNPROCESSED_RETRIES = 10;
const MAX_MEMBERSHIP_CONFLICT_RETRIES = 5;
const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface CapabilityFreeSuppressionObjectSource {
  list(
    bucket: string,
    prefix: string,
  ): Promise<readonly SuppressionObjectDescriptor[]>;
  read(
    descriptor: SuppressionObjectDescriptor,
  ): Promise<ValidatedSuppressionObject>;
}

export interface HandlerDeps {
  s3: Pick<S3Client, "send">;
  dynamo: Pick<DynamoDBClient, "send">;
  env: {
    INBOX_BUCKET: string;
    SNAPSHOTS_TABLE: string;
    SUPPRESSION_TABLE: string;
  };
  now?: () => Date;
  runId?: (timestamp: number) => string;
  capabilityFreeObjectSource?: CapabilityFreeSuppressionObjectSource;
}

export type ProductionHandlerDeps = Omit<
  HandlerDeps,
  "capabilityFreeObjectSource"
>;

export type SuppressionSyncEvent =
  | { mode?: "incremental"; maxObjects?: number }
  | { mode: "replay"; dryRun: boolean }
  | { mode: "reconcile"; reportKey: string };

export type SuppressionReplayReport = Readonly<{
  generatedAt: string;
  objectsSeen: number;
  objectsValid: number;
  objectsQuarantined: number;
  uniqueMemberships: number;
  appliedMemberships: number;
  missingMemberships: number;
  unexpectedMemberships: number;
  sourceUnionChecksumSha256: string;
  quarantine: ReadonlyArray<{
    key: string;
    versionId: string | null;
    invalidLineNumbers: readonly number[];
  }>;
}>;

export type SuppressionReplayResult = Readonly<{
  reportKey: string;
  report: SuppressionReplayReport;
}>;

export type ReplayQuarantineEntry = Readonly<{
  key: string;
  versionId: string | null;
  invalidLineNumbers: readonly number[];
}>;

export type ReplayEvidenceObject = Readonly<{
  key: string;
  versionId: string | null;
  etag: string;
  lastModified: string;
  checksumSha256: string;
  status: "valid" | "quarantined";
}>;

export type ProductionReplaySource = Readonly<{
  objectsSeen: number;
  validObjects: readonly ValidatedSuppressionObject[];
  quarantine: readonly ReplayQuarantineEntry[];
  evidenceObjects: readonly ReplayEvidenceObject[];
}>;

type Reconciliation = Readonly<{
  existing: ReadonlyMap<string, Record<string, AttributeValue>>;
  missingMemberships: number;
  unexpectedMemberships: number;
}>;

const REASON_STRENGTH: Readonly<Record<SuppressionUploadLine["reason"], number>> = {
  wrong_person: 1,
  founder_block: 2,
  opt_out: 3,
};

function sha256Utf8(value: string): string {
  return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

function lexicalCompare(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export async function listUploadObjects(
  deps: HandlerDeps,
): Promise<readonly SuppressionObjectDescriptor[]> {
  if (deps.capabilityFreeObjectSource) {
    return deps.capabilityFreeObjectSource.list(
      deps.env.INBOX_BUCKET,
      UPLOADS_PREFIX,
    );
  }
  const objects: SuppressionObjectDescriptor[] = [];
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  for (;;) {
    const page = await deps.s3.send(new ListObjectVersionsCommand({ Bucket: deps.env.INBOX_BUCKET, Prefix: UPLOADS_PREFIX, KeyMarker: keyMarker, VersionIdMarker: versionIdMarker }));
    for (const version of page.Versions ?? []) {
      const key = version.Key;
      if (!key?.endsWith(".ndjson") || !version.ETag || !version.LastModified) continue;
      objects.push({ bucket: deps.env.INBOX_BUCKET, key, versionId: version.VersionId ?? null, etag: version.ETag.startsWith('"') ? version.ETag.slice(1, -1) : version.ETag, lastModified: version.LastModified.toISOString() });
    }
    if (!page.IsTruncated) break;
    if (!page.NextKeyMarker) throw new Error("truncated suppression object version listing has no next key marker");
    keyMarker = page.NextKeyMarker;
    versionIdMarker = page.NextVersionIdMarker;
  }
  return objects.sort((left, right) => lexicalCompare(left.lastModified, right.lastModified) || lexicalCompare(left.key, right.key) || lexicalCompare(left.versionId ?? "", right.versionId ?? ""));
}

export async function readValidatedObject(
  deps: HandlerDeps,
  descriptor: SuppressionObjectDescriptor,
): Promise<ValidatedSuppressionObject> {
  if (deps.capabilityFreeObjectSource) {
    return deps.capabilityFreeObjectSource.read(descriptor);
  }
  const raw = await deps.s3.send(new GetObjectCommand({ Bucket: descriptor.bucket, Key: descriptor.key, VersionId: descriptor.versionId ?? undefined }));
  const text = raw.Body ? await (raw.Body as { transformToString(): Promise<string> }).transformToString() : "";
  try {
    return parseAndValidateSuppressionObject({ descriptor, text });
  } catch (error) {
    if (error instanceof SuppressionObjectValidationError) {
      throw new SuppressionObjectValidationError({ key: error.key, versionId: error.versionId, invalidLineNumbers: error.invalidLineNumbers, checksumSha256: sha256Utf8(text) });
    }
    throw error;
  }
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

export async function ledgerHas(
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

export async function ledgerMark(
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

function mergeUnionLine(
  current: SuppressionUploadLine | undefined,
  incoming: SuppressionUploadLine,
): SuppressionUploadLine {
  if (!current) return incoming;
  return {
    contact_hmac: current.contact_hmac,
    kind: current.kind,
    reason:
      REASON_STRENGTH[incoming.reason] > REASON_STRENGTH[current.reason]
        ? incoming.reason
        : current.reason,
    observed_at:
      incoming.observed_at < current.observed_at
        ? incoming.observed_at
        : current.observed_at,
  };
}

function sourceUnionChecksum(union: ReadonlyMap<string, SuppressionUploadLine>): string {
  const canonical = [...union.values()]
    .sort((left, right) => lexicalCompare(left.contact_hmac, right.contact_hmac))
    .map((line) => ({
      contact_hmac: line.contact_hmac,
      kind: line.kind,
      reason: line.reason,
      observed_at: line.observed_at,
    }));
  return sha256Utf8(JSON.stringify(canonical));
}

export function toValidEvidence(
  object: ValidatedSuppressionObject,
): ReplayEvidenceObject {
  return {
    key: object.descriptor.key,
    versionId: object.descriptor.versionId,
    etag: object.descriptor.etag,
    lastModified: object.descriptor.lastModified,
    checksumSha256: object.checksumSha256,
    status: "valid",
  };
}

export function toQuarantinedEvidence(
  descriptor: SuppressionObjectDescriptor,
  error: SuppressionObjectValidationError,
): ReplayEvidenceObject {
  if (!error.checksumSha256) {
    throw new Error("quarantined suppression object is missing checksum");
  }
  return {
    key: descriptor.key,
    versionId: descriptor.versionId,
    etag: descriptor.etag,
    lastModified: descriptor.lastModified,
    checksumSha256: error.checksumSha256,
    status: "quarantined",
  };
}

function sourceUnion(
  objects: readonly ValidatedSuppressionObject[],
): ReadonlyMap<string, SuppressionUploadLine> {
  const union = new Map<string, SuppressionUploadLine>();
  for (const object of objects) {
    for (const line of object.lines) {
      union.set(
        line.contact_hmac,
        mergeUnionLine(union.get(line.contact_hmac), line),
      );
    }
  }
  return union;
}

async function loadCapabilityFreeReplaySource(
  deps: HandlerDeps,
  quarantineInvalid: boolean,
): Promise<ProductionReplaySource> {
  const descriptors = await listUploadObjects(deps);
  const validObjects: ValidatedSuppressionObject[] = [];
  const quarantine: ReplayQuarantineEntry[] = [];
  const evidenceObjects: ReplayEvidenceObject[] = [];

  for (const descriptor of descriptors) {
    try {
      const object = await readValidatedObject(deps, descriptor);
      validObjects.push(object);
      evidenceObjects.push(toValidEvidence(object));
    } catch (error) {
      if (!(error instanceof SuppressionObjectValidationError)) throw error;
      log("warn", "suppression_object_invalid_aggregate", {
        invalid_line_numbers: error.invalidLineNumbers,
        invalid_line_count: error.invalidLineNumbers.length,
      });
      if (!quarantineInvalid) throw error;
      quarantine.push({
        key: error.key,
        versionId: error.versionId,
        invalidLineNumbers: error.invalidLineNumbers,
      });
      evidenceObjects.push(toQuarantinedEvidence(descriptor, error));
    }
  }

  return {
    objectsSeen: descriptors.length,
    validObjects,
    quarantine,
    evidenceObjects,
  };
}

function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

async function batchGetMemberships(
  deps: HandlerDeps,
  hashes: readonly string[],
): Promise<Map<string, Record<string, AttributeValue>>> {
  const items = new Map<string, Record<string, AttributeValue>>();

  for (const hashChunk of chunks(hashes, BATCH_GET_LIMIT)) {
    let pending: Array<Record<string, AttributeValue>> = hashChunk.map((hash) => ({
      contact_hash: { S: hash },
    }));
    let retries = 0;
    while (pending.length > 0) {
      const result = await deps.dynamo.send(
        new BatchGetItemCommand({
          RequestItems: {
            [deps.env.SUPPRESSION_TABLE]: { Keys: pending },
          },
        }),
      );
      for (const item of result.Responses?.[deps.env.SUPPRESSION_TABLE] ?? []) {
        const hash = stringAttribute(item, "contact_hash");
        if (hash) items.set(hash, item);
      }
      pending = result.UnprocessedKeys?.[deps.env.SUPPRESSION_TABLE]?.Keys ?? [];
      if (pending.length > 0 && ++retries > MAX_UNPROCESSED_RETRIES) {
        throw new Error(
          `suppression BatchGetItem left ${pending.length} keys unprocessed after retries`,
        );
      }
    }
  }

  return items;
}

async function scanMembershipHashes(deps: HandlerDeps): Promise<Set<string>> {
  const hashes = new Set<string>();
  let exclusiveStartKey: Record<string, AttributeValue> | undefined;

  for (;;) {
    const result = await deps.dynamo.send(
      new ScanCommand({
        TableName: deps.env.SUPPRESSION_TABLE,
        ProjectionExpression: "contact_hash",
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of result.Items ?? []) {
      const hash = stringAttribute(item, "contact_hash");
      if (hash) hashes.add(hash);
    }
    if (!result.LastEvaluatedKey) break;
    exclusiveStartKey = result.LastEvaluatedKey;
  }

  return hashes;
}

async function reconcileSource(
  deps: HandlerDeps,
  union: ReadonlyMap<string, SuppressionUploadLine>,
): Promise<Reconciliation> {
  const hashes = [...union.keys()].sort(lexicalCompare);
  const existing = await batchGetMemberships(deps, hashes);
  const cloudHashes = await scanMembershipHashes(deps);
  return {
    existing,
    missingMemberships: hashes.filter((hash) => !existing.has(hash)).length,
    unexpectedMemberships: [...cloudHashes].filter((hash) => !union.has(hash)).length,
  };
}

function validKind(value: string | undefined): SuppressionUploadLine["kind"] | undefined {
  return value === "phone" || value === "email" ? value : undefined;
}

function validReason(
  value: string | undefined,
): SuppressionUploadLine["reason"] | undefined {
  return value === "opt_out" || value === "founder_block" || value === "wrong_person"
    ? value
    : undefined;
}

function monotonicMembership(
  source: SuppressionUploadLine,
  existing: Record<string, AttributeValue> | undefined,
): SuppressionUploadLine {
  if (!existing) return source;
  const existingReason = validReason(stringAttribute(existing, "reason"));
  const existingObservedAt = stringAttribute(existing, "observed_at");
  return {
    contact_hmac: source.contact_hmac,
    kind: validKind(stringAttribute(existing, "kind")) ?? source.kind,
    reason:
      existingReason && REASON_STRENGTH[existingReason] > REASON_STRENGTH[source.reason]
        ? existingReason
        : source.reason,
    observed_at:
      existingObservedAt && existingObservedAt < source.observed_at
        ? existingObservedAt
        : source.observed_at,
  };
}

function membershipMatches(
  item: Record<string, AttributeValue> | undefined,
  membership: SuppressionUploadLine,
): boolean {
  return (
    item !== undefined &&
    stringAttribute(item, "kind") === membership.kind &&
    stringAttribute(item, "reason") === membership.reason &&
    stringAttribute(item, "observed_at") === membership.observed_at
  );
}

function expectedMembershipCondition(
  current: Record<string, AttributeValue> | undefined,
): {
  ConditionExpression: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, AttributeValue>;
} {
  if (!current) {
    return { ConditionExpression: "attribute_not_exists(contact_hash)" };
  }

  const names: Record<string, string> = {};
  const values: Record<string, AttributeValue> = {};
  const clauses: string[] = [];
  for (const field of ["kind", "reason", "observed_at"] as const) {
    const name = `#${field}`;
    names[name] = field;
    const value = current[field];
    if (value === undefined) {
      clauses.push(`attribute_not_exists(${name})`);
    } else {
      const expected = `:expected_${field}`;
      values[expected] = value;
      clauses.push(`${name} = ${expected}`);
    }
  }
  return {
    ConditionExpression: clauses.join(" AND "),
    ExpressionAttributeNames: names,
    ...(Object.keys(values).length > 0
      ? { ExpressionAttributeValues: values }
      : {}),
  };
}

function isConditionalConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "ConditionalCheckFailedException"
  );
}

export async function persistSuppressionMonotonically(
  deps: HandlerDeps,
  source: SuppressionUploadLine,
  now: Date,
  initial?: { current: Record<string, AttributeValue> | undefined },
): Promise<boolean> {
  let current = initial?.current;
  if (initial === undefined) {
    current = (await batchGetMemberships(deps, [source.contact_hmac])).get(
      source.contact_hmac,
    );
  }

  let conflicts = 0;
  for (;;) {
    const membership = monotonicMembership(source, current);
    if (membershipMatches(current, membership)) return false;

    try {
      await deps.dynamo.send(
        new PutItemCommand({
          TableName: deps.env.SUPPRESSION_TABLE,
          Item: {
            contact_hash: { S: membership.contact_hmac },
            kind: { S: membership.kind },
            reason: { S: membership.reason },
            observed_at: { S: membership.observed_at },
            synced_at: { S: now.toISOString() },
          },
          ...expectedMembershipCondition(current),
        }),
      );
      return true;
    } catch (error) {
      if (!isConditionalConflict(error)) throw error;
      conflicts += 1;
      if (conflicts > MAX_MEMBERSHIP_CONFLICT_RETRIES) {
        throw new Error("suppression membership conflict retry limit exceeded");
      }
      current = (await batchGetMemberships(deps, [source.contact_hmac])).get(
        source.contact_hmac,
      );
    }
  }
}

async function applyUnion(
  deps: HandlerDeps,
  union: ReadonlyMap<string, SuppressionUploadLine>,
  existing: ReadonlyMap<string, Record<string, AttributeValue>>,
  now: Date,
): Promise<number> {
  let applied = 0;
  for (const hash of [...union.keys()].sort(lexicalCompare)) {
    const source = union.get(hash);
    if (!source) continue;
    if (
      await persistSuppressionMonotonically(deps, source, now, {
        current: existing.get(hash),
      })
    ) {
      applied += 1;
    }
  }
  return applied;
}

async function ledgerValidObjects(
  deps: HandlerDeps,
  objects: readonly ValidatedSuppressionObject[],
  now: Date,
): Promise<void> {
  for (const object of objects) {
    if (!(await ledgerHas(deps, object))) {
      await ledgerMark(deps, object, now);
    }
  }
}

function reportFor(input: {
  source: ProductionReplaySource;
  union: ReadonlyMap<string, SuppressionUploadLine>;
  sourceUnionChecksumSha256: string;
  now: Date;
  appliedMemberships: number;
  missingMemberships: number;
  unexpectedMemberships: number;
}): SuppressionReplayReport {
  return {
    generatedAt: input.now.toISOString(),
    objectsSeen: input.source.objectsSeen,
    objectsValid: input.source.validObjects.length,
    objectsQuarantined: input.source.quarantine.length,
    uniqueMemberships: input.union.size,
    appliedMemberships: input.appliedMemberships,
    missingMemberships: input.missingMemberships,
    unexpectedMemberships: input.unexpectedMemberships,
    sourceUnionChecksumSha256: input.sourceUnionChecksumSha256,
    quarantine: input.source.quarantine,
  };
}

function reportKey(now: Date, runId: string): string {
  const date = now.toISOString().slice(0, 10);
  const timestamp = now.toISOString().replace(/[:.]/g, "");
  return `${REPORTS_PREFIX}${date}/${timestamp}-${runId}.json`;
}

async function writeEvidenceReport(
  deps: HandlerDeps,
  key: string,
  report: SuppressionReplayReport,
  objects: readonly ReplayEvidenceObject[],
): Promise<void> {
  await deps.s3.send(
    new PutObjectCommand({
      Bucket: deps.env.INBOX_BUCKET,
      Key: key,
      Body: `${JSON.stringify({ ...report, objects })}\n`,
      ContentType: "application/json",
      IfNoneMatch: "*",
    }),
  );
}

export async function runReplay(
  deps: HandlerDeps,
  input: { dryRun: boolean; now: Date; runId: string },
): Promise<SuppressionReplayResult> {
  return runReplayFromLoadedSource(
    deps,
    input,
    await loadCapabilityFreeReplaySource(deps, true),
  );
}

export async function runReplayFromLoadedSource(
  deps: HandlerDeps,
  input: { dryRun: boolean; now: Date; runId: string },
  source: ProductionReplaySource,
): Promise<SuppressionReplayResult> {
  const union = sourceUnion(source.validObjects);
  const sourceUnionChecksumSha256 = sourceUnionChecksum(union);
  const reconciliation = await reconcileSource(deps, union);
  const appliedMemberships = input.dryRun
    ? 0
    : await applyUnion(deps, union, reconciliation.existing, input.now);

  if (!input.dryRun) {
    await ledgerValidObjects(deps, source.validObjects, input.now);
  }

  const report = reportFor({
    source,
    union,
    sourceUnionChecksumSha256,
    now: input.now,
    appliedMemberships,
    missingMemberships: input.dryRun ? reconciliation.missingMemberships : 0,
    unexpectedMemberships: reconciliation.unexpectedMemberships,
  });
  const key = reportKey(input.now, input.runId);
  await writeEvidenceReport(deps, key, report, source.evidenceObjects);

  log("info", "suppression_replay_run", {
    report_key: key,
    dry_run: input.dryRun,
    objects_seen: report.objectsSeen,
    objects_valid: report.objectsValid,
    objects_quarantined: report.objectsQuarantined,
    unique_memberships: report.uniqueMemberships,
    applied_memberships: report.appliedMemberships,
    missing_memberships: report.missingMemberships,
    unexpected_memberships: report.unexpectedMemberships,
    source_union_checksum_sha256: report.sourceUnionChecksumSha256,
  });
  return { reportKey: key, report };
}

function decodeUlidTimestamp(runId: string): number {
  let timestamp = 0;
  for (const character of runId.slice(0, 10)) {
    timestamp = timestamp * 32 + CROCKFORD_BASE32.indexOf(character);
  }
  return timestamp;
}

export function assertReportKey(key: string): void {
  const match = new RegExp(
    `^${REPORTS_PREFIX}(\\d{4}-\\d{2}-\\d{2})/(\\d{4}-\\d{2}-\\d{2})T(\\d{2})(\\d{2})(\\d{2})(\\d{3})Z-([0-7][0-9A-HJKMNP-TV-Z]{25})\\.json$`,
  ).exec(key);
  if (!match) {
    throw new Error("reconciliation requires an exact suppression replay report key");
  }
  const [, directoryDate, timestampDate, hour, minute, second, millisecond, runId] =
    match;
  if (!runId || directoryDate !== timestampDate) {
    throw new Error("reconciliation requires an exact suppression replay report key");
  }
  const isoTimestamp = `${timestampDate}T${hour}:${minute}:${second}.${millisecond}Z`;
  const parsed = new Date(isoTimestamp);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString() !== isoTimestamp ||
    decodeUlidTimestamp(runId) !== parsed.getTime()
  ) {
    throw new Error("reconciliation requires an exact suppression replay report key");
  }
}

export async function runReconciliation(
  deps: HandlerDeps,
  input: { reportKey: string; now: Date },
): Promise<SuppressionReplayResult> {
  assertReportKey(input.reportKey);
  return runReconciliationFromLoadedSource(
    deps,
    input,
    await loadCapabilityFreeReplaySource(deps, false),
  );
}

export async function runReconciliationFromLoadedSource(
  deps: HandlerDeps,
  input: { reportKey: string; now: Date },
  source: ProductionReplaySource,
): Promise<SuppressionReplayResult> {
  assertReportKey(input.reportKey);
  if (source.quarantine.length > 0) {
    throw new Error("reconciliation source cannot contain quarantined objects");
  }
  const union = sourceUnion(source.validObjects);
  const sourceUnionChecksumSha256 = sourceUnionChecksum(union);
  const reconciliation = await reconcileSource(deps, union);
  const report = reportFor({
    source,
    union,
    sourceUnionChecksumSha256,
    now: input.now,
    appliedMemberships: 0,
    missingMemberships: reconciliation.missingMemberships,
    unexpectedMemberships: reconciliation.unexpectedMemberships,
  });

  log("info", "suppression_reconciliation_run", {
    report_key: input.reportKey,
    objects_seen: report.objectsSeen,
    objects_valid: report.objectsValid,
    unique_memberships: report.uniqueMemberships,
    missing_memberships: report.missingMemberships,
    unexpected_memberships: report.unexpectedMemberships,
    source_union_checksum_sha256: report.sourceUnionChecksumSha256,
  });
  return { reportKey: input.reportKey, report };
}
