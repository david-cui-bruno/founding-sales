import { describe, expect, it, vi } from "vitest";
import { createHandler, CURSOR_KEY, handlerWithDeps, type HandlerDeps } from "../src/handler";
import {
  ROW_COMMERCIAL,
  ROW_SINGLE_FAMILY_OWNER_OCC,
  ROW_TWO_FAMILY_LLP_ABSENTEE,
  ROW_TWO_FAMILY_OWNER_OCC,
} from "./fixtures";
import type { TaxRollRow } from "../src/taxroll";

const ENV = {
  INBOX_BUCKET: "inbox",
  IDEMPOTENCY_TABLE: "idem",
  SNAPSHOTS_TABLE: "snaps",
  MAX_RUNTIME_MS: 840000,
};

interface FakeState {
  /** snapshots table: naturalKey -> latest fingerprint */
  snapshots: Map<string, string>;
  cursorOffset: number | null;
  claimedIdempotencyKeys: Set<string>;
  s3Writes: Array<{ Key: string; Body: string }>;
  snapshotPuts: Array<Record<string, unknown>>;
  cursorWrites: number[];
}

function fakeDeps(pages: TaxRollRow[][], state?: Partial<FakeState>): {
  deps: HandlerDeps;
  state: FakeState;
} {
  const full: FakeState = {
    snapshots: new Map(),
    cursorOffset: null,
    claimedIdempotencyKeys: new Set(),
    s3Writes: [],
    snapshotPuts: [],
    cursorWrites: [],
    ...state,
  };

  // Flatten pages into an offset-addressable array to emulate Socrata paging.
  const allRows = pages.flat();

  const dynamo = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async send(command: any): Promise<any> {
      const name = command.constructor.name;
      const input = command.input;
      if (name === "GetItemCommand") {
        // Cursor read
        if (full.cursorOffset === null) return {};
        return { Item: { cursor_offset: { N: String(full.cursorOffset) } } };
      }
      if (name === "QueryCommand") {
        const key = input.ExpressionAttributeValues[":pk"].S as string;
        const fingerprint = full.snapshots.get(key);
        return {
          Items: fingerprint
            ? [{ content_fingerprint: { S: fingerprint } }]
            : [],
        };
      }
      if (name === "PutItemCommand") {
        if (input.TableName === ENV.SNAPSHOTS_TABLE) {
          const key = input.Item.source_natural_key.S as string;
          if (key === CURSOR_KEY) {
            full.cursorOffset = Number(input.Item.cursor_offset.N);
            full.cursorWrites.push(full.cursorOffset);
          } else {
            full.snapshots.set(key, input.Item.content_fingerprint.S as string);
            full.snapshotPuts.push(input);
          }
          return {};
        }
        // Idempotency table conditional put
        const key = input.Item.idempotency_key.S as string;
        if (full.claimedIdempotencyKeys.has(key)) {
          const error = new Error("conditional failed");
          error.name = "ConditionalCheckFailedException";
          throw error;
        }
        full.claimedIdempotencyKeys.add(key);
        return {};
      }
      throw new Error(`unexpected command ${name}`);
    },
  };

  const s3 = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async send(command: any): Promise<any> {
      full.s3Writes.push(command.input);
      return {};
    },
  };

  const fetchImpl = (async (url: string | URL) => {
    const params = new URL(String(url)).searchParams;
    const offset = Number(params.get("$offset") ?? "0");
    const limit = Number(params.get("$limit") ?? "1000");
    const slice = allRows.slice(offset, offset + limit);
    return {
      ok: true,
      status: 200,
      json: async () => slice,
    } as unknown as Response;
  }) as typeof fetch;

  return {
    deps: { s3, dynamo, fetchImpl, env: { ...ENV }, now: () => new Date("2026-09-01T03:00:00.000Z") },
    state: full,
  };
}

