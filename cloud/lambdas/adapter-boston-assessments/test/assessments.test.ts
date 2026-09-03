import { describe, expect, it } from "vitest";
import {
  deterministicCloudEntityId,
  validateSourceEvent,
} from "@callie-sourcing/shared";
import {
  buildParcelEvent,
  contentFingerprint,
  isAbsentee,
  isOrgName,
  naturalKey,
  ownerKind,
  ownerMatchesEntity,
  toNumber,
  toYear,
  unitCount,
  type AssessmentRow,
} from "../src/assessments";
import {
  ROW_CONDO,
  ROW_LLC_APARTMENT,
  ROW_R3_OWNER_OCC,
  ROW_TRUST_ABSENTEE,
} from "./fixtures";

const META = {
  fetchedAt: new Date("2026-09-03T12:00:00.000Z"),
  snapshotDate: "2026-09-03",
};

describe("field parsing", () => {
  it("parses comma-grouped values and dollar tax strings", () => {
    expect(toNumber("822,900")).toBe(822900);
    expect(toNumber(" $10,203.96 ")).toBe(10203.96);
    expect(toNumber("")).toBeNull();
    expect(toNumber(null)).toBeNull();
    expect(toNumber("N/A")).toBeNull();
  });

  it("parses plausible years only", () => {
    expect(toYear("1900")).toBe(1900);
    expect(toYear("0")).toBeNull();
    expect(toYear(null)).toBeNull();
  });

  it("sums unit counts across RES/COM/RC fields", () => {
    expect(unitCount(ROW_LLC_APARTMENT)).toBe(9); // 8 res + 1 com
    expect(unitCount(ROW_R3_OWNER_OCC)).toBeNull(); // all null
    expect(unitCount(ROW_CONDO)).toBe(1);
  });
});

describe("absentee", () => {
  it("is false when mailing zip5 == situs zip5", () => {
    expect(isAbsentee(ROW_R3_OWNER_OCC)).toBe(false);
  });
  it("is true when zips differ", () => {
    expect(isAbsentee(ROW_TRUST_ABSENTEE)).toBe(true);
    expect(isAbsentee(ROW_LLC_APARTMENT)).toBe(true);
  });
  it("is null when either zip is missing", () => {
    expect(isAbsentee({ ...ROW_R3_OWNER_OCC, MAIL_ZIP_CODE: null })).toBeNull();
    expect(isAbsentee({ ...ROW_R3_OWNER_OCC, ZIP_CODE: "" })).toBeNull();
  });
});

describe("owner classification", () => {
  it("classifies llc / trust / individual", () => {
    expect(ownerKind(ROW_LLC_APARTMENT)).toBe("llc");
    expect(ownerKind(ROW_TRUST_ABSENTEE)).toBe("trust");
    expect(ownerKind(ROW_R3_OWNER_OCC)).toBe("individual");
    expect(ownerKind({ ...ROW_R3_OWNER_OCC, OWNER: null })).toBeNull();
  });

  it("detects org names for org_names", () => {
    expect(isOrgName("MAVERICK HOLDINGS LLC")).toBe(true);
    expect(isOrgName("SEMBRANO LIVING TRUST")).toBe(true);
    expect(isOrgName("PASCUCCI CARLO")).toBe(false);
  });
});

describe("ownerMatchesEntity", () => {
  const entity = {
    canonicalName: "PASCUCCI CARLO",
    normalizedName: "CARLO PASCUCCI",
  };
  it("matches exact raw canonical name", () => {
    expect(ownerMatchesEntity("PASCUCCI CARLO", entity)).toBe(true);
  });
  it("matches token-reordered names via normalized form", () => {
    expect(ownerMatchesEntity("CARLO PASCUCCI", entity)).toBe(true);
  });
  it("matches suffix-noise variants (LLC stripping)", () => {
    const llc = {
      canonicalName: "MAVERICK HOLDINGS LLC",
      normalizedName: "HOLDINGS MAVERICK",
    };
    expect(ownerMatchesEntity("MAVERICK HOLDINGS, L.L.C.", llc)).toBe(true);
  });
  it("rejects different owners and empty names", () => {
    expect(ownerMatchesEntity("SMITH JOHN", entity)).toBe(false);
    expect(ownerMatchesEntity("", entity)).toBe(false);
    expect(ownerMatchesEntity(null, entity)).toBe(false);
  });
});

