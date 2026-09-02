import { describe, expect, it } from "vitest";
import { runHandler, UPLOADS_PREFIX, type HandlerDeps } from "../src/handler";

const NOW = new Date("2026-09-02T12:00:00.000Z");

const VALID_LINE = {
  contact_hmac: "a".repeat(64),
  kind: "phone",
  reason: "opt_out",
  observed_at: "2026-09-02T11:00:00.000Z",
};

interface FakeState {
  files: Record<string, string>;
  ledger: Set<string>;
  suppressions: Map<string, Record<string, { S: string }>>;
}

function fakeDeps(state: FakeState): HandlerDeps {
  return {
    s3: {
      send: async (command: unknown) => {
        const name = (command as { constructor: { name: string } }).constructor.name;
        const input = (command as { input: Record<string, unknown> }).input;
        if (name === "ListObjectsV2Command") {
          const prefix = input.Prefix as string;
          return {
            Contents: Object.keys(state.files)
              .filter((k) => k.startsWith(prefix))
              .map((Key) => ({ Key })),
            IsTruncated: false,
          };
        }
        if (name === "GetObjectCommand") {
          const key = input.Key as string;
          const text = state.files[key] ?? "";
          return { Body: { transformToString: async () => text } };
        }
        throw new Error(`unexpected s3 command ${name}`);
      },
    } as HandlerDeps["s3"],
    dynamo: {
      send: async (command: unknown) => {
        const name = (command as { constructor: { name: string } }).constructor.name;
        const input = (command as { input: Record<string, unknown> }).input;
        if (name === "GetItemCommand") {
          const key = (input.Key as Record<string, { S: string }>).source_natural_key?.S ?? "";
          return state.ledger.has(key) ? { Item: {} } : {};
        }
        if (name === "PutItemCommand") {
          const item = input.Item as Record<string, { S: string }>;
          if (input.TableName === "suppression") {
            state.suppressions.set(item.contact_hash?.S ?? "", item);
          } else {
            state.ledger.add(item.source_natural_key?.S ?? "");
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

function state(files: Record<string, string> = {}): FakeState {
  return { files, ledger: new Set(), suppressions: new Map() };
}

describe("suppression-sync handler", () => {
  it("writes each valid line to the suppression table keyed by hash", async () => {
    const s = state({
      [`${UPLOADS_PREFIX}2026-09-02.ndjson`]: `${JSON.stringify(VALID_LINE)}\n`,
    });
    const result = await runHandler(fakeDeps(s));
    expect(result.linesWritten).toBe(1);
    expect(result.filesProcessed).toBe(1);
    const row = s.suppressions.get("a".repeat(64));
    if (row === undefined) throw new Error("row missing");
    expect(row.kind?.S).toBe("phone");
    expect(row.reason?.S).toBe("opt_out");
    expect(row.synced_at?.S).toBe(NOW.toISOString());
  });

  it("skips files already in the ledger and marks new files done", async () => {
    const s = state({
      [`${UPLOADS_PREFIX}old.ndjson`]: `${JSON.stringify(VALID_LINE)}\n`,
      [`${UPLOADS_PREFIX}new.ndjson`]: `${JSON.stringify({ ...VALID_LINE, contact_hmac: "b".repeat(64) })}\n`,
    });
    s.ledger.add(`suppression-sync:${UPLOADS_PREFIX}old.ndjson`);
    const result = await runHandler(fakeDeps(s));
    expect(result.filesSkipped).toBe(1);
    expect(result.filesProcessed).toBe(1);
    expect(result.linesWritten).toBe(1);
    expect(s.suppressions.has("b".repeat(64))).toBe(true);
    expect(s.suppressions.has("a".repeat(64))).toBe(false);
    expect(s.ledger.has(`suppression-sync:${UPLOADS_PREFIX}new.ndjson`)).toBe(true);
  });

  it("counts invalid lines without writing them and still completes the file", async () => {
    const bad = [
      JSON.stringify({ ...VALID_LINE, contact_hmac: "TOO SHORT" }),
      JSON.stringify({ ...VALID_LINE, reason: "free text!" }),
      "not json at all",
      JSON.stringify({ ...VALID_LINE, name: "Jane Doe" }), // strict: unknown key
      JSON.stringify({ ...VALID_LINE, contact_hmac: "c".repeat(64) }),
    ].join("\n");
    const s = state({ [`${UPLOADS_PREFIX}mixed.ndjson`]: bad });
    const result = await runHandler(fakeDeps(s));
    expect(result.invalidLines).toBe(4);
    expect(result.linesWritten).toBe(1);
    expect(s.suppressions.has("c".repeat(64))).toBe(true);
    expect(s.suppressions.size).toBe(1);
  });

  it("rerun is idempotent: processed files are not rewritten", async () => {
    const s = state({
      [`${UPLOADS_PREFIX}2026-09-02.ndjson`]: `${JSON.stringify(VALID_LINE)}\n`,
    });
    const deps = fakeDeps(s);
    await runHandler(deps);
    const second = await runHandler(deps);
    expect(second.filesSkipped).toBe(1);
    expect(second.linesWritten).toBe(0);
  });

  it("maxFiles bounds work for live testing", async () => {
    const s = state({
      [`${UPLOADS_PREFIX}a.ndjson`]: `${JSON.stringify(VALID_LINE)}\n`,
      [`${UPLOADS_PREFIX}b.ndjson`]: `${JSON.stringify(VALID_LINE)}\n`,
    });
    const result = await runHandler(fakeDeps(s), { maxFiles: 1 });
    expect(result.filesSeen).toBe(1);
    expect(result.filesProcessed).toBe(1);
  });
});
