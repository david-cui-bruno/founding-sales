# Sourcing Inbox Integration Plan (app side)

**Goal:** the Mac app polls the cloud inbox, maps CloudSourceEvents into CRM intake
commands, uploads the membership set and outcome labels, and layers local score
adjustments. Depends on migration 0005 (channels parcel/deed/permit/violation,
segments hot/cold/warm) being landed.

**References:** `cloud/CONTRACT.md` (wire format), `cloud/VERIFIED_SOURCES.md`,
`src/main/domain/source/sourceService.ts` (intake), `docs/superpowers/plans/` house style:
TDD RED→GREEN per task, `.strict()` zod, injected clock/ids, exact commit messages.

---

## Task 1: Inbox client (pure S3 polling layer)

`src/main/sourcing/inboxClient.ts`
- Scoped read-only key from Keychain (service `com.callie.sourcing-inbox`, account
  `app-inbox`); key material imported once from `~/.callie-sourcing-app-inbox-key.json`
  via a one-time settings action (Task 4) — never bundled.
- `listNewObjects(sinceKey)` — S3 ListObjectsV2 on `events/`, lexicographic cursor
  (keys embed date + ULID so ordering is stable); `fetchNdjson(key)` — GetObject,
  parse ndjson, validate each line against a LOCAL zod mirror of CloudSourceEvent v1
  (`src/shared/contracts/cloudSourceEventContract.ts`, `.strict()`; invalid lines are
  quarantined, not fatal).
- No AWS SDK dependency in the renderer; main-process only. Use `@aws-sdk/client-s3`
  in main. Injected clock, injected client for tests.
- Commit: `feat: sourcing inbox client with cursor and quarantine`

## Task 2: Intake mapper (CloudSourceEvent → CRM commands)

`src/main/sourcing/intakeMapper.ts`
- channel→segment mapping per 0005 (frbo,community→hot; registry,parcel,deed,permit,
  violation→cold; rireig,referral,inbound_demo→warm).
- Person-bearing events (parcel etc.): map to source intake command with person
  descriptor (name, mailing address, org names), property, sourceRecord = full payload
  JSON (typed, no prose by contract), idempotency via existing
  `source_intake_receipts` keyed by the CLOUD idempotency_key (store as
  `cloud:<idempotency_key>` in the receipt command_json for replay detection).
- Person-null events (frbo/community): create Unreviewed review items tied to the
  property/situs address; the founder resolves identity manually until entity
  resolution ships. These become `Unreviewed` cycles per existing lifecycle.
- Scored re-emissions (scores_version present, same idempotency_key): update the
  prospect's cloud-score fields only, never re-create.
- Trigger-bearing events for KNOWN persons: trigger_events row (0005 mappings).
- Commit: `feat: cloud event intake mapper with idempotent replay`

## Task 3: Poller service + scheduling

`src/main/sourcing/sourcingPoller.ts`
- Poll on app focus + every 15 min while running (injected timer). Cursor persisted
  in a new `sourcing_cursor` single-row table (part of 0006 migration below).
- New migration 0006SourcingState: `sourcing_cursor(id CHECK id=1, last_key TEXT,
  polled_at TEXT)`, `cloud_entity_links(cloud_entity_id TEXT PRIMARY KEY, person_id
  TEXT REFERENCES persons(id), linked_at TEXT)` — the local-only mapping.
  Schema gate 5→6, storageReadiness, KNOWN_SCHEMA_VERSIONS.
- IPC + preload: `sourcing.pollNow`, `sourcing.status` (last poll, backlog count,
  quarantine count). Read-only status chip in Today header.
- Commit: `feat: sourcing poller with cursor persistence and status surface`

## Task 4: Upstream sync (membership set + outcome labels)

`src/main/sourcing/upstreamSync.ts`
- Membership set: cloud_entity_ids from `cloud_entity_links` + salted-HMAC
  (SHA-256, salt fetched ONCE from SSM parameter via founder-supplied value pasted in
  settings — the app never holds AWS SSM permissions; salt cached in Keychain) of
  normalized phones/emails for manually-added persons. Upload to
  `upstream/membership/<date>.json` — requires s3:PutObject on `upstream/*` ONLY:
  IAM user policy must be extended (terraform note, keep GetObject on events/).
- Outcome labels: on lifecycle transitions (Interviewed/Offered/Won/Lost) where the
  person has a cloud_entity_link, append `{cloud_entity_id, label, loss_reason_code,
  override_direction, observed_at}` to a local outbox table; flush to
  `upstream/outcomes/<date>.ndjson` on poll. NO names, NO notes (schema-enforced:
  the zod upload schema has no string fields except enums/ids/timestamps).
- Commit: `feat: privacy-preserving upstream sync (membership set, outcome labels)`

## Task 5: Local score adjustments + Today integration

- Cloud fit/timing stored on prospect; local adjustments (existing priority context,
  founder overrides) layered in the Today ranking WITHOUT blending into a single
  opaque number (user rule: no blended lead score ever) — display as
  `Fit 62 · Timing 41` chips with top-3 reasons tooltip, sort Today by
  score band then freshness, capacity-bound to ~40.
- Override logging: one-tap "wrong signal" on the lead card writes override_direction
  to the outcome outbox.
- Packaged E2E: drop a fixture ndjson into a temp inbox (LocalStack-free: point the
  client at a filesystem fake via injected client), poll, verify Unreviewed item
  appears with reasons; axe on new surfaces.
- Commit: `feat: cloud scores in Today ranking with explainable reasons`

## Sequencing

Task 1+2 parallelizable after 0005 lands; Task 3 depends on 1+2; Task 4 anytime after
0006 exists (Task 3); Task 5 last. IAM upstream/* PutObject change goes in terraform
with the adapter/scorer resource sync.
