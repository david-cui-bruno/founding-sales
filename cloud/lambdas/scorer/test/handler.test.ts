import { describe, expect, it, vi } from "vitest";
import {
  computeIdempotencyKey,
  newCloudEntityId,
  newSourceEventId,
  validateSourceEvent,
  type CloudSourceEvent,
} from "@callie-sourcing/shared";
import { handlerWithDeps, runScorer, SCORES_VERSION, type HandlerDeps } from "../src/handler";
import { log } from "../src/log";

const NOW = new Date("2026-09-01T06:00:00.000Z");

// ---------------------------------------------------------------------------
// DI fakes
// ---------------------------------------------------------------------------

interface FakeState {
  objects: Map<string, string>; // key -> ndjson body
  puts: Array<{ key: string; body: string }>;
  snapshots: Map<string, Record<string, unknown>>; // pk|sk -> item
  /** entities-table items served by the normalized_name GSI query. */
  entities: Array<Record<string, any>>;
  entityQueries: string[];
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
        if (name === "QueryCommand") {
          const queried: string = command.input.ExpressionAttributeValues[":name"].S;
          state.entityQueries.push(queried);
          return {
            Items: state.entities.filter((item) => item.normalized_name.S === queried),
          };
        }
        throw new Error(`unexpected dynamo command ${name}`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    },
    env: { INBOX_BUCKET: "inbox", SNAPSHOTS_TABLE: "snapshots", ENTITIES_TABLE: "entities" },
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
    entities: [],
    entityQueries: [],
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

// ---------------------------------------------------------------------------
// Entity context (resolver entities table -> EntityContext)
// ---------------------------------------------------------------------------

function personEvent(overrides: Partial<CloudSourceEvent> = {}): CloudSourceEvent {
  const key = Math.random().toString(36).slice(2);
  return makeEvent({
    channel: "parcel",
    idempotency_key: computeIdempotencyKey("parcel", key, "fp"),
    entity: {
      cloud_entity_id: newCloudEntityId(),
      person: {
        full_name: "SMITH, JOHN",
        mailing_address: {
          line1: "12 Main St",
          locality: "Providence",
          region: "RI",
          postal_code: "02906",
          country_code: "US",
        },
        phones: [],
        emails: [],
        org_names: [],
      },
      property: null,
      known_person: false,
    },
    payload: {
      assessor_class: "2",
      assessed_value_usd: 500000,
      tax_usd: 5000,
      absentee: true,
      owner_kind: null,
      tax_year: 2025,
    },
    trigger: null,
    ...overrides,
  });
}

/** Entities-table item the way the resolver writes it. */
function entityItem(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    entity_id: { S: "ce_00000000000000000000000001" },
    normalized_name: { S: "JOHN SMITH" },
    canonical_name: { S: "SMITH, JOHN" },
    owner_kind: { S: "llc" },
    mailing_address_json: {
      S: JSON.stringify({
        line1: "12 Main Street",
        locality: "Providence",
        region: "RI",
        postal_code: "02906",
        country_code: "US",
      }),
    },
    member_cloud_entity_ids: { SS: ["ce_00000000000000000000000001"] },
    doors_by_parcel_json: { S: JSON.stringify({ "P-1": 6, "P-2": 6 }) },
    parcel_count: { N: "2" },
    doors_estimate: { N: "12" },
    situs_localities_json: { S: JSON.stringify(["Providence"]) },
    resolution_confidence: { N: "0.95" },
    updated_at: { S: NOW.toISOString() },
    ...overrides,
  };
}

