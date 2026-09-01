/**
 * Deterministic entity resolution (v1) — pure functions, no I/O.
 *
 * Identity rules (design spec):
 * - Block key: normalizeOwnerName(name) + zip5 of the mailing address.
 * - Within a block, merge when:
 *     (a) exact normalized mailing-address match  -> confidence 0.95, OR
 *     (b) name token sets equal AND same zip      -> confidence 0.85.
 *   Normalized names ARE sorted token sets, so within a block rule (b) holds
 *   by construction — EXCEPT for single-token names ("SMITH"), which are too
 *   ambiguous for token-set merging. Single-token blocks merge ONLY via rule
 *   (a): the exact-address requirement also keeps the same owner stable
 *   across runs without conflating different SMITHs in one zip.
 * - entity_id = the LOWEST cloud_entity_id among members. ce_ ULIDs are
 *   time-ordered, so the first-ever-observed member keeps winning across
 *   runs: the id is stable once minted.
 * - canonical name = longest member name (tie: lexicographically first).
 * - Doors: per distinct parcel, unit_count when present else 1 (a parcel
 *   with unknown units counts as one door); doors_estimate = the sum. For a
 *   portfolio with no unit_count data anywhere this equals parcel_count.
 *   When the same parcel is observed more than once, the highest unit_count
 *   wins (later roll years can add units; we never lose doors to a null).
 */
import {
  isAmbiguousName,
  mailingAddressCompareKey,
  normalizeOwnerName,
  normalizeZip5,
  ownerKindFromName,
  type CloudSourceEvent,
  type OwnerKind,
  type PostalAddress,
} from "@callie-sourcing/shared";

// ---------------------------------------------------------------------------
// Member records (one per person-bearing event)
// ---------------------------------------------------------------------------

export interface MemberRecord {
  cloudEntityId: string;
  /** Owner name as it appears in the public record. */
  rawName: string;
  normalizedName: string;
  mailingAddress: PostalAddress | null;
  /** null when the mailing address is null/unusable. */
  mailingCompareKey: string | null;
  zip5: string;
  parcelId: string | null;
  unitCount: number | null;
  situsLocality: string | null;
}

/**
 * Project a person-bearing event into a member record. Returns null when the
 * event cannot participate in resolution: no cloud_entity_id (members are
 * keyed by it), no person, or no usable owner name.
 */
export function toMemberRecord(event: CloudSourceEvent): MemberRecord | null {
  const cloudEntityId = event.entity.cloud_entity_id;
  const person = event.entity.person;
  if (!cloudEntityId || !person) return null;

  const rawName = person.full_name?.trim() || person.org_names[0]?.trim() || "";
  const normalizedName = normalizeOwnerName(rawName);
  if (!normalizedName) return null;

  const mailingAddress = person.mailing_address;
  const property = event.entity.property;

  return {
    cloudEntityId,
    rawName,
    normalizedName,
    mailingAddress,
    mailingCompareKey: mailingAddressCompareKey(mailingAddress),
    zip5: normalizeZip5(mailingAddress?.postal_code),
    parcelId: property?.parcel_id ?? null,
    unitCount: property?.unit_count ?? null,
    situsLocality: property?.situs_address?.locality ?? null,
  };
}

// ---------------------------------------------------------------------------
// Resolved entities
// ---------------------------------------------------------------------------

export interface ResolvedEntity {
  /** Lowest member cloud_entity_id — stable across runs. */
  entityId: string;
  normalizedName: string;
  /** Longest member raw name. */
  canonicalName: string;
  ownerKind: OwnerKind;
  mailingAddress: PostalAddress | null;
  memberCloudEntityIds: string[];
  /** Distinct parcel_id -> doors (unit_count when present else 1). */
  doorsByParcel: Record<string, number>;
  parcelCount: number;
  doorsEstimate: number;
  situsLocalities: string[];
  /** 1 singleton, 0.95 exact-address merge, 0.85 token-set merge. */
  confidence: number;
}

function longestName(names: string[]): string {
  return names.reduce((best, name) =>
    name.length > best.length || (name.length === best.length && name < best)
      ? name
      : best,
  );
}

/**
 * Deterministic representative mailing address for a group: the most common
 * compare key wins; ties break to the lexicographically smallest key; within
 * the winning key, the longest line1 (keeps unit designators, which compare
 * keys strip). null when no member has an address.
 */
function representativeAddress(members: MemberRecord[]): PostalAddress | null {
  const groups = new Map<string, MemberRecord[]>();
  for (const member of members) {
    if (!member.mailingCompareKey || !member.mailingAddress) continue;
    const list = groups.get(member.mailingCompareKey) ?? [];
    list.push(member);
    groups.set(member.mailingCompareKey, list);
  }
  if (groups.size === 0) return null;
  const bestKey = [...groups.entries()].sort(
    (a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1),
  )[0]![0];
  const best = groups
    .get(bestKey)!
    .reduce((a, b) => (b.mailingAddress!.line1.length > a.mailingAddress!.line1.length ? b : a));
  return best.mailingAddress;
}

