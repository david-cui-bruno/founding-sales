import { describe, expect, it } from "vitest";
import { validateSourceEvent } from "@callie-sourcing/shared";
import {
  buildParcelEvent,
  contentFingerprint,
  isAbsentee,
  isOrgName,
  naturalKey,
  ownerFullName,
  ownerKind,
  RESIDENTIAL_RENTAL_CLASSES,
  shouldRetainRow,
} from "../src/taxroll";
import {
  ROW_COMMERCIAL,
  ROW_SINGLE_FAMILY_ABSENTEE,
  ROW_SINGLE_FAMILY_OWNER_OCC,
  ROW_TWO_FAMILY_LLP_ABSENTEE,
  ROW_TWO_FAMILY_OWNER_OCC,
} from "./fixtures";

const META = {
  fetchedAt: new Date("2026-09-01T03:00:00.000Z"),
  snapshotDate: "2026-09-01",
};

describe("class filtering", () => {
  it("retains multi-family rows regardless of occupancy", () => {
    expect(shouldRetainRow(ROW_TWO_FAMILY_OWNER_OCC)).toBe(true);
    expect(shouldRetainRow(ROW_TWO_FAMILY_LLP_ABSENTEE)).toBe(true);
  });

  it("skips owner-occupied single-family", () => {
    expect(shouldRetainRow(ROW_SINGLE_FAMILY_OWNER_OCC)).toBe(false);
  });

  it("retains absentee single-family (rental SFH)", () => {
    expect(shouldRetainRow(ROW_SINGLE_FAMILY_ABSENTEE)).toBe(true);
  });

  it("skips commercial and exempt classes", () => {
    expect(shouldRetainRow(ROW_COMMERCIAL)).toBe(false);
    expect(shouldRetainRow({ p_id: "x", class: "13" })).toBe(false);
    expect(shouldRetainRow({ p_id: "x", class: "78" })).toBe(false);
  });

  it("retains apartment and combo classes", () => {
    for (const cls of RESIDENTIAL_RENTAL_CLASSES) {
      expect(shouldRetainRow({ ...ROW_TWO_FAMILY_OWNER_OCC, class: cls })).toBe(true);
    }
  });
});

describe("absentee detection", () => {
  it("owner-occupied: mailing street+city equals situs (zip quirk ignored)", () => {
    // Real data quirk: 13 Nashua St situs zip 02906, mailing zip 02904 —
    // still the same street + city, so NOT absentee.
    expect(isAbsentee(ROW_TWO_FAMILY_OWNER_OCC)).toBe(false);
  });

  it("absentee: PO Box mailing differs from situs", () => {
    expect(isAbsentee(ROW_TWO_FAMILY_LLP_ABSENTEE)).toBe(true);
  });

  it("absentee: different city", () => {
    expect(isAbsentee(ROW_SINGLE_FAMILY_ABSENTEE)).toBe(true);
  });

  it("null when mailing is missing", () => {
    expect(isAbsentee({ p_id: "x", formated_address: "1 Main St", city: "Providence" })).toBe(
      null,
    );
  });

  it("normalizes case and punctuation", () => {
    const row = {
      ...ROW_TWO_FAMILY_OWNER_OCC,
      formated_address: "13 NASHUA ST.",
      civic_1: "13",
      street_1: "nashua",
      s_suffix: "st",
    };
    expect(isAbsentee(row)).toBe(false);
  });
});

describe("org detection + owner kind", () => {
  it("detects LLC / LLP / TRUST / INC suffixes", () => {
    expect(isOrgName("RAB Properties LLC")).toBe(true);
    expect(isOrgName("Natale Family LLP")).toBe(true);
    expect(isOrgName("SMITH FAMILY TRUST")).toBe(true);
    expect(isOrgName("ACME INC")).toBe(true);
  });

  it("does not flag plain personal names", () => {
    expect(isOrgName("Ricardo Baez")).toBe(false);
    expect(isOrgName("Wallace Cooper")).toBe(false);
  });

  it("classifies owner kind from company", () => {
    expect(ownerKind(ROW_TWO_FAMILY_LLP_ABSENTEE)).toBe("other"); // LLP -> other
    expect(ownerKind(ROW_COMMERCIAL)).toBe("llc");
    expect(ownerKind({ p_id: "x", company: "SMITH FAMILY TRUST" })).toBe("trust");
    expect(ownerKind(ROW_TWO_FAMILY_OWNER_OCC)).toBe("individual");
    expect(ownerKind({ p_id: "x" })).toBe(null);
  });

  it("builds full name from first/last or company", () => {
    expect(ownerFullName(ROW_TWO_FAMILY_OWNER_OCC)).toBe("Ricardo Baez");
    expect(ownerFullName(ROW_TWO_FAMILY_LLP_ABSENTEE)).toBe("Natale Family LLP");
    expect(ownerFullName({ p_id: "x" })).toBe(null);
  });
});

