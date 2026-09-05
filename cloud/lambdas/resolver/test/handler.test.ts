import { describe, expect, it, vi } from "vitest";
import { createHandler, handlerWithDeps, runResolver, type HandlerDeps } from "../src/handler";
import { fromItem } from "../src/entitiesTable";
import { ceId, parcelEvent, NOW } from "./fixtures";
import type { CloudSourceEvent } from "@callie-sourcing/shared";

// ---------------------------------------------------------------------------
// DI fakes
// ---------------------------------------------------------------------------

interface FakeState {
  objects: Map<string, string>; // s3 key -> ndjson body
  entities: Map<string, Record<string, any>>; // entity_id -> item
  queries: Array<{ indexName: string; name: string }>;
}

function fakeDeps(state: FakeState): HandlerDeps {
  return {
    s3: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      send: (async (command: any) => {
        const name = command.constructor.name;
        if (name === "ListObjectsV2Command") {
          const prefix: string = command.input.Prefix;
          const keys = [...state.objects.keys()].filter((k) => k.startsWith(prefix));
          return { Contents: keys.map((Key) => ({ Key })), IsTruncated: false };
        }
        if (name === "GetObjectCommand") {
          const body = state.objects.get(command.input.Key);
          if (body === undefined) throw new Error(`NoSuchKey: ${command.input.Key}`);
          return { Body: { transformToString: async () => body } };
        }
        throw new Error(`unexpected s3 command ${name}`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    },
    dynamo: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      send: (async (command: any) => {
        const name = command.constructor.name;
        if (name === "QueryCommand") {
          const queried: string = command.input.ExpressionAttributeValues[":name"].S;
          state.queries.push({ indexName: command.input.IndexName, name: queried });
          const items = [...state.entities.values()].filter(
            (item) => item.normalized_name.S === queried,
          );
          return { Items: items };
        }
        if (name === "PutItemCommand") {
          state.entities.set(command.input.Item.entity_id.S, command.input.Item);
          return {};
        }
        throw new Error(`unexpected dynamo command ${name}`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    },
    env: { INBOX_BUCKET: "inbox", ENTITIES_TABLE: "entities" },
    now: () => NOW,
  };
}

function ndjson(...events: CloudSourceEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

function stateWith(files: Record<string, string>): FakeState {
  return { objects: new Map(Object.entries(files)), entities: new Map(), queries: [] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runResolver", () => {
  it("resolves person events into entities-table items", async () => {
    const state = stateWith({
      "events/2026-09-01/pvd-taxroll-01AAAAAAAAAAAAAAAAAAAAAAAA.ndjson": ndjson(
        parcelEvent({ cloudEntityId: ceId(1), fullName: "SMITH, JOHN", parcelId: "P-1" }),
        parcelEvent({ cloudEntityId: ceId(2), fullName: "JOHN SMITH", parcelId: "P-2" }),
        parcelEvent({ cloudEntityId: ceId(3), fullName: "JANE ROE", parcelId: "P-9" }),
      ),
    });
    const result = await runResolver(null, fakeDeps(state));

    expect(result.filesRead).toBe(1);
    expect(result.eventsSeen).toBe(3);
    expect(result.personEvents).toBe(3);
    expect(result.entitiesResolved).toBe(2);
    expect(result.entitiesCreated).toBe(2);
    expect(result.multiParcelEntities).toBe(1);

    const smith = fromItem(state.entities.get(ceId(1))!)!;
    expect(smith.normalizedName).toBe("JOHN SMITH");
    expect(smith.memberCloudEntityIds).toEqual([ceId(1), ceId(2)]);
    expect(smith.parcelCount).toBe(2);
    expect(smith.doorsEstimate).toBe(2);
    expect(state.queries.every((q) => q.indexName === "normalized_name-index")).toBe(true);
  });

  it("skips person-less events and scorer output files", async () => {
    const state = stateWith({
      "events/2026-09-01/mail-parse-01AAAAAAAAAAAAAAAAAAAAAAAA.ndjson": ndjson(
        parcelEvent({ person: null }),
      ),
      "events/2026-09-01/scorer-01BBBBBBBBBBBBBBBBBBBBBBBB.ndjson": ndjson(
        parcelEvent({ cloudEntityId: ceId(1), fullName: "JANE ROE" }),
      ),
    });
    const result = await runResolver(null, fakeDeps(state));
    expect(result.filesRead).toBe(1); // scorer file not read
    expect(result.personEvents).toBe(0);
    expect(result.entitiesResolved).toBe(0);
    expect(state.entities.size).toBe(0);
  });

  it("reads the full lookback window and honors maxFiles", async () => {
    const state = stateWith({
      "events/2026-08-26/pvd-taxroll-01AAAAAAAAAAAAAAAAAAAAAAAA.ndjson": ndjson(
        parcelEvent({ cloudEntityId: ceId(1), fullName: "JANE ROE" }),
      ),
      "events/2026-09-01/pvd-taxroll-01BBBBBBBBBBBBBBBBBBBBBBBB.ndjson": ndjson(
        parcelEvent({ cloudEntityId: ceId(2), fullName: "JOHN SMITH" }),
      ),
    });
    const both = await runResolver(null, fakeDeps(state));
    expect(both.filesRead).toBe(2); // 2026-08-26 is day 7 of the default lookback

    const narrow = await runResolver({ lookbackDays: 2 }, fakeDeps(state));
    expect(narrow.filesRead).toBe(1);

    const bounded = await runResolver({ maxFiles: 1 }, fakeDeps(state));
    expect(bounded.filesRead).toBe(1);
  });

  it("read-modify-write: second run merges instead of duplicating", async () => {
    const state = stateWith({
      "events/2026-09-01/pvd-taxroll-01AAAAAAAAAAAAAAAAAAAAAAAA.ndjson": ndjson(
        parcelEvent({ cloudEntityId: ceId(1), fullName: "JOHN SMITH", parcelId: "P-1" }),
      ),
      "events/2026-09-01/pvd-taxroll-01BBBBBBBBBBBBBBBBBBBBBBBB.ndjson": ndjson(
        parcelEvent({ cloudEntityId: ceId(2), fullName: "SMITH, JOHN", parcelId: "P-2", unitCount: 3 }),
      ),
    });
    const deps = fakeDeps(state);

    // First run sees only file A (simulate by lookback over a copy).
    const firstState = stateWith({
      "events/2026-09-01/pvd-taxroll-01AAAAAAAAAAAAAAAAAAAAAAAA.ndjson":
        state.objects.get("events/2026-09-01/pvd-taxroll-01AAAAAAAAAAAAAAAAAAAAAAAA.ndjson")!,
    });
    firstState.entities = state.entities; // shared table
    await runResolver(null, fakeDeps(firstState));
    expect(state.entities.size).toBe(1);

    // Second run sees both files; the new member must merge into ce 1.
    const second = await runResolver(null, deps);
    expect(second.entitiesUpdated).toBe(1);
    expect(second.entitiesCreated).toBe(0);
    expect(state.entities.size).toBe(1);

    const merged = fromItem(state.entities.get(ceId(1))!)!;
    expect(merged.memberCloudEntityIds).toEqual([ceId(1), ceId(2)]);
    expect(merged.parcelCount).toBe(2);
    expect(merged.doorsEstimate).toBe(4); // 1 + 3
  });

  it("is idempotent: re-running the same input changes nothing", async () => {
    const state = stateWith({
      "events/2026-09-01/pvd-taxroll-01AAAAAAAAAAAAAAAAAAAAAAAA.ndjson": ndjson(
        parcelEvent({ cloudEntityId: ceId(1), fullName: "JOHN SMITH", parcelId: "P-1", unitCount: 6 }),
        parcelEvent({ cloudEntityId: ceId(2), fullName: "SMITH JOHN", parcelId: "P-2" }),
      ),
    });
    const deps = fakeDeps(state);
    await runResolver(null, deps);
    const after1 = JSON.stringify([...state.entities.entries()]);
    const second = await runResolver(null, deps);
    expect(second.entitiesUpdated).toBe(1);
    expect(JSON.stringify([...state.entities.entries()])).toBe(after1);
  });

  it("counts parse failures without dying", async () => {
    const state = stateWith({
      "events/2026-09-01/pvd-taxroll-01AAAAAAAAAAAAAAAAAAAAAAAA.ndjson":
        'not json\n{"nope": true}\n' + JSON.stringify(parcelEvent({ fullName: "JANE ROE" })) + "\n",
    });
    const result = await runResolver(null, fakeDeps(state));
    expect(result.parseFailures).toBe(2);
    expect(result.entitiesResolved).toBe(1);
  });

  it("empty inbox -> no writes", async () => {
    const state = stateWith({});
    const result = await runResolver(null, fakeDeps(state));
    expect(result.entitiesResolved).toBe(0);
    expect(state.entities.size).toBe(0);
  });
});

describe("exported handler boundary", () => {
  it("includes dependency initialization, rounds fractional duration, and excludes warm idle", async () => {
    const deps = fakeDeps(stateWith({}));
    const output: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    const times = [100, 105.6, 10_000, 10_007.4];
    const invocation = createHandler(() => deps, () => times.shift()!);
    try { await invocation(null); await invocation(null); } finally { consoleSpy.mockRestore(); }
    const completions = output.map((line) => JSON.parse(line) as Record<string, unknown>).filter((record) => record.eventCode === "SCHEDULED_RUN_COMPLETED");
    expect(completions).toHaveLength(2);
    expect(completions.map((record) => record.durationMs)).toEqual([6, 7]);
    for (const record of completions) expect(Object.keys(record).sort()).toEqual(["component", "count", "durationMs", "eventCode", "level", "unprocessedCount"].sort());
  });
  it("finalizes failures with safe defaults and rejects only the fixed safe error", async () => {
    const output: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    const invocation = createHandler(() => { throw new Error("private@example.test provider payload secret-token"); }, () => 20);
    try { await expect(invocation(null)).rejects.toMatchObject({ name: "SafeHandlerError", message: "Cloud handler invocation failed" }); } finally { consoleSpy.mockRestore(); }
    const serialized = output.find((line) => line.includes("SCHEDULED_RUN_COMPLETED"))!;
    expect(JSON.parse(serialized)).toMatchObject({ count: 0, unprocessedCount: 0, durationMs: 0 });
    expect(serialized).not.toContain("private@example.test");
    expect(serialized).not.toContain("secret-token");
  });
});