describe("fingerprint / idempotency", () => {
  it("is stable across identical rows and flips on owner change", () => {
    expect(contentFingerprint(ROW_R3_OWNER_OCC)).toBe(
      contentFingerprint({ ...ROW_R3_OWNER_OCC }),
    );
    expect(contentFingerprint(ROW_R3_OWNER_OCC)).not.toBe(
      contentFingerprint({ ...ROW_R3_OWNER_OCC, OWNER: "NEW OWNER LLC" }),
    );
    expect(contentFingerprint(ROW_R3_OWNER_OCC)).not.toBe(
      contentFingerprint({ ...ROW_R3_OWNER_OCC, TOTAL_VALUE: "900,000" }),
    );
  });

  it("ignores cosmetic whitespace/punctuation changes", () => {
    expect(contentFingerprint(ROW_R3_OWNER_OCC)).toBe(
      contentFingerprint({ ...ROW_R3_OWNER_OCC, OWNER: "  PASCUCCI  CARLO " }),
    );
  });

  it("natural key is ckan-style with the PID", () => {
    expect(naturalKey(ROW_R3_OWNER_OCC)).toBe("ckan:boston-assessments:0100001000");
  });
});

describe("buildParcelEvent", () => {
  it("builds a valid parcel event with mapped fields", () => {
    const event = buildParcelEvent(ROW_LLC_APARTMENT, META);
    const validation = validateSourceEvent(event);
    expect(validation.success, JSON.stringify(validation)).toBe(true);

    expect(event.channel).toBe("parcel");
    expect(event.source_uri).toBe(
      "ckan:data.boston.gov:ee73430d-96c0-423e-ad21-c4cfb54c8961:0200003000",
    );
    expect(event.trigger).toBeNull();
    expect(event.entity.person?.full_name).toBe("MAVERICK HOLDINGS LLC");
    expect(event.entity.person?.org_names).toEqual(["MAVERICK HOLDINGS LLC"]);
    expect(event.entity.person?.mailing_address).toEqual({
      line1: "1 FINANCIAL CTR STE 900",
      locality: "BOSTON",
      region: "MA",
      postal_code: "02111",
      country_code: "US",
    });
    expect(event.entity.property?.situs_address).toEqual({
      line1: "12 Maverick SQ",
      locality: "EAST BOSTON",
      region: "MA",
      postal_code: "02128",
      country_code: "US",
    });
    expect(event.entity.property?.unit_count).toBe(9);
    expect(event.entity.property?.year_built).toBe(1925);
    expect(event.entity.property?.use_code).toBe("A");
    expect(event.payload).toEqual({
      assessor_class: "A",
      assessed_value_usd: 3200000,
      tax_usd: 39680,
      absentee: true,
      owner_kind: "llc",
      tax_year: 2026,
    });
  });

  it("mints deterministic cloud entity ids from owner + MAILING zip5", () => {
    const event = buildParcelEvent(ROW_TRUST_ABSENTEE, META);
    expect(event.entity.cloud_entity_id).toBe(
      deterministicCloudEntityId("SEMBRANO LIVING TRUST", "01880"),
    );
    // Same owner+zip in a different parcel -> same id (identity convergence).
    const other = buildParcelEvent(
      { ...ROW_TRUST_ABSENTEE, PID: "9999", ST_NUM: "1", ST_NAME: "Elsewhere ST" },
      META,
    );
    expect(other.entity.cloud_entity_id).toBe(event.entity.cloud_entity_id);
  });

  it("individual owner has no org_names and condo unit maps cleanly", () => {
    const event = buildParcelEvent(ROW_CONDO, META);
    expect(validateSourceEvent(event).success).toBe(true);
    expect(event.entity.person?.org_names).toEqual([]);
    expect(event.entity.property?.situs_address?.line1).toBe(
      "45 Province ST UNIT 1203",
    );
    expect((event.payload as { owner_kind: string }).owner_kind).toBe("individual");
    expect((event.payload as { absentee: boolean }).absentee).toBe(false);
  });

  it("idempotency key changes with content, not with fetch time", () => {
    const a = buildParcelEvent(ROW_R3_OWNER_OCC, META);
    const b = buildParcelEvent(ROW_R3_OWNER_OCC, {
      fetchedAt: new Date("2026-10-01T00:00:00.000Z"),
      snapshotDate: "2026-10-01",
    });
    expect(a.idempotency_key).toBe(b.idempotency_key);
    const changed: AssessmentRow = { ...ROW_R3_OWNER_OCC, LU: "R4" };
    expect(buildParcelEvent(changed, META).idempotency_key).not.toBe(
      a.idempotency_key,
    );
  });
});