describe("runScorer entity context", () => {
  it("queries the GSI by normalized owner name and counts a hit", async () => {
    const event = personEvent();
    const state = stateWith({
      "events/2026-09-01/pvd-taxroll-01JJJJJJJJJJJJJJJJJJJJJJJJ.ndjson": ndjson(event),
    });
    state.entities.push(entityItem());

    const result = await runScorer(fakeDeps(state));
    expect(state.entityQueries).toEqual(["JOHN SMITH"]); // normalizeOwnerName("SMITH, JOHN")
    expect(result.entityContextHits).toBe(1);
    expect(result.scored).toBe(1);
  });

  it("passes ownerKind and portfolioDoors into scoring (fit reflects both)", async () => {
    const event = personEvent();
    const withContext = stateWith({
      "events/2026-09-01/pvd-taxroll-01KKKKKKKKKKKKKKKKKKKKKKKK.ndjson": ndjson(event),
    });
    withContext.entities.push(entityItem()); // llc, 12 doors (in band)
    const bare = stateWith({
      "events/2026-09-01/pvd-taxroll-01KKKKKKKKKKKKKKKKKKKKKKKK.ndjson": ndjson(event),
    });

    const hit = await runScorer(fakeDeps(withContext));
    const miss = await runScorer(fakeDeps(bare));
    expect(hit.entityContextHits).toBe(1);
    expect(miss.entityContextHits).toBe(0);

    const hitScored = JSON.parse(
      withContext.puts[0]!.body.trim(),
    ) as CloudSourceEvent;
    const missScored = JSON.parse(bare.puts[0]!.body.trim()) as CloudSourceEvent;
    // 12 doors in band + llc owner add fit signals a bare event lacks.
    expect(hitScored.scores!.fit).toBeGreaterThan(missScored.scores!.fit);
    const signals = hitScored.scores!.reasons.map((r) => r.signal);
    expect(signals).toContain("portfolio_in_band");
  });

  it("prefers the exact-address row, falls back to same zip", async () => {
    const event = personEvent();
    const state = stateWith({
      "events/2026-09-01/pvd-taxroll-01LLLLLLLLLLLLLLLLLLLLLLLL.ndjson": ndjson(event),
    });
    // Two rows share the name: a different-zip decoy and the zip match.
    state.entities.push(
      entityItem({
        entity_id: { S: "ce_00000000000000000000000002" },
        owner_kind: { S: "individual" },
        doors_estimate: { N: "1" },
        mailing_address_json: {
          S: JSON.stringify({
            line1: "99 Other Rd",
            locality: "Boston",
            region: "MA",
            postal_code: "02118",
            country_code: "US",
          }),
        },
      }),
      entityItem({
        entity_id: { S: "ce_00000000000000000000000003" },
        doors_estimate: { N: "12" },
        mailing_address_json: {
          S: JSON.stringify({
            line1: "45 Different St", // same zip, different address
            locality: "Providence",
            region: "RI",
            postal_code: "02906",
            country_code: "US",
          }),
        },
      }),
    );
    const result = await runScorer(fakeDeps(state));
    expect(result.entityContextHits).toBe(1);
    const scored = JSON.parse(state.puts[0]!.body.trim()) as CloudSourceEvent;
    expect(scored.scores!.reasons.map((r) => r.signal)).toContain("portfolio_in_band");
  });

  it("no table row -> no hit, event still scores", async () => {
    const event = personEvent();
    const state = stateWith({
      "events/2026-09-01/pvd-taxroll-01MMMMMMMMMMMMMMMMMMMMMMMM.ndjson": ndjson(event),
    });
    const result = await runScorer(fakeDeps(state));
    expect(result.entityContextHits).toBe(0);
    expect(result.scored).toBe(1);
  });

  it("ambiguous multi-row name with no address/zip match -> no hit", async () => {
    const event = personEvent();
    const state = stateWith({
      "events/2026-09-01/pvd-taxroll-01NNNNNNNNNNNNNNNNNNNNNNNN.ndjson": ndjson(event),
    });
    state.entities.push(
      entityItem({
        entity_id: { S: "ce_00000000000000000000000004" },
        mailing_address_json: {
          S: JSON.stringify({
            line1: "1 A St",
            locality: "Boston",
            region: "MA",
            postal_code: "02118",
            country_code: "US",
          }),
        },
      }),
      entityItem({
        entity_id: { S: "ce_00000000000000000000000005" },
        mailing_address_json: {
          S: JSON.stringify({
            line1: "2 B St",
            locality: "Warwick",
            region: "RI",
            postal_code: "02886",
            country_code: "US",
          }),
        },
      }),
    );
    const result = await runScorer(fakeDeps(state));
    expect(result.entityContextHits).toBe(0);
  });

  it("caches GSI queries per normalized name within a run", async () => {
    const a = personEvent();
    const b = personEvent();
    const state = stateWith({
      "events/2026-09-01/pvd-taxroll-01PPPPPPPPPPPPPPPPPPPPPPPP.ndjson": ndjson(a, b),
    });
    state.entities.push(entityItem());
    const result = await runScorer(fakeDeps(state));
    expect(result.entityContextHits).toBe(2);
    expect(state.entityQueries).toEqual(["JOHN SMITH"]); // one query, two hits
  });

  it("person-less events never query the entities table", async () => {
    const state = stateWith({
      "events/2026-09-01/mail-parse-01QQQQQQQQQQQQQQQQQQQQQQQQ.ndjson": ndjson(makeEvent()),
    });
    const result = await runScorer(fakeDeps(state));
    expect(state.entityQueries).toEqual([]);
    expect(result.entityContextHits).toBe(0);
    expect(result.scored).toBe(1);
  });
});

describe("PII-safe handler logging", () => {
  it("serializes only the package policy for PII-bearing inputs", () => {
    const output: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((value) => {
      output.push(String(value));
    });

    try {
      log("info", 'scorer run complete', { written: 4, eventsRead: 6, event: { name: "Private Person", address: "12 Private Street" } });
    } finally {
      spy.mockRestore();
    }

    expect(output).toHaveLength(1);
    const serialized = output[0]!;
    const record = JSON.parse(serialized);
    expect(record.component).toBe('scorer');
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

describe("scheduled completion duration", () => {
  it("excludes warm-container idle time between consecutive invocations", async () => {
    const output: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((value) => {
      output.push(String(value));
    });
    const clockSpy = vi
      .spyOn(performance, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(105)
      .mockReturnValueOnce(10_000)
      .mockReturnValueOnce(10_007);

    try {
      await handlerWithDeps(fakeDeps({ objects: new Map(), puts: [], snapshots: new Map(), entities: [], entityQueries: [] }));
      await handlerWithDeps(fakeDeps({ objects: new Map(), puts: [], snapshots: new Map(), entities: [], entityQueries: [] }));
    } finally {
      clockSpy.mockRestore();
      consoleSpy.mockRestore();
    }

    const completions = output
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.eventCode === "SCHEDULED_RUN_COMPLETED");
    expect(completions).toHaveLength(2);
    expect(completions.map((record) => record.durationMs)).toEqual([5, 7]);
    for (const record of completions) {
      expect(Object.keys(record).sort()).toEqual(
        ["component", "count", "durationMs", "eventCode", "level", "unprocessedCount"].sort(),
      );
    }
  });
});
