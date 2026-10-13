# #616 source acceptance, October 13, 2026

## Delivered boundary

Normal authenticated Settings controls save, read, revise, disable and revoke a separate versioned standing LinkedIn posting policy. Saved is never technically ready or enabled. The fixed #608 scope is displayed: intended personal profile, text-only Tuesday/Thursday 10AM America/New_York, at most two weekly, governed sanitized facts/public-source provenance and voice boundaries, exact Bedrock social-draft route/model, $1 New York day/$10 calendar month within stricter limits. Optional version references record configuration, not provider, credential, allowance or native evidence.

An approved text-only LinkedIn post can be **owner-staged** against the durable current policy revision through Social. The server derives account, owner, delivery and policy authority. This does not create approval, certify grounding, or implement #617 automatic candidates. Existing manual approval/fingerprint/device gates remain necessary. Unbound manual delivery remains available.

## Behavioral acceptance map

`apps/api/test/linkedinPostingPolicy.test.ts` uses authenticated public routes, disposable PostgreSQL and real `app_runtime` sessions. OAuth and the external native adapter/HTTP response waits are controlled boundaries. SQL barriers synchronize actual locks only, never manufacture policy or candidate bindings.

- Save/read/revise/disable/revoke: durable revision history survives application-role restart, old command replay cannot restore current policy. Outreach policy is unchanged. Invented Enable has no route.
- Positive ordinary caller: policy save → post save → unchanged manual approve → owner bind → queue → claim → begin → final freshness read → controlled adapter submits once → ordinary observation conserves the receipt. Confirmed schedules obey existing next-inspection timing. After revoke, an ordinary cancellation request still discovers the same native receipt without replay.
- Candidate currentness is genuinely true before revocation while overall publication readiness remains false. Revocation during adapter preparation refuses begin, dispatch count stays zero, stale unattempted work disappears from queue. Unbound manually approved work still begins normally.
- Revocation during the committed begin-response wait produces unknown without native submit. The same submission marker survives restart as inspect work, and fresh claim refuses replay.
- Real observed PostgreSQL blocking barriers cover bind → revoke → claim, revoke → queue observer, account change → bind, and final freshness read → sign-out. Account/policy locks precede post locks. Binding discovery is serialized against late owner staging. Final pure read reauthenticates after waits.
- Wrong owner/workspace/device, anonymous caller, exact-scope/budget/model violations, stale post/policy revisions, repeat binding and attempted work refuse. Immutable binding cannot be rebound to salvage old work.
- Normal desktop host operations exercise save/read/revise/revoke against the same API/database and discard a response after session generation changes.

`apps/desktop/test/linkedinPostingPolicy.component.test.tsx` exercises owner save/revise/revoke actions and visible stale settings/candidate refusals, not label-only rendering. `linkedinPostingPolicy.delivery.test.ts` exercises server-derived bound-marker fail-closed behavior when the final callback is absent, false or throws, positive bound submit-once and unchanged optional-callback-free manual behavior. Closed operation registry and actual bridge traffic are covered by the existing registry suites; route inventory includes all seven policy endpoints.

### Genuine development RED → GREEN

- Missing save/read endpoint: ordinary save returned 404 before persistence implementation, then saved exact separate scope with false readiness/Enable.
- Missing owner bind endpoint: public binding returned 404 before immutable staging, then normal approved delivery queued, claimed and began successfully.
- Missing history/candidate readback: behavioral read assertions failed before those public summaries, then durable revisions/currentness were visible.
- Preparation wait revocation: baseline continued into submission with an unknown result and external dispatch; claim/begin fences now return `not_submitted: policy_revoked` with zero dispatch.
- Begin-response wait revocation: baseline external dispatch was `['submit']`; trusted bound marker plus final freshness callback now dispatches nothing and conserves inspection marker.
- Missing owner UI controls: behavioral button lookup failed before UI implementation, then owner controls succeeded and stale refusals stayed nonoptimistic.

Additional concurrency/scope/receipt/session tests are regression evidence, not claimed newly observed RED slices. Real-role concurrency exposed a forbidden share lock on immutable approvals; fixed by reading immutable approvals while retaining account/policy/post/delivery locks, without widening grants. A receipt test initially assumed immediate inspection of a confirmed future schedule; corrected to the ordinary due-time/cancellation behavior, without fake clocks or changing queue timing.

## Persistence inventory

Migration `0109_linkedin_posting_policy.sql`, declared changed tables:

