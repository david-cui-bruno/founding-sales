import { describe, expect, it } from "vitest";
import {
  addressLineCompareKey,
  isAmbiguousName,
  mailingAddressCompareKey,
  normalizeAddressLine,
  normalizeOwnerName,
  normalizeZip5,
  ownerKindFromName,
} from "../src/normalize";

// ---------------------------------------------------------------------------
// normalizeOwnerName
// ---------------------------------------------------------------------------

describe("normalizeOwnerName", () => {
  it("uppercases and collapses whitespace", () => {
    expect(normalizeOwnerName("  jane   roe ")).toBe("JANE ROE");
  });

  it("sorts tokens so LAST, FIRST equals FIRST LAST", () => {
    expect(normalizeOwnerName("SMITH, JOHN")).toBe(normalizeOwnerName("JOHN SMITH"));
    expect(normalizeOwnerName("Smith, John")).toBe("JOHN SMITH");
  });

  it("strips punctuation, joining periods and apostrophes", () => {
    expect(normalizeOwnerName("O'Brien, Patrick")).toBe("OBRIEN PATRICK");
    expect(normalizeOwnerName("J.P. Realty Co-Op")).toBe("CO JP OP REALTY");
  });

  it("strips LLC noise including dotted forms", () => {
    expect(normalizeOwnerName("COTE REALTY LLC")).toBe("COTE REALTY");
    expect(normalizeOwnerName("COTE REALTY L.L.C.")).toBe("COTE REALTY");
    expect(normalizeOwnerName("Cote Realty, LLC.")).toBe("COTE REALTY");
  });

  it("strips INC/CORP/LTD noise", () => {
    expect(normalizeOwnerName("ACME HOMES INC")).toBe("ACME HOMES");
    expect(normalizeOwnerName("ACME HOMES INCORPORATED")).toBe("ACME HOMES");
    expect(normalizeOwnerName("ACME HOMES CORP")).toBe("ACME HOMES");
    expect(normalizeOwnerName("ACME HOMES LTD")).toBe("ACME HOMES");
  });

  it("strips trust noise (TRUST, TR, TRS, TRUSTEE, LIVING, REVOCABLE)", () => {
    expect(normalizeOwnerName("JANE ROE LIVING TRUST")).toBe("JANE ROE");
    expect(normalizeOwnerName("JANE ROE REVOCABLE TRUST")).toBe("JANE ROE");
    expect(normalizeOwnerName("ROE JANE TR")).toBe("JANE ROE");
    expect(normalizeOwnerName("ROE JANE TRS")).toBe("JANE ROE");
    expect(normalizeOwnerName("JANE ROE TRUSTEE")).toBe("JANE ROE");
    expect(normalizeOwnerName("JANE ROE IRREVOCABLE TRUST")).toBe("JANE ROE");
  });

  it("strips ET AL / ETAL", () => {
    expect(normalizeOwnerName("SMITH JOHN ET AL")).toBe("JOHN SMITH");
    expect(normalizeOwnerName("SMITH JOHN ETAL")).toBe("JOHN SMITH");
    expect(normalizeOwnerName("SMITH JOHN ET AL.")).toBe("JOHN SMITH");
  });

  it("keeps bare AL (a name, not ET AL)", () => {
    expect(normalizeOwnerName("AL GREEN")).toBe("AL GREEN");
  });

  it("trust form matches the bare individual (merge-by-name works)", () => {
    expect(normalizeOwnerName("JANE ROE LIVING TRUST")).toBe(
      normalizeOwnerName("ROE, JANE"),
    );
  });

  it("dedupes repeated tokens", () => {
    expect(normalizeOwnerName("SMITH SMITH JOHN")).toBe("JOHN SMITH");
  });

  it("falls back to pre-strip tokens when stripping over-collapses", () => {
    // "212 LLC" must NOT become the ambiguous single token "212".
    expect(normalizeOwnerName("212 LLC")).toBe("212 LLC");
    // A name that is ONLY noise keeps itself rather than vanishing.
    expect(normalizeOwnerName("TRUST LLC")).toBe("LLC TRUST");
  });

  it("does not fall back when enough distinctive tokens remain", () => {
    expect(normalizeOwnerName("CHARLES LANDING PROVIDENCE LLC")).toBe(
      "CHARLES LANDING PROVIDENCE",
    );
  });

  it("handles empty and null-ish input", () => {
    expect(normalizeOwnerName("")).toBe("");
    expect(normalizeOwnerName("   ")).toBe("");
    expect(normalizeOwnerName(null)).toBe("");
    expect(normalizeOwnerName(undefined)).toBe("");
    expect(normalizeOwnerName("...")).toBe("");
  });

  it("keeps single-token individual names as-is (flagged ambiguous, not dropped)", () => {
    expect(normalizeOwnerName("MADONNA")).toBe("MADONNA");
  });
});