describe("fingerprint + natural key", () => {
  it("is stable across re-fetches of identical rows", () => {
    expect(contentFingerprint(ROW_TWO_FAMILY_OWNER_OCC)).toBe(
      contentFingerprint({ ...ROW_TWO_FAMILY_OWNER_OCC }),
    );
  });

  it("changes when the owner changes", () => {
    const sold = { ...ROW_TWO_FAMILY_OWNER_OCC, first_name: "New", last_name: "Owner" };
    expect(contentFingerprint(sold)).not.toBe(contentFingerprint(ROW_TWO_FAMILY_OWNER_OCC));
  });

  it("changes when the assessment changes", () => {
    const reassessed = { ...ROW_TWO_FAMILY_OWNER_OCC, total_assmt: "500000" };
    expect(contentFingerprint(reassessed)).not.toBe(
      contentFingerprint(ROW_TWO_FAMILY_OWNER_OCC),
    );
  });

  it("ignores geo jitter (not part of the projection)", () => {
    const jittered = {
      ...ROW_TWO_FAMILY_OWNER_OCC,
      property_location: { type: "Point", coordinates: [-71.4, 41.85] },
    };
    expect(contentFingerprint(jittered)).toBe(contentFingerprint(ROW_TWO_FAMILY_OWNER_OCC));
  });

  it("natural key is pvd-taxroll:<p_id>", () => {
    expect(naturalKey(ROW_TWO_FAMILY_OWNER_OCC)).toBe("pvd-taxroll:30");
  });
});

describe("buildParcelEvent", () => {
  it("builds a schema-valid identity event for an org owner", () => {
    const event = buildParcelEvent(ROW_TWO_FAMILY_LLP_ABSENTEE, META);
    const validation = validateSourceEvent(event);
    expect(validation.success, JSON.stringify(validation)).toBe(true);

    expect(event.channel).toBe("parcel");
    expect(event.trigger).toBe(null);
    expect(event.scores).toBe(null);
    expect(event.source_uri).toBe("socrata:6ub4-iebe:34");
    expect(event.entity.person?.full_name).toBe("Natale Family LLP");
    expect(event.entity.person?.org_names).toEqual(["Natale Family LLP"]);
    expect(event.entity.person?.mailing_address?.line1).toBe("PO Box 6547");
    expect(event.entity.property?.situs_address?.line1).toBe("24 Nashua St");
    expect(event.entity.property?.parcel_id).toBe("001-0040-0000");
    expect(event.entity.property?.use_code).toBe("2");
    expect(event.payload).toEqual({
      assessor_class: "2",
      assessed_value_usd: 373200,
      tax_usd: 5224.8,
      absentee: true,
      owner_kind: "other",
      tax_year: 2025,
    });
    expect(event.provenance).toEqual({
      adapter: "pvd-taxroll",
      adapter_version: "1.0.0",
      confidence: 0.95,
    });
  });

  it("individual owner has empty org_names", () => {
    const event = buildParcelEvent(ROW_TWO_FAMILY_OWNER_OCC, META);
    expect(validateSourceEvent(event).success).toBe(true);
    expect(event.entity.person?.full_name).toBe("Ricardo Baez");
    expect(event.entity.person?.org_names).toEqual([]);
    expect(event.payload.absentee).toBe(false);
    expect(event.payload.owner_kind).toBe("individual");
  });

  it("observed_at falls back to the snapshot date (no per-row record date)", () => {
    const event = buildParcelEvent(ROW_TWO_FAMILY_OWNER_OCC, META);
    expect(event.observed_at).toBe("2026-09-01T00:00:00.000Z");
  });

  it("idempotency key changes with content, stays stable otherwise", () => {
    const a = buildParcelEvent(ROW_TWO_FAMILY_OWNER_OCC, META);
    const b = buildParcelEvent(ROW_TWO_FAMILY_OWNER_OCC, META);
    expect(a.idempotency_key).toBe(b.idempotency_key);
    const sold = buildParcelEvent(
      { ...ROW_TWO_FAMILY_OWNER_OCC, first_name: "New" },
      META,
    );
    expect(sold.idempotency_key).not.toBe(a.idempotency_key);
  });
});
