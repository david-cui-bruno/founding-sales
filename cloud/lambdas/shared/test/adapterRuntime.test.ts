import { describe, expect, it } from "vitest";
import { emitEvents } from "../src/adapterRuntime.js";
import {
  computeIdempotencyKey,
  newCloudEntityId,
  newSourceEventId,
  type CloudSourceEvent,
} from "../src/sourceEvent.js";

function validParcelEvent(naturalKey = "pvd-taxroll:29", fingerprint = "fp-1"): CloudSourceEvent {
  return {
    contract_version: 1,
    id: newSourceEventId(),
    idempotency_key: computeIdempotencyKey("parcel", naturalKey, fingerprint),
    channel: "parcel",
    source_uri: `socrata:6ub4-iebe:${naturalKey}`,
    fetched_at: "2026-09-01T03:00:00.000Z",
    observed_at: "2026-09-01T00:00:00.000Z",
    entity: {
      cloud_entity_id: newCloudEntityId(),
      person: {
        full_name: "Natale Family LLP",
        mailing_address: {
          line1: "PO Box 6547",
          locality: "Providence",
          region: "RI",
          postal_code: "02940",
          country_code: "US",
        },
        phones: [],
        emails: [],
        org_names: ["Natale Family LLP"],
      },
      property: {
        situs_address: {
          line1: "24 Nashua St",
          locality: "Providence",
          region: "RI",
          postal_code: "02906",
          country_code: "US",
        },
        parcel_id: "001-0040-0000",
        unit_count: null,
        year_built: null,
        use_code: "2",
      },
      known_person: false,
    },
    payload: {
      assessor_class: "2",
      assessed_value_usd: 373200,
      tax_usd: 5224.8,
      absentee: true,
      owner_kind: "other",
      tax_year: 2025,
    },
    signal_flags: {
      self_managed: null,
      vacancy: null,
      pain_mentions: [],
      urgency: 0,
      portfolio_hint: null,
    },
    trigger: null,
    scores: null,
    provenance: {
      adapter: "pvd-taxroll",
      adapter_version: "1.0.0",
      confidence: 0.95,
    },
  };
}

interface Recorded {
  puts: Array<Record<string, unknown>>;
  s3Puts: Array<{ Bucket: string; Key: string; Body: string; ContentType: string }>;
}

function fakeClients(options: { claimedKeys?: Set<string> } = {}) {
  const recorded: Recorded = { puts: [], s3Puts: [] };
  const claimed = options.claimedKeys ?? new Set<string>();
  const dynamo = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async send(command: any): Promise<any> {
      const input = command.input as { Item: { idempotency_key: { S: string } } };
      recorded.puts.push(input);
      const key = input.Item.idempotency_key.S;
      if (claimed.has(key)) {
        const error = new Error("The conditional request failed");
        error.name = "ConditionalCheckFailedException";
        throw error;
      }
      claimed.add(key);
      return {};
    },
  };
  const s3 = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async send(command: any): Promise<any> {
      recorded.s3Puts.push(command.input);
      return {};
    },
  };
  return { recorded, dynamo, s3, claimed };
}

const ENV = {
  inboxBucket: "callie-sourcing-inbox-326255650484",
  idempotencyTable: "callie-sourcing-idempotency",
  adapterName: "pvd-taxroll",
};

const FIXED_NOW = () => new Date("2026-09-01T03:00:00.000Z");

describe("emitEvents", () => {
  it("writes one ndjson file with all valid events", async () => {
    const { recorded, dynamo, s3 } = fakeClients();
    const events = [validParcelEvent("pvd-taxroll:1", "a"), validParcelEvent("pvd-taxroll:2", "b")];
    const result = await emitEvents({ dynamo, s3, ...ENV, events, now: FIXED_NOW });

    expect(result).toMatchObject({ total: 2, written: 2, idempotencySkips: 0 });
    expect(result.inboxKey).toMatch(
      /^events\/2026-09-01\/pvd-taxroll-[0-9A-HJKMNP-TV-Z]{26}\.ndjson$/,
    );
    expect(recorded.s3Puts).toHaveLength(1);
    const body = recorded.s3Puts[0]!.Body;
    const lines = body.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).channel).toBe("parcel");
    expect(recorded.s3Puts[0]!.ContentType).toBe("application/x-ndjson");
    expect(recorded.s3Puts[0]!.Bucket).toBe(ENV.inboxBucket);
  });

  it("skips events whose idempotency key is already claimed", async () => {
    const dupe = validParcelEvent("pvd-taxroll:1", "same");
    const { dynamo, s3, recorded } = fakeClients({
      claimedKeys: new Set([dupe.idempotency_key]),
    });
    const fresh = validParcelEvent("pvd-taxroll:2", "b");
    const result = await emitEvents({ dynamo, s3, ...ENV, events: [dupe, fresh], now: FIXED_NOW });

    expect(result).toMatchObject({ total: 2, written: 1, idempotencySkips: 1 });
    const body = recorded.s3Puts[0]!.Body;
    expect(body.trimEnd().split("\n")).toHaveLength(1);
  });

  it("writes no file when every event is a dupe", async () => {
    const dupe = validParcelEvent();
    const { dynamo, s3, recorded } = fakeClients({
      claimedKeys: new Set([dupe.idempotency_key]),
    });
    const result = await emitEvents({ dynamo, s3, ...ENV, events: [dupe], now: FIXED_NOW });

    expect(result).toMatchObject({ total: 1, written: 0, idempotencySkips: 1, inboxKey: null });
    expect(recorded.s3Puts).toHaveLength(0);
  });

  it("returns zero counts for an empty batch without touching AWS", async () => {
    const { dynamo, s3, recorded } = fakeClients();
    const result = await emitEvents({ dynamo, s3, ...ENV, events: [], now: FIXED_NOW });
    expect(result).toEqual({ total: 0, written: 0, idempotencySkips: 0, inboxKey: null });
    expect(recorded.puts).toHaveLength(0);
    expect(recorded.s3Puts).toHaveLength(0);
  });

  it("throws on an invalid event (adapter bug, not a data condition)", async () => {
    const { dynamo, s3 } = fakeClients();
    const bad = validParcelEvent();
    // Violate the parcel payload schema.
    (bad.payload as Record<string, unknown>).assessor_class = 42;
    await expect(
      emitEvents({ dynamo, s3, ...ENV, events: [bad], now: FIXED_NOW }),
    ).rejects.toThrow(/invalid event/);
  });

  it("conditional-puts idempotency keys with TTL", async () => {
    const { dynamo, s3, recorded } = fakeClients();
    const event = validParcelEvent();
    await emitEvents({ dynamo, s3, ...ENV, events: [event], now: FIXED_NOW });

    const put = recorded.puts[0] as {
      TableName: string;
      ConditionExpression: string;
      Item: { idempotency_key: { S: string }; expires_at: { N: string } };
    };
    expect(put.TableName).toBe(ENV.idempotencyTable);
    expect(put.ConditionExpression).toBe("attribute_not_exists(idempotency_key)");
    expect(put.Item.idempotency_key.S).toBe(event.idempotency_key);
    const nowSec = Math.floor(FIXED_NOW().getTime() / 1000);
    expect(Number(put.Item.expires_at.N)).toBe(nowSec + 90 * 24 * 60 * 60);
  });
});
