import { describe, expect, it } from "vitest";
import { validateSourceEvent } from "@callie-sourcing/shared";
import {
  buildEnrichmentEvent,
  contactHmac,
  contentFingerprint,
  naturalKey,
  normalizeContacts,
  phoneKind,
  pickPerson,
  toE164,
} from "../src/enrich";
import { person, request } from "./fixtures";

describe("toE164", () => {
  it("prefixes 10-digit US numbers with +1", () => {
    expect(toE164("4015550100")).toBe("+14015550100");
    expect(toE164("(401) 555-0100")).toBe("+14015550100");
  });

  it("accepts 11 digits with leading 1", () => {
    expect(toE164("14015550100")).toBe("+14015550100");
  });

  it("rejects short, long, and empty numbers", () => {
    expect(toE164("555010")).toBe(null);
    expect(toE164("240155501001")).toBe(null);
    expect(toE164("")).toBe(null);
    expect(toE164(null)).toBe(null);
  });
});

describe("phoneKind", () => {
  it("maps vendor types case-insensitively", () => {
    expect(phoneKind("Mobile")).toBe("mobile");
    expect(phoneKind("Landline")).toBe("landline");
    expect(phoneKind("VOIP")).toBe("voip");
    expect(phoneKind("Wireless")).toBe("mobile");
    expect(phoneKind("Satellite")).toBe("other");
    expect(phoneKind(null)).toBe("other");
  });
});

describe("normalizeContacts", () => {
  it("normalizes phones to E.164 and lowercases emails", () => {
    const contacts = normalizeContacts(person());
    expect(contacts.phones.map((p) => p.e164)).toEqual([
      "+14015550100",
      "+14015550200",
    ]);
    expect(contacts.phones[0]).toMatchObject({
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
    });
    expect(contacts.phones[1]).toMatchObject({
      kind: "landline",
      compliance: { federal_status: "listed" },
    });
    expect(contacts.emails).toEqual([{ address: "jane.roe@example.com", rank: 1 }]);
    expect(contacts.invalidDropped).toBe(0);
  });

  it("drops unparseable contacts and dedupes", () => {
    const contacts = normalizeContacts(
      person({
        phones: [
          { number: "4015550100", type: "Mobile", dnc: false, tcpa: false, rank: 1 },
          { number: "14015550100", type: "Mobile", dnc: false, tcpa: false, rank: 2 },
          { number: "12345", type: "Mobile", dnc: false, tcpa: false, rank: 3 },
        ],
        emails: [
          { email: "a@example.com", rank: 1 },
          { email: "A@EXAMPLE.COM", rank: 2 },
          { email: "not-an-email", rank: 3 },
        ],
      }),
    );
    expect(contacts.phones).toHaveLength(1);
    expect(contacts.emails).toHaveLength(1);
    expect(contacts.invalidDropped).toBe(2);
  });

  it("maps missing vendor DNC and TCPA fields to unknown evidence", () => {
    const contacts = normalizeContacts(
      person({
        phones: [{ number: "4015550100" }],
        emails: [{ email: "x@example.com" }],
      }),
    );
    expect(contacts.phones[0]).toMatchObject({
      compliance: {
        federal_status: "unknown",
        tcpa_flag: null,
        covered_area_code: null,
        source: "enrichment_vendor",
        scrubbed_at: null,
        expires_at: null,
      },
      rank: 1,
    });
    expect(contacts.emails[0]).toMatchObject({ rank: 1 });
  });

  it("maps vendor false DNC and TCPA fields to unknown evidence", () => {
    const contacts = normalizeContacts(person({
      phones: [{ number: "4015550100", dnc: false, tcpa: false }],
    }));
    expect(contacts.phones[0]?.compliance).toEqual({
      federal_status: "unknown",
      tcpa_flag: null,
      covered_area_code: null,
      source: "enrichment_vendor",
      scrubbed_at: null,
      expires_at: null,
    });
  });

  it("maps a positive DNC result to listed", () => {
    const contacts = normalizeContacts(person({
      phones: [{ number: "4015550100", dnc: true, tcpa: false }],
    }));
    expect(contacts.phones[0]?.compliance.federal_status).toBe("listed");
    expect(contacts.phones[0]?.compliance.tcpa_flag).toBeNull();
  });

  it("maps a positive TCPA result to true while federal remains unknown", () => {
    const contacts = normalizeContacts(person({
      phones: [{ number: "4015550100", dnc: false, tcpa: true }],
    }));
    expect(contacts.phones[0]?.compliance.federal_status).toBe("unknown");
    expect(contacts.phones[0]?.compliance.tcpa_flag).toBe(true);
  });
});

describe("pickPerson", () => {
  it("prefers property_owner=true over earlier non-owners", () => {
    const renter = person({ full_name: "Sam Renter", property_owner: false });
    const owner = person({ full_name: "Pat Owner", property_owner: true });
    const picked = pickPerson([renter, owner], "SOMEONE ELSE");
    expect(picked?.person.full_name).toBe("Pat Owner");
    expect(picked?.matchedOwner).toBe(true);
  });

  it("among owners, prefers the normalized name match", () => {
    const ownerA = person({ full_name: "Pat Owner", property_owner: true });
    const ownerB = person({ full_name: "Jane Roe", property_owner: true });
    const picked = pickPerson([ownerA, ownerB], "ROE, JANE");
    expect(picked?.person.full_name).toBe("Jane Roe");
    expect(picked?.matchedOwner).toBe(true);
  });

  it("falls back to name match when no property_owner flag", () => {
    const other = person({ full_name: "Sam Other", property_owner: false });
    const match = person({ full_name: "jane roe", property_owner: false });
    const picked = pickPerson([other, match], "JANE ROE");
    expect(picked?.person.full_name).toBe("jane roe");
    expect(picked?.matchedOwner).toBe(true);
  });

  it("falls back to vendor rank order otherwise (matched_owner false)", () => {
    const first = person({ full_name: "Sam First", property_owner: false });
    const second = person({ full_name: "Ann Second", property_owner: false });
    const picked = pickPerson([first, second], "NO SUCH OWNER");
    expect(picked?.person.full_name).toBe("Sam First");
    expect(picked?.matchedOwner).toBe(false);
  });

  it("returns null for an empty persons list", () => {
    expect(pickPerson([], "JANE ROE")).toBe(null);
  });
});

