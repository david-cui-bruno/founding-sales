import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { runHandler, UPLOADS_PREFIX, type HandlerDeps } from "../src/handler";
import { SuppressionObjectValidationError } from "../src/suppressionObject";

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
  listPageSize: number;
  failOnSuppressionHash?: string;
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
          const versionId = (input.VersionId as string | undefined) ?? null;
          const object = s.objects.find(
            (candidate) => candidate.key === key && candidate.versionId === versionId,
          );
          if (!object) throw new Error(`missing fake object ${key} ${String(versionId)}`);
          return { Body: { transformToString: async () => object.body } };
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
            s.suppressions.set(hash, item);
          } else if (tableName === "snapshots") {
            s.ledger.set(readS(item, "source_natural_key") ?? "", item);
          } else {
            throw new Error(`unexpected table ${tableName}`);
          }
          return {};
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

  it("reports exact invalid line numbers without logging contact data", async () => {
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
      await expect(runHandler(fakeDeps(s))).rejects.toBeInstanceOf(
        SuppressionObjectValidationError,
      );
    } finally {
      logSpy.mockRestore();
    }

    expect(output).toHaveLength(1);
    const logged = JSON.parse(output[0]!) as Record<string, unknown>;
    expect(logged).toMatchObject({
      level: "error",
      msg: "suppression_object_invalid",
      key: object.key,
      version_id: object.versionId,
      invalid_line_numbers: [3, 5],
      invalid_line_count: 2,
    });
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
    ).toHaveLength(2);
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

  it("maxFiles bounds object versions for live testing", async () => {
    const s = state([
      objectVersion({ key: `${UPLOADS_PREFIX}a.ndjson`, body: bodyFor("a") }),
      objectVersion({ key: `${UPLOADS_PREFIX}b.ndjson`, body: bodyFor("b") }),
    ]);

    const result = await runHandler(fakeDeps(s), { maxFiles: 1 });

    expect(result.filesSeen).toBe(1);
    expect(result.filesProcessed).toBe(1);
  });
});
