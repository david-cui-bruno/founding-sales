import { describe, expect, it } from "vitest";
import {
  runHandler,
  UPLOADS_PREFIX,
  type HandlerDeps,
  type SuppressionReplayResult,
} from "../src/handler";
import { SuppressionObjectValidationError } from "../src/suppressionObject";

const NOW = new Date("2026-09-04T12:34:56.789Z");
const REPORTS_PREFIX = "upstream/suppression-reports/";

type AttributeValue = { S: string } | { N: string } | { NULL: boolean };
type DynamoItem = Record<string, AttributeValue>;

type FakeObjectVersion = Readonly<{
  key: string;
  versionId: string | null;
  etag: string;
  lastModified: string;
  body: string;
}>;

type SentCommand = Readonly<{
  name: string;
  input: Record<string, unknown>;
}>;

interface FakeState {
  objects: FakeObjectVersion[];
  ledger: Map<string, DynamoItem>;
  suppressions: Map<string, DynamoItem>;
  reports: Map<string, string>;
  commands: SentCommand[];
  listPageSize: number;
  scanPageSize: number;
  runIds: string[];
  unprocessedBatchGetOnce: boolean;
  conflictOnSuppressionWrite?: {
    hash: string;
    winner: DynamoItem;
    remaining: number;
  };
}

const VALID_LINE = {
  contact_hmac: "a".repeat(64),
  kind: "phone",
  reason: "opt_out",
  observed_at: "2026-09-04T11:00:00.000Z",
} as const;

type TestLine = Readonly<{
  contact_hmac: string;
  kind: "phone" | "email";
  reason: "opt_out" | "founder_block" | "wrong_person";
  observed_at: string;
}>;

function hashFor(index: number): string {
  return index.toString(16).padStart(64, "0");
}

function lineFor(
  hash: string,
  overrides: Partial<TestLine> = {},
): Record<string, string> {
  return { ...VALID_LINE, contact_hmac: hash, ...overrides };
}

function ndjson(...lines: ReadonlyArray<Record<string, unknown> | string>): string {
  return `${lines
    .map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
    .join("\n")}\n`;
}

function objectVersion(input: Partial<FakeObjectVersion> = {}): FakeObjectVersion {
  return {
    key: `${UPLOADS_PREFIX}2026-09-04/123456-batch.ndjson`,
    versionId: "version-1",
    etag: '"etag-1"',
    lastModified: "2026-09-04T12:00:00.000Z",
    body: ndjson(lineFor("a".repeat(64))),
    ...input,
  };
}

function state(objects: FakeObjectVersion[] = []): FakeState {
  return {
    objects,
    ledger: new Map(),
    suppressions: new Map(),
    reports: new Map(),
    commands: [],
    listPageSize: 100,
    scanPageSize: 100,
    runIds: [
      "01K4AWJ1AN0000000000000001",
      "01K4AWJ1AN0000000000000002",
      "01K4AWJ1AN0000000000000003",
    ],
    unprocessedBatchGetOnce: false,
  };
}

function readS(item: DynamoItem, key: string): string | undefined {
  const value = item[key];
  return value && "S" in value ? value.S : undefined;
}

function conditionalFailure(): Error {
  return Object.assign(new Error("conditional write conflict"), {
    name: "ConditionalCheckFailedException",
  });
}

function conditionMatches(
  input: Record<string, unknown>,
  current: DynamoItem | undefined,
): boolean {
  const expression = input.ConditionExpression as string | undefined;
  if (!expression) return true;
  if (expression === "attribute_not_exists(contact_hash)") return current === undefined;
  if (!current) return false;
  const values = (input.ExpressionAttributeValues ?? {}) as DynamoItem;
  const expected = [
    ["kind", readS(values, ":expected_kind")],
    ["reason", readS(values, ":expected_reason")],
    ["observed_at", readS(values, ":expected_observed_at")],
  ] as const;
  return expected.every(([field, value]) =>
    value === undefined
      ? expression.includes(`attribute_not_exists(#${field})`) &&
        readS(current, field) === undefined
      : readS(current, field) === value,
  );
}

