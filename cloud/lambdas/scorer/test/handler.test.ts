import { describe, expect, it } from "vitest";
import {
  computeIdempotencyKey,
  newCloudEntityId,
  newSourceEventId,
  validateSourceEvent,
  type CloudSourceEvent,
} from "@callie-sourcing/shared";
import { runScorer, SCORES_VERSION, type HandlerDeps } from "../src/handler";

const NOW = new Date("2026-09-01T06:00:00.000Z");

// ---------------------------------------------------------------------------
// DI fakes
// ---------------------------------------------------------------------------

interface FakeState {
  objects: Map<string, string>; // key -> ndjson body
  puts: Array<{ key: string; body: string }>;
  snapshots: Map<string, Record<string, unknown>>; // pk|sk -> item
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
          return {
            Contents: keys.map((Key) => ({ Key })),
            IsTruncated: false,
          };
        }
        if (name === "GetObjectCommand") {
          const body = state.objects.get(command.input.Key);
          if (body === undefined) throw new Error(`NoSuchKey: ${command.input.Key}`);
          return { Body: { transformToString: async () => body } };
        }
        if (name === "PutObjectCommand") {
          state.puts.push({ key: command.input.Key, body: command.input.Body });
          state.objects.set(command.input.Key, command.input.Body);
          return {};
        }
        throw new Error(`unexpected s3 command ${name}`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    },
    dynamo: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      send: (async (command: any) => {
        const name = command.constructor.name;
        if (name === "GetItemCommand") {
          const pk = command.input.Key.source_natural_key.S;
          const sk = command.input.Key.snapshot_date.S;
          const item = state.snapshots.get(`${pk}|${sk}`);
          return item ? { Item: item } : {};
        }
        if (name === "PutItemCommand") {
          const pk = command.input.Item.source_natural_key.S;
          const sk = command.input.Item.snapshot_date.S;
          state.snapshots.set(`${pk}|${sk}`, command.input.Item);
          return {};
        }
        throw new Error(`unexpected dynamo command ${name}`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    },
    env: { INBOX_BUCKET: "inbox", SNAPSHOTS_TABLE: "snapshots" },
    now: () => NOW,
  };
}

function makeEvent(overrides: Partial<CloudSourceEvent> = {}): CloudSourceEvent {
  const url = `https://example.com/${Math.random().toString(36).slice(2)}`;
  return {
    contract_version: 1,
    id: newSourceEventId(),
    idempotency_key: computeIdempotencyKey("frbo", url, "fp"),
    channel: "frbo",
    source_uri: "test:fixture",
    fetched_at: NOW.toISOString(),
    observed_at: NOW.toISOString(),
    entity: {
      cloud_entity_id: newCloudEntityId(),
      person: null,
      property: null,
      known_person: false,
    },
    payload: {
      listing_url: url,
      rent_usd: 2000,
      beds: 3,
      baths: 1,
      property_kind: "multi_family",
      listed_at: null,
    },
    signal_flags: {
      self_managed: true,
      vacancy: null,
      pain_mentions: [],
      urgency: 1,
      portfolio_hint: null,
    },
    trigger: { type: "frbo_listing", weight: 1, half_life_days: 3, window: null },
    scores: null,
    provenance: { adapter: "mail-parse", adapter_version: "1.0.0", confidence: 0.9 },
    ...overrides,
  };
}

