# Enrichment Gate Plan (Tracerfy skip-trace, DNC scrub, suppression)

**Goal:** contact enrichment as a *gated verb*: only founder-approved, Fit-gate-passing
leads get skip-traced; every dialable number is DNC-scrubbed and suppression-checked
before it can surface. Compliance lives in the schema.

**References:** design spec §3.7/§6, `cloud/CONTRACT.md` (suppression invariants),
`docs/sourcing/founder-actions/dnc-registration.md`. Blocked founder actions: Tracerfy
signup (marketing/non-FCRA tier), DNC SAN acquisition. Build fully stubbed; flip env
vars when accounts exist.

## Shape

Enrichment runs CLOUD-side (vendor API keys never live in the app), triggered by an
explicit app request (founder taps "Find contact info" on an eligible lead). Flow:

app → upstream/enrichment-requests/<date>.ndjson  { cloud_entity_id, requested_at }
cloud (Lambda `enricher`, EventBridge every 15 min):
  1. read new requests (snapshots-table cursor)
  2. entity lookup → REQUIRE fit-gate pass recorded in request (app enforces; lambda re-checks shape)
  3. suppression check (contact_hmacs table) — drop + log if hit
  4. Tracerfy PAYG lookup (env TRACERFY_API_KEY, stub mode when unset: returns fixture)
  5. DNC scrub (env DNC_SAN + file from telemarketing.donotcall.gov; stub mode: all clear)
     — result cached per phone in a `dnc_status` DynamoDB table w/ 31-day TTL re-check
  6. emit SourceEvent channel matching original entity, payload enrichmentPayloadSchema:
     { phones: [{e164, dnc_listed: bool, scrubbed_at}], emails: [lowercased],
       vendor: 'tracerfy', hit: bool, cost_usd } — trigger null, person carries the contact
  7. write vendor cost to a `spend` DynamoDB item (monthly rollup); HARD STOP putting
     requests when month-to-date >= $20 (env EXTERNAL_SPEND_CAP_USD), alarm at $15 (SNS).

App side:
- "Find contact info" button visible only when prospect is eligible + fit >= gate.
- Poller imports enrichment events like any other; contacts land through the existing
  contact-method flow (dnc_listed numbers stored but rendered non-dialable).
- Render-time + dial-time suppression checks already exist app-side (opt_out_tombstones);
  add dnc_listed check to the dial affordance.

## Tasks
1. cloud: `enrichmentRequestSchema` + `enrichmentPayloadSchema` in shared, enricher
   Lambda (stub-mode Tracerfy + DNC), spend cap + alarm, terraform. Live-verify in stub mode.
2. app: request button + IPC + upstream write; import path for enrichment events;
   dial affordance honors dnc_listed. Migration only if a new column is needed
   (dnc fields fit in existing contact-method metadata? verify; prefer no migration).
3. founder: Tracerfy key + DNC SAN → SSM params → env flip → live paid verification
   against ONE known lead, checking hit rate + cost logging.

## Non-negotiables
- No enrichment without an explicit request row (no bulk enrichment, ever).
- Suppression checked cloud-side at request AND app-side at render/dial.
- 12-month purge: uncontacted enriched contacts follow the existing retention design
  (implement the purge job when retention lands globally).
