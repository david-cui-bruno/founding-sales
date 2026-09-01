import {
  computeIdempotencyKey,
  newCloudEntityId,
  newSourceEventId,
  type CloudSourceEvent,
  type PostalAddress,
} from "@callie-sourcing/shared";

export const NOW = new Date("2026-09-01T06:00:00.000Z");

export interface ParcelEventSpec {
  cloudEntityId?: string;
  fullName?: string | null;
  orgNames?: string[];
  mailing?: Partial<PostalAddress> | null;
  parcelId?: string | null;
  unitCount?: number | null;
  situsLocality?: string | null;
  person?: null;
}

let counter = 0;

/** A person-bearing parcel identity event, in the pvd-taxroll shape. */
export function parcelEvent(spec: ParcelEventSpec = {}): CloudSourceEvent {
  counter += 1;
  const mailing: PostalAddress | null =
    spec.mailing === null
      ? null
      : {
          line1: "12 Main St",
          locality: "Providence",
          region: "RI",
          postal_code: "02906",
          country_code: "US",
          ...spec.mailing,
        };
  return {
    contract_version: 1,
    id: newSourceEventId(NOW.getTime()),
    idempotency_key: computeIdempotencyKey("parcel", `fixture-${counter}`, "fp"),
    channel: "parcel",
    source_uri: `socrata:test:${counter}`,
    fetched_at: NOW.toISOString(),
    observed_at: NOW.toISOString(),
    entity: {
      cloud_entity_id: spec.cloudEntityId ?? newCloudEntityId(NOW.getTime()),
      person:
        spec.person === null
          ? null
          : {
              full_name: spec.fullName === undefined ? "JANE ROE" : spec.fullName,
              mailing_address: mailing,
              phones: [],
              emails: [],
              org_names: spec.orgNames ?? [],
            },
      property: {
        situs_address: {
          line1: "27 Douglas Ave",
          locality: spec.situsLocality === undefined ? "Providence" : spec.situsLocality,
          region: "RI",
          postal_code: "02908",
          country_code: "US",
        },
        parcel_id: spec.parcelId === undefined ? `P-${counter}` : spec.parcelId,
        unit_count: spec.unitCount ?? null,
        year_built: null,
        use_code: "2",
      },
      known_person: false,
    },
    payload: {
      assessor_class: "2",
      assessed_value_usd: 500000,
      tax_usd: 5000,
      absentee: true,
      owner_kind: null,
      tax_year: 2025,
    },
    signal_flags: {
      self_managed: null,
      vacancy: null,
      pain_mentions: [],
      urgency: 0,
      portfolio_hint: null,
    },
    trigger: null,
    scores: null,
    provenance: { adapter: "pvd-taxroll", adapter_version: "1.0.0", confidence: 0.95 },
  };
}

/** Deterministic, valid ce_ id ordered by `n` (0-99). */
export function ceId(n: number): string {
  return `ce_${String(n).padStart(26, "0")}`;
}
