# ADR 0021: Durable private social composition

Accepted October25, 2026 for issue771, following delivered readonly review/memory scratch ADR0020. This decision adds private persistence, not generation, publishing or account authority.

## Boundary and owner

Use one destination-independent `social_private_drafts` table, migration0135, owned by the existing social domain and ordinary authenticated command runner. Do not widen account-required publishing `social_posts`, create fake accounts or connect drafts to approvals, schedules, delivery, jobs, providers or social accounts. Explicit post/comment format has no external target. Store only current text, no prose revision history. Revisions are compare-and-swap counters.

Exact browser POST reads: `/social/private-drafts/list`, `/social/private-drafts/read`, `/social/private-drafts/receipt`. Exact command: `/social/private-drafts/save`. Strict contracts in `socialPrivateDrafts.ts` reject all publishing/account fields and client origin replacement on update. List at most20 metadata entries, no excerpts. Explicit reopen obtains current authorized text. Save result and server command receipt contain only draftId/revision, never text. Receipt projection is owner/workspace/device/exact-command-kind and canonical-payload-hash bound. It only reads the existing receipt, never creates a parallel command ledger or replays a write.

## Provenance and lifetime

Manual composition is owner-provided unverified text. Application-mediated suggestion adoption has sticky server-derived lineage through edits, format changes, saves and conflicts. No detach/copy-as-manual action. Starting manual composition first clears the old full text and origin. This is not a claim to detect arbitrary externally pasted/retyped source text or malicious textual taint.

First sourced save requires the exact current ready, unexpired selected request and variant, server validation of current source selection/hash and fact versions, and fresh wallclock checks after all waits. `selectionSHA256` is SHA256 of UTF8 JSON.stringify({request: socialDraftViewSchema.parse(selectedRequest), conceptIndex, variantIndex}) in that key order. It binds the full normalized selected request and indexes, not positional identity alone. Provenance is not semantic support or approval of edited prose.

**Persisted composition lifetime is explicitly separate from the generation-request deadline.** A successful first sourced save captures the authoritative immutable source selection/hash and fact versions. Later read/update validates this saved source basis independently through existing source-policy owners, without re-running generation or renewing a request. The original request's30-minute dispatch deadline does not expire already-saved composition. Current source eligibility, shorter news freshness, exact source changes/retirement/deletion/retention and ownership still govern every derived byte. Use fresh wallclock after waits, not transaction-start now().

Manual and sourced compositions expire at most90days after first save. Updates do not extend this bound. Show expiry before/after save. Source-dependent loss/expiry withholds prose immediately and terminal erasure clears current stored text and private snapshots, increments revision and prevents stale-save resurrection. Transient session/auth failure clears browser projections but does not erase legitimate manual server text. Lock/source serialization and physical removal must integrate normal CRM/source/fact/retention owners, including underlying public-source references of fact blocks. Read-time refusal alone is not erasure. Existing retention sweep performs deadline cleanup, no new scheduler/job. No irreversible deletion button is introduced.

## Save custody, authorization and conflicts

Persist only opaque identity binding, commandId, operation, draftId/revision where known, canonical parsed-payload fingerprint and bounded custody expiry BEFORE dispatch. No prose in browser storage, URL, logs, caches or receipt projection. In-memory payload may support an explicit exact-sameUUID/same-payload retry. After refresh, explicit sameUUID/fingerprint receipt read needs no lost prose. Accepted receipt is historical result only, followed by current draft read. Absent receipt is UNKNOWN, not proof of no write or permission to remint an operation. No automatic replay, silent replacement or guessed payload reconstruction. Fail closed on custody storage corruption/failure and serialize cross-tab operations using Web Locks plus existing client/session invalidation.

Source/association locks precede private draft locks, then fresh principal checks with exact retained device/session authority through commit. Reread source eligibility after waits under a fresh statement snapshot. Revalidate principal on normal result, receipt replay and late response. Updates cannot change persisted lineage, overwrite a different revision, revive terminal text or edit while an uncertain operation is unresolved. Unsaved authorized manual conflict edits may remain only in mounted memory, visibly unsaved. Scope loss clears all private projections. No content in audit details or test artifacts.

## Acceptance and excluded scope

Actual signed HTTPS/OIDC/gateway/API/app_runtime/Postgres/browser acceptance covers account-free save/list/reopen/refresh/edit, conflicts, sameUUID lost-response/reload receipt recovery, UNKNOWN hold, source lifecycle/normal deletion/retention and principal changes during real lock waits, expiry and late responses. Verify stored erasure as well as withheld projections. No changes to publishing posts/revisions, approval/delivery/account/weekly/provider/job/acquisition/contact ledgers. Focused constraints/upgrade/retention/current-authority tests and finished spec/standards/privacy reviews accompany normal CI and protected release. Hosted acceptance uses newly authored neutral owner-private text only, never discards existing owner work.

Voice learning, model generation, sourced comment generation, durable voice preferences, approval, scheduling, publication, handoff, external actions and new provider/data/spend scope remain separate follow-ons.