function bodyToString(body: unknown): string {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf8");
  throw new Error(`unexpected report body ${typeof body}`);
}

function fakeDeps(s: FakeState): HandlerDeps {
  let nextRunId = 0;
  return {
    s3: {
      send: async (command: unknown) => {
        const name = (command as { constructor: { name: string } }).constructor.name;
        const input = (command as { input: Record<string, unknown> }).input;
        s.commands.push({ name: `s3:${name}`, input });

        if (name === "ListObjectVersionsCommand") {
          const prefix = input.Prefix as string;
          const candidates = s.objects.filter((object) => object.key.startsWith(prefix));
          const keyMarker = input.KeyMarker as string | undefined;
          const versionIdMarker = input.VersionIdMarker as string | undefined;
          let start = 0;
          if (keyMarker !== undefined) {
            const markerIndex = candidates.findIndex(
              (object) =>
                object.key === keyMarker &&
                (object.versionId ?? undefined) === versionIdMarker,
            );
            if (markerIndex < 0) throw new Error("unknown version-list marker");
            start = markerIndex + 1;
          }
          const page = candidates.slice(start, start + s.listPageSize);
          const truncated = start + page.length < candidates.length;
          const last = page.at(-1);
          return {
            Versions: page.map((object) => ({
              Key: object.key,
              VersionId: object.versionId ?? undefined,
              ETag: object.etag,
              LastModified: new Date(object.lastModified),
            })),
            IsTruncated: truncated,
            NextKeyMarker: truncated ? last?.key : undefined,
            NextVersionIdMarker: truncated ? last?.versionId ?? undefined : undefined,
          };
        }

        if (name === "GetObjectCommand") {
          const key = input.Key as string;
          const versionId = (input.VersionId as string | undefined) ?? null;
          const object = s.objects.find(
            (candidate) => candidate.key === key && candidate.versionId === versionId,
          );
          if (!object) throw new Error(`missing fake object ${key} ${String(versionId)}`);
          return { Body: { transformToString: async () => object.body } };
        }

        if (name === "PutObjectCommand") {
          const key = input.Key as string;
          if (input.IfNoneMatch !== "*") throw new Error("report write was not immutable");
          if (s.reports.has(key)) throw new Error("PreconditionFailed: report already exists");
          s.reports.set(key, bodyToString(input.Body));
          return {};
        }

        throw new Error(`unexpected s3 command ${name}`);
      },
    } as HandlerDeps["s3"],
    dynamo: {
      send: async (command: unknown) => {
        const name = (command as { constructor: { name: string } }).constructor.name;
        const input = (command as { input: Record<string, unknown> }).input;
        const tableName = input.TableName as string | undefined;
        s.commands.push({ name: `dynamo:${name}`, input });

        if (name === "GetItemCommand") {
          const key = input.Key as DynamoItem;
          const item = s.ledger.get(readS(key, "source_natural_key") ?? "");
          return item === undefined ? {} : { Item: item };
        }

        if (name === "PutItemCommand") {
          const item = input.Item as DynamoItem;
          if (tableName === "suppression") {
            const hash = readS(item, "contact_hash") ?? "";
            const conflict = s.conflictOnSuppressionWrite;
            if (conflict?.hash === hash && conflict.remaining > 0) {
              conflict.remaining -= 1;
              s.suppressions.set(hash, conflict.winner);
              if (input.ConditionExpression) throw conditionalFailure();
            }
            if (!conditionMatches(input, s.suppressions.get(hash))) {
              throw conditionalFailure();
            }
            s.suppressions.set(hash, item);
          } else if (tableName === "snapshots") {
            s.ledger.set(readS(item, "source_natural_key") ?? "", item);
          } else {
            throw new Error(`unexpected table ${String(tableName)}`);
          }
          return {};
        }

        if (name === "BatchGetItemCommand") {
          const requestItems = input.RequestItems as Record<
            string,
            { Keys: DynamoItem[] }
          >;
          const request = requestItems.suppression;
          if (!request) throw new Error("missing suppression BatchGet request");
          const keys = request.Keys;
          const unprocessed = s.unprocessedBatchGetOnce ? keys.slice(0, 1) : [];
          s.unprocessedBatchGetOnce = false;
          const unprocessedHashes = new Set(
            unprocessed.map((key) => readS(key, "contact_hash")),
          );
          const items = keys
            .map((key) => readS(key, "contact_hash") ?? "")
            .filter((hash) => !unprocessedHashes.has(hash))
            .map((hash) => s.suppressions.get(hash))
            .filter((item): item is DynamoItem => item !== undefined);
          return {
            Responses: { suppression: items },
            UnprocessedKeys:
              unprocessed.length === 0
                ? {}
                : { suppression: { Keys: unprocessed } },
          };
        }

        if (name === "ScanCommand") {
          const hashes = [...s.suppressions.keys()].sort();
          const exclusiveStartKey = input.ExclusiveStartKey as DynamoItem | undefined;
          const previous = exclusiveStartKey
            ? readS(exclusiveStartKey, "contact_hash")
            : undefined;
          const start = previous === undefined ? 0 : hashes.indexOf(previous) + 1;
          const page = hashes.slice(start, start + s.scanPageSize);
          const last = page.at(-1);
          return {
            Items: page.map((hash) => ({ contact_hash: { S: hash } })),
            LastEvaluatedKey:
              start + page.length < hashes.length && last
                ? { contact_hash: { S: last } }
                : undefined,
          };
        }

        throw new Error(`unexpected dynamo command ${name}`);
      },
    } as HandlerDeps["dynamo"],
    env: {
      INBOX_BUCKET: "inbox",
      SNAPSHOTS_TABLE: "snapshots",
      SUPPRESSION_TABLE: "suppression",
    },
    now: () => NOW,
    runId: () => s.runIds[nextRunId++] ?? "01K4AWJ1ANZZZZZZZZZZZZZZZZ",
  } as HandlerDeps;
}

