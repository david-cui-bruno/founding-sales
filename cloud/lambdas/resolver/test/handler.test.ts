import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { createHandler, runResolver, type HandlerDeps } from "../src/handler";
import { fromItem } from "../src/entitiesTable";
import { ceId, parcelEvent, NOW } from "./fixtures";
import type { CloudSourceEvent } from "@callie-sourcing/shared";

// ---------------------------------------------------------------------------
// DI fakes
// ---------------------------------------------------------------------------

interface FakeState {
  objects: Map<string, string>; // s3 key -> ndjson body
  entities: Map<string, Record<string, AttributeValue>>; // entity_id -> item
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
            (item) => item.normalized_name!.S === queried,
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
    const pii = "JANE ROE";
    const deps = fakeDeps(stateWith({
      "events/2026-09-01/pvd-taxroll-01AAAAAAAAAAAAAAAAAAAAAAAA.ndjson": ndjson(
        parcelEvent({ cloudEntityId: ceId(1), fullName: pii, parcelId: "P-1" }),
      ),
    }));
    const output: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    const times = [100, 102.4, 105.6, 10_000, 10_007.4];
    let cold = true;
    const invocation = createHandler(() => { if (cold) { cold = false; times.shift(); } return deps; }, () => times.shift()!);
    try { await invocation(null); await invocation(null); } finally { consoleSpy.mockRestore(); }
    const completions = output.map((line) => JSON.parse(line) as Record<string, unknown>).filter((record) => record.eventCode === "SCHEDULED_RUN_COMPLETED");
    expect(completions).toHaveLength(2);
    expect(completions.map((record) => ({ status: record.status, durationMs: record.durationMs, count: record.count, unprocessedCount: record.unprocessedCount }))).toEqual([
      { status: "success", durationMs: 6, count: 1, unprocessedCount: 0 },
      { status: "success", durationMs: 7, count: 1, unprocessedCount: 0 },
    ]);
    expect(output.join("\n")).not.toContain(pii);
    for (const record of completions) expect(Object.keys(record).sort()).toEqual(["component", "count", "durationMs", "eventCode", "level", "status", "unprocessedCount"].sort());
  });
  it("finalizes failures with safe defaults and rejects only the fixed safe error", async () => {
    const output: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((value) => output.push(String(value)));
    const deps = fakeDeps(stateWith({}));
    deps.s3 = { send: async () => { throw Object.assign(new Error("private@example.test provider payload secret-token"), { name: "PrivateProviderError", privatePayload: "must-not-escape" }); } } as HandlerDeps["s3"];
    const invocation = createHandler(() => deps, () => 20);
    try { const failure = await invocation(null).then(() => undefined, (error) => error);
      assertSafeBoundaryFailure(failure, "PrivateProviderError", "private@example.test provider payload secret-token"); } finally { consoleSpy.mockRestore(); }
    const completionLines = output.filter((line) => line.includes("SCHEDULED_RUN_COMPLETED"));
    expect(completionLines).toHaveLength(1);
    const serialized = completionLines[0]!;
    expect(JSON.parse(serialized)).toMatchObject({ status: "failure", count: 0, unprocessedCount: 0, durationMs: 0 });
    expect(output.join("\n")).not.toContain("private@example.test");
    expect(output.join("\n")).not.toContain("secret-token");
  });
});