function buildEntity(members: MemberRecord[], confidence: number): ResolvedEntity {
  const memberIds = [...new Set(members.map((m) => m.cloudEntityId))].sort();

  const doorsByParcel: Record<string, number> = {};
  for (const member of members) {
    if (!member.parcelId) continue;
    const doors = member.unitCount ?? 1;
    const existing = doorsByParcel[member.parcelId];
    doorsByParcel[member.parcelId] =
      existing === undefined ? doors : Math.max(existing, doors);
  }

  const canonicalName = longestName(members.map((m) => m.rawName));
  const localities = [
    ...new Set(members.map((m) => m.situsLocality).filter((l): l is string => !!l)),
  ].sort();

  return {
    entityId: memberIds[0]!,
    normalizedName: members[0]!.normalizedName,
    canonicalName,
    ownerKind: ownerKindFromName(canonicalName),
    mailingAddress: representativeAddress(members),
    memberCloudEntityIds: memberIds,
    doorsByParcel,
    parcelCount: Object.keys(doorsByParcel).length,
    doorsEstimate: Object.values(doorsByParcel).reduce((sum, d) => sum + d, 0),
    situsLocalities: localities,
    confidence,
  };
}

/**
 * Resolve member records into entities. Deterministic: same input (in any
 * order) -> same entities with the same entity_ids.
 */
export function resolveEntities(records: MemberRecord[]): ResolvedEntity[] {
  // Dedupe by cloud_entity_id (an event may appear in both an adapter file
  // and the scorer's re-emitted file).
  const byId = new Map<string, MemberRecord>();
  for (const record of records) {
    if (!byId.has(record.cloudEntityId)) byId.set(record.cloudEntityId, record);
  }

  // Block on normalized name + zip5.
  const blocks = new Map<string, MemberRecord[]>();
  for (const record of byId.values()) {
    const key = `${record.normalizedName}|${record.zip5}`;
    const list = blocks.get(key) ?? [];
    list.push(record);
    blocks.set(key, list);
  }

  const entities: ResolvedEntity[] = [];
  for (const members of blocks.values()) {
    const ambiguous = isAmbiguousName(members[0]!.normalizedName);

    if (!ambiguous) {
      // Rule (b): token sets equal + same zip holds for the whole block.
      // Exact-address agreement upgrades confidence to 0.95.
      const compareKeys = new Set(members.map((m) => m.mailingCompareKey));
      const confidence =
        members.length === 1
          ? 1
          : compareKeys.size === 1 && !compareKeys.has(null)
            ? 0.95
            : 0.85;
      entities.push(buildEntity(members, confidence));
      continue;
    }

    // Ambiguous (single-token) name: merge ONLY on exact address, rule (a).
    const byAddress = new Map<string, MemberRecord[]>();
    const loners: MemberRecord[] = [];
    for (const member of members) {
      if (!member.mailingCompareKey) {
        loners.push(member);
        continue;
      }
      const list = byAddress.get(member.mailingCompareKey) ?? [];
      list.push(member);
      byAddress.set(member.mailingCompareKey, list);
    }
    for (const group of byAddress.values()) {
      entities.push(buildEntity(group, group.length === 1 ? 1 : 0.95));
    }
    for (const loner of loners) {
      entities.push(buildEntity([loner], 1));
    }
  }

  // Stable output order for tests and logs.
  return entities.sort((a, b) => (a.entityId < b.entityId ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Cross-run merge with an existing entities-table row
// ---------------------------------------------------------------------------

export interface StoredEntity {
  entityId: string;
  normalizedName: string;
  canonicalName: string;
  ownerKind: OwnerKind;
  mailingAddress: PostalAddress | null;
  memberCloudEntityIds: string[];
  doorsByParcel: Record<string, number>;
  parcelCount: number;
  doorsEstimate: number;
  situsLocalities: string[];
}

/**
 * Would this stored row and this resolved entity merge under the same rules?
 * (Same normalized name is a precondition — callers query the GSI first.)
 */
export function matchesStored(entity: ResolvedEntity, stored: StoredEntity): boolean {
  const storedKey = mailingAddressCompareKey(stored.mailingAddress);
  const entityKey = mailingAddressCompareKey(entity.mailingAddress);
  if (storedKey !== null && storedKey === entityKey) return true; // rule (a)
  if (isAmbiguousName(entity.normalizedName)) return false; // rule (b) off
  const storedZip = normalizeZip5(stored.mailingAddress?.postal_code);
  const entityZip = normalizeZip5(entity.mailingAddress?.postal_code);
  return storedZip === entityZip; // rule (b)
}

/**
 * Union-merge a resolved entity into its stored row (read-modify-write).
 *
 * The stored entity_id is PRESERVED even when the incoming batch contains a
 * lower ce_ id (possible when a longer lookback re-reads older files): the
 * "lowest member id" rule applies at creation, and once minted the id must
 * stay stable — the app has already mapped it to a local person.
 */
export function mergeWithStored(
  entity: ResolvedEntity,
  stored: StoredEntity,
): ResolvedEntity {
  const memberIds = [
    ...new Set([...stored.memberCloudEntityIds, ...entity.memberCloudEntityIds]),
  ].sort();

  const doorsByParcel: Record<string, number> = { ...stored.doorsByParcel };
  for (const [parcelId, doors] of Object.entries(entity.doorsByParcel)) {
    const existing = doorsByParcel[parcelId];
    doorsByParcel[parcelId] = existing === undefined ? doors : Math.max(existing, doors);
  }

  return {
    entityId: stored.entityId,
    normalizedName: entity.normalizedName,
    canonicalName: longestName([stored.canonicalName, entity.canonicalName]),
    ownerKind: entity.ownerKind,
    mailingAddress: entity.mailingAddress ?? stored.mailingAddress,
    memberCloudEntityIds: memberIds,
    doorsByParcel,
    parcelCount: Object.keys(doorsByParcel).length,
    doorsEstimate: Object.values(doorsByParcel).reduce((sum, d) => sum + d, 0),
    situsLocalities: [
      ...new Set([...stored.situsLocalities, ...entity.situsLocalities]),
    ].sort(),
    confidence: entity.confidence,
  };
}
