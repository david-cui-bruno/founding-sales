# 0025: Calling composes existing outcomes with private promised-email work

## Status and scope

Accepted local implementation under usable workspace #783 and child #790, David's October26 2026 00:04:42 approval of Sheep design d1240dc. Design approval is not permission to call, send, publish, acquire, spend or deploy. Existing source, assignment, channel, owner pause and execution policies remain authoritative. Root owns interfaces and integration. One Calling owner implements the complete vertical outcome, Email consumes the same private draft owner.

## Subjects and boundaries

`contracts/calling.ts` separates exact candidate/revision from explicit canonical Firm with optional current Today item/opportunity. No inferred association by name, site, endpoint, grouping or qualification admission. Candidate report uses ADR0024 and never becomes a CallOutcome, callback/Today task or suppression. Canonical report calls the existing `logCallOutcome` owner, retaining its actual dispositions, callback clock, suppression scope and assignment policy. Explicit user attestation is required. A UI label such as Connected must not silently mean interested.

Calling reads existing current Today/CRM/research/candidate interfaces. Research readiness is not callability. A website is observed unless current identity evidence supports the exact selected entity. No live reachability claim, automatic fetch/embed or email-domain inference. Safe deliberate HTTP(S) links only. Queue selection/pause/next is local navigation, not a new queue engine. This slice does not expose dial reservation or execution.

## One current-content private draft

Reserve migration **0138_calling_follow_up_drafts.sql**, owned by the Calling implementer after this root contract commit. Table `calling_follow_up_drafts` binds workspace, creator, positive revision and exactly one candidate/revision/manualAttempt or Firm/callLog source. Exact same-workspace foreign keys/checks prohibit mixed branches. One draft per exact source, including after withdrawal, prevents accidental reminting. Subject is nonblank at most160 characters/640 bytes, body4000 characters/16000 bytes. No recipient address, copied private call note, generated inference or approved-template identity. Recipient stays unresolved. `queued_for_review` means saved Email work only, not a scheduled send or consent.

Available content can be edited with revision CAS or permanently withdrawn. Withdrawn/source-unavailable states physically clear subject/body and retain only body-free source/command fencing. SQL constraints must reject malformed/null/extra-key content and enforce terminal erasure, not rely on HTTP validation. Reads require current same private principal, exact source authority and current revision. Candidate change, report withdrawal/deletion, raw-source erasure/retention and canonical deletion/retention must clear content through existing lifecycle owners before denial evidence disappears. Candidate optional-phone evidence alone is not raw-source authority. No audit/receipt/history/log duplication of prose. Creator-only draft access plus existing subject access, not workspace-wide private draft visibility.

## Wrap transaction and failures

Canonical wrap calls `logCallOutcome` once under its existing send-gate-first lock order. The existing engaged-call stop remains Firm-wide: pending/held executions cancel, live enrollments stop, sent history remains. Dispatching/reconciling/unknown history is not relabeled canceled. Do not add a campaign engine or weaken these stops to mimic the prototype. `setManual:false` may mean already manual, not failed stopping. Confirm effects and current stop state before returning `staleIntroductions:stopped`.

If the call owner reports effects_not_applied, keep its honest history and return `not_queued`, never queued success. After successful effects, create the private draft in a savepoint. A confirmed draft business refusal rolls back only draft work, preserves call/stop and returns explicit `not_queued`. Infrastructure or final authority failures roll back the entire outer command and leave uncertain browser custody. No hidden retry of call logging. Canonical reached dispositions use the existing reached set (interested/referral/callback/not_interested), not inferred buying interest. No legacy template followUpPermission inside this wrapper.

Candidate wrap takes source lifecycle locks before candidate/report/draft, reuses manual-report owner and final source/principal fences, and makes no canonical mutation. Promised preparation requires an explicit conversation, callback_requested or not_interested report. Report-only accepts existing honest unknowns. Both branches require explicit promised_email selection and independently edited content. Never synthesize from private notes. Final principal/source checks run after receipt uniqueness and other waits, before commit.

## Closed routes and custody

Five POST routes: `/calling/wrap`, `/calling/follow-ups/list`, `/calling/follow-ups/read`, `/calling/follow-ups/save`, `/calling/follow-ups/receipt`. Root owns registration and browser allowlist. Scoped `callingBoundary.ts` maps confirmed content/source/CAS refusals separately from authentication loss. No generic calls proxy or sending route. Metadata list is bounded20/keyset and contains no subject/body/address/note. Exact read requires ID/revision. Edits/withdrawal use normal command envelope and CAS. Receipt binds wrap/save kind, UUID, canonical parsed-payload hash, workspace/user/device and returns historical opaque acceptance, never current content authority.

Browser keeps only IDs/hash/operation/revisions under existing identity/expiry WebLock custody. Persist before dispatch, no prose in storage/URL/logs. Unknown blocks conflicting exact-subject actions, not unrelated entries, with explicit receipt-only recovery and no replay/remint. Source loss clears content but retains opaque uncertainty. Actual logout/expiry/identity/session/role loss clears custody and late results. No Next or success discard on UNKNOWN. Accepted receipt requires a fresh current read. Calling-to-Email navigation carries draftId only; both use the same owner. Editing invalidates any local review.

## Verification and delivery limits

Focused real-interface safe-data acceptance covers raw unknown-phone save/read with zero canonical effects, canonical reached stop plus edited draft while sent/uncertain history remains, private-note exclusion, source/retention erasure, actual transaction waits, final authority rollback, duplicate UUID and CAS, response loss/reload/receipt/cross-tab/logout. Migration constraints/upgrade and real app_runtime requests are required. Root grants the sole disposable PG/HTTPS/OIDC/Chrome lane explicitly. Finished SPEC/STANDARDS/privacy-risk review once, findings returned to the same owners. No fixture-only UI success, local-to-production implication or real-customer usefulness claim.
