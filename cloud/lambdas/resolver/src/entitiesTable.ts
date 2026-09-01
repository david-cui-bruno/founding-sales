/**
 * Entities-table (callie-sourcing-entities) marshalling.
 *
 * Item shape (pk `entity_id` S; GSI `normalized_name-index` on
 * `normalized_name` S, projection ALL):
 *   entity_id                S   lowest member cloud_entity_id
 *   normalized_name          S   normalizeOwnerName output (GSI hash key)
 *   canonical_name           S   longest member raw name
 *   owner_kind               S   llc | trust | individual | other
 *   mailing_address_json     S   PostalAddress JSON, or absent when null
 *   member_cloud_entity_ids  SS  member ce_ ids
 *   doors_by_parcel_json     S   {parcel_id: doors} JSON (merge state)
 *   parcel_count             N   distinct parcel ids
 *   doors_estimate           N   sum(unit_count || 1) over distinct parcels
 *   situs_localities_json    S   string[] JSON
 *   resolution_confidence    N   1 | 0.95 | 0.85
 *   updated_at               S   ISO timestamp
 */
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import type { OwnerKind, PostalAddress } from "@callie-sourcing/shared";
import type { ResolvedEntity, StoredEntity } from "./resolve";

export function toItem(
  entity: ResolvedEntity,
  updatedAt: string,
): Record<string, AttributeValue> {
  const item: Record<string, AttributeValue> = {
    entity_id: { S: entity.entityId },
    normalized_name: { S: entity.normalizedName },
    canonical_name: { S: entity.canonicalName },
    owner_kind: { S: entity.ownerKind },
    member_cloud_entity_ids: { SS: entity.memberCloudEntityIds },
    doors_by_parcel_json: { S: JSON.stringify(entity.doorsByParcel) },
    parcel_count: { N: String(entity.parcelCount) },
    doors_estimate: { N: String(entity.doorsEstimate) },
    situs_localities_json: { S: JSON.stringify(entity.situsLocalities) },
    resolution_confidence: { N: String(entity.confidence) },
    updated_at: { S: updatedAt },
  };
  if (entity.mailingAddress) {
    item.mailing_address_json = { S: JSON.stringify(entity.mailingAddress) };
  }
  return item;
}

const OWNER_KINDS: ReadonlySet<string> = new Set(["individual", "llc", "trust", "other"]);

function parseJson<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Parse a stored item back into merge state. Defensive: bad JSON -> empty. */
export function fromItem(item: Record<string, AttributeValue>): StoredEntity | null {
  const entityId = item.entity_id?.S;
  const normalizedName = item.normalized_name?.S;
  if (!entityId || !normalizedName) return null;

  const ownerKindRaw = item.owner_kind?.S ?? "other";
  return {
    entityId,
    normalizedName,
    canonicalName: item.canonical_name?.S ?? "",
    ownerKind: (OWNER_KINDS.has(ownerKindRaw) ? ownerKindRaw : "other") as OwnerKind,
    mailingAddress: parseJson<PostalAddress | null>(item.mailing_address_json?.S, null),
    memberCloudEntityIds: item.member_cloud_entity_ids?.SS ?? [],
    doorsByParcel: parseJson<Record<string, number>>(item.doors_by_parcel_json?.S, {}),
    parcelCount: Number(item.parcel_count?.N ?? "0"),
    doorsEstimate: Number(item.doors_estimate?.N ?? "0"),
    situsLocalities: parseJson<string[]>(item.situs_localities_json?.S, []),
  };
}
