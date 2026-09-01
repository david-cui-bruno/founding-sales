import { describe, expect, it } from "vitest";
import {
  matchesStored,
  mergeWithStored,
  resolveEntities,
  toMemberRecord,
  type MemberRecord,
  type StoredEntity,
} from "../src/resolve";
import { ceId, parcelEvent } from "./fixtures";

function record(spec: Parameters<typeof parcelEvent>[0] = {}): MemberRecord {
  const member = toMemberRecord(parcelEvent(spec));
  if (!member) throw new Error("fixture did not produce a member record");
  return member;
}

// ---------------------------------------------------------------------------
// toMemberRecord
// ---------------------------------------------------------------------------

describe("toMemberRecord", () => {
  it("projects a person-bearing event", () => {
    const member = toMemberRecord(
      parcelEvent({
        cloudEntityId: ceId(1),
        fullName: "SMITH, JOHN",
        parcelId: "P-1",
        unitCount: 3,
      }),
    )!;
    expect(member.cloudEntityId).toBe(ceId(1));
    expect(member.rawName).toBe("SMITH, JOHN");
    expect(member.normalizedName).toBe("JOHN SMITH");
    expect(member.zip5).toBe("02906");
    expect(member.parcelId).toBe("P-1");
    expect(member.unitCount).toBe(3);
    expect(member.situsLocality).toBe("Providence");
  });

  it("null for events without person", () => {
    expect(toMemberRecord(parcelEvent({ person: null }))).toBeNull();
  });

  it("null for events without cloud_entity_id", () => {
    const event = parcelEvent();
    event.entity.cloud_entity_id = null;
    expect(toMemberRecord(event)).toBeNull();
  });

  it("falls back to org_names when full_name is null", () => {
    const member = toMemberRecord(
      parcelEvent({ fullName: null, orgNames: ["ROE PROPERTIES LLC"] }),
    )!;
    expect(member.rawName).toBe("ROE PROPERTIES LLC");
    expect(member.normalizedName).toBe("PROPERTIES ROE");
  });

  it("null when no usable name at all", () => {
    expect(toMemberRecord(parcelEvent({ fullName: null }))).toBeNull();
    expect(toMemberRecord(parcelEvent({ fullName: "..." }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveEntities
// ---------------------------------------------------------------------------

describe("resolveEntities", () => {
  it("merges LAST, FIRST with FIRST LAST in the same zip (0.85 token-set)", () => {
    const entities = resolveEntities([
      record({ cloudEntityId: ceId(2), fullName: "SMITH, JOHN", parcelId: "P-1", mailing: { line1: "12 Main St" } }),
      record({ cloudEntityId: ceId(1), fullName: "JOHN SMITH", parcelId: "P-2", mailing: { line1: "99 Elm St" } }),
    ]);
    expect(entities).toHaveLength(1);
    const entity = entities[0]!;
    expect(entity.entityId).toBe(ceId(1)); // lowest member id
    expect(entity.memberCloudEntityIds).toEqual([ceId(1), ceId(2)]);
    expect(entity.parcelCount).toBe(2);
    expect(entity.confidence).toBe(0.85);
  });

  it("exact mailing-address match earns 0.95", () => {
    const entities = resolveEntities([
      record({ cloudEntityId: ceId(1), fullName: "JOHN SMITH", parcelId: "P-1", mailing: { line1: "12 Main Street" } }),
      record({ cloudEntityId: ceId(2), fullName: "SMITH JOHN", parcelId: "P-2", mailing: { line1: "12 MAIN ST APT 2" } }),
    ]);
    expect(entities).toHaveLength(1);
    expect(entities[0]!.confidence).toBe(0.95);
  });

  it("same name in different zips does NOT merge", () => {
    const entities = resolveEntities([
      record({ cloudEntityId: ceId(1), fullName: "JOHN SMITH", mailing: { postal_code: "02906" } }),
      record({ cloudEntityId: ceId(2), fullName: "JOHN SMITH", mailing: { postal_code: "02914" } }),
    ]);
    expect(entities).toHaveLength(2);
  });

  it("single-token names merge only on exact address", () => {
    const entities = resolveEntities([
      record({ cloudEntityId: ceId(1), fullName: "MADONNA", parcelId: "P-1", mailing: { line1: "12 Main St" } }),
      record({ cloudEntityId: ceId(2), fullName: "MADONNA", parcelId: "P-2", mailing: { line1: "12 Main Street" } }),
      record({ cloudEntityId: ceId(3), fullName: "MADONNA", parcelId: "P-3", mailing: { line1: "99 Elm St" } }),
    ]);
    expect(entities).toHaveLength(2);
    const merged = entities.find((e) => e.entityId === ceId(1))!;
    expect(merged.memberCloudEntityIds).toEqual([ceId(1), ceId(2)]);
    expect(merged.confidence).toBe(0.95);
    const single = entities.find((e) => e.entityId === ceId(3))!;
    expect(single.memberCloudEntityIds).toEqual([ceId(3)]);
  });

  it("single-token names without an address never merge", () => {
    const entities = resolveEntities([
      record({ cloudEntityId: ceId(1), fullName: "MADONNA", mailing: null }),
      record({ cloudEntityId: ceId(2), fullName: "MADONNA", mailing: null }),
    ]);
    expect(entities).toHaveLength(2);
  });

  it("LLC suffix noise merges with the bare name", () => {
    const entities = resolveEntities([
      record({ cloudEntityId: ceId(1), fullName: "COTE REALTY LLC", parcelId: "P-1" }),
      record({ cloudEntityId: ceId(2), fullName: "Cote Realty, L.L.C.", parcelId: "P-2" }),
    ]);
    expect(entities).toHaveLength(1);
    expect(entities[0]!.parcelCount).toBe(2);
  });

  it("doors: sum unit_count when present else count parcels", () => {
    const entities = resolveEntities([
      record({ cloudEntityId: ceId(1), fullName: "JOHN SMITH", parcelId: "P-1", unitCount: 6 }),
      record({ cloudEntityId: ceId(2), fullName: "JOHN SMITH", parcelId: "P-2", unitCount: null }),
      record({ cloudEntityId: ceId(3), fullName: "JOHN SMITH", parcelId: "P-3", unitCount: 3 }),
    ]);
    expect(entities).toHaveLength(1);
    const entity = entities[0]!;
    expect(entity.parcelCount).toBe(3);
    expect(entity.doorsEstimate).toBe(10); // 6 + 1 + 3
  });

  it("duplicate parcel observations count once, highest unit_count wins", () => {
    const entities = resolveEntities([
      record({ cloudEntityId: ceId(1), fullName: "JOHN SMITH", parcelId: "P-1", unitCount: null }),
      record({ cloudEntityId: ceId(2), fullName: "JOHN SMITH", parcelId: "P-1", unitCount: 4 }),
    ]);
    expect(entities[0]!.parcelCount).toBe(1);
    expect(entities[0]!.doorsEstimate).toBe(4);
  });

  it("dedupes repeated cloud_entity_ids (adapter + scorer copies)", () => {
    const member = record({ cloudEntityId: ceId(1), fullName: "JOHN SMITH", parcelId: "P-1" });
    const entities = resolveEntities([member, { ...member }]);
    expect(entities).toHaveLength(1);
    expect(entities[0]!.memberCloudEntityIds).toEqual([ceId(1)]);
    expect(entities[0]!.confidence).toBe(1);
  });

  it("canonical name is the longest member name", () => {
    const entities = resolveEntities([
      record({ cloudEntityId: ceId(1), fullName: "SMITH JOHN" }),
      record({ cloudEntityId: ceId(2), fullName: "SMITH, JOHN" }),
    ]);
    expect(entities[0]!.canonicalName).toBe("SMITH, JOHN");
  });

  it("owner_kind from the canonical name", () => {
    const llc = resolveEntities([record({ fullName: "212 LLC" })]);
    expect(llc[0]!.ownerKind).toBe("llc");
    const trust = resolveEntities([record({ fullName: "ROE FAMILY TRUST" })]);
    expect(trust[0]!.ownerKind).toBe("trust");
    const individual = resolveEntities([record({ fullName: "JANE ROE" })]);
    expect(individual[0]!.ownerKind).toBe("individual");
  });

  it("collects distinct situs localities sorted", () => {
    const entities = resolveEntities([
      record({ cloudEntityId: ceId(1), fullName: "JOHN SMITH", situsLocality: "Providence" }),
      record({ cloudEntityId: ceId(2), fullName: "JOHN SMITH", situsLocality: "Cranston" }),
      record({ cloudEntityId: ceId(3), fullName: "JOHN SMITH", situsLocality: "Providence" }),
    ]);
    expect(entities[0]!.situsLocalities).toEqual(["Cranston", "Providence"]);
  });

  it("is order-independent (deterministic)", () => {
    const records = [
      record({ cloudEntityId: ceId(3), fullName: "SMITH, JOHN", parcelId: "P-3" }),
      record({ cloudEntityId: ceId(1), fullName: "JOHN SMITH", parcelId: "P-1" }),
      record({ cloudEntityId: ceId(2), fullName: "John Smith", parcelId: "P-2" }),
    ];
    const forward = resolveEntities(records);
    const reversed = resolveEntities([...records].reverse());
    expect(forward).toEqual(reversed);
    expect(forward[0]!.entityId).toBe(ceId(1));
  });
});

// ---------------------------------------------------------------------------
// matchesStored / mergeWithStored
// ---------------------------------------------------------------------------

function stored(overrides: Partial<StoredEntity> = {}): StoredEntity {
  return {
    entityId: ceId(1),
    normalizedName: "JOHN SMITH",
    canonicalName: "JOHN SMITH",
    ownerKind: "individual",
    mailingAddress: {
      line1: "12 Main St",
      locality: "Providence",
      region: "RI",
      postal_code: "02906",
      country_code: "US",
    },
    memberCloudEntityIds: [ceId(1)],
    doorsByParcel: { "P-1": 1 },
    parcelCount: 1,
    doorsEstimate: 1,
    situsLocalities: ["Providence"],
    ...overrides,
  };
}

describe("matchesStored", () => {
  it("matches on exact address", () => {
    const [entity] = resolveEntities([
      record({ cloudEntityId: ceId(9), fullName: "SMITH JOHN", mailing: { line1: "12 Main Street" } }),
    ]);
    expect(matchesStored(entity!, stored())).toBe(true);
  });

  it("matches on same zip for multi-token names", () => {
    const [entity] = resolveEntities([
      record({ cloudEntityId: ceId(9), fullName: "SMITH JOHN", mailing: { line1: "99 Elm St", postal_code: "02906" } }),
    ]);
    expect(matchesStored(entity!, stored())).toBe(true);
  });

  it("no match across zips", () => {
    const [entity] = resolveEntities([
      record({ cloudEntityId: ceId(9), fullName: "SMITH JOHN", mailing: { line1: "99 Elm St", postal_code: "02914" } }),
    ]);
    expect(matchesStored(entity!, stored())).toBe(false);
  });

  it("ambiguous names require exact address", () => {
    const [entity] = resolveEntities([
      record({ cloudEntityId: ceId(9), fullName: "MADONNA", mailing: { line1: "99 Elm St", postal_code: "02906" } }),
    ]);
    expect(
      matchesStored(entity!, stored({ normalizedName: "MADONNA", canonicalName: "MADONNA" })),
    ).toBe(false);
  });
});

describe("mergeWithStored", () => {
  it("unions members and doors, keeps the STORED entity id", () => {
    const [entity] = resolveEntities([
      record({ cloudEntityId: ceId(0), fullName: "SMITH JOHN JR", parcelId: "P-2", unitCount: 3 }),
    ]);
    const merged = mergeWithStored(entity!, stored());
    // ceId(0) < ceId(1), but the minted id must never change.
    expect(merged.entityId).toBe(ceId(1));
    expect(merged.memberCloudEntityIds).toEqual([ceId(0), ceId(1)]);
    expect(merged.parcelCount).toBe(2);
    expect(merged.doorsEstimate).toBe(4); // 1 + 3
    expect(merged.canonicalName).toBe("SMITH JOHN JR");
  });

  it("re-observing the same parcel does not inflate counts", () => {
    const [entity] = resolveEntities([
      record({ cloudEntityId: ceId(1), fullName: "SMITH JOHN", parcelId: "P-1" }),
    ]);
    const merged = mergeWithStored(entity!, stored());
    expect(merged.parcelCount).toBe(1);
    expect(merged.doorsEstimate).toBe(1);
    expect(merged.memberCloudEntityIds).toEqual([ceId(1)]);
  });

  it("unions situs localities", () => {
    const [entity] = resolveEntities([
      record({ cloudEntityId: ceId(2), fullName: "SMITH JOHN", situsLocality: "Cranston" }),
    ]);
    const merged = mergeWithStored(entity!, stored());
    expect(merged.situsLocalities).toEqual(["Cranston", "Providence"]);
  });
});
