# CloudSourceEvent Contract v1

The wire format between the sourcing cloud and the Callie Mac app. Adapters write
newline-delimited JSON objects (one file per batch) to the inbox bucket
`callie-sourcing-inbox-326255650484` under `events/YYYY-MM-DD/<adapter>-<ulid>.ndjson`.
The app polls with a read-only key, maps events into CRM intake commands, and records
`source_intake_receipts` keyed by `idempotency_key` so replays are no-ops.

The canonical schema lives in `cloud/lambdas/shared/src/sourceEvent.ts` (zod, `.strict()`).
Terraform, adapters, and the app-side poller all conform to THIS document. Change it
only with a version bump and a migration note.

## Design rules

1. **Typed fields only.** No free text about a person anywhere in the event. Raw
   listing/review/post text is extracted into flags cloud-side and discarded.
2. **`channel` is first-touch provenance** — what kind of source can mint a person.
   `trigger` is what happened. A Google review never mints a person: it resolves via
   address → parcel → owner, so its event carries `channel: "parcel"` with
   `trigger.type: "review_pain"`.
3. **Idempotency before identity.** `idempotency_key = sha256(channel + "|" + source_natural_key + "|" + content_fingerprint)` (UTF-8 bytes, literal `|` joiner, lowercase hex output)
   computed cloud-side. The app must treat a duplicate key as already-imported.
4. **Cloud entity IDs are stable** (`ce_` prefix, ULID). The app maps them to local
   persons; the mapping never leaves the Mac. Outcome labels flow back keyed by
   `cloud_entity_id` only.

## Channels (align with CRM migration 0005)

| channel | mints person? | segment | examples |
|---|---|---|---|
| `frbo` | yes | hot | Zillow/Apartments by-owner listing |
| `community` | yes | hot | F5Bot Reddit/HN keyword hit with identifiable poster |
| `registry` | yes | cold | RI Rental Registry row |
| `parcel` | yes | cold | RIGIS/MassGIS/CT parcel owner |
| `deed` | yes | cold | masslandrecords / recently-sold pass |
| `permit` | yes | cold | Boston/Providence building permit |
| `violation` | yes | cold | ISD violation, failed inspection |
| `rireig` | yes | warm | RIREIG membership |
| `referral` | yes | warm | referral |
| `inbound_demo` | yes | warm | inbound demo request |
| `custom` | yes | (caller) | manual/CSV import |

## Trigger types (v1 set)

`frbo_listing` (half-life 3d), `community_post` (7d), `violation_opened` (45d),
`permit_filed` (60d), `deed_transfer` (180d), `review_pain` (45d),
`lead_cert_window` (window: ramps from 120d out), `heating_season` | `student_turnover` |
`tax_season` (seasonal), `registry_delta` (no decay, informational).

## Event shape

```jsonc
{
  "contract_version": 1,
  "id": "se_01JC...",                     // ULID, adapter-generated
  "idempotency_key": "hex sha256",
  "channel": "permit",                     // enum above
  "source_uri": "analyze-boston:approved-building-permits:A123456",
  "fetched_at": "2026-09-01T03:00:00.000Z",
  "observed_at": "2026-08-30T00:00:00.000Z",
  "entity": {
    "cloud_entity_id": "ce_01JC...",       // null when unresolved
    "person": {                            // provisional descriptor, typed only
      "full_name": "JANE ROE",             // as in the public record
      "mailing_address": { "line1": "...", "locality": "...", "region": "RI", "postal_code": "02906", "country_code": "US" },
      "phones": ["+14015551234"],          // E.164, only if public record carries it
      "emails": ["jane@example.com"],
      "org_names": ["ROE PROPERTIES LLC"]
    },
    "property": {                          // null when event is person-only
      "situs_address": { "line1": "...", "locality": "Providence", "region": "RI", "postal_code": "02905", "country_code": "US" },
      "parcel_id": "PROV-123-456",
      "unit_count": 3,
      "year_built": 1918,
      "use_code": "3F"
    },
    "known_person": false                  // true when membership set says the app already has this entity
  },
  "payload": {                             // channel-specific typed fields, schema per channel in sourceEvent.ts
    "permit_type": "plumbing",
    "declared_value_usd": 8500,
    "status": "approved"
  },
  "signal_flags": {
    "self_managed": true,                  // null = unknown
    "vacancy": null,
    "pain_mentions": ["plumbing"],         // enum: no_heat|slow_repair|unresponsive|plumbing|electrical|pests|mold|other
    "urgency": 1,                          // 0-3
    "portfolio_hint": null                 // int | null
  },
  "trigger": {                             // null for pure identity events (registry row, parcel row)
    "type": "permit_filed",
    "weight": 1.0,
    "half_life_days": 60,                  // decay triggers
    "window": null                         // window triggers: { "opens_at": ..., "peaks_at": ..., "closes_at": ... }
  },
  "scores": {                              // cloud-computed, app layers local adjustments
    "fit": 62,                             // 0-100, per-state normalized
    "timing": 41,                          // 0-100, decayed trigger mass
    "reasons": [                           // 1 to 3 entries, highest contribution first
      { "signal": "portfolio_in_band", "contribution": 15 },
      { "signal": "multi_unit_stock", "contribution": 12 },
      { "signal": "permit_filed_recent", "contribution": 12 },
      { "signal": "pre_1940_stock", "contribution": 8 }
    ]
  },
  "provenance": { "adapter": "boston-permits", "adapter_version": "1.0.0", "confidence": 0.92 }
}
```

