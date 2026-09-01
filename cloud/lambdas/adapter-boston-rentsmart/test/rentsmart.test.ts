import { describe, expect, it } from "vitest";
import { validateSourceEvent } from "@callie-sourcing/shared";
import {
  buildViolationEvent,
  contentFingerprint,
  isoDateOf,
  isoDatetimeOf,
  isOrgName,
  isViolationKind,
  naturalKey,
  situsAddress,
  VIOLATION_TYPES,
} from "../src/rentsmart";
import {
  ROW_ENFORCEMENT_VIOLATION,
  ROW_HOUSING_COMPLAINT,
  ROW_LLC_VIOLATION,
  ROW_NO_OWNER,
  ROW_SANITATION_REQUEST,
} from "./fixtures";

const META = {
  fetchedAt: new Date("2026-09-01T03:00:00.000Z"),
  snapshotDate: "2026-09-01",
};

describe("row kind mapping", () => {
  it("violation kinds get triggers, complaints/requests do not", () => {
    expect(isViolationKind(ROW_ENFORCEMENT_VIOLATION)).toBe(true);
    expect(isViolationKind(ROW_LLC_VIOLATION)).toBe(true);
    expect(isViolationKind(ROW_SANITATION_REQUEST)).toBe(false);
    expect(isViolationKind(ROW_HOUSING_COMPLAINT)).toBe(false);
  });

  it("covers the observed catalog", () => {
    expect(VIOLATION_TYPES).toEqual(
      new Set(["Enforcement Violations", "Housing Violations", "Building Violations"]),
    );
    expect(isViolationKind({ _id: 1, violation_type: "Housing Violations" })).toBe(true);
    expect(isViolationKind({ _id: 1, violation_type: "Building Violations" })).toBe(true);
    expect(isViolationKind({ _id: 1, violation_type: "Civic Maintenance Requests" })).toBe(
      false,
    );
  });
});

describe("date parsing", () => {
  it("extracts the ISO date", () => {
    expect(isoDateOf("2026-08-29 02:35:00.983+00")).toBe("2026-08-29");
    expect(isoDateOf(null)).toBe(null);
    expect(isoDateOf("garbage")).toBe(null);
  });

  it("converts to ISO datetime", () => {
    expect(isoDatetimeOf("2026-08-28 00:00:00+00")).toBe("2026-08-28T00:00:00.000Z");
    expect(isoDatetimeOf("2026-08-29 02:35:00.983+00")).toBe("2026-08-29T02:35:00.983Z");
    expect(isoDatetimeOf(null)).toBe(null);
  });
});

describe("address + org detection", () => {
  it("splits the zip suffix out of the address", () => {
    expect(situsAddress(ROW_SANITATION_REQUEST)).toEqual({
      line1: "23 Page St",
      locality: "Boston",
      region: "MA",
      postal_code: "02121",
      country_code: "US",
    });
  });

  it("detects org owners", () => {
    expect(isOrgName("292 BENNINGTON STREET LLC")).toBe(true);
    expect(isOrgName("EIGHTY 8 WALTHAM STREET CONDOMINIUM ASSN")).toBe(true);
    expect(isOrgName("POWELL UDA M")).toBe(false);
  });
});

describe("natural key + fingerprint", () => {
  it("natural key is composite and stable", () => {
    const key = naturalKey(ROW_ENFORCEMENT_VIOLATION);
    expect(key).toBe(
      "boston-rentsmart:269:2026-08-28:ENFORCEMENT VIOLATIONS:34 ROBESON ST 02130",
    );
    expect(naturalKey({ ...ROW_ENFORCEMENT_VIOLATION })).toBe(key);
  });

  it("fingerprint stable across refetch, changes on owner change", () => {
    expect(contentFingerprint(ROW_LLC_VIOLATION)).toBe(
      contentFingerprint({ ...ROW_LLC_VIOLATION }),
    );
    expect(
      contentFingerprint({ ...ROW_LLC_VIOLATION, owner: "SOMEONE ELSE" }),
    ).not.toBe(contentFingerprint(ROW_LLC_VIOLATION));
  });

  it("fingerprint ignores geo jitter", () => {
    expect(
      contentFingerprint({ ...ROW_LLC_VIOLATION, latitude: "42.0", longitude: "-71.0" }),
    ).toBe(contentFingerprint(ROW_LLC_VIOLATION));
  });
});

describe("buildViolationEvent", () => {
  it("violation row: schema-valid with violation_opened trigger", () => {
    const event = buildViolationEvent(ROW_ENFORCEMENT_VIOLATION, META);
    const validation = validateSourceEvent(event);
    expect(validation.success, JSON.stringify(validation)).toBe(true);

    expect(event.channel).toBe("violation");
    expect(event.trigger).toEqual({
      type: "violation_opened",
      weight: 1.0,
      half_life_days: 45,
      window: null,
    });
    expect(event.observed_at).toBe("2026-08-28T00:00:00.000Z");
    expect(event.payload).toEqual({
      violation_kind: "Enforcement Violations",
      status: "open",
      opened_at: "2026-08-28",
      case_ref: "269",
    });
    expect(event.entity.person?.full_name).toBe("TRACY PHILIP A JR TS");
    expect(event.entity.property?.situs_address?.line1).toBe("34 Robeson St");
    expect(event.entity.property?.parcel_id).toBe("1102497000");
    expect(event.entity.property?.year_built).toBe(1905);
    expect(event.entity.property?.use_code).toBe("Residential 3-family");
    expect(event.provenance).toEqual({
      adapter: "boston-rentsmart",
      adapter_version: "1.0.0",
      confidence: 0.9,
    });
  });

  it("complaint row: identity event with trigger null, kind in payload", () => {
    const event = buildViolationEvent(ROW_HOUSING_COMPLAINT, META);
    expect(validateSourceEvent(event).success).toBe(true);
    expect(event.trigger).toBe(null);
    expect(event.payload.violation_kind).toBe("Housing Complaints");
    expect(event.payload.status).toBe("unknown");
    expect(event.signal_flags.urgency).toBe(0);
  });

  it("service request row: identity event", () => {
    const event = buildViolationEvent(ROW_SANITATION_REQUEST, META);
    expect(validateSourceEvent(event).success).toBe(true);
    expect(event.trigger).toBe(null);
    expect(event.payload.violation_kind).toBe("Sanitation Requests");
  });

  it("LLC owner lands in org_names", () => {
    const event = buildViolationEvent(ROW_LLC_VIOLATION, META);
    expect(event.entity.person?.org_names).toEqual(["292 BENNINGTON STREET LLC"]);
  });

  it("individual owner has empty org_names", () => {
    const event = buildViolationEvent(ROW_SANITATION_REQUEST, META);
    expect(event.entity.person?.org_names).toEqual([]);
  });

  it("missing owner -> person null, property only", () => {
    const event = buildViolationEvent(ROW_NO_OWNER, META);
    expect(validateSourceEvent(event).success).toBe(true);
    expect(event.entity.person).toBe(null);
    expect(event.entity.property?.situs_address?.line1).toBe("34 Robeson St");
  });

  it("idempotency key stable for identical rows, distinct across rows", () => {
    const a = buildViolationEvent(ROW_LLC_VIOLATION, META);
    const b = buildViolationEvent(ROW_LLC_VIOLATION, META);
    const c = buildViolationEvent(ROW_ENFORCEMENT_VIOLATION, META);
    expect(a.idempotency_key).toBe(b.idempotency_key);
    expect(a.idempotency_key).not.toBe(c.idempotency_key);
  });
});
