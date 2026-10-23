# 0015: Browser-reviewed replies and sourced meeting preparation

## Scope

October22 local continuation after closed issue742. Reuse existing reply-card/composer and meeting-preparation owners over the reviewed HTTPS browser host. Controlled synthetic data and a fixture-only injected reply port are permitted. No live acquisition, inference, provider configuration, send, booking, hosting or private-business routing is activated. Production/client881/schema129, OFF and desktop fallback remain unchanged.

## Closed interface

Browser POST reads: `/replies`, `/replies/card`, `/replies/composer/context`, `/replies/composer/preview`. Browser command: `/replies/composer/generate`, with the existing server-pinned client version and paid-attempt UUID. Browser GET reads: `/meetings/firm` and `/meetings/brief?meetingId=<uuid>&version=2&include=meeting_tasks`. Existing strict contracts and domain owners remain authoritative. No send/status, reply confirmation, settings, attendance, match or scheduling route is added. No new schema, model, auth engine or background scheduler.

Every private read/result must retain current workspace, membership, session/device, assigned-Firm and source access after waits. Actual revocation refuses and clears browser private state. Missing/changed source is not permission to reveal stale context or regenerate under a replacement UUID. Existing owner-consent, approved facts, source revision, recipients, suppression, holds, reservations and budgets apply to generation. Production port remains absent unless separately configured under its existing authority. No generation on page load, reload, timer or retry loop.

## Browser custody and review

Private cards, original/prior text, generated suggestion, editable draft, preview, recipient addresses and meeting brief live only in the mounted session's memory. Do not put them into local/session storage, URLs, logs, receipts or process-wide caches. Logout, auth refusal, expiry, revision/identity/role transition and cross-tab invalidation clear projections, operation owners and locks. A late response cannot repopulate or unlock replacement work.

Before an explicit generation request retain an IDs-only pending record bound to the current public identity/revision and expiry no later than session expiry: messageId, sourceRevision, commandId, approved fact IDs/versions and a fingerprint of the exact current default envelope. Reconstruct only from fresh authorized context matching those fields. A lost response retains this identity across reload; no automatic replay, replacement UUID, paid retry or invented recovered prose. An explicit same-attempt check may return already-attempted/unknown, which remains unavailable rather than causing another provider call. Actual auth loss clears custody, authenticated source unavailability must not erase uncertainty. Browser global409 invalidates authority conservatively, so composer content/generation refusals must be represented separately from real auth/revision refusals.

Generated text is a suggestion requiring final human review. Manual edits invalidate preview. Preview binds current context and exact selected approved facts/default recipient envelope. No send control or endpoint is available in this slice, and preview is not sending permission. Booking links appear only if present in currently approved facts, never from invented configuration.

## One-screen preparation

Read existing v2 meeting preparation from the selected Firm's existing meetings. Show bounded company/person facts, previous interactions, explicitly inferred/unverified hypotheses, up to three sourced preparation questions, next-step objective and accessible source/date labels. Empty evidence stays unknown. No invented pain, commitment, booking or capability. Preserve legacy brief contracts.

## Plan and verification

Root owns this contract, browser allowlist, BrowserApp placement, integration and tracker/docs. An API/domain owner owns current-access/refusal composition and focused tests. A browser-reply owner owns new reply/pending components and focused tests. A separate brief owner owns new meeting-preparation component/tests. One acceptance owner owns new controlled signed-OIDC/HTTPS/PG/Chromium fixtures and the sole disposable PG lane, after implementation readiness. No shared file has two writers.

New composed acceptance covers reply selection/current context, explicit controlled generation, edits/exact preview, no outbound writes, sourced brief, missing/changed source, lost response and unchanged attempt identity, logout/revocation/cross-tab/late response. Existing accepted browser/host/supply suites remain closed. Finish normal types/lint/workflow/scoped secret scan, owned cleanup and spec/standards/privacy review, with the same reviewers checking fixes only. This is not model quality, permitted-original availability or real selling acceptance.
