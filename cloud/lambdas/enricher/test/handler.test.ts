import { describe, expect, it, vi } from "vitest";
import { validateSourceEvent } from "@callie-sourcing/shared";
import { handlerWithDeps, REQUESTS_PREFIX, type HandlerDeps } from "../src/handler";
import { contactHmac } from "../src/enrich";
import { CE_ID_2, hitResponse, missResponse, person, request } from "./fixtures";
import type { TracerfyLookupResponse } from "../src/tracerfy";
import { log } from "../src/log";

const SALT = "test-salt";

const ENV = {
  INBOX_BUCKET: "inbox",
  IDEMPOTENCY_TABLE: "idem",
  SNAPSHOTS_TABLE: "snaps",
  SUPPRESSION_TABLE: "suppress",
  SNS_TOPIC_ARN: "arn:aws:sns:us-east-1:000000000000:ops",
  TRACERFY_BASE_URL: "https://mock.tracerfy.example",
  TRACERFY_API_KEY: "test-token",
  ENRICH_MONTHLY_CREDIT_CAP: 1000,
};

type VendorReply =
  | { status: 200; body: TracerfyLookupResponse }
  | { status: number; body: unknown };

interface FakeState {
  /** s3 objects: key -> ndjson body. */
  objects: Map<string, string>;
  /** snapshots-table ledger keys (source_natural_key). */
  ledger: Set<string>;
  /** spend items: source_natural_key -> credits. */
  spend: Map<string, number>;
  capAlarmSent: Set<string>;
  suppressedHmacs: Set<string>;
  claimedIdempotencyKeys: Set<string>;
  s3Writes: Array<{ Key: string; Body: string }>;
  snsPublishes: Array<{ Subject?: string; Message?: string }>;
  vendorCalls: Array<{ url: string; body: Record<string, unknown> }>;
  sleeps: number[];
}

function fakeDeps(
  vendorQueue: VendorReply[],
  init?: Partial<FakeState>,
): { deps: HandlerDeps; state: FakeState } {
  const state: FakeState = {
    objects: new Map(),
    ledger: new Set(),
    spend: new Map(),
    capAlarmSent: new Set(),
    suppressedHmacs: new Set(),
    claimedIdempotencyKeys: new Set(),
    s3Writes: [],
    snsPublishes: [],
    vendorCalls: [],
    sleeps: [],
    ...init,
  };

  const s3 = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async send(command: any): Promise<any> {
      const name = command.constructor.name;
      const input = command.input;
      if (name === "ListObjectsV2Command") {
        const keys = [...state.objects.keys()]
          .filter((key) => key.startsWith(input.Prefix))
          .sort();
        return {
          Contents: keys.map((Key) => ({ Key })),
          IsTruncated: false,
        };
      }
      if (name === "GetObjectCommand") {
        const body = state.objects.get(input.Key);
        if (body === undefined) throw new Error(`no such key ${input.Key}`);
        return { Body: { transformToString: async () => body } };
      }
      if (name === "PutObjectCommand") {
        state.s3Writes.push(input);
        state.objects.set(input.Key, input.Body);
        return {};
      }
      throw new Error(`unexpected s3 command ${name}`);
    },
  };

  const dynamo = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async send(command: any): Promise<any> {
      const name = command.constructor.name;
      const input = command.input;
      if (name === "GetItemCommand") {
        if (input.TableName === ENV.SUPPRESSION_TABLE) {
          const hmac = input.Key.contact_hash.S as string;
          return state.suppressedHmacs.has(hmac) ? { Item: { contact_hash: { S: hmac } } } : {};
        }
        const key = input.Key.source_natural_key.S as string;
        if (key.startsWith("enricher:__spend__:")) {
          const credits = state.spend.get(key);
          return credits === undefined
            ? {}
            : { Item: { credits_used: { N: String(credits) } } };
        }
        return state.ledger.has(key) ? { Item: { processed_at: { S: "x" } } } : {};
      }
      if (name === "PutItemCommand") {
        if (input.TableName === ENV.SNAPSHOTS_TABLE) {
          state.ledger.add(input.Item.source_natural_key.S as string);
          return {};
        }
        // idempotency conditional put
        const key = input.Item.idempotency_key.S as string;
        if (state.claimedIdempotencyKeys.has(key)) {
          const error = new Error("conditional failed");
          error.name = "ConditionalCheckFailedException";
          throw error;
        }
        state.claimedIdempotencyKeys.add(key);
        return {};
      }
      if (name === "UpdateItemCommand") {
        const key = input.Key.source_natural_key.S as string;
        if (input.UpdateExpression.includes("cap_alarm_sent_at")) {
          if (state.capAlarmSent.has(key)) {
            const error = new Error("conditional failed");
            error.name = "ConditionalCheckFailedException";
            throw error;
          }
          state.capAlarmSent.add(key);
          return {};
        }
        // spend ADD
        const credits = Number(input.ExpressionAttributeValues[":credits"].N);
        state.spend.set(key, (state.spend.get(key) ?? 0) + credits);
        return {};
      }
      throw new Error(`unexpected dynamo command ${name}`);
    },
  };

  const sns = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async send(command: any): Promise<any> {
      state.snsPublishes.push(command.input);
      return {};
    },
  };

  const queue = [...vendorQueue];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    state.vendorCalls.push({ url: String(url), body });
    const reply = queue.shift();
    if (!reply) throw new Error("vendor queue exhausted");
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body,
      text: async () => JSON.stringify(reply.body),
    } as unknown as Response;
  }) as typeof fetch;

  const deps: HandlerDeps = {
    s3,
    dynamo,
    sns,
    fetchImpl,
    getHmacSalt: async () => SALT,
    env: { ...ENV },
    now: () => new Date("2026-09-01T15:05:00.000Z"),
    sleep: async (ms) => {
      state.sleeps.push(ms);
    },
  };
  return { deps, state };
}