describe("isAmbiguousName", () => {
  it("single token or empty is ambiguous", () => {
    expect(isAmbiguousName("")).toBe(true);
    expect(isAmbiguousName("SMITH")).toBe(true);
  });
  it("two or more tokens is not", () => {
    expect(isAmbiguousName("JOHN SMITH")).toBe(false);
    expect(isAmbiguousName("212 LLC")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ownerKindFromName
// ---------------------------------------------------------------------------

describe("ownerKindFromName", () => {
  it("llc", () => {
    expect(ownerKindFromName("COTE REALTY LLC")).toBe("llc");
    expect(ownerKindFromName("Cote Realty L.L.C.")).toBe("llc");
    expect(ownerKindFromName("212 LLC")).toBe("llc");
  });

  it("trust (wins over generic org hints)", () => {
    expect(ownerKindFromName("JANE ROE LIVING TRUST")).toBe("trust");
    expect(ownerKindFromName("ROE JANE TR")).toBe("trust");
    expect(ownerKindFromName("ROE FAMILY REALTY TRUST")).toBe("trust");
    expect(ownerKindFromName("SMITH JOHN TRUSTEE")).toBe("trust");
  });

  it("other org forms", () => {
    expect(ownerKindFromName("ACME HOMES INC")).toBe("other");
    expect(ownerKindFromName("PROVIDENCE HOUSING AUTHORITY")).toBe("other");
    expect(ownerKindFromName("MACR PROPERTIES CORP")).toBe("other");
  });

  it("individual is the default for plain names", () => {
    expect(ownerKindFromName("JANE ROE")).toBe("individual");
    expect(ownerKindFromName("Vanessa Tapia")).toBe("individual");
  });

  it("empty input is other", () => {
    expect(ownerKindFromName("")).toBe("other");
    expect(ownerKindFromName(null)).toBe("other");
    expect(ownerKindFromName(undefined)).toBe("other");
  });

  it("does not treat TRIM or LLCX substrings as suffixes (word boundaries)", () => {
    expect(ownerKindFromName("TRIMBLE JOHN")).toBe("individual");
  });
});

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

describe("normalizeAddressLine", () => {
  it("uppercases and applies USPS abbreviations", () => {
    expect(normalizeAddressLine("184 Central Avenue")).toBe("184 CENTRAL AVE");
    expect(normalizeAddressLine("12 Main Street")).toBe("12 MAIN ST");
    expect(normalizeAddressLine("5 Oak Boulevard")).toBe("5 OAK BLVD");
    expect(normalizeAddressLine("7 Elm Drive")).toBe("7 ELM DR");
  });

  it("leaves already-abbreviated forms alone", () => {
    expect(normalizeAddressLine("184 CENTRAL AVE")).toBe("184 CENTRAL AVE");
    expect(normalizeAddressLine("12 Main St")).toBe("12 MAIN ST");
  });

  it("abbreviates directions", () => {
    expect(normalizeAddressLine("10 North Main Street")).toBe("10 N MAIN ST");
  });

  it("strips punctuation and collapses whitespace", () => {
    expect(normalizeAddressLine("12  Main   St.")).toBe("12 MAIN ST");
    expect(normalizeAddressLine("31-33 Douglas Ave")).toBe("31 33 DOUGLAS AVE");
  });

  it("handles PO boxes", () => {
    expect(normalizeAddressLine("P.O. Box 123")).toBe("PO BOX 123");
    expect(normalizeAddressLine("Post Office Box 123")).toBe("PO OFFICE BOX 123");
  });

  it("empty-ish input", () => {
    expect(normalizeAddressLine("")).toBe("");
    expect(normalizeAddressLine(null)).toBe("");
    expect(normalizeAddressLine(undefined)).toBe("");
  });
});

describe("addressLineCompareKey", () => {
  it("strips APT/UNIT/STE/#/FL designators plus their value", () => {
    expect(addressLineCompareKey("12 Main St Apt 4B")).toBe("12 MAIN ST");
    expect(addressLineCompareKey("12 Main Street Unit 2")).toBe("12 MAIN ST");
    expect(addressLineCompareKey("12 Main St Suite 300")).toBe("12 MAIN ST");
    expect(addressLineCompareKey("12 Main St #3")).toBe("12 MAIN ST");
    expect(addressLineCompareKey("12 Main St Floor 2")).toBe("12 MAIN ST");
  });

  it("unit vs no-unit compares equal", () => {
    expect(addressLineCompareKey("12 Main Street")).toBe(
      addressLineCompareKey("12 MAIN ST APT 2"),
    );
  });

  it("different street numbers stay different", () => {
    expect(addressLineCompareKey("12 Main St")).not.toBe(
      addressLineCompareKey("14 Main St"),
    );
  });
});

describe("normalizeZip5", () => {
  it("takes the first five digits", () => {
    expect(normalizeZip5("02906")).toBe("02906");
    expect(normalizeZip5("02906-1234")).toBe("02906");
    expect(normalizeZip5(" 02906 ")).toBe("02906");
  });
  it("keeps short/foreign codes as cleaned uppercase", () => {
    expect(normalizeZip5("2906")).toBe("2906");
    expect(normalizeZip5("K1A 0B1")).toBe("K1A0B1");
  });
  it("empty-ish input", () => {
    expect(normalizeZip5("")).toBe("");
    expect(normalizeZip5(null)).toBe("");
    expect(normalizeZip5(undefined)).toBe("");
  });
});

describe("mailingAddressCompareKey", () => {
  it("combines unit-stripped line, locality, region, zip5 (directionals abbreviated)", () => {
    expect(
      mailingAddressCompareKey({
        line1: "184 Central Avenue Apt 2",
        locality: "East Providence",
        region: "RI",
        postal_code: "02914-5555",
      }),
    ).toBe("184 CENTRAL AVE|E PROVIDENCE|RI|02914");
    // ... which makes "E Providence" and "East Providence" compare equal.
    expect(normalizeAddressLine("E Providence")).toBe(
      normalizeAddressLine("East Providence"),
    );
  });

  it("equal for unit vs no-unit and STREET vs ST", () => {
    const a = mailingAddressCompareKey({
      line1: "12 Main Street",
      locality: "Providence",
      region: "RI",
      postal_code: "02906",
    });
    const b = mailingAddressCompareKey({
      line1: "12 MAIN ST APT 4",
      locality: "PROVIDENCE",
      region: "ri",
      postal_code: "02906-1234",
    });
    expect(a).toBe(b);
  });

  it("null address or empty line1 -> null", () => {
    expect(mailingAddressCompareKey(null)).toBeNull();
    expect(mailingAddressCompareKey(undefined)).toBeNull();
    expect(
      mailingAddressCompareKey({
        line1: "...",
        locality: null,
        region: null,
        postal_code: null,
      }),
    ).toBeNull();
  });

  it("null locality/region/zip are empty segments, still comparable", () => {
    expect(
      mailingAddressCompareKey({
        line1: "12 Main St",
        locality: null,
        region: null,
        postal_code: null,
      }),
    ).toBe("12 MAIN ST|||");
  });
});
