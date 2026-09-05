import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const productionS3Send = vi.hoisted(() => vi.fn());
vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return { ...actual, S3Client: class { send = productionS3Send; } };
});
import {
  createHandler,
  REPORTS_PREFIX,
  runHandler,
  UPLOADS_PREFIX,
  type HandlerDeps,
  type SuppressionReplayResult,
} from "../src/handler";
import * as suppressionObjects from "../src/suppressionObject";
import { parseAndValidateSuppressionObject, productionSuppressionObjectSource, SuppressionObjectValidationError } from "../src/suppressionObject";

const NOW = new Date("2026-09-04T12:00:00.000Z");

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
  commands: SentCommand[];
  reports: Map<string, string>;
  listPageSize: number;
  failOnSuppressionHash?: string;
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

function bodyFor(hashCharacter: string, overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    ...VALID_LINE,
    contact_hmac: hashCharacter.repeat(64),
    ...overrides,
  })}\n`;
}

function objectVersion(input: Partial<FakeObjectVersion> = {}): FakeObjectVersion {
  return {
    key: `${UPLOADS_PREFIX}2026-09-04/120000-batch.ndjson`,
    versionId: "version-1",
    etag: '"etag-1"',
    lastModified: "2026-09-04T12:00:00.000Z",
    body: bodyFor("a"),
    ...input,
  };
}

function state(objects: FakeObjectVersion[] = []): FakeState {
  return {
    objects,
    ledger: new Map(),
    suppressions: new Map(),
    commands: [],
    reports: new Map(),
    listPageSize: 100,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

function normalizedEtag(etag: string): string {
  return etag.startsWith('"') && etag.endsWith('"') ? etag.slice(1, -1) : etag;
}

function naturalKeyFor(object: FakeObjectVersion): string {
  const canonical = JSON.stringify({
    bucket: "inbox",
    key: object.key,
    versionId: object.versionId,
    etag: normalizedEtag(object.etag),
    checksumSha256: sha256(object.body),
  });
  return `suppression-sync:${sha256(canonical)}`;
}

function versionAttribute(versionId: string | null): AttributeValue {
  return versionId === null ? { NULL: true } : { S: versionId };
}

function exactLedgerItem(
  object: FakeObjectVersion,
  overrides: Partial<DynamoItem> = {},
): DynamoItem {
  return {
    source_natural_key: { S: naturalKeyFor(object) },
    snapshot_date: { S: "ledger" },
    object_bucket: { S: "inbox" },
    object_key: { S: object.key },
    object_version_id: versionAttribute(object.versionId),
    object_etag: { S: normalizedEtag(object.etag) },
    object_checksum_sha256: { S: sha256(object.body) },
    processed_at: { S: NOW.toISOString() },
    valid_row_count: { N: "1" },
    ...overrides,
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

function fakeDeps(s: FakeState): HandlerDeps {
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
          if (s.reports.has(key)) return { Body: { transformToString: async () => s.reports.get(key)! } };
          const versionId = (input.VersionId as string | undefined) ?? null;
          const object = s.objects.find(
            (candidate) => candidate.key === key && candidate.versionId === versionId,
          );
          if (!object) throw new Error(`missing fake object ${key} ${String(versionId)}`);
          return { Body: { transformToString: async () => object.body } };
        }

        if (name === "PutObjectCommand") {
          const key = input.Key as string;
          s.reports.set(key, String(input.Body));
          return {};
        }

        throw new Error(`unexpected s3 command ${name}`);
      },
    } as HandlerDeps["s3"],
    dynamo: {
      send: async (command: unknown) => {
        const name = (command as { constructor: { name: string } }).constructor.name;
        const input = (command as { input: Record<string, unknown> }).input;
        const tableName = input.TableName as string;
        s.commands.push({
          name: name === "PutItemCommand" ? `dynamo:${name}:${tableName}` : `dynamo:${name}`,
          input,
        });

        if (name === "GetItemCommand") {
          const key = input.Key as DynamoItem;
          const naturalKey = readS(key, "source_natural_key") ?? "";
          const item = s.ledger.get(naturalKey);
          return item === undefined ? {} : { Item: item };
        }

        if (name === "PutItemCommand") {
          const item = input.Item as DynamoItem;
          if (tableName === "suppression") {
            const hash = readS(item, "contact_hash") ?? "";
            if (hash === s.failOnSuppressionHash) {
              throw new Error("forced suppression write failure");
            }
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
            throw new Error(`unexpected table ${tableName}`);
          }
          return {};
        }

        if (name === "BatchGetItemCommand") {
          const requestItems = input.RequestItems as Record<
            string,
            { Keys: DynamoItem[] }
          >;
          const keys = requestItems.suppression?.Keys ?? [];
          return {
            Responses: {
              suppression: keys
                .map((key) => s.suppressions.get(readS(key, "contact_hash") ?? ""))
                .filter((item): item is DynamoItem => item !== undefined),
            },
            UnprocessedKeys: {},
          };
        }

        if (name === "ScanCommand") {
          return { Items: [...s.suppressions.values()] };
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
  };
}

describe("suppression-sync handler", () => {
  it("rejects malformed runtime events before side effects", async () => {
    const invalidEvents: unknown[] = [
      null,
      [],
      "incremental",
      { mode: "unknown" },
      { mode: "replay", dryRun: "false" },
      { mode: "reconcile", reportKey: 1 },
      { mode: "incremental", maxObjects: 0 },
      { mode: "incremental", maxObjects: -1 },
      { mode: "incremental", maxObjects: 1.5 },
      { mode: "incremental", maxObjects: Number.NaN },
      { mode: "incremental", maxObjects: Number.POSITIVE_INFINITY },
      { mode: "incremental", maxObjects: Number.MAX_SAFE_INTEGER + 1 },
      { mode: "incremental", unexpected: true },
      { mode: "replay", dryRun: true, unexpected: true },
      { mode: "reconcile", reportKey: "report.json", unexpected: true },
      { dryRun: true },
      { reportKey: "report.json" },
    ];

    for (const event of invalidEvents) {
      const s = state();
      await expect(runHandler(fakeDeps(s), event as never)).rejects.toThrow(
        "invalid suppression sync event",
      );
      expect(s.commands).toEqual([]);
    }
  });

  it("validates reconcile report keys before reading time or generating a run ID", async () => {
    const s = state();
    const now = vi.fn(() => NOW);
    const runId = vi.fn(() => "01M1P5EQ000000000000000001");
    const deps = { ...fakeDeps(s), now, runId };

    await expect(
      runHandler(deps, {
        mode: "reconcile",
        reportKey: `${REPORTS_PREFIX}latest.json`,
      }),
    ).rejects.toThrow("exact suppression replay report key");

    expect(now).not.toHaveBeenCalled();
    expect(runId).not.toHaveBeenCalled();
    expect(s.commands).toEqual([]);
  });

  it("accepts the explicit scheduled incremental payload", async () => {
    const s = state([objectVersion()]);

    const result = await runHandler(fakeDeps(s), { mode: "incremental" });

    expect(result).toMatchObject({ filesSeen: 1, filesProcessed: 1 });
  });

  it("processes two same-day immutable objects", async () => {
    const s = state([
      objectVersion({
        key: `${UPLOADS_PREFIX}2026-09-04/120000-first.ndjson`,
        versionId: "first-version",
        body: bodyFor("a"),
      }),
      objectVersion({
        key: `${UPLOADS_PREFIX}2026-09-04/120000-second.ndjson`,
        versionId: "second-version",
        body: bodyFor("b"),
      }),
    ]);

    const result = await runHandler(fakeDeps(s));

    expect(result.filesProcessed).toBe(2);
    expect(result.linesWritten).toBe(2);
    expect(s.suppressions.has("a".repeat(64))).toBe(true);
    expect(s.suppressions.has("b".repeat(64))).toBe(true);
  });

  it("processes two versions of the same legacy key", async () => {
    const key = `${UPLOADS_PREFIX}2026-09-02.ndjson`;
    const s = state([
      objectVersion({ key, versionId: "new-version", body: bodyFor("a") }),
      objectVersion({ key, versionId: "old-version", body: bodyFor("b") }),
    ]);

    const result = await runHandler(fakeDeps(s));

    expect(result.filesProcessed).toBe(2);
    expect(
      s.commands
        .filter((command) => command.name === "s3:GetObjectCommand")
        .map((command) => command.input.VersionId),
    ).toEqual(["new-version", "old-version"]);
  });

  it("paginates through every listed object version with both version markers", async () => {
    const key = `${UPLOADS_PREFIX}2026-09-02.ndjson`;
    const versions = [
      objectVersion({ key, versionId: "v3", body: bodyFor("a") }),
      objectVersion({ key, versionId: "v2", body: bodyFor("b") }),
      objectVersion({ key, versionId: "v1", body: bodyFor("c") }),
    ];
    const s = state(versions);
    s.listPageSize = 1;

    const result = await runHandler(fakeDeps(s));

    expect(result.filesProcessed).toBe(3);
    const listInputs = s.commands
      .filter((command) => command.name === "s3:ListObjectVersionsCommand")
      .map((command) => command.input);
    expect(listInputs).toHaveLength(3);
    expect(listInputs[1]).toMatchObject({ KeyMarker: key, VersionIdMarker: "v3" });
    expect(listInputs[2]).toMatchObject({ KeyMarker: key, VersionIdMarker: "v2" });
  });

  it("does not accept a key-only legacy ledger record as an exact hit", async () => {
    const object = objectVersion();
    const s = state([object]);
    s.ledger.set(`suppression-sync:${object.key}`, {
      source_natural_key: { S: `suppression-sync:${object.key}` },
      snapshot_date: { S: "ledger" },
      processed_at: { S: NOW.toISOString() },
    });
    s.ledger.set(naturalKeyFor(object), {
      source_natural_key: { S: naturalKeyFor(object) },
      snapshot_date: { S: "ledger" },
      object_key: { S: object.key },
    });

    const result = await runHandler(fakeDeps(s));

    expect(result.filesProcessed).toBe(1);
    expect(result.filesSkipped).toBe(0);
    expect(s.suppressions.size).toBe(1);
  });

  it("requires matching bucket key version ETag and checksum for a ledger hit", async () => {
    const exact = objectVersion({ key: `${UPLOADS_PREFIX}exact.ndjson`, body: bodyFor("a") });
    const mismatches = [
      objectVersion({ key: `${UPLOADS_PREFIX}bucket.ndjson`, body: bodyFor("b") }),
      objectVersion({ key: `${UPLOADS_PREFIX}key.ndjson`, body: bodyFor("c") }),
      objectVersion({ key: `${UPLOADS_PREFIX}version.ndjson`, body: bodyFor("d") }),
      objectVersion({ key: `${UPLOADS_PREFIX}etag.ndjson`, body: bodyFor("e") }),
      objectVersion({ key: `${UPLOADS_PREFIX}checksum.ndjson`, body: bodyFor("f") }),
    ];
    const s = state([exact, ...mismatches]);
    s.ledger.set(naturalKeyFor(exact), exactLedgerItem(exact));
    s.ledger.set(naturalKeyFor(mismatches[0]!), exactLedgerItem(mismatches[0]!, { object_bucket: { S: "other" } }));
    s.ledger.set(naturalKeyFor(mismatches[1]!), exactLedgerItem(mismatches[1]!, { object_key: { S: "other" } }));
    s.ledger.set(naturalKeyFor(mismatches[2]!), exactLedgerItem(mismatches[2]!, { object_version_id: { S: "other" } }));
    s.ledger.set(naturalKeyFor(mismatches[3]!), exactLedgerItem(mismatches[3]!, { object_etag: { S: "other" } }));
    s.ledger.set(naturalKeyFor(mismatches[4]!), exactLedgerItem(mismatches[4]!, { object_checksum_sha256: { S: "other" } }));

    const result = await runHandler(fakeDeps(s));

    expect(result.filesSkipped).toBe(1);
    expect(result.filesProcessed).toBe(5);
  });

  it("records bucket key version ETag checksum timestamp and valid row count", async () => {
    const object = objectVersion({
      versionId: null,
      etag: '"quoted-etag"',
      body: `${bodyFor("a")}\n${bodyFor("b")}`,
    });
    const s = state([object]);

    await runHandler(fakeDeps(s));

    const ledgerItem = s.ledger.get(naturalKeyFor(object));
    expect(ledgerItem).toEqual({
      source_natural_key: { S: naturalKeyFor(object) },
      snapshot_date: { S: "ledger" },
      object_bucket: { S: "inbox" },
      object_key: { S: object.key },
      object_version_id: { NULL: true },
      object_etag: { S: "quoted-etag" },
      object_checksum_sha256: { S: sha256(object.body) },
      processed_at: { S: NOW.toISOString() },
      valid_row_count: { N: "2" },
    });
  });

  it("fails the entire object on one malformed row before the first suppression write", async () => {
    const object = objectVersion({
      body: [bodyFor("a").trimEnd(), "not-json", bodyFor("b").trimEnd()].join("\n"),
    });
    const s = state([object]);

    await expect(runHandler(fakeDeps(s))).rejects.toBeInstanceOf(
      SuppressionObjectValidationError,
    );

    expect(s.suppressions.size).toBe(0);
    expect(
      s.commands.some((command) => command.name === "dynamo:GetItemCommand"),
    ).toBe(false);
    expect(
      s.commands.some((command) =>
        command.name.startsWith("dynamo:PutItemCommand:suppression"),
      ),
    ).toBe(false);
    expect(s.ledger.size).toBe(0);
  });

  it("incremental mode still fails on an invalid current object", async () => {
    const contactData = "person@example.com";
    const phoneData = "+1-401-555-0199";
    const object = objectVersion({
      body: [
        "",
        bodyFor("a").trimEnd(),
        JSON.stringify({ ...VALID_LINE, contact_hmac: contactData }),
        "   ",
        phoneData,
      ].join("\n"),
    });
    const s = state([object]);
    const output: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((value) => {
      output.push(String(value));
    });

    try {
      await expect(
        runHandler(fakeDeps(s), { mode: "incremental" }),
      ).rejects.toBeInstanceOf(
        SuppressionObjectValidationError,
      );
    } finally {
      logSpy.mockRestore();
    }

    expect(output).toHaveLength(1);
    const logged = JSON.parse(output[0]!) as Record<string, unknown>;
    expect(logged).toMatchObject({
      level: "error",
      eventCode: "SUPPRESSION_OBJECT_INVALID",
      component: "suppression-sync",
      invalidLineNumbers: [3, 5],
      invalidLineCount: 2,
    });
    expect(logged).not.toHaveProperty("objectKey");
    expect(logged).not.toHaveProperty("objectVersionId");
    expect(logged).not.toHaveProperty("objectEtag");
    expect(logged).not.toHaveProperty("objectChecksumSha256");
    expect(output[0]).not.toContain(contactData);
    expect(output[0]).not.toContain(phoneData);
    expect(output[0]).not.toContain("contact_hmac");
  });

  it("does not ledger an object when a suppression write fails", async () => {
    const object = objectVersion({ body: `${bodyFor("a")}${bodyFor("b")}` });
    const s = state([object]);
    s.failOnSuppressionHash = "b".repeat(64);

    await expect(runHandler(fakeDeps(s))).rejects.toThrow(
      "forced suppression write failure",
    );

    expect(s.suppressions.has("a".repeat(64))).toBe(true);
    expect(s.ledger.size).toBe(0);
    expect(
      s.commands.some((command) =>
        command.name.startsWith("dynamo:PutItemCommand:snapshots"),
      ),
    ).toBe(false);

    s.failOnSuppressionHash = undefined;
    const retry = await runHandler(fakeDeps(s));
    expect(retry.filesProcessed).toBe(1);
    expect(s.suppressions.size).toBe(2);
    expect(s.ledger.size).toBe(1);
    expect(
      s.commands.filter((command) => {
        if (command.name !== "dynamo:PutItemCommand:suppression") return false;
        return readS(command.input.Item as DynamoItem, "contact_hash") === "a".repeat(64);
      }),
    ).toHaveLength(1);
  });

  it("replaying the exact same object identity is idempotent", async () => {
    const object = objectVersion();
    const s = state([object]);
    const deps = fakeDeps(s);

    await runHandler(deps);
    const commandCountAfterFirstRun = s.commands.length;
    const second = await runHandler(deps);

    expect(second.filesSkipped).toBe(1);
    expect(second.linesWritten).toBe(0);
    expect(
      s.commands.filter(
        (command) => command.name === "dynamo:PutItemCommand:suppression",
      ),
    ).toHaveLength(1);
    expect(
      s.commands.slice(commandCountAfterFirstRun).map((command) => command.name),
    ).toEqual([
      "s3:ListObjectVersionsCommand",
      "s3:GetObjectCommand",
      "dynamo:GetItemCommand",
    ]);
  });

  it("maxObjects bounds object versions for live testing", async () => {
    const s = state([
      objectVersion({ key: `${UPLOADS_PREFIX}a.ndjson`, body: bodyFor("a") }),
      objectVersion({ key: `${UPLOADS_PREFIX}b.ndjson`, body: bodyFor("b") }),
    ]);

    const result = await runHandler(fakeDeps(s), { maxObjects: 1 });

    expect(result.filesSeen).toBe(1);
    expect(result.filesProcessed).toBe(1);
  });

  it("incremental mode cannot weaken an existing membership", async () => {
    const hash = "a".repeat(64);
    const s = state([
      objectVersion({
        body: bodyFor("a", {
          reason: "wrong_person",
          observed_at: "2026-09-04T11:00:00.000Z",
        }),
      }),
    ]);
    s.suppressions.set(hash, {
      contact_hash: { S: hash },
      kind: { S: "phone" },
      reason: { S: "opt_out" },
      observed_at: { S: "2026-09-04T09:00:00.000Z" },
      synced_at: { S: "2026-09-04T09:00:00.000Z" },
    });

    const result = await runHandler(fakeDeps(s), { mode: "incremental" });

    expect(result.linesWritten).toBe(0);
    expect(s.suppressions.get(hash)).toMatchObject({
      reason: { S: "opt_out" },
      observed_at: { S: "2026-09-04T09:00:00.000Z" },
    });
  });

  it("incremental mode retries a conflict and preserves the concurrent winner", async () => {
    const hash = "a".repeat(64);
    const winner: DynamoItem = {
      contact_hash: { S: hash },
      kind: { S: "phone" },
      reason: { S: "opt_out" },
      observed_at: { S: "2026-09-04T08:00:00.000Z" },
      synced_at: { S: "2026-09-04T08:00:00.000Z" },
    };
    const s = state([
      objectVersion({
        body: bodyFor("a", {
          reason: "founder_block",
          observed_at: "2026-09-04T10:00:00.000Z",
        }),
      }),
    ]);
    s.conflictOnSuppressionWrite = { hash, winner, remaining: 1 };

    const result = await runHandler(fakeDeps(s), { mode: "incremental" });

    expect(result.linesWritten).toBe(0);
    expect(s.suppressions.get(hash)).toEqual(winner);
    expect(
      s.commands.filter((command) => command.name === "dynamo:BatchGetItemCommand"),
    ).toHaveLength(2);
  });

  it("bounds repeated conditional membership conflicts", async () => {
    const hash = "a".repeat(64);
    const weakerWinner: DynamoItem = {
      contact_hash: { S: hash },
      kind: { S: "phone" },
      reason: { S: "wrong_person" },
      observed_at: { S: "2026-09-04T12:00:00.000Z" },
      synced_at: { S: "2026-09-04T12:00:00.000Z" },
    };
    const s = state([
      objectVersion({
        body: bodyFor("a", {
          reason: "opt_out",
          observed_at: "2026-09-04T08:00:00.000Z",
        }),
      }),
    ]);
    s.conflictOnSuppressionWrite = {
      hash,
      winner: weakerWinner,
      remaining: 100,
    };

    await expect(
      runHandler(fakeDeps(s), { mode: "incremental" }),
    ).rejects.toThrow("membership conflict retry limit exceeded");
    expect(s.ledger.size).toBe(0);
  });
});

function assertSafeBoundaryFailure(failure: unknown, originalName: string, originalMessage: string): void {
  expect(failure).toBeInstanceOf(Error);
  const error = failure as Error;
  expect(error.name).toBe("SafeHandlerError");
  expect(error.message).toBe("Cloud handler invocation failed");
  expect(Object.getOwnPropertyNames(error).sort()).toEqual(["message", "name", "stack"].sort());
  expect(error).not.toHaveProperty("cause");
  expect(error.name).not.toBe(originalName);
  expect(error.message).not.toContain(originalMessage);
  expect(JSON.stringify(error)).not.toContain(originalMessage);
}

describe("exported handler boundary", () => {
  it("does not grant pure parser fixtures AWS or fetched-body capabilities", () => {
    const parsed = parseAndValidateSuppressionObject({
      descriptor: { bucket: "fixture", key: "private-person.ndjson", versionId: "secret-token", etag: "b".repeat(32), lastModified: NOW.toISOString() },
      text: bodyFor("a"),
    });
    expect(parsed).not.toHaveProperty("logMetadata");
  });
  it("exports no fabricated-response issuer or reusable invalid-log policy consumer", async () => {
    expect(suppressionObjects).not.toHaveProperty("listSuppressionObjectsFromS3");
    expect(suppressionObjects).not.toHaveProperty("readValidatedSuppressionObjectFromS3");
    expect(suppressionObjects).not.toHaveProperty("suppressionLogPolicy");
    expect(suppressionObjects).not.toHaveProperty("suppressionObjectLogReaders");
    expect(suppressionObjects).not.toHaveProperty("logSuppressionObjectDiagnostic");
    expect(Object.keys(productionSuppressionObjectSource).sort()).toEqual(["list", "read"]);
    await expect(productionSuppressionObjectSource.read({
      bucket: "caller-controlled",
      key: "private-person.ndjson",
      versionId: "secret-token",
      etag: "b".repeat(32),
      lastModified: NOW.toISOString(),
    })).rejects.toThrow("suppression object was not issued by the production list source");
  });
  it.each([
    { mode: "incremental" as const, level: "error", event: { mode: "incremental" } },
    { mode: "replay" as const, level: "warn", event: { mode: "replay", dryRun: true } },
  ])("atomically owns the full production $mode diagnostic before wrappers see failure", async ({ level, event }) => {
    const key = `${UPLOADS_PREFIX}private-person.ndjson`;
    const versionId = "production-version";
    const etag = "production-etag";
    const body = "private@example.test";
    productionS3Send.mockImplementation(async (command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (name === "ListObjectVersionsCommand") return { Versions: [{ Key: key, VersionId: versionId, ETag: etag, LastModified: NOW }], IsTruncated: false };
      if (name === "GetObjectCommand") return { Body: { transformToString: async () => body } };
      throw new Error(`unexpected production command ${name}`);
    });
    const base = productionSuppressionObjectSource;
    const wrappedSource = {
      list: (...args: Parameters<typeof base.list>) => base.list(...args),
      read: async (...args: Parameters<typeof base.read>) => {
        try { return await base.read(...args); }
        catch (error) {
          expect(error).toBeInstanceOf(SuppressionObjectValidationError);
          expect(error).not.toHaveProperty("logMetadata");
          const failure = error as SuppressionObjectValidationError;
          return parseAndValidateSuppressionObject({
            descriptor: { bucket: "inbox", key: failure.key, versionId: failure.versionId, etag, lastModified: NOW.toISOString() },
            text: bodyFor("a"),
          });
        }
      },
    };
    const deps = fakeDeps(state());
    deps.objectSource = wrappedSource;
    const output: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    try {
      await runHandler(deps, event);
    } finally {
      consoleSpy.mockRestore();
      productionS3Send.mockReset();
    }
    const invalid = output.map((line) => JSON.parse(line) as Record<string, unknown>).filter((record) => record.eventCode === "SUPPRESSION_OBJECT_INVALID");
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toMatchObject({ level, objectKey: key, objectVersionId: versionId, objectEtag: etag, objectChecksumSha256: sha256(body), invalidLineNumbers: [1], invalidLineCount: 1 });
    expect(output.join("\n")).not.toContain(body);
  });
  it("includes dependency initialization, rounds fractional duration, and excludes warm idle", async () => {
    const object = objectVersion({ body: bodyFor("a") });
    const deps = fakeDeps(state([object]));
    const output: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    let now = 100;
    let initialized = false;
    const invocation = createHandler(() => { if (!initialized) { initialized = true; now += 5.6; } return deps; }, () => now);
    try { await invocation({ mode: "incremental" }); now = 10_000; await invocation({ mode: "incremental" }); } finally { consoleSpy.mockRestore(); }
    const completions = output.map((line) => JSON.parse(line) as Record<string, unknown>).filter((record) => record.eventCode === "SCHEDULED_RUN_COMPLETED");
    expect(completions).toHaveLength(2);
    expect(completions.map((record) => ({ durationMs: record.durationMs, count: record.count, unprocessedCount: record.unprocessedCount }))).toEqual([
      { durationMs: 6, count: 1, unprocessedCount: 0 },
      { durationMs: 0, count: 0, unprocessedCount: 0 },
    ]);
    expect(output.join("\n")).not.toContain("a".repeat(64));
    for (const record of completions) expect(Object.keys(record).sort()).toEqual(["component", "count", "durationMs", "eventCode", "level", "unprocessedCount"].sort());
  });
  it("does not mint production metadata from fake S3 responses and safely finalizes parser failure", async () => {
    const contactHmac = "0123456789abcdef".repeat(4);
    const object = objectVersion({ body: JSON.stringify({ ...VALID_LINE, contact_hmac: contactHmac, email: "private@example.test" }) });
    const output: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    const invocation = createHandler(() => fakeDeps(state([object])), () => 20);
    try { const failure = await invocation({ mode: "incremental" }).then(() => undefined, (error) => error);
      assertSafeBoundaryFailure(failure, "SuppressionObjectValidationError", "invalid suppression object lines"); } finally { consoleSpy.mockRestore(); }
    const records = output.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.filter((record) => record.eventCode === "SCHEDULED_RUN_COMPLETED")).toHaveLength(1);
    const invalid = records.find((record) => record.eventCode === "SUPPRESSION_OBJECT_INVALID")!;
    expect(invalid).toMatchObject({ invalidLineNumbers: [1], invalidLineCount: 1 });
    expect(invalid).not.toHaveProperty("objectKey");
    expect(invalid).not.toHaveProperty("objectVersionId");
    expect(invalid).not.toHaveProperty("objectEtag");
    expect(invalid).not.toHaveProperty("objectChecksumSha256");
    const serialized = output.find((line) => line.includes("SCHEDULED_RUN_COMPLETED"))!;
    expect(JSON.parse(serialized)).toMatchObject({ count: 0, unprocessedCount: 0, durationMs: 0 });
    expect(serialized).not.toContain("private@example.test");
    expect(output.join("\n")).not.toContain(contactHmac);
    expect(output.join("\n")).not.toContain("private@example.test");
  });
  it("maps replay and reconcile success reports to nonzero completion aggregates", async () => {
    const s = state([
      objectVersion({ key: `${UPLOADS_PREFIX}valid-a.ndjson`, versionId: "valid-a", body: bodyFor("a") }),
      objectVersion({ key: `${UPLOADS_PREFIX}valid-b.ndjson`, versionId: "valid-b", body: bodyFor("b") }),
      objectVersion({ key: `${UPLOADS_PREFIX}invalid.ndjson`, versionId: "invalid", body: "private@example.test" }),
    ]);
    const output: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    const invocation = createHandler(() => fakeDeps(s), () => 50);
    let replay: Awaited<ReturnType<typeof invocation>>;
    try {
      replay = await invocation({ mode: "replay", dryRun: true });
      const replayCompletions = output.map((line) => JSON.parse(line) as Record<string, unknown>).filter((record) => record.eventCode === "SCHEDULED_RUN_COMPLETED");
      expect(replayCompletions).toHaveLength(1);
      expect(replayCompletions[0]).toMatchObject({ count: 2, unprocessedCount: 1 });
      expect(output.join("\n")).not.toContain("private@example.test");
      output.length = 0;
      s.objects = s.objects.filter((object) => object.versionId !== "invalid");
      await invocation({ mode: "reconcile", reportKey: (replay as SuppressionReplayResult).reportKey });
      const reconcileCompletions = output.map((line) => JSON.parse(line) as Record<string, unknown>).filter((record) => record.eventCode === "SCHEDULED_RUN_COMPLETED");
      expect(reconcileCompletions).toHaveLength(1);
      expect(reconcileCompletions[0]).toMatchObject({ count: 2, unprocessedCount: 2 });
      expect(output.join("\n")).not.toContain("private@example.test");
    } finally { consoleSpy.mockRestore(); }
  });
});