`scores` is `null` until the scoring engine runs; adapters emit events without it and
the scorer re-emits enriched events (same `idempotency_key` + `scores_version` bump —
the app updates scores idempotently, never duplicates the person).

## Upstream (app → cloud)

Two objects, written by the app to `s3://callie-sourcing-inbox-326255650484/upstream/`:

1. **Membership set** `upstream/membership/<date>.json`:
   `{ "cloud_entity_ids": ["ce_..."], "contact_hmacs": ["hex..."] }`
   HMAC-SHA256 over normalized phone (E.164) or lowercased email, salt stored in the
   Mac Keychain and in SSM (shared secret, provisioned once). Lets the cloud tag
   `known_person` without cleartext.
2. **Outcome labels** `upstream/outcomes/<date>.ndjson`:
   `{ "cloud_entity_id": "ce_...", "label": "interviewed|offered|won|lost", "loss_reason_code": "...", "override_direction": "up|down|null", "observed_at": "..." }`

No names, no notes, no free text ever flows upstream.

### `upstream/suppressions/<YYYY-MM-DD>.ndjson` (app -> cloud)

One line per opted-out contact handle:
   `{ "contact_hmac": "<64 hex>", "kind": "phone|email", "reason": "opt_out|wrong_person|founder_block", "observed_at": "..." }`

The HMAC uses the same salt + canonicalization as membership uploads. The
suppression-sync stage writes each hash into the suppression table; it is the
table's ONLY writer (the enricher reads it, never writes). Raw handles never
flow upstream.

## Compliance invariants

- An event whose entity matches the suppression table (contact_hmac hit) is dropped
  cloud-side and logged, never written to the inbox. Enforcement point: any adapter or
  stage that emits an event carrying person contact data must check suppression first.
  Stages whose events carry `person: null` (mail-parse FRBO/community) are exempt and
  intentionally have no suppression-table IAM access; the entity-resolution stage
  re-checks when it attaches a person.
- `observed_at` semantics per stage: alert emails use the message `Date` header
  (fallback: SES receipt time); batch snapshots use the source's own record date
  (fallback: snapshot date).
- Channels without a payload schema in `sourceEvent.ts` are rejected by
  `validateSourceEvent` by design. Adding a channel's adapter REQUIRES landing its
  payload schema in the shared package in the same change.
- Events carry no protected-characteristic data; the extraction prompt forbids it and
  the schema has nowhere to put it.
- `payload` schemas are closed (`.strict()`); adapters cannot smuggle prose.

## Known operational limits

- SES inbound (the FRBO/community hot channel) is region-bound to us-east-1: a
  regional outage pauses hot alerts until it clears. Batch adapters and scoring
  are unaffected (S3/DynamoDB in-region but replayable; adapters re-emit
  idempotently on the next run). Accepted SPOF at this scale.
- Entity identity keys on sha256(normalized_name | zip5). Live scan 2026-09-03:
  0 same-name collisions across 353 entities. If common-name collisions ever
  exceed ~2% (per external review threshold), escalate to keying on
  name + full standardized mailing address or probabilistic linkage.