function ndjson(...events: CloudSourceEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

function stateWith(files: Record<string, string>): FakeState {
  return {
    objects: new Map(Object.entries(files)),
    puts: [],
    snapshots: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runScorer", () => {
  it("scores unscored events and writes scorer ndjson with scores_version", async () => {
    const event = makeEvent();
    const state = stateWith({
      "events/2026-09-01/mail-parse-01AAAAAAAAAAAAAAAAAAAAAAAA.ndjson": ndjson(event),
    });
    const result = await runScorer(fakeDeps(state));

    expect(result.eventsSeen).toBe(1);
    expect(result.unscored).toBe(1);
    expect(result.scored).toBe(1);
    expect(result.outputKey).toMatch(
      /^events\/2026-09-01\/scorer-[0-9A-HJKMNP-TV-Z]{26}\.ndjson$/,
    );

    const written = state.puts[0]!;
    const scored = JSON.parse(written.body.trim()) as CloudSourceEvent;
    expect(validateSourceEvent(scored).success).toBe(true);
    expect(scored.idempotency_key).toBe(event.idempotency_key); // SAME key
    expect(scored.scores_version).toBe(SCORES_VERSION);
    expect(scored.scores).not.toBeNull();
    expect(scored.scores!.fit).toBeGreaterThan(0); // frbo => vacancy
    expect(scored.scores!.timing).toBeGreaterThanOrEqual(50); // fresh trigger
    expect(scored.scores!.reasons.length).toBeGreaterThanOrEqual(1);
    expect(scored.scores!.reasons.length).toBeLessThanOrEqual(3);
  });

  it("reads yesterday's prefix too", async () => {
    const event = makeEvent();
    const state = stateWith({
      "events/2026-08-31/mail-parse-01BBBBBBBBBBBBBBBBBBBBBBBB.ndjson": ndjson(event),
    });
    const result = await runScorer(fakeDeps(state));
    expect(result.eventsSeen).toBe(1);
    expect(result.scored).toBe(1);
  });

  it("skips already-scored events via the snapshots table", async () => {
    const event = makeEvent();
    const state = stateWith({
      "events/2026-09-01/mail-parse-01CCCCCCCCCCCCCCCCCCCCCCCC.ndjson": ndjson(event),
    });
    const deps = fakeDeps(state);

    const first = await runScorer(deps);
    expect(first.scored).toBe(1);
    expect(state.snapshots.size).toBe(1);
    expect(
      state.snapshots.has(`scorer:${event.idempotency_key}|v${SCORES_VERSION}`),
    ).toBe(true);

    const second = await runScorer(deps);
    expect(second.skippedAlreadyScored).toBe(1);
    expect(second.scored).toBe(0);
    // Only the first run wrote output.
    expect(state.puts.filter((p) => p.key.includes("scorer-"))).toHaveLength(1);
  });

  it("ignores already-scored events (scores !== null) and its own output files", async () => {
    const adapterEvent = makeEvent();
    const scoredEvent: CloudSourceEvent = {
      ...makeEvent(),
      scores: { fit: 50, timing: 50, reasons: [{ signal: "x", contribution: 1 }] },
      scores_version: 1,
    };
    const state = stateWith({
      "events/2026-09-01/mail-parse-01DDDDDDDDDDDDDDDDDDDDDDDD.ndjson":
        ndjson(adapterEvent),
      "events/2026-09-01/scorer-01EEEEEEEEEEEEEEEEEEEEEEEE.ndjson": ndjson(scoredEvent),
    });
    const result = await runScorer(fakeDeps(state));
    // scorer file is not even read
    expect(result.filesRead).toBe(1);
    expect(result.scored).toBe(1);
  });

  it("compound bonus applies when the same entity has frbo + violation triggers", async () => {
    const entityId = newCloudEntityId();
    const frbo = makeEvent({
      entity: { cloud_entity_id: entityId, person: null, property: null, known_person: false },
    });
    const violation = makeEvent({
      channel: "violation",
      idempotency_key: computeIdempotencyKey("violation", "v1", "fp"),
      payload: {
        violation_kind: "housing",
        status: "open",
        opened_at: "2026-08-30",
        case_ref: "CASE-1",
      },
      trigger: { type: "violation_opened", weight: 1, half_life_days: 45, window: null },
      entity: { cloud_entity_id: entityId, person: null, property: null, known_person: false },
    });
    const solo = makeEvent(); // different entity, frbo only

    const state = stateWith({
      "events/2026-09-01/mail-parse-01FFFFFFFFFFFFFFFFFFFFFFFF.ndjson": ndjson(
        frbo,
        violation,
        solo,
      ),
    });
    const result = await runScorer(fakeDeps(state));
    // The frbo and solo events always score; the violation event also scores
    // once shared registers violationPayloadSchema (otherwise it is dropped
    // at validation but its trigger still feeds the entity context).
    expect(result.scored).toBeGreaterThanOrEqual(2);

    const written = state.puts.find((p) => p.key.includes("scorer-"))!;
    const events = written.body
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as CloudSourceEvent);

    const compoundScored = events.find((e) => e.idempotency_key === frbo.idempotency_key)!;
    const soloScored = events.find((e) => e.idempotency_key === solo.idempotency_key)!;
    // mass 1 (fresh frbo) vs mass (1 + violationMass) * 1.5
    expect(compoundScored.scores!.timing).toBeGreaterThan(soloScored.scores!.timing);
    expect(soloScored.scores!.timing).toBe(50);
  });

  it("counts parse failures without dying", async () => {
    const event = makeEvent();
    const state = stateWith({
      "events/2026-09-01/mail-parse-01GGGGGGGGGGGGGGGGGGGGGGGG.ndjson":
        'not json\n{"also": "not a source event"}\n' + JSON.stringify(event) + "\n",
    });
    const result = await runScorer(fakeDeps(state));
    expect(result.parseFailures).toBe(2);
    expect(result.scored).toBe(1);
  });

  it("no unscored events -> no output write", async () => {
    const state = stateWith({});
    const result = await runScorer(fakeDeps(state));
    expect(result.eventsSeen).toBe(0);
    expect(result.outputKey).toBeNull();
    expect(state.puts).toHaveLength(0);
  });

  it("marks scored only after the output write (ordering)", async () => {
    const event = makeEvent();
    const state = stateWith({
      "events/2026-09-01/mail-parse-01HHHHHHHHHHHHHHHHHHHHHHHH.ndjson": ndjson(event),
    });
    const order: string[] = [];
    const deps = fakeDeps(state);
    const s3Send = deps.s3.send.bind(deps.s3);
    const dynamoSend = deps.dynamo.send.bind(deps.dynamo);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (deps.s3 as any).send = async (c: any) => {
      if (c.constructor.name === "PutObjectCommand") order.push("s3put");
      return s3Send(c);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (deps.dynamo as any).send = async (c: any) => {
      if (c.constructor.name === "PutItemCommand") order.push("markscored");
      return dynamoSend(c);
    };
    await runScorer(deps);
    expect(order).toEqual(["s3put", "markscored"]);
  });
});
