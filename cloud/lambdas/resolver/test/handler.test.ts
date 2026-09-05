import { describe, expect, it, vi } from "vitest";
import { runResolver, type HandlerDeps } from "../src/handler";
import { fromItem } from "../src/entitiesTable";
import { ceId, parcelEvent, NOW } from "./fixtures";
import type { CloudSourceEvent } from "@callie-sourcing/shared";
import { log } from "../src/log";

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

describe("PII-safe handler logging", () => {
  it("serializes only the package policy for PII-bearing inputs", () => {
    const output: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((value) => {
      output.push(String(value));
    });

    try {
      log("info", 'resolver run complete', { eventsRead: 6, entitiesCreated: 4, person: { name: "Private Person", email: "private@example.test" } });
    } finally {
      spy.mockRestore();
    }

    expect(output).toHaveLength(1);
    const serialized = output[0]!;
    const record = JSON.parse(serialized);
    expect(record.component).toBe('resolver');
    expect(record.eventCode).toBe('SCHEDULED_RUN_COMPLETED');
    expect(Object.keys(record).sort()).toEqual(
      ['component', 'count', 'durationMs', 'eventCode', 'level', 'unprocessedCount'].sort(),
    );
    expect(serialized).not.toContain("Private");
    expect(serialized).not.toContain("private@example.test");
    expect(serialized).not.toContain("contact-hmac-secret");
    expect(serialized).not.toContain("b".repeat(64));
  });
});