describe("contactHmac", () => {
  it("matches the app-side canonicalization (lowercased email, trimmed)", () => {
    expect(contactHmac("salt", "email", " Jane@Example.com ")).toBe(
      contactHmac("salt", "email", "jane@example.com"),
    );
    expect(contactHmac("salt", "phone", " +14015550100 ")).toBe(
      contactHmac("salt", "phone", "+14015550100"),
    );
    expect(contactHmac("salt", "phone", "+14015550100")).toMatch(/^[0-9a-f]{64}$/);
    expect(contactHmac("other-salt", "phone", "+14015550100")).not.toBe(
      contactHmac("salt", "phone", "+14015550100"),
    );
  });
});

describe("contentFingerprint + naturalKey", () => {
  const payload = {
    vendor: "tracerfy" as const,
    hit: true,
    phones: [
      {
        e164: "+14015550100",
        kind: "mobile" as const,
        compliance: {
          federal_status: "unknown" as const,
          tcpa_flag: null,
          covered_area_code: null,
          source: "enrichment_vendor" as const,
          scrubbed_at: null,
          expires_at: null,
        },
        rank: 1,
      },
    ],
    emails: [{ address: "jane.roe@example.com", rank: 1 }],
    credits_used: 5,
    matched_owner: true,
  };

  it("is stable and order-insensitive over the contact set", () => {
    const twoPhones = {
      ...payload,
      phones: [
        {
          e164: "+14015550200",
          kind: "landline" as const,
          compliance: {
            federal_status: "listed" as const,
            tcpa_flag: null,
            covered_area_code: null,
            source: "enrichment_vendor" as const,
            scrubbed_at: null,
            expires_at: null,
          },
          rank: 2,
        },
        ...payload.phones,
      ],
    };
    const reversed = { ...twoPhones, phones: [...twoPhones.phones].reverse() };
    expect(contentFingerprint(twoPhones)).toBe(contentFingerprint(reversed));
    expect(contentFingerprint(payload)).not.toBe(contentFingerprint(twoPhones));
  });

  it("naturalKey is enrich:<cloud_entity_id>", () => {
    expect(naturalKey(request())).toBe(
      "enrich:ce_01JC0000000000000000000000",
    );
  });
});

describe("buildEnrichmentEvent", () => {
  const fetchedAt = new Date("2026-09-01T15:05:00.000Z");

  it("builds a schema-valid hit event with matched owner (confidence 0.9)", () => {
    const picked = { person: person(), matchedOwner: true };
    const contacts = normalizeContacts(picked.person);
    const event = buildEnrichmentEvent({
      request: request(),
      picked,
      phones: contacts.phones,
      emails: contacts.emails,
      creditsUsed: 5,
      fetchedAt,
    });
    const validated = validateSourceEvent(event);
    expect(validated.success, validated.success ? "" : validated.error).toBe(true);
    expect(event.channel).toBe("parcel");
    expect(event.trigger).toBe(null);
    expect(event.entity.known_person).toBe(true);
    expect(event.entity.person?.phones).toEqual(["+14015550100", "+14015550200"]);
    expect(event.payload).toMatchObject({
      vendor: "tracerfy",
      hit: true,
      credits_used: 5,
      matched_owner: true,
    });
    expect(event.provenance).toEqual({
      adapter: "enricher",
      adapter_version: "1.0.0",
      confidence: 0.9,
    });
  });

  it("uses confidence 0.6 when the owner did not match", () => {
    const picked = { person: person({ property_owner: false }), matchedOwner: false };
    const contacts = normalizeContacts(picked.person);
    const event = buildEnrichmentEvent({
      request: request(),
      picked,
      phones: contacts.phones,
      emails: contacts.emails,
      creditsUsed: 5,
      fetchedAt,
    });
    expect(validateSourceEvent(event).success).toBe(true);
    expect(event.provenance.confidence).toBe(0.6);
    expect(event.payload.matched_owner).toBe(false);
  });

  it("builds a schema-valid miss event (person null, hit false, 0 credits)", () => {
    const event = buildEnrichmentEvent({
      request: request(),
      picked: null,
      phones: [],
      emails: [],
      creditsUsed: 0,
      fetchedAt,
    });
    const validated = validateSourceEvent(event);
    expect(validated.success, validated.success ? "" : validated.error).toBe(true);
    expect(event.entity.person).toBe(null);
    expect(event.payload).toMatchObject({ hit: false, credits_used: 0 });
  });

  it("reports hit:false when suppression dropped every contact (vendor hit)", () => {
    const picked = { person: person(), matchedOwner: true };
    const event = buildEnrichmentEvent({
      request: request(),
      picked,
      phones: [],
      emails: [],
      creditsUsed: 5,
      fetchedAt,
    });
    expect(validateSourceEvent(event).success).toBe(true);
    expect(event.payload).toMatchObject({ hit: false, credits_used: 5 });
    expect(event.entity.person?.phones).toEqual([]);
    expect(event.entity.person?.emails).toEqual([]);
  });
});