1. `linkedin_posting_settings`: owner/workspace current revision/state/snapshot, SELECT/INSERT/UPDATE only.
2. `linkedin_posting_policy_revisions`: immutable owner-scoped revision history, SELECT/INSERT only.
3. `linkedin_posting_candidate_bindings`: immutable exact delivery-to-policy revision binding, SELECT/INSERT only.

All three have registered negative constraint cases and retention entries. No delete/update grant on immutable history/bindings, no copied draft bodies, private inputs or credentials. Schema support is 109 without weakening startup checks. The focused migration/constraints/retention run passed 2,685 tests. Existing domain delivery suite passed 10 tests. Affected contracts/domain/API/desktop typechecks and changed-TypeScript ESLint are required before freeze. Root owns integrated full gates, upgrades, all-ref secrets and independent Spec/Standards review.

## Precise final admission limitation

The final authenticated pure-read freshness check occurs after begin's network response wait and immediately before `adapter.submit`. Bound work fails closed if that callback is missing, false, offline or throws. A committed marker is preserved, not retried or released.

The unchanged native LinkedIn adapter then awaits its internal `same()` account probe before `executeJavaScriptInIsolatedWorld` executes the submit script. The script checks composer/content/media/button, stores its window marker and clicks synchronously. A server HTTP check cannot atomically cover the final check → native account-probe wait → irreversible click distributed race. This implementation makes no claim that revocation atomically prevents every external action after final admission, and cannot unsend submitted work. No native/provider acceptance or live account operation was performed.

## Reviewer readback repair

Independent Spec review found that retrying a lost save response after another owner session revoked could display the immutable saved revision-1 receipt while durable current state was revoked revision 2. A normal host/API `app_runtime` test reproduced this genuine RED. The same-command retry now performs fresh authenticated policy readback after confirmed save/disable/revoke success, guarded by the original session generation before and after both waits. Immutable API receipts and command IDs remain unchanged. A visible UI host/transport test confirms Revoked 2, its held reason and the identical retry command ID. If current readback is unavailable after confirmation, UI removes the stale scope, displays current state as unavailable, and offers a read refresh rather than another policy command. The unavailable-current UI assertion also failed before the repair. API session-switch-during-readback and offline-read regressions pass. Closed operation declarations include the existing policy read as the conditional second request, without adding authority or a new operation.

Baseline `8e0939ce` was kept separate from this isolated repair checkout. Two initially appended test-only hunks briefly overlapped the baseline gate before the concurrency notice, then were transferred exactly and removed with narrow edits. The original checkout was verified clean again; that overlapping gate is not claimed as pristine exact-head final acceptance. Root owns renewed review/gates on the repaired immutable head.

## Exact changed file inventory

- API: `apps/api/src/routes/{linkedinPostingPolicy.ts,modules.ts,social.ts}` and `apps/api/test/{linkedinPostingPolicy.test.ts,routeMounting.test.ts}`.
- Desktop main: `apps/desktop/src/main/operationHost.ts` and `apps/desktop/src/main/social/{deliveryApi.ts,deliveryLoop.ts,linkedinPostingPolicyOperations.ts}`.
- Renderer: `apps/desktop/src/renderer/settings/SettingsView.tsx` and `apps/desktop/src/renderer/social/{LinkedinPostingCandidate.tsx,LinkedinPostingPolicy.tsx,SocialRoute.tsx}`.
- Shared operations/tests: `apps/desktop/src/shared/operations.ts`, `apps/desktop/test/{linkedinPostingPolicy.component.test.tsx,linkedinPostingPolicy.delivery.test.ts,registryTraffic.test.ts,support/bridgeAnswers.ts}`.
- Contracts: `packages/contracts/src/{index.ts,linkedinPostingPolicy.ts}`.
- Domain: `packages/domain/social/{delivery.ts,deliveryQueue.ts,linkedinPostingPolicy.ts}`, `packages/domain/db/{migrations/0109_linkedin_posting_policy.sql,schemaRange.ts}`, `packages/domain/retention/coverage.ts`, `packages/domain/test/db/{constraints.test.ts,support/linkedinPostingPolicyCases.ts}`.
- This source acceptance record.

Source owner-control outcome is delivered, subject to root independent integration review. Activation, recurring generation/scheduling (#617), actual native/provider grounding/readiness proof (#618), deployment and release remain outside this outcome. No GH writes/push/PR/merge or live external actions were performed.