function replayResult(value: unknown): SuppressionReplayResult {
  return value as SuppressionReplayResult;
}

function suppressionItem(input: {
  hash: string;
  kind?: "phone" | "email";
  reason?: "opt_out" | "founder_block" | "wrong_person";
  observedAt?: string;
}): DynamoItem {
  return {
    contact_hash: { S: input.hash },
    kind: { S: input.kind ?? "phone" },
    reason: { S: input.reason ?? "opt_out" },
    observed_at: { S: input.observedAt ?? "2026-09-04T11:00:00.000Z" },
    synced_at: { S: "2026-09-04T11:30:00.000Z" },
  };
}

describe("suppression historical replay", () => {
  it("replays every retained version in deterministic version order", async () => {
    const s = state([
      objectVersion({
        key: `${UPLOADS_PREFIX}b.ndjson`,
        versionId: "v2",
        lastModified: "2026-09-04T12:00:00.000Z",
        body: ndjson(lineFor(hashFor(2))),
      }),
      objectVersion({
        key: `${UPLOADS_PREFIX}a.ndjson`,
        versionId: "v2",
        lastModified: "2026-09-04T12:00:00.000Z",
        body: ndjson(lineFor(hashFor(1))),
      }),
      objectVersion({
        key: `${UPLOADS_PREFIX}a.ndjson`,
        versionId: "v1",
        lastModified: "2026-09-04T12:00:00.000Z",
        body: ndjson(lineFor(hashFor(0))),
      }),
      objectVersion({
        key: `${UPLOADS_PREFIX}z.ndjson`,
        versionId: "v9",
        lastModified: "2026-09-03T12:00:00.000Z",
        body: ndjson(lineFor(hashFor(3))),
      }),
    ]);

    const result = replayResult(
      await runHandler(fakeDeps(s), { mode: "replay", dryRun: true }),
    );

    expect(
      s.commands
        .filter((command) => command.name === "s3:GetObjectCommand")
        .map((command) => [command.input.Key, command.input.VersionId]),
    ).toEqual([
      [`${UPLOADS_PREFIX}z.ndjson`, "v9"],
      [`${UPLOADS_PREFIX}a.ndjson`, "v1"],
      [`${UPLOADS_PREFIX}a.ndjson`, "v2"],
      [`${UPLOADS_PREFIX}b.ndjson`, "v2"],
    ]);
    expect(result.report).toMatchObject({
      objectsSeen: 4,
      objectsValid: 4,
      objectsQuarantined: 0,
      uniqueMemberships: 4,
      appliedMemberships: 0,
      missingMemberships: 4,
    });
  });

  it("builds the union of person and contact tombstones idempotently", async () => {
    const duplicate = hashFor(10);
    const other = hashFor(11);
    const s = state([
      objectVersion({
        body: ndjson(
          lineFor(duplicate, {
            reason: "wrong_person",
            observed_at: "2026-09-04T10:00:00.000Z",
          }),
          lineFor(other, { reason: "founder_block" }),
        ),
      }),
      objectVersion({
        key: `${UPLOADS_PREFIX}later.ndjson`,
        versionId: "version-2",
        lastModified: "2026-09-04T12:01:00.000Z",
        body: ndjson(
          lineFor(duplicate, {
            reason: "founder_block",
            observed_at: "2026-09-04T09:00:00.000Z",
          }),
          lineFor(duplicate, {
            reason: "opt_out",
            observed_at: "2026-09-04T11:00:00.000Z",
          }),
        ),
      }),
    ]);

    const result = replayResult(
      await runHandler(fakeDeps(s), { mode: "replay", dryRun: false }),
    );

    expect(result.report.uniqueMemberships).toBe(2);
    expect(result.report.appliedMemberships).toBe(2);
    expect(result.report.missingMemberships).toBe(0);
    expect(s.suppressions.get(duplicate)).toMatchObject({
      reason: { S: "opt_out" },
      observed_at: { S: "2026-09-04T09:00:00.000Z" },
    });
    expect(
      s.commands.filter(
        (command) =>
          command.name === "dynamo:PutItemCommand" &&
          (command.input.TableName as string) === "suppression",
      ),
    ).toHaveLength(2);
  });

  it("preserves a stronger cloud reason and earlier observation monotonically", async () => {
    const hash = hashFor(12);
    const s = state([
      objectVersion({
        body: ndjson(
          lineFor(hash, {
            reason: "founder_block",
            observed_at: "2026-09-04T10:00:00.000Z",
          }),
        ),
      }),
    ]);
    s.suppressions.set(
      hash,
      suppressionItem({
        hash,
        reason: "opt_out",
        observedAt: "2026-09-04T09:00:00.000Z",
      }),
    );

    const result = replayResult(
      await runHandler(fakeDeps(s), { mode: "replay", dryRun: false }),
    );

    expect(result.report.appliedMemberships).toBe(0);
    expect(result.report.missingMemberships).toBe(0);
    expect(s.suppressions.get(hash)).toMatchObject({
      reason: { S: "opt_out" },
      observed_at: { S: "2026-09-04T09:00:00.000Z" },
    });
    expect(
      s.commands.filter(
        (command) =>
          command.name === "dynamo:PutItemCommand" &&
          command.input.TableName === "suppression",
      ),
    ).toHaveLength(0);
  });

  it("retries a replay conflict and preserves the stronger earlier concurrent winner", async () => {
    const hash = hashFor(13);
    const winner = suppressionItem({
      hash,
      reason: "opt_out",
      observedAt: "2026-09-04T08:00:00.000Z",
    });
    const s = state([
      objectVersion({
        body: ndjson(
          lineFor(hash, {
            reason: "founder_block",
            observed_at: "2026-09-04T10:00:00.000Z",
          }),
        ),
      }),
    ]);
    s.conflictOnSuppressionWrite = { hash, winner, remaining: 1 };

    const result = replayResult(
      await runHandler(fakeDeps(s), { mode: "replay", dryRun: false }),
    );

    expect(result.report.appliedMemberships).toBe(0);
    expect(s.suppressions.get(hash)).toEqual(winner);
    expect(
      s.commands.filter((command) => command.name === "dynamo:BatchGetItemCommand"),
    ).toHaveLength(2);
  });

  it("quarantines invalid historical versions without ledgering them", async () => {
    const invalid = objectVersion({
      key: `${UPLOADS_PREFIX}middle.ndjson`,
      versionId: "invalid-version",
      lastModified: "2026-09-04T12:01:00.000Z",
      body: ndjson(lineFor(hashFor(20)), "not-json", { forbidden: "row-content" }),
    });
    const s = state([
      objectVersion({
        key: `${UPLOADS_PREFIX}first.ndjson`,
        versionId: "first-version",
        lastModified: "2026-09-04T12:00:00.000Z",
        body: ndjson(lineFor(hashFor(19))),
      }),
      invalid,
      objectVersion({
        key: `${UPLOADS_PREFIX}last.ndjson`,
        versionId: "last-version",
        lastModified: "2026-09-04T12:02:00.000Z",
        body: ndjson(lineFor(hashFor(21))),
      }),
    ]);

    const result = replayResult(
      await runHandler(fakeDeps(s), { mode: "replay", dryRun: false }),
    );

    expect(result.report).toMatchObject({
      objectsSeen: 3,
      objectsValid: 2,
      objectsQuarantined: 1,
      quarantine: [
        {
          key: invalid.key,
          versionId: invalid.versionId,
          invalidLineNumbers: [2, 3],
        },
      ],
    });
    expect(s.suppressions.size).toBe(2);
    expect(s.ledger.size).toBe(2);
    expect(
      [...s.ledger.values()].some(
        (item) => readS(item, "object_version_id") === invalid.versionId,
      ),
    ).toBe(false);
  });

  it("reports missing and unexpected cloud memberships", async () => {
    const sourceHashes = Array.from({ length: 205 }, (_, index) => hashFor(index));
    const s = state([
      objectVersion({
        body: ndjson(...sourceHashes.map((hash) => lineFor(hash))),
      }),
    ]);
    for (const hash of sourceHashes.slice(0, 202)) {
      s.suppressions.set(hash, suppressionItem({ hash }));
    }
    const unexpected = "f".repeat(64);
    s.suppressions.set(unexpected, suppressionItem({ hash: unexpected }));
    s.scanPageSize = 40;
    s.unprocessedBatchGetOnce = true;

    const result = replayResult(
      await runHandler(fakeDeps(s), { mode: "replay", dryRun: true }),
    );

    expect(result.report).toMatchObject({
      uniqueMemberships: 205,
      appliedMemberships: 0,
      missingMemberships: 3,
      unexpectedMemberships: 1,
    });
    expect(
      s.commands
        .filter((command) => command.name === "dynamo:BatchGetItemCommand")
        .map((command) => {
          const requestItems = command.input.RequestItems as Record<
            string,
            { Keys: DynamoItem[] }
          >;
          return requestItems.suppression?.Keys.length;
        }),
    ).toEqual([100, 1, 100, 5]);
    expect(
      s.commands.filter((command) => command.name === "dynamo:ScanCommand").length,
    ).toBeGreaterThan(1);
  });

  it("writes a dated immutable evidence report without HMACs or row content", async () => {
    const hmac = hashFor(30);
    const secretRowContent = "person@example.com";
    const valid = objectVersion({ body: ndjson(lineFor(hmac)) });
    const invalid = objectVersion({
      key: `${UPLOADS_PREFIX}invalid.ndjson`,
      versionId: "invalid-version",
      lastModified: "2026-09-04T12:01:00.000Z",
      body: ndjson(secretRowContent),
    });
    const s = state([valid, invalid]);

    const result = replayResult(
      await runHandler(fakeDeps(s), { mode: "replay", dryRun: true }),
    );

    expect(result.reportKey).toMatch(
      /^upstream\/suppression-reports\/2026-09-04\/.+-01K4AWJ1AN0000000000000001\.json$/,
    );
    const put = s.commands.find((command) => command.name === "s3:PutObjectCommand");
    expect(put?.input).toMatchObject({
      Bucket: "inbox",
      Key: result.reportKey,
      IfNoneMatch: "*",
      ContentType: "application/json",
    });
    const reportBody = s.reports.get(result.reportKey);
    expect(reportBody).toBeDefined();
    expect(reportBody).not.toContain(hmac);
    expect(reportBody).not.toContain(secretRowContent);
    expect(reportBody).not.toContain("contact_hmac");
    const evidence = JSON.parse(reportBody ?? "{}") as {
      objects?: Array<Record<string, unknown>>;
      quarantine?: Array<Record<string, unknown>>;
    };
    expect(evidence.objects).toEqual([
      expect.objectContaining({
        key: valid.key,
        versionId: valid.versionId,
        checksumSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        status: "valid",
      }),
      expect.objectContaining({
        key: invalid.key,
        versionId: invalid.versionId,
        checksumSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        status: "quarantined",
      }),
    ]);
    expect(evidence.quarantine).toEqual([
      {
        key: invalid.key,
        versionId: invalid.versionId,
        invalidLineNumbers: [1],
      },
    ]);
  });

  it("two replay runs at the same clock instant produce distinct immutable report keys", async () => {
    const s = state([objectVersion()]);
    const deps = fakeDeps(s);

    const first = replayResult(
      await runHandler(deps, { mode: "replay", dryRun: true }),
    );
    const second = replayResult(
      await runHandler(deps, { mode: "replay", dryRun: true }),
    );

    expect(first.report.generatedAt).toBe(NOW.toISOString());
    expect(second.report.generatedAt).toBe(NOW.toISOString());
    expect(first.reportKey).not.toBe(second.reportKey);
    expect(s.reports.has(first.reportKey)).toBe(true);
    expect(s.reports.has(second.reportKey)).toBe(true);
  });

  it("fails rather than overwriting an immutable report collision", async () => {
    const s = state([objectVersion()]);
    s.runIds = [
      "01K4AWJ1AN0000000000000001",
      "01K4AWJ1AN0000000000000001",
    ];
    const deps = fakeDeps(s);

    await runHandler(deps, { mode: "replay", dryRun: true });

    await expect(
      runHandler(deps, { mode: "replay", dryRun: true }),
    ).rejects.toThrow("PreconditionFailed");
    expect(s.reports.size).toBe(1);
  });

  it("reconciliation accepts the exact report key returned by replay", async () => {
    const s = state([objectVersion()]);
    const deps = fakeDeps(s);
    const replay = replayResult(
      await runHandler(deps, { mode: "replay", dryRun: true }),
    );
    const commandCount = s.commands.length;

    const reconciled = replayResult(
      await runHandler(deps, { mode: "reconcile", reportKey: replay.reportKey }),
    );

    expect(reconciled.reportKey).toBe(replay.reportKey);
    expect(reconciled.report.sourceUnionChecksumSha256).toBe(
      replay.report.sourceUnionChecksumSha256,
    );
    expect(
      s.commands.slice(commandCount).some((command) => command.name === "s3:PutObjectCommand"),
    ).toBe(false);
    expect(reconciled.reportKey.startsWith(REPORTS_PREFIX)).toBe(true);
  });

  it("rejects report keys that are not an exact generated key", async () => {
    const ulid = "01K4AWJ1AN0000000000000001";
    const invalidKeys = [
      `${REPORTS_PREFIX}latest.json`,
      `${REPORTS_PREFIX}2026-09-04/report.json`,
      `${REPORTS_PREFIX}2026-09-03/2026-09-04T123456789Z-${ulid}.json`,
      `${REPORTS_PREFIX}2026-09-04/2026-09-04T126056789Z-${ulid}.json`,
      `${REPORTS_PREFIX}2026-09-04/2026-09-04T12:34:56.789Z-${ulid}.json`,
      `${REPORTS_PREFIX}2026-09-04/2026-09-04T123456789Z-${ulid.toLowerCase()}.json`,
      `${REPORTS_PREFIX}2026-09-04/2026-09-04T123456789Z-${ulid}.json.bak`,
      `${REPORTS_PREFIX}/2026-09-04/2026-09-04T123456789Z-${ulid}.json`,
      `${REPORTS_PREFIX}2026-09-04/extra/2026-09-04T123456789Z-${ulid}.json`,
      `${REPORTS_PREFIX}2026-09-04/2026-09-04T123456789Z-${ulid.slice(1)}.json`,
    ];

    for (const reportKey of invalidKeys) {
      const s = state();
      await expect(
        runHandler(fakeDeps(s), { mode: "reconcile", reportKey }),
      ).rejects.toThrow("exact suppression replay report key");
      expect(s.commands).toEqual([]);
    }
  });

  it("only explicit replay continues past quarantined historical versions", async () => {
    const s = state([
      objectVersion({ body: ndjson("not-json") }),
      objectVersion({
        key: `${UPLOADS_PREFIX}later.ndjson`,
        versionId: "later-version",
        lastModified: "2026-09-04T12:01:00.000Z",
        body: ndjson(lineFor(hashFor(41))),
      }),
    ]);
    const deps = fakeDeps(s);
    const replay = replayResult(
      await runHandler(deps, { mode: "replay", dryRun: true }),
    );

    expect(replay.report.objectsQuarantined).toBe(1);
    await expect(
      runHandler(deps, { mode: "reconcile", reportKey: replay.reportKey }),
    ).rejects.toBeInstanceOf(SuppressionObjectValidationError);
  });

  it("a second replay produces the same source union checksum and no new memberships", async () => {
    const hash = hashFor(40);
    const s = state([
      objectVersion({
        body: ndjson(
          lineFor(hash, {
            reason: "founder_block",
            observed_at: "2026-09-04T10:00:00.000Z",
          }),
        ),
      }),
    ]);
    const deps = fakeDeps(s);

    const first = replayResult(
      await runHandler(deps, { mode: "replay", dryRun: false }),
    );
    const suppressionWritesAfterFirst = s.commands.filter(
      (command) =>
        command.name === "dynamo:PutItemCommand" &&
        command.input.TableName === "suppression",
    ).length;
    const second = replayResult(
      await runHandler(deps, { mode: "replay", dryRun: false }),
    );

    expect(second.report.sourceUnionChecksumSha256).toBe(
      first.report.sourceUnionChecksumSha256,
    );
    expect(second.report.appliedMemberships).toBe(0);
    expect(second.report.missingMemberships).toBe(0);
    expect(
      s.commands.filter(
        (command) =>
          command.name === "dynamo:PutItemCommand" &&
          command.input.TableName === "suppression",
      ),
    ).toHaveLength(suppressionWritesAfterFirst);
    expect(s.suppressions.get(hash)).toMatchObject({
      reason: { S: "founder_block" },
      observed_at: { S: "2026-09-04T10:00:00.000Z" },
    });
  });
});
