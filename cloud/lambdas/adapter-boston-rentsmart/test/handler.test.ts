import { describe, expect, it, vi } from "vitest";
import { createHandler, handlerWithDeps, WATERMARK_KEY, type HandlerDeps } from "../src/handler";
import {
  ROW_ENFORCEMENT_VIOLATION,
  ROW_HOUSING_COMPLAINT,
  ROW_LLC_VIOLATION,
  ROW_SANITATION_REQUEST,
} from "./fixtures";
import type { RentSmartRow } from "../src/rentsmart";

const ENV = {
  INBOX_BUCKET: "inbox",
  IDEMPOTENCY_TABLE: "idem",
  SNAPSHOTS_TABLE: "snaps",
  MAX_RUNTIME_MS: 840000,
};

interface FakeState {
  snapshots: Map<string, string>;
  watermark: string | null;
  claimedIdempotencyKeys: Set<string>;
  s3Writes: Array<{ Key: string; Body: string }>;
  watermarkWrites: string[];
  sqlQueries: string[];
}

function fakeDeps(rows: RentSmartRow[], state?: Partial<FakeState>): {
  deps: HandlerDeps;
  state: FakeState;
} {
  const full: FakeState = {
    snapshots: new Map(),
    watermark: null,
    claimedIdempotencyKeys: new Set(),
    s3Writes: [],
    watermarkWrites: [],
    sqlQueries: [],
    ...state,
  };

  const dynamo = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async send(command: any): Promise<any> {
      const name = command.constructor.name;
      const input = command.input;
      if (name === "GetItemCommand") {
        if (full.watermark === null) return {};
        return { Item: { watermark_date: { S: full.watermark } } };
      }
      if (name === "QueryCommand") {
        const key = input.ExpressionAttributeValues[":pk"].S as string;
        const fingerprint = full.snapshots.get(key);
        return {
          Items: fingerprint ? [{ content_fingerprint: { S: fingerprint } }] : [],
        };
      }
      if (name === "PutItemCommand") {
        if (input.TableName === ENV.SNAPSHOTS_TABLE) {
          const key = input.Item.source_natural_key.S as string;
          if (key === WATERMARK_KEY) {
            full.watermark = input.Item.watermark_date.S as string;
            full.watermarkWrites.push(full.watermark);
          } else {
            full.snapshots.set(key, input.Item.content_fingerprint.S as string);
          }
          return {};
        }
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
    const sql = new URL(String(url)).searchParams.get("sql") ?? "";
    full.sqlQueries.push(sql);
    const offsetMatch = sql.match(/OFFSET (\d+)/);
    const limitMatch = sql.match(/LIMIT (\d+)/);
    const sinceMatch = sql.match(/"date" >= '(\d{4}-\d{2}-\d{2})'/);
    const since = sinceMatch?.[1] ?? "0000-00-00";
    const offset = Number(offsetMatch?.[1] ?? "0");
    const limit = Number(limitMatch?.[1] ?? "1000");
    const filtered = rows
      .filter((row) => (row.date ?? "") >= since)
      .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a._id - b._id);
    const slice = filtered.slice(offset, offset + limit);
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { records: slice } }),
    } as unknown as Response;
  }) as typeof fetch;

  return {
    deps: {
      s3,
      dynamo,
      fetchImpl,
      env: { ...ENV },
      now: () => new Date("2026-09-01T03:00:00.000Z"),
    },
    state: full,
  };
}

const ALL_ROWS = [
  ROW_SANITATION_REQUEST,
  ROW_HOUSING_COMPLAINT,
  ROW_ENFORCEMENT_VIOLATION,
  ROW_LLC_VIOLATION,
];