function requestFile(lines: unknown[]): string {
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

const FILE_KEY = `${REQUESTS_PREFIX}2026-09-01.ndjson`;

describe("handlerWithDeps", () => {
  it("hit: emits a schema-valid enrichment event and records spend", async () => {
    const { deps, state } = fakeDeps([{ status: 200, body: hitResponse() }], {
      objects: new Map([[FILE_KEY, requestFile([request()])]]),
    });
    const result = await handlerWithDeps(null, deps);

    expect(result.requestsHandled).toBe(1);
    expect(result.vendorHits).toBe(1);
    expect(result.creditsUsedRun).toBe(5);
    expect(result.eventsWritten).toBe(1);
    expect(result.filesCompleted).toBe(1);
    expect(result.stopped).toBe(null);
    expect(state.spend.get("enricher:__spend__:2026-09")).toBe(5);

    // find_owner:true lookup with the situs address
    expect(state.vendorCalls[0]!.body).toMatchObject({
      address: "123 Hope St",
      city: "Providence",
      state: "RI",
      zip: "02906",
      find_owner: true,
    });

    const write = state.s3Writes.find((w) => w.Key.includes("/enricher-"));
    expect(write).toBeDefined();
    expect(write!.Key).toMatch(/^events\/2026-09-01\/enricher-.+\.ndjson$/);
    const event = JSON.parse(write!.Body.trim());
    const validated = validateSourceEvent(event);
    expect(validated.success, validated.success ? "" : validated.error).toBe(true);
    expect(event.channel).toBe("parcel");
    expect(event.payload).toMatchObject({
      vendor: "tracerfy",
      hit: true,
      credits_used: 5,
      matched_owner: true,
    });
    expect(event.payload.phones).toEqual([
      {
        e164: "+14015550100",
        kind: "mobile",
        compliance: {
          federal_status: "unknown",
          tcpa_flag: null,
          covered_area_code: null,
          source: "enrichment_vendor",
          scrubbed_at: null,
          expires_at: null,
        },
        rank: 1,
      },
      {
        e164: "+14015550200",
        kind: "landline",
        compliance: {
          federal_status: "listed",
          tcpa_flag: null,
          covered_area_code: null,
          source: "enrichment_vendor",
          scrubbed_at: null,
          expires_at: null,
        },
        rank: 2,
      },
    ]);
    expect(event.payload.emails).toEqual([{ address: "jane.roe@example.com", rank: 1 }]);

    // Ledgers written: request + file.
    expect(state.ledger.has(`enricher:${FILE_KEY}`)).toBe(true);
    expect(
      state.ledger.has(`enricher:req:${request().cloud_entity_id}:${request().requested_at}`),
    ).toBe(true);
  });

  it("miss: emits hit:false with person null and spends nothing", async () => {
    const { deps, state } = fakeDeps([{ status: 200, body: missResponse() }], {
      objects: new Map([[FILE_KEY, requestFile([request()])]]),
    });
    const result = await handlerWithDeps(null, deps);

    expect(result.vendorMisses).toBe(1);
    expect(result.creditsUsedRun).toBe(0);
    expect(result.eventsWritten).toBe(1);
    expect(state.spend.size).toBe(0);

    const write = state.s3Writes.find((w) => w.Key.includes("/enricher-"))!;
    const event = JSON.parse(write.Body.trim());
    expect(validateSourceEvent(event).success).toBe(true);
    expect(event.payload).toMatchObject({ hit: false, credits_used: 0, matched_owner: false });
    expect(event.entity.person).toBe(null);
  });

  it("owner-match: prefers the property_owner person over vendor order", async () => {
    const renter = person({
      full_name: "Sam Renter",
      property_owner: false,
      phones: [{ number: "4015559999", type: "Mobile", dnc: false, tcpa: false, rank: 1 }],
      emails: [],
    });
    const owner = person({ full_name: "Jane Roe", property_owner: true });
    const { deps, state } = fakeDeps(
      [{ status: 200, body: hitResponse([renter, owner]) }],
      { objects: new Map([[FILE_KEY, requestFile([request()])]]) },
    );
    await handlerWithDeps(null, deps);

    const write = state.s3Writes.find((w) => w.Key.includes("/enricher-"))!;
    const event = JSON.parse(write.Body.trim());
    expect(event.entity.person.full_name).toBe("Jane Roe");
    expect(event.payload.matched_owner).toBe(true);
    expect(event.provenance.confidence).toBe(0.9);
  });

  it("rank-fallback: no owner flag, no name match -> first person, confidence 0.6", async () => {
    const first = person({ full_name: "Sam First", property_owner: false });
    const second = person({ full_name: "Ann Second", property_owner: false });
    const { deps, state } = fakeDeps(
      [{ status: 200, body: hitResponse([first, second]) }],
      {
        objects: new Map([
          [FILE_KEY, requestFile([request({ owner_full_name: "NO SUCH OWNER" })])],
        ]),
      },
    );
    await handlerWithDeps(null, deps);

    const write = state.s3Writes.find((w) => w.Key.includes("/enricher-"))!;
    const event = JSON.parse(write.Body.trim());
    expect(event.entity.person.full_name).toBe("Sam First");
    expect(event.payload.matched_owner).toBe(false);
    expect(event.provenance.confidence).toBe(0.6);
  });

  it("suppression: drops the suppressed phone, keeps the rest", async () => {
    const suppressed = contactHmac(SALT, "phone", "+14015550100");
    const { deps, state } = fakeDeps([{ status: 200, body: hitResponse() }], {
      objects: new Map([[FILE_KEY, requestFile([request()])]]),
      suppressedHmacs: new Set([suppressed]),
    });
    const result = await handlerWithDeps(null, deps);

    expect(result.suppressedPhones).toBe(1);
    const write = state.s3Writes.find((w) => w.Key.includes("/enricher-"))!;
    const event = JSON.parse(write.Body.trim());
    expect(validateSourceEvent(event).success).toBe(true);
    expect(event.payload.hit).toBe(true);
    expect(event.payload.phones).toHaveLength(1);
    expect(event.payload.phones[0].e164).toBe("+14015550200");
    expect(event.entity.person.phones).toEqual(["+14015550200"]);
  });

  it("suppression: all contacts dropped -> hit:false, no cleartext leaks", async () => {
    const { deps, state } = fakeDeps([{ status: 200, body: hitResponse() }], {
      objects: new Map([[FILE_KEY, requestFile([request()])]]),
      suppressedHmacs: new Set([
        contactHmac(SALT, "phone", "+14015550100"),
        contactHmac(SALT, "phone", "+14015550200"),
        contactHmac(SALT, "email", "jane.roe@example.com"),
      ]),
    });
    const result = await handlerWithDeps(null, deps);

    expect(result.suppressedPhones).toBe(2);
    expect(result.suppressedEmails).toBe(1);
    const write = state.s3Writes.find((w) => w.Key.includes("/enricher-"))!;
    const event = JSON.parse(write.Body.trim());
    expect(validateSourceEvent(event).success).toBe(true);
    expect(event.payload).toMatchObject({ hit: false, phones: [], emails: [] });
    expect(event.entity.person.phones).toEqual([]);
    expect(event.entity.person.emails).toEqual([]);
  });

  it("402: stops the whole run and throws (founder problem)", async () => {
    const { deps, state } = fakeDeps(
      [{ status: 402, body: { error: "Insufficient credits." } }],
      {
        objects: new Map([
          [FILE_KEY, requestFile([request(), request({ cloud_entity_id: CE_ID_2 })])],
        ]),
      },
    );
    await expect(handlerWithDeps(null, deps)).rejects.toThrow(/no_credits/);
    // Only ONE vendor call: the second request was never attempted.
    expect(state.vendorCalls).toHaveLength(1);
    // Nothing emitted, file ledger NOT written (rerun will retry).
    expect(state.s3Writes).toHaveLength(0);
    expect(state.ledger.has(`enricher:${FILE_KEY}`)).toBe(false);
  });

  it("403: stops the whole run and throws", async () => {
    const { deps, state } = fakeDeps(
      [{ status: 403, body: { error: "api_disabled" } }],
      { objects: new Map([[FILE_KEY, requestFile([request()])]]) },
    );
    await expect(handlerWithDeps(null, deps)).rejects.toThrow(/suspended/);
    expect(state.vendorCalls).toHaveLength(1);
  });

  it("429: backs off 60s once, retries, then succeeds", async () => {
    const { deps, state } = fakeDeps(
      [
        { status: 429, body: { status: 429, error: "Rate limit exceeded." } },
        { status: 200, body: hitResponse() },
      ],
      { objects: new Map([[FILE_KEY, requestFile([request()])]]) },
    );
    const result = await handlerWithDeps(null, deps);
    expect(state.sleeps).toEqual([60_000]);
    expect(result.eventsWritten).toBe(1);
    expect(result.stopped).toBe(null);
  });

  it("429 twice: stops gracefully without throwing (next tick resumes)", async () => {
    const { deps, state } = fakeDeps(
      [
        { status: 429, body: { status: 429, error: "Rate limit exceeded." } },
        { status: 429, body: { status: 429, error: "Rate limit exceeded." } },
      ],
      {
        objects: new Map([
          [FILE_KEY, requestFile([request(), request({ cloud_entity_id: CE_ID_2 })])],
        ]),
      },
    );
    const result = await handlerWithDeps(null, deps);
    expect(result.stopped).toBe("rate_limited");
    expect(state.vendorCalls).toHaveLength(2); // both for request 1
    expect(state.ledger.has(`enricher:${FILE_KEY}`)).toBe(false);
  });

  it("5xx: retries once then succeeds", async () => {
    const { deps, state } = fakeDeps(
      [
        { status: 503, body: { error: "temporarily unavailable" } },
        { status: 200, body: hitResponse() },
      ],
      { objects: new Map([[FILE_KEY, requestFile([request()])]]) },
    );
    const result = await handlerWithDeps(null, deps);
    expect(result.eventsWritten).toBe(1);
    expect(state.vendorCalls).toHaveLength(2);
    expect(state.sleeps).toEqual([]); // no backoff on 5xx, immediate retry
  });

  it("cap-skip: at cap, skips the lookup, publishes SNS exactly once", async () => {
    const { deps, state } = fakeDeps([], {
      objects: new Map([
        [FILE_KEY, requestFile([request(), request({ cloud_entity_id: CE_ID_2 })])],
      ]),
      spend: new Map([["enricher:__spend__:2026-09", 1000]]),
    });
    const result = await handlerWithDeps(null, deps);

    expect(result.requestsCapSkipped).toBe(2);
    expect(result.eventsWritten).toBe(0);
    expect(state.vendorCalls).toHaveLength(0); // NEVER called the vendor
    expect(state.snsPublishes).toHaveLength(1); // alarm once, not per request
    expect(state.snsPublishes[0]!.Subject).toContain("credit cap");
    // File stays open so requests run next month / after a cap raise.
    expect(state.ledger.has(`enricher:${FILE_KEY}`)).toBe(false);
    expect(result.stopped).toBe(null);
  });

  it("cap alarm: not re-published when a previous run already sent it", async () => {
    const { deps, state } = fakeDeps([], {
      objects: new Map([[FILE_KEY, requestFile([request()])]]),
      spend: new Map([["enricher:__spend__:2026-09", 1000]]),
      capAlarmSent: new Set(["enricher:__spend__:2026-09"]),
    });
    await handlerWithDeps(null, deps);
    expect(state.snsPublishes).toHaveLength(0);
  });

  it("under cap: proceeds when month-to-date is below the cap", async () => {
    const { deps, state } = fakeDeps([{ status: 200, body: hitResponse() }], {
      objects: new Map([[FILE_KEY, requestFile([request()])]]),
      spend: new Map([["enricher:__spend__:2026-09", 995]]),
    });
    const result = await handlerWithDeps(null, deps);
    expect(result.requestsHandled).toBe(1);
    expect(state.spend.get("enricher:__spend__:2026-09")).toBe(1000);
  });

  it("ledger: skips already-processed files and requests", async () => {
    const fileKey2 = `${REQUESTS_PREFIX}2026-09-02.ndjson`;
    const { deps, state } = fakeDeps([{ status: 200, body: hitResponse() }], {
      objects: new Map([
        [FILE_KEY, requestFile([request()])],
        [
          fileKey2,
          requestFile([request(), request({ cloud_entity_id: CE_ID_2 })]),
        ],
      ]),
      ledger: new Set([
        `enricher:${FILE_KEY}`,
        `enricher:req:${request().cloud_entity_id}:${request().requested_at}`,
      ]),
    });
    const result = await handlerWithDeps(null, deps);

    expect(result.filesSkippedLedger).toBe(1);
    expect(result.requestsSkippedLedger).toBe(1); // duplicate request in file 2
    expect(result.requestsHandled).toBe(1); // only CE_ID_2
    expect(state.vendorCalls).toHaveLength(1);
  });

  it("invalid request lines are counted and skipped, valid ones proceed", async () => {
    const { deps, state } = fakeDeps([{ status: 200, body: hitResponse() }], {
      objects: new Map([
        [
          FILE_KEY,
          JSON.stringify(request()) +
            "\n" +
            "not json\n" +
            JSON.stringify({ cloud_entity_id: "bogus" }) +
            "\n",
        ],
      ]),
    });
    const result = await handlerWithDeps(null, deps);
    expect(result.invalidLines).toBe(2);
    expect(result.requestsHandled).toBe(1);
    expect(state.vendorCalls).toHaveLength(1);
  });

  it("maxRequests bounds the run and keeps the file open", async () => {
    const { deps, state } = fakeDeps([{ status: 200, body: hitResponse() }], {
      objects: new Map([
        [FILE_KEY, requestFile([request(), request({ cloud_entity_id: CE_ID_2 })])],
      ]),
    });
    const result = await handlerWithDeps({ maxRequests: 1 }, deps);
    expect(result.requestsHandled).toBe(1);
    expect(state.ledger.has(`enricher:${FILE_KEY}`)).toBe(false);
  });

  it("no request files: clean no-op run, never touches SSM or the vendor", async () => {
    let saltFetched = false;
    const { deps, state } = fakeDeps([]);
    deps.getHmacSalt = async () => {
      saltFetched = true;
      return SALT;
    };
    const result = await handlerWithDeps(null, deps);
    expect(result.filesSeen).toBe(0);
    expect(result.eventsWritten).toBe(0);
    expect(state.vendorCalls).toHaveLength(0);
    expect(saltFetched).toBe(false);
  });
});

describe("PII-safe handler logging", () => {
  it("serializes only the package policy for PII-bearing inputs", () => {
    const output: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((value) => {
      output.push(String(value));
    });

    try {
      log("info", 'enricher run complete', { written: 4, requestsRead: 6, cloud_entity_id: "contact-hmac-secret", detail: "private@example.test" });
    } finally {
      spy.mockRestore();
    }

    expect(output).toHaveLength(1);
    const serialized = output[0]!;
    const record = JSON.parse(serialized);
    expect(record.component).toBe('enricher');
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
