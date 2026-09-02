import { describe, expect, it } from "vitest";
import {
  computeIdempotencyKey,
  newSourceEventId,
  type CloudSourceEvent,
} from "@callie-sourcing/shared";
import {
  FIT_WEIGHTS,
  fitScore,
  isInSeason,
  rentalStockKind,
  scoreEvent,
  SEASONAL_WEIGHT,
  timingScore,
  triggerMass,
  windowRamp,
  type TriggerInstance,
} from "../src/scoring";

const NOW = new Date("2026-09-01T00:00:00.000Z");

function daysAgo(days: number, from: Date = NOW): string {
  return new Date(from.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function decayTrigger(
  type: TriggerInstance["type"],
  observedDaysAgo: number,
  weight = 1,
): TriggerInstance {
  const halfLives: Record<string, number> = {
    frbo_listing: 3,
    community_post: 7,
    violation_opened: 45,
    permit_filed: 60,
    deed_transfer: 180,
    review_pain: 45,
  };
  return {
    type,
    weight,
    half_life_days: halfLives[type] ?? null,
    window: null,
    observed_at: daysAgo(observedDaysAgo),
  };
}

function baseEvent(overrides: Partial<CloudSourceEvent> = {}): CloudSourceEvent {
  return {
    contract_version: 1,
    id: newSourceEventId(),
    idempotency_key: computeIdempotencyKey("frbo", "test", "fp"),
    channel: "frbo",
    source_uri: "test:fixture",
    fetched_at: NOW.toISOString(),
    observed_at: daysAgo(0),
    entity: {
      cloud_entity_id: null,
      person: null,
      property: null,
      known_person: false,
    },
    payload: {
      listing_url: "https://example.com/listing",
      rent_usd: null,
      beds: null,
      baths: null,
      property_kind: "other",
      listed_at: null,
    },
    signal_flags: {
      self_managed: null,
      vacancy: null,
      pain_mentions: [],
      urgency: 1,
      portfolio_hint: null,
    },
    trigger: {
      type: "frbo_listing",
      weight: 1,
      half_life_days: 3,
      window: null,
    },
    scores: null,
    provenance: { adapter: "test", adapter_version: "1.0.0", confidence: 0.9 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Decay math
// ---------------------------------------------------------------------------

describe("triggerMass — exponential decay", () => {
  it("fresh trigger (age 0) contributes full weight", () => {
    expect(triggerMass(decayTrigger("frbo_listing", 0), NOW)).toBeCloseTo(1.0, 10);
  });

  it("one half-life halves the mass", () => {
    expect(triggerMass(decayTrigger("frbo_listing", 3), NOW)).toBeCloseTo(0.5, 10);
    expect(triggerMass(decayTrigger("community_post", 7), NOW)).toBeCloseTo(0.5, 10);
    expect(triggerMass(decayTrigger("violation_opened", 45), NOW)).toBeCloseTo(0.5, 10);
  });

  it("two half-lives quarter the mass", () => {
    expect(triggerMass(decayTrigger("frbo_listing", 6), NOW)).toBeCloseTo(0.25, 10);
    expect(triggerMass(decayTrigger("deed_transfer", 360), NOW)).toBeCloseTo(0.25, 10);
  });

  it("scales with weight", () => {
    expect(triggerMass(decayTrigger("frbo_listing", 3, 2), NOW)).toBeCloseTo(1.0, 10);
  });

  it("future observed_at clamps to age 0, not amplification", () => {
    expect(triggerMass(decayTrigger("frbo_listing", -5), NOW)).toBeCloseTo(1.0, 10);
  });

  it("informational triggers contribute nothing", () => {
    const registry: TriggerInstance = {
      type: "registry_delta",
      weight: 1,
      half_life_days: null,
      window: null,
      observed_at: daysAgo(0),
    };
    expect(triggerMass(registry, NOW)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Window ramp
// ---------------------------------------------------------------------------

describe("windowRamp", () => {
  const window = {
    opens_at: "2026-09-01T00:00:00.000Z",
    peaks_at: "2026-09-11T00:00:00.000Z",
    closes_at: "2026-10-01T00:00:00.000Z",
  };

  it("is 0 before opens_at", () => {
    expect(windowRamp(window, new Date("2026-08-31T23:59:59Z"))).toBe(0);
  });

  it("is 0 exactly at opens_at, ramps linearly to peaks_at", () => {
    expect(windowRamp(window, new Date("2026-09-01T00:00:00Z"))).toBe(0);
    expect(windowRamp(window, new Date("2026-09-06T00:00:00Z"))).toBeCloseTo(0.5, 10);
    expect(windowRamp(window, new Date("2026-09-08T12:00:00Z"))).toBeCloseTo(0.75, 10);
  });

  it("is 1 from peaks_at through closes_at", () => {
    expect(windowRamp(window, new Date("2026-09-11T00:00:00Z"))).toBe(1);
    expect(windowRamp(window, new Date("2026-09-20T00:00:00Z"))).toBe(1);
    expect(windowRamp(window, new Date("2026-10-01T00:00:00Z"))).toBe(1);
  });

  it("is 0 after closes_at", () => {
    expect(windowRamp(window, new Date("2026-10-01T00:00:01Z"))).toBe(0);
  });

  it("degenerate window (opens == peaks) jumps straight to 1", () => {
    const degenerate = { ...window, peaks_at: window.opens_at };
    expect(windowRamp(degenerate, new Date("2026-09-01T00:00:00Z"))).toBe(1);
  });

  it("window trigger mass = weight × ramp", () => {
    const trigger: TriggerInstance = {
      type: "lead_cert_window",
      weight: 2,
      half_life_days: null,
      window,
      observed_at: daysAgo(0),
    };
    expect(triggerMass(trigger, new Date("2026-09-06T00:00:00Z"))).toBeCloseTo(1.0, 10);
  });
});

// ---------------------------------------------------------------------------
// Seasonal boundaries
// ---------------------------------------------------------------------------

describe("isInSeason", () => {
  it("heating_season spans the year boundary (Oct 1 – Mar 31)", () => {
    expect(isInSeason("heating_season", new Date("2026-10-01T00:00:00Z"))).toBe(true);
    expect(isInSeason("heating_season", new Date("2026-12-15T00:00:00Z"))).toBe(true);
    expect(isInSeason("heating_season", new Date("2027-01-15T00:00:00Z"))).toBe(true);
    expect(isInSeason("heating_season", new Date("2027-03-31T00:00:00Z"))).toBe(true);
    expect(isInSeason("heating_season", new Date("2027-04-01T00:00:00Z"))).toBe(false);
    expect(isInSeason("heating_season", new Date("2026-09-30T00:00:00Z"))).toBe(false);
  });

  it("student_turnover Aug 1 – Sep 30", () => {
    expect(isInSeason("student_turnover", new Date("2026-08-01T00:00:00Z"))).toBe(true);
    expect(isInSeason("student_turnover", new Date("2026-09-30T00:00:00Z"))).toBe(true);
    expect(isInSeason("student_turnover", new Date("2026-07-31T00:00:00Z"))).toBe(false);
    expect(isInSeason("student_turnover", new Date("2026-10-01T00:00:00Z"))).toBe(false);
  });

  it("tax_season Mar 1 – Apr 15", () => {
    expect(isInSeason("tax_season", new Date("2026-03-01T00:00:00Z"))).toBe(true);
    expect(isInSeason("tax_season", new Date("2026-04-15T00:00:00Z"))).toBe(true);
    expect(isInSeason("tax_season", new Date("2026-04-16T00:00:00Z"))).toBe(false);
    expect(isInSeason("tax_season", new Date("2026-02-28T00:00:00Z"))).toBe(false);
  });

  it("in-season seasonal trigger adds fixed 0.15 mass; out of season 0", () => {
    const heating: TriggerInstance = {
      type: "heating_season",
      weight: 1,
      half_life_days: null,
      window: null,
      observed_at: daysAgo(0),
    };
    expect(triggerMass(heating, new Date("2026-12-01T00:00:00Z"))).toBe(SEASONAL_WEIGHT);
    expect(triggerMass(heating, new Date("2026-06-01T00:00:00Z"))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// timingScore: normalization, compound bonus
// ---------------------------------------------------------------------------

describe("timingScore", () => {
  it("no triggers -> 0", () => {
    const result = timingScore([], NOW);
    expect(result.timing).toBe(0);
    expect(result.reasons).toEqual([]);
  });

  it("single fresh weight-1 trigger ≈ 50", () => {
    const result = timingScore([decayTrigger("frbo_listing", 0)], NOW);
    expect(result.timing).toBeCloseTo(50, 5);
  });

  it("mass 2 -> 75, saturating smoothly toward 100", () => {
    const result = timingScore(
      [decayTrigger("frbo_listing", 0), decayTrigger("community_post", 0)],
      NOW,
    );
    expect(result.timing).toBeCloseTo(75, 5);
    const big = timingScore(
      Array.from({ length: 10 }, () => decayTrigger("frbo_listing", 0)),
      NOW,
    );
    expect(big.timing).toBeGreaterThanOrEqual(99.9);
    expect(big.timing).toBeLessThanOrEqual(100);
  });

  it("compound bonus: fresh frbo + violation within 30d multiplies mass 1.5x", () => {
    const frbo = decayTrigger("frbo_listing", 0);
    const violation = decayTrigger("violation_opened", 10);
    const withBonus = timingScore([frbo, violation], NOW);

    const frboMass = 1.0;
    const violationMass = Math.pow(2, -10 / 45);
    const expectedMass = (frboMass + violationMass) * 1.5;
    expect(withBonus.mass).toBeCloseTo(expectedMass, 10);
    expect(withBonus.timing).toBeCloseTo(100 * (1 - Math.pow(2, -expectedMass)), 2);
  });

  it("no compound bonus when the compliance trigger is older than 30d", () => {
    const frbo = decayTrigger("frbo_listing", 0);
    const staleViolation = decayTrigger("violation_opened", 31);
    const result = timingScore([frbo, staleViolation], NOW);
    const expectedMass = 1.0 + Math.pow(2, -31 / 45); // no 1.5x
    expect(result.mass).toBeCloseTo(expectedMass, 10);
  });

  it("no compound bonus for vacancy-only or compliance-only", () => {
    expect(timingScore([decayTrigger("frbo_listing", 0)], NOW).mass).toBeCloseTo(1, 10);
    expect(
      timingScore([decayTrigger("violation_opened", 0)], NOW).mass,
    ).toBeCloseTo(1, 10);
  });

  it("live lead_cert_window counts as current compliance pressure for the bonus", () => {
    const leadCert: TriggerInstance = {
      type: "lead_cert_window",
      weight: 1,
      half_life_days: null,
      window: {
        opens_at: daysAgo(60),
        peaks_at: daysAgo(50),
        closes_at: daysAgo(-30),
      },
      observed_at: daysAgo(60), // observed long ago but window is live
    };
    const result = timingScore([decayTrigger("frbo_listing", 0), leadCert], NOW);
    // frbo 1.0 + leadCert 1.0 (past peak) = 2.0, ×1.5 = 3.0
    expect(result.mass).toBeCloseTo(3.0, 10);
  });

  it("reasons are ordered by contribution and sum to timing", () => {
    const result = timingScore(
      [decayTrigger("frbo_listing", 0), decayTrigger("community_post", 14)],
      NOW,
    );
    expect(result.reasons.length).toBe(2);
    expect(result.reasons[0]!.signal).toBe("frbo_listing_recent");
    expect(result.reasons[0]!.contribution).toBeGreaterThan(
      result.reasons[1]!.contribution,
    );
    const sum = result.reasons.reduce((s, r) => s + r.contribution, 0);
    expect(sum).toBeCloseTo(result.timing, 1);
  });

  it("duplicate trigger types merge into one reason", () => {
    const result = timingScore(
      [decayTrigger("frbo_listing", 0), decayTrigger("frbo_listing", 3)],
      NOW,
    );
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]!.signal).toBe("frbo_listing_recent");
  });
});

// ---------------------------------------------------------------------------
// fitScore: observability rescaling
// ---------------------------------------------------------------------------

describe("fitScore — observability normalization", () => {
  it("frbo event with nothing else: vacancy observable+earned -> 100", () => {
    // Only live_vacancy is observable (channel frbo), and it is earned.
    const result = fitScore(baseEvent(), { now: NOW });
    expect(result.fit).toBe(100);
    expect(result.reasons).toEqual([
      { signal: "live_vacancy", contribution: FIT_WEIGHTS.live_vacancy },
    ]);
  });

  it("observed-false keeps the signal in the denominator", () => {
    // community event: vacancy false (observed absent) -> observable, earns 0.
    const event = baseEvent({
      channel: "community",
      payload: {
        platform: "reddit",
        topic_keywords: ["k"],
        post_url: "https://reddit.com/x",
      },
      signal_flags: {
        self_managed: null,
        vacancy: false,
        pain_mentions: [],
        urgency: 1,
        portfolio_hint: 12,
      },
    });
    const result = fitScore(event, { now: NOW });
    // observable: live_vacancy (0/15) + portfolio_in_band (15/15) -> 15/30
    expect(result.fit).toBe(50);
    expect(result.reasons).toEqual([
      { signal: "portfolio_in_band", contribution: FIT_WEIGHTS.portfolio_in_band },
    ]);
  });

  it("portfolio banding: 10-19 full, 5-9 and 20-30 partial, outside 0", () => {
    const withDoors = (doors: number) =>
      fitScore(baseEvent(), { portfolioDoors: doors, now: NOW });
    // Denominator: vacancy 15 (earned) + portfolio 15
    expect(withDoors(12).fit).toBe(100);
    expect(withDoors(7).fit).toBe(Math.round((100 * (15 + 10)) / 30));
    expect(withDoors(25).fit).toBe(Math.round((100 * (15 + 10)) / 30));
    expect(withDoors(2).fit).toBe(50); // 15/30
    expect(withDoors(40).fit).toBe(50);
  });

  it("recent acquisition needs deed_transfer < 365d", () => {
    const fresh = fitScore(baseEvent(), {
      recentTriggers: [decayTrigger("deed_transfer", 100)],
      now: NOW,
    });
    // vacancy 15 + acquisition 15 over 30
    expect(fresh.fit).toBe(100);
    const stale = fitScore(baseEvent(), {
      recentTriggers: [decayTrigger("deed_transfer", 400)],
      now: NOW,
    });
    expect(stale.fit).toBe(50); // acquisition observable, earns 0
  });

  it("compliance deadline via open violation or active lead_cert_window", () => {
    const violation = fitScore(baseEvent(), {
      recentTriggers: [decayTrigger("violation_opened", 5)],
      now: NOW,
    });
    expect(violation.fit).toBe(100); // (15+12)/27
    const inactiveWindow: TriggerInstance = {
      type: "lead_cert_window",
      weight: 1,
      half_life_days: null,
      window: {
        opens_at: daysAgo(-10),
        peaks_at: daysAgo(-20),
        closes_at: daysAgo(-30),
      },
      observed_at: daysAgo(0),
    };
    const notYet = fitScore(baseEvent(), {
      recentTriggers: [inactiveWindow],
      now: NOW,
    });
    expect(notYet.fit).toBe(Math.round((100 * 15) / 27));
  });

  it("self-managed at distance requires both halves known", () => {
    const event = baseEvent({
      payload: {
        listing_url: "https://example.com/x",
        rent_usd: null,
        beds: null,
        baths: null,
        property_kind: "other",
        listed_at: null,
        absentee: true,
      } as never,
      signal_flags: {
        self_managed: true,
        vacancy: null,
        pain_mentions: [],
        urgency: 1,
        portfolio_hint: null,
      },
    });
    const result = fitScore(event, { now: NOW });
    // vacancy 15 + self_managed_at_distance 10 over 25
    expect(result.fit).toBe(100);
    // absentee missing -> unobservable
    const noAbsentee = fitScore(baseEvent({
      signal_flags: {
        self_managed: true,
        vacancy: null,
        pain_mentions: [],
        urgency: 1,
        portfolio_hint: null,
      },
    }), { now: NOW });
    expect(noAbsentee.fit).toBe(100); // only vacancy observable
    expect(noAbsentee.reasons).toHaveLength(1);
  });

  it("multi_unit_stock: Boston multi-family use codes earn, 1-family and land earn 0", () => {
    const withUse = (use_code: string | null) =>
      baseEvent({
        entity: {
          cloud_entity_id: null,
          person: null,
          property: {
            situs_address: null,
            parcel_id: null,
            unit_count: null,
            year_built: null,
            use_code,
          },
          known_person: false,
        },
      });

    // Multi-family: signal observable and earned -> vacancy(15)+multi(12) of 27 observable = 100
    const multi = fitScore(withUse("Residential 3-family"), { now: NOW });
    expect(multi.fit).toBe(100);
    expect(multi.reasons.map((r) => r.signal)).toContain("multi_unit_stock");

    // 1-family: observable but earns 0 -> vacancy 15 of 27
    const single = fitScore(withUse("Residential 1-family"), { now: NOW });
    expect(single.fit).toBe(Math.round((100 * 15) / 27));
    expect(single.reasons.map((r) => r.signal)).not.toContain("multi_unit_stock");

    // Land: observable, earns 0 like 1-family
    const land = fitScore(withUse("Residential Land"), { now: NOW });
    expect(land.fit).toBe(Math.round((100 * 15) / 27));

    // Unknown use code: UNOBSERVABLE, denominator unchanged (fit as before this signal)
    const unknown = fitScore(withUse(null), { now: NOW });
    expect(unknown.fit).toBe(100); // only vacancy observable
    expect(unknown.reasons.map((r) => r.signal)).not.toContain("multi_unit_stock");
  });

  it("rentalStockKind classifies both Boston and Providence vocabularies", () => {
    // Boston RentSmart property_type values
    expect(rentalStockKind("Residential 3-family")).toBe("multi");
    expect(rentalStockKind("Residential 2-family")).toBe("multi");
    expect(rentalStockKind("Residential 4 or more family")).toBe("multi");
    expect(rentalStockKind("Residential 7 or more units")).toBe("multi");
    expect(rentalStockKind("Mixed Use (Res. and Comm.)")).toBe("multi");
    expect(rentalStockKind("Residential 1-family")).toBe("single_or_none");
    expect(rentalStockKind("Residential Land")).toBe("single_or_none");
    expect(rentalStockKind("Condominium Main*")).toBe("single_or_none");
    // Providence tax roll class codes
    expect(rentalStockKind("2")).toBe("multi"); // 2-5 family
    expect(rentalStockKind("03-610")).toBe("multi");
    expect(rentalStockKind("03-11+")).toBe("multi");
    expect(rentalStockKind("04-05U")).toBe("multi");
    expect(rentalStockKind("04-610")).toBe("multi");
    expect(rentalStockKind("04-11+")).toBe("multi");
    expect(rentalStockKind("1")).toBe("single_or_none"); // single family
    // Unknown vocabulary -> unknown (unobservable)
    expect(rentalStockKind("Commercial Warehouse")).toBe("unknown");
    expect(rentalStockKind(null)).toBe("unknown");
    expect(rentalStockKind("")).toBe("unknown");
  });

  it("pre-1940 stock from property.year_built", () => {
    const event = baseEvent({
      entity: {
        cloud_entity_id: null,
        person: null,
        property: {
          situs_address: null,
          parcel_id: null,
          unit_count: null,
          year_built: 1918,
          use_code: null,
        },
        known_person: false,
      },
    });
    expect(fitScore(event, { now: NOW }).fit).toBe(100); // (15+8)/23
    const newer = baseEvent({
      entity: {
        ...event.entity,
        property: { ...event.entity.property!, year_built: 1990 },
      },
    });
    expect(fitScore(newer, { now: NOW }).fit).toBe(Math.round((100 * 15) / 23));
  });

  it("reachable direct contact from person phones/emails", () => {
    const person = {
      full_name: "JANE ROE",
      mailing_address: null,
      phones: ["+14015551234"],
      emails: [],
      org_names: [],
    };
    const event = baseEvent({
      entity: { cloud_entity_id: null, person, property: null, known_person: false },
    });
    expect(fitScore(event, { now: NOW }).fit).toBe(100); // (15+8)/23
    const unreachable = baseEvent({
      entity: {
        cloud_entity_id: null,
        person: { ...person, phones: [] },
        property: null,
        known_person: false,
      },
    });
    expect(fitScore(unreachable, { now: NOW }).fit).toBe(Math.round((100 * 15) / 23));
  });

  it("llc/trust owner kind from entity context", () => {
    expect(fitScore(baseEvent(), { ownerKind: "llc", now: NOW }).fit).toBe(100);
    expect(fitScore(baseEvent(), { ownerKind: "trust", now: NOW }).fit).toBe(100);
    expect(fitScore(baseEvent(), { ownerKind: "individual", now: NOW }).fit).toBe(
      Math.round((100 * 15) / 22),
    );
    // null/undefined -> unobservable
    expect(fitScore(baseEvent(), { ownerKind: null, now: NOW }).fit).toBe(100);
  });

  it("owner_kind falls back to the event payload when context has no entity data", () => {
    // Regression: live parcel events scored fit 0 because the handler passes
    // no ownerKind and the payload was ignored.
    const parcelish = baseEvent({
      channel: "community",
      payload: {
        platform: "reddit",
        topic_keywords: ["k"],
        post_url: "https://reddit.com/x",
        // fitScore reads owner_kind straight off the payload record.
        owner_kind: "llc",
      } as never,
    });
    const result = fitScore(parcelish, { now: NOW });
    // observable: llc 7/7 -> earns; live_vacancy not observable (community, vacancy null)
    expect(result.reasons).toContainEqual({
      signal: "llc_owner_no_pm",
      contribution: FIT_WEIGHTS.llc_owner_no_pm,
    });
    // context wins over payload when both present
    const both = fitScore(parcelish, { ownerKind: "individual", now: NOW });
    expect(both.reasons.map((r) => r.signal)).not.toContain("llc_owner_no_pm");
  });

  it("prior_tool_adoption never enters the denominator", () => {
    // If it did, a full-signal event could not reach 100.
    const result = fitScore(baseEvent(), {
      portfolioDoors: 12,
      ownerKind: "llc",
      recentTriggers: [
        decayTrigger("deed_transfer", 30),
        decayTrigger("violation_opened", 5),
        decayTrigger("permit_filed", 30),
      ],
      now: NOW,
    });
    expect(result.fit).toBe(100);
  });

  it("active permit <=6mo earns 5", () => {
    const active = fitScore(baseEvent(), {
      recentTriggers: [decayTrigger("permit_filed", 100)],
      now: NOW,
    });
    expect(active.fit).toBe(100); // (15+5)/20
    const stale = fitScore(baseEvent(), {
      recentTriggers: [decayTrigger("permit_filed", 200)],
      now: NOW,
    });
    expect(stale.fit).toBe(75); // 15/20
  });

  it("no observable signals -> fit 0", () => {
    const event = baseEvent({ channel: "community", payload: {
      platform: "reddit",
      topic_keywords: ["k"],
      post_url: "https://reddit.com/x",
    } });
    expect(fitScore(event, { now: NOW }).fit).toBe(0);
  });

  it("fit is capped at 100 and reasons sorted desc", () => {
    const result = fitScore(baseEvent(), {
      portfolioDoors: 12,
      recentTriggers: [decayTrigger("violation_opened", 1)],
      now: NOW,
    });
    expect(result.fit).toBeLessThanOrEqual(100);
    const contributions = result.reasons.map((r) => r.contribution);
    expect([...contributions].sort((a, b) => b - a)).toEqual(contributions);
  });
});

// ---------------------------------------------------------------------------
// scoreEvent: merged reasons
// ---------------------------------------------------------------------------

describe("scoreEvent", () => {
  it("merges fit and timing reasons, top 3 by contribution", () => {
    const context = {
      portfolioDoors: 12,
      recentTriggers: [decayTrigger("frbo_listing", 0), decayTrigger("violation_opened", 2)],
    };
    const result = scoreEvent(baseEvent(), context, NOW);
    expect(result.reasons.length).toBeGreaterThanOrEqual(1);
    expect(result.reasons.length).toBeLessThanOrEqual(3);
    const contributions = result.reasons.map((r) => r.contribution);
    expect([...contributions].sort((a, b) => b - a)).toEqual(contributions);
    expect(Number.isInteger(result.fit)).toBe(true);
    expect(Number.isInteger(result.timing)).toBe(true);
    for (const r of result.reasons) expect(Number.isInteger(r.contribution)).toBe(true);
  });

  it("zero-signal event still emits one reason (schema needs 1..3)", () => {
    const event = baseEvent({
      channel: "community",
      payload: { platform: "reddit", topic_keywords: ["k"], post_url: "https://r.com/x" },
    });
    const result = scoreEvent(event, { recentTriggers: [] }, NOW);
    expect(result.fit).toBe(0);
    expect(result.timing).toBe(0);
    expect(result.reasons).toEqual([{ signal: "no_signals", contribution: 0 }]);
  });

  it("truncates to exactly 3 reasons when more contribute", () => {
    const context = {
      portfolioDoors: 12,
      ownerKind: "llc" as const,
      recentTriggers: [
        decayTrigger("frbo_listing", 0),
        decayTrigger("violation_opened", 2),
        decayTrigger("deed_transfer", 30),
        decayTrigger("permit_filed", 30),
      ],
    };
    const result = scoreEvent(baseEvent(), context, NOW);
    expect(result.reasons).toHaveLength(3);
  });
});