describe("handlerWithDeps", () => {
  it("emits new rows: violations with triggers, complaints as identity events", async () => {
    const { deps, state } = fakeDeps(ALL_ROWS);
    const result = await handlerWithDeps(null, deps);

    expect(result.fetched).toBe(4);
    expect(result.new).toBe(4);
    expect(result.written).toBe(4);
    expect(result.triggers).toBe(2); // two Enforcement Violations
    expect(result.identityOnly).toBe(2); // complaint + sanitation request
    expect(state.s3Writes).toHaveLength(1);
    expect(state.s3Writes[0]!.Key).toMatch(
      /^events\/2026-09-01\/boston-rentsmart-.+\.ndjson$/,
    );
    const lines = state.s3Writes[0]!.Body.trimEnd().split("\n");
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(JSON.parse(line).channel).toBe("violation");
    }
  });

  it("uses the 7-day lookback on first run, the stored watermark after", async () => {
    const first = fakeDeps(ALL_ROWS);
    await handlerWithDeps(null, first.deps);
    expect(first.state.sqlQueries[0]).toContain(`"date" >= '2026-08-25'`); // 7d before 2026-09-01
    // Watermark advanced to the last processed row's date.
    expect(first.state.watermark).toBe("2026-08-29");

    const second = fakeDeps(ALL_ROWS, {
      watermark: first.state.watermark,
      snapshots: first.state.snapshots,
    });
    const result = await handlerWithDeps(null, second.deps);
    expect(second.state.sqlQueries[0]).toContain(`"date" >= '2026-08-29'`);
    // Only the two 08-29 rows are in the window, both unchanged.
    expect(result.fetched).toBe(2);
    expect(result.unchanged).toBe(2);
    expect(result.written).toBe(0);
    expect(second.state.s3Writes).toHaveLength(0);
  });

  it("re-emits a changed row inside the window", async () => {
    const first = fakeDeps(ALL_ROWS);
    await handlerWithDeps(null, first.deps);

    const changed = ALL_ROWS.map((row) =>
      row._id === ROW_SANITATION_REQUEST._id ? { ...row, owner: "NEW OWNER LLC" } : row,
    );
    const second = fakeDeps(changed, {
      watermark: "2026-08-28",
      snapshots: first.state.snapshots,
    });
    const result = await handlerWithDeps(null, second.deps);
    expect(result.changed).toBe(1);
    expect(result.written).toBe(1);
  });

  it("honors maxRows and skips watermark writes in bounded runs", async () => {
    const { deps, state } = fakeDeps(ALL_ROWS);
    const result = await handlerWithDeps({ maxRows: 2 }, deps);
    expect(result.fetched).toBe(2);
    expect(state.watermarkWrites).toHaveLength(0);
    // maxRows also skips the watermark read: full 7-day lookback.
    expect(state.sqlQueries[0]).toContain(`"date" >= '2026-08-25'`);
  });

  it("skips already-claimed idempotency keys", async () => {
    const first = fakeDeps(ALL_ROWS);
    await handlerWithDeps(null, first.deps);

    const second = fakeDeps(ALL_ROWS, {
      claimedIdempotencyKeys: first.state.claimedIdempotencyKeys,
    });
    const result = await handlerWithDeps(null, second.deps);
    expect(result.new).toBe(4);
    expect(result.idempotencySkips).toBe(4);
    expect(result.written).toBe(0);
  });

  it("throws on CKAN HTTP and API errors", async () => {
    const { deps } = fakeDeps([]);
    deps.fetchImpl = (async () =>
      ({ ok: false, status: 503 }) as unknown as Response) as typeof fetch;
    await expect(handlerWithDeps(null, deps)).rejects.toThrow(/HTTP 503/);

    deps.fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ success: false, error: { message: "bad sql" } }),
      }) as unknown as Response) as typeof fetch;
    await expect(handlerWithDeps(null, deps)).rejects.toThrow(/datastore_search_sql error/);
  });
});

describe("exported handler boundary", () => {
  it("includes dependency initialization, rounds fractional duration, and excludes warm idle", async () => {
    const { deps } = fakeDeps([]);
    const output: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    const times = [100, 105.6, 10_000, 10_007.4];
    const invocation = createHandler(() => deps, () => times.shift()!);
    try {
      await invocation(null);
      await invocation(null);
    } finally {
      consoleSpy.mockRestore();
    }
    const completions = output.map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.eventCode === "SCHEDULED_RUN_COMPLETED");
    expect(completions).toHaveLength(2);
    expect(completions.map((record) => record.durationMs)).toEqual([6, 7]);
    for (const record of completions) {
      expect(Object.keys(record).sort()).toEqual(["component", "count", "durationMs", "eventCode", "level", "unprocessedCount"].sort());
    }
  });

  it("finalizes failures with safe defaults and rejects only the fixed safe error", async () => {
    const output: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    const invocation = createHandler(() => { throw new Error("private@example.test provider payload secret-token"); }, () => 20);
    try {
      await expect(invocation(null)).rejects.toMatchObject({
        name: "SafeHandlerError",
        message: "Cloud handler invocation failed",
      });
    } finally {
      consoleSpy.mockRestore();
    }
    const serialized = output.find((line) => line.includes("SCHEDULED_RUN_COMPLETED"))!;
    expect(JSON.parse(serialized)).toMatchObject({ count: 0, unprocessedCount: 0, durationMs: 0 });
    expect(serialized).not.toContain("private@example.test");
    expect(serialized).not.toContain("secret-token");
  });
});
