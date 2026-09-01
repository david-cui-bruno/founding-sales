import { describe, expect, it, vi } from "vitest";
import type { CloudSourceEvent } from "@callie-sourcing/shared";
import { buildHotPushMessage, isHotEvent, pushHotEvents } from "../src/notify";

function frboEvent(overrides?: {
  rent?: number | null;
  beds?: number | null;
  locality?: string | null;
}): CloudSourceEvent {
  return {
    contract_version: 1,
    id: "se_01TEST",
    idempotency_key: "a".repeat(64),
    channel: "frbo",
    source_uri: "ses:zillow-alert:m1",
    fetched_at: "2026-09-01T00:00:00.000Z",
    observed_at: "2026-09-01T00:00:00.000Z",
    entity: {
      cloud_entity_id: "ce_01TEST",
      person: null,
      property: {
        situs_address:
          overrides?.locality === null
            ? null
            : {
                line1: "12 Elm St",
                locality: overrides?.locality ?? "Providence",
                region: "RI",
                postal_code: "02906",
                country_code: "US",
              },
        parcel_id: null,
        unit_count: null,
        year_built: null,
        use_code: null,
      },
      known_person: false,
    },
    payload: {
      listing_url: "https://example.com/listing",
      rent_usd: overrides?.rent === undefined ? 1800 : overrides.rent,
      beds: overrides?.beds === undefined ? 3 : overrides.beds,
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
  } as CloudSourceEvent;
}

function communityEvent(): CloudSourceEvent {
  const event = frboEvent();
  return {
    ...event,
    channel: "community",
    entity: { ...event.entity, property: null },
    payload: {
      platform: "reddit",
      topic_keywords: ["providence landlord"],
      post_url: "https://reddit.com/r/x/1",
    },
    signal_flags: { ...event.signal_flags, pain_mentions: ["plumbing", "unresponsive"] },
    trigger: { type: "community_post", weight: 1, half_life_days: 7, window: null },
  } as CloudSourceEvent;
}

describe("isHotEvent", () => {
  it("hot for frbo and community with a trigger", () => {
    expect(isHotEvent(frboEvent())).toBe(true);
    expect(isHotEvent(communityEvent())).toBe(true);
  });

  it("not hot without a trigger", () => {
    expect(isHotEvent({ ...frboEvent(), trigger: null })).toBe(false);
  });
});

describe("buildHotPushMessage", () => {
  it("frbo message carries locality, rent, beds and no PII fields", () => {
    expect(buildHotPushMessage(frboEvent())).toBe("FRBO listing · Providence · $1,800 · 3bd");
  });

  it("frbo message degrades gracefully with missing fields", () => {
    expect(buildHotPushMessage(frboEvent({ rent: null, beds: null, locality: null }))).toBe(
      "FRBO listing · unknown area",
    );
  });

  it("community message carries platform and pain flags", () => {
    expect(buildHotPushMessage(communityEvent())).toBe(
      "Community post · reddit · pain: plumbing, unresponsive",
    );
  });
});

describe("pushHotEvents", () => {
  it("posts one message per hot event to the topic", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const sent = await pushHotEvents(
      { fetchImpl: fetchImpl as unknown as typeof fetch, topic: "t0pic" },
      [frboEvent(), communityEvent(), { ...frboEvent(), trigger: null }],
    );
    expect(sent).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://ntfy.sh/t0pic");
    const body = (fetchImpl.mock.calls[0]?.[1] as { body: string }).body;
    expect(body).not.toMatch(/@|\+1\d{10}/); // no emails or phones ever
  });

  it("counts only ok responses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false });
    const sent = await pushHotEvents(
      { fetchImpl: fetchImpl as unknown as typeof fetch, topic: "t" },
      [frboEvent()],
    );
    expect(sent).toBe(0);
  });
});