describe("handlerWithDeps", () => {
  it("filters, snapshots, and writes one ndjson file of new rows", async () => {
    const { deps, state } = fakeDeps([
      [
        ROW_TWO_FAMILY_OWNER_OCC,
        ROW_TWO_FAMILY_LLP_ABSENTEE,
        ROW_SINGLE_FAMILY_OWNER_OCC, // filtered: owner-occupied SFH
        ROW_COMMERCIAL, // filtered: class 6
      ],
    ]);
    const result = await handlerWithDeps(null, deps);

    expect(result.fetched).toBe(4);
    expect(result.retained).toBe(2);
    expect(result.new).toBe(2);
    expect(result.written).toBe(2);
    expect(result.completed).toBe(true);
    expect(state.s3Writes).toHaveLength(1);
    expect(state.s3Writes[0]!.Key).toMatch(/^events\/2026-09-01\/pvd-taxroll-.+\.ndjson$/);
    const lines = state.s3Writes[0]!.Body.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const event = JSON.parse(line);
      expect(event.channel).toBe("parcel");
      expect(event.trigger).toBe(null);
    }
  });

  it("skips unchanged rows on the second pass (snapshot diff)", async () => {
    const rows = [[ROW_TWO_FAMILY_OWNER_OCC, ROW_TWO_FAMILY_LLP_ABSENTEE]];
    const first = fakeDeps(rows);
    await handlerWithDeps(null, first.deps);

    // Second run against the same snapshot state, fresh idempotency table.
    const second = fakeDeps(rows, {
      snapshots: first.state.snapshots,
    });
    const result = await handlerWithDeps(null, second.deps);
    expect(result.retained).toBe(2);
    expect(result.unchanged).toBe(2);
    expect(result.new).toBe(0);
    expect(result.written).toBe(0);
    expect(second.state.s3Writes).toHaveLength(0);
  });

  it("re-emits when a row changed (owner change)", async () => {
    const first = fakeDeps([[ROW_TWO_FAMILY_OWNER_OCC]]);
    await handlerWithDeps(null, first.deps);

    const sold = { ...ROW_TWO_FAMILY_OWNER_OCC, first_name: "New", last_name: "Owner" };
    const second = fakeDeps([[sold]], { snapshots: first.state.snapshots });
    const result = await handlerWithDeps(null, second.deps);
    expect(result.changed).toBe(1);
    expect(result.written).toBe(1);
  });

  it("honors maxRows for bounded test runs and skips cursor writes", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      ...ROW_TWO_FAMILY_OWNER_OCC,
      p_id: String(1000 + i),
    }));
    const { deps, state } = fakeDeps([many]);
    const result = await handlerWithDeps({ maxRows: 3 }, deps);
    expect(result.fetched).toBe(3);
    expect(state.cursorWrites).toHaveLength(0);
  });

  it("persists a cursor when the time budget is exhausted", async () => {
    const pageA = Array.from({ length: 1000 }, (_, i) => ({
      ...ROW_TWO_FAMILY_OWNER_OCC,
      p_id: String(2000 + i),
    }));
    const pageB = [{ ...ROW_TWO_FAMILY_OWNER_OCC, p_id: "9000" }];
    const { deps, state } = fakeDeps([pageA, pageB]);
    // Clock advances past the budget after the first page.
    let calls = 0;
    deps.now = () => new Date(calls++ < 1 ? 0 : ENV.MAX_RUNTIME_MS + 1);
    deps.env.MAX_RUNTIME_MS = 1;

    const result = await handlerWithDeps(null, deps);
    expect(result.completed).toBe(false);
    expect(result.resumeOffset).toBe(1000);
    expect(state.cursorOffset).toBe(1000);
  });

  it("resumes from a persisted cursor and resets it on completion", async () => {
    const pageA = Array.from({ length: 1000 }, (_, i) => ({
      ...ROW_TWO_FAMILY_OWNER_OCC,
      p_id: String(3000 + i),
    }));
    const pageB = [{ ...ROW_TWO_FAMILY_OWNER_OCC, p_id: "9001" }];
    const { deps, state } = fakeDeps([pageA, pageB], { cursorOffset: 1000 });

    const result = await handlerWithDeps(null, deps);
    // Resumed at offset 1000: only pageB's single row is fetched.
    expect(result.fetched).toBe(1);
    expect(result.completed).toBe(true);
    // Cursor reset for the next full pass.
    expect(state.cursorOffset).toBe(0);
  });

  it("skips events already claimed in the idempotency table", async () => {
    const first = fakeDeps([[ROW_TWO_FAMILY_OWNER_OCC]]);
    await handlerWithDeps(null, first.deps);

    // Same idempotency table, empty snapshots (row appears 'new' again).
    const second = fakeDeps([[ROW_TWO_FAMILY_OWNER_OCC]], {
      claimedIdempotencyKeys: first.state.claimedIdempotencyKeys,
    });
    const result = await handlerWithDeps(null, second.deps);
    expect(result.new).toBe(1);
    expect(result.idempotencySkips).toBe(1);
    expect(result.written).toBe(0);
  });

  it("throws on a failed Socrata fetch", async () => {
    const { deps } = fakeDeps([[]]);
    deps.fetchImpl = (async () =>
      ({ ok: false, status: 500 }) as unknown as Response) as typeof fetch;
    await expect(handlerWithDeps(null, deps)).rejects.toThrow(/HTTP 500/);
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
  it("includes dependency initialization, rounds fractional duration, and excludes warm idle", async () => {
    const pii = "private@example.test";
    const { deps } = fakeDeps([[{ ...ROW_TWO_FAMILY_OWNER_OCC, first_name: pii }]]);
    const output: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    const times = [100, 102.4, 105.6, 10_000, 10_007.4];
    let cold = true;
    const invocation = createHandler(() => { if (cold) { cold = false; times.shift(); } return deps; }, () => times.shift()!);
    try {
      await invocation(null);
      await invocation(null);
    } finally {
      consoleSpy.mockRestore();
    }
    const completions = output.map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.eventCode === "SCHEDULED_RUN_COMPLETED");
    expect(completions).toHaveLength(2);
    expect(completions.map((record) => ({ durationMs: record.durationMs, count: record.count, unprocessedCount: record.unprocessedCount }))).toEqual([
      { durationMs: 6, count: 1, unprocessedCount: 0 },
      { durationMs: 7, count: 0, unprocessedCount: 0 },
    ]);
    expect(output.join("\n")).not.toContain(pii);
    for (const record of completions) {
      expect(Object.keys(record).sort()).toEqual(["component", "count", "durationMs", "eventCode", "level", "unprocessedCount"].sort());
    }
  });

  it("finalizes failures with safe defaults and rejects only the fixed safe error", async () => {
    const output: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    const { deps } = fakeDeps([[]]);
    deps.fetchImpl = (async () => { throw Object.assign(new Error("private@example.test provider payload secret-token"), { name: "PrivateProviderError", privatePayload: "must-not-escape" }); }) as typeof fetch;
    const invocation = createHandler(() => deps, () => 20);
    try {
      const failure = await invocation(null).then(() => undefined, (error) => error);
      assertSafeBoundaryFailure(failure, "PrivateProviderError", "private@example.test provider payload secret-token");
    } finally {
      consoleSpy.mockRestore();
    }
    const completionLines = output.filter((line) => line.includes("SCHEDULED_RUN_COMPLETED"));
    expect(completionLines).toHaveLength(1);
    const serialized = completionLines[0]!;
    expect(JSON.parse(serialized)).toMatchObject({ count: 0, unprocessedCount: 0, durationMs: 0 });
    expect(output.join("\n")).not.toContain("private@example.test");
    expect(output.join("\n")).not.toContain("secret-token");
  });
});
