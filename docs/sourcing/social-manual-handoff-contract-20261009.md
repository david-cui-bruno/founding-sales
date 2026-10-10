# Exact manual social handoff

Proposed integration contract for #462/#464/#465, based on the provider feasibility reports dated October 9. This is an implementation plan, not approval of any external post. Root integration owns shared contracts, schema, routes, desktop bridges and source composition.

## Smallest useful slice

Keep unsupported accounts unsupported. Expose manual handoff as its own operation on an owned current draft; it does not create `social_deliveries`, a native submission marker, a provider receipt or a scheduled/published state. The existing native LinkedIn route stays available under its own verified authority. Choosing manual handoff never cancels or replaces an unresolved native submission.

1. **Read preview:** public authenticated read receives `postId` and `expectedRevision`. Return exact text, destination platform/external identity/display label/kind/current account revision, requested instant/zone, image versions/digests/alt text and approved derivative previews. Return a hash binding those fields, plus provider support reason and truthful account-evidence status. Read is not approval. No body-bearing URL query or automatic composer prefill.
2. **Confirm exact handoff:** public idempotent command receives post/revision, preview hash, command ID and explicit reviewed-destination affirmation. Under normal owner/workspace and post/account locks, regenerate current preview and validate text/media/time. Reject a changed account/revision/image, missing Page identity, past time, inaccessible derivative or any existing unresolved submission. Store a small immutable handoff approval with snapshot/hash, actor and date, distinct from publication authority. A human-reviewed destination is labeled human-confirmed, never observed OAuth permission. Do not mutate account `state`, `verified_at` or native adapter version.
3. **Read current handoff:** regenerate validity on every use. Only the exact still-current approval allows a user-clicked copy/download/open-composer affordance. Show **Manual publication needed; Callie has not scheduled this post**. Copy success proves clipboard handoff only. If current authority/content/time is invalid, require review again and refuse the action; frontend cached preview alone is insufficient. Browser open uses fixed official provider URLs and does not click final Publish/Schedule.

Minimum persisted states are active/superseded/cancelled for handoff approval. Display time-missed and account/content/media-changed from current authoritative reads; no worker or due-time publication job is needed for this slice. Editing uses existing post revisions and invalidates current handoff use without deleting the historical snapshot. Changing the requested time requires fresh exact approval. Reusing the native delivery enum for handoff would falsely imply provider progress.

Do not add a “mark published” command in the first slice. If a later slice records David's reported native outcome, store reported scheduled/published/unknown and optional provider permalink separately with its source/observed date. It remains a human report; verified native inspection is a distinct receipt. Unknown prior native submission blocks replacement regardless of a new manual approval. Preserve other platforms' successes and never group-delete/repost.

## Validation seam and X integration

Public command/read integration with real disposable PostgreSQL exercises authorization, idempotency, immutable exact snapshots, concurrent account/post/media changes and refusal during unresolved submission. No provider dispatch or copied desktop credential is part of the module. Native/provider acceptance remains separately approved and measured.

The dedicated pure domain seam `inspectXPostText(text)` returns `{weightedLength, remaining, valid}` through official `twitter-text` rules without returning altered text. `socialApprovalSnapshot` should replace the X scalar-length predicate with this validator; retain existing non-X limits and image-count restrictions. The manual preview/confirmation must use the same validator, not frontend approximation. Valid text is not publication permission. Keep native platform-counter validation for any later automated adapter. The pinned package is the official latest npm `twitter-text@3.1.0`, with community type declarations `@types/twitter-text@3.1.10`; its old transitive parser/polyfill versions require normal dependency review, not an assumption of current platform equivalence for every newly added Unicode sequence.

## Acceptance examples

- Preview/copy for exact reviewed text/account/media/time shows manual-needed state and creates zero delivery/submission rows or provider calls. Read alone, save alone and changing text never approve it.
- Changed revision, account ID/external identity/kind/revision, image bytes/version/alt text, owner or time rejects a stale handoff, including concurrent changes at confirmation. Facebook profiles refuse; no verified Page claim comes from a label.
- X's ASCII 280 boundary passes; overweight CJK refuses; family emoji, NFC text and detected URLs follow official weighted results. No Premium posts, threads or paid fallback.
- Lost command response retries the same command; it returns the same handoff approval. Copy/open errors remain handoff errors, never ambiguous provider acceptance. No retry performs publication.
- Existing native scheduled/submitting/unknown/cancellation-pending work refuses manual replacement. A missed future time shows reschedule/reapprove and never publishes a backlog. Other-platform successes remain unchanged.
- Desktop public UI tests use fake clipboard/browser/image ports: visible exact destination and requested time, image/alt review, explicit confirmation, stale-preview refusal, honest labels and copy/navigation. No test schedules or publishes to a live account.

## Separate operational gates

The fallback slice can be source-complete without cloud grants, but real installed UI acceptance and signed release are still separate. Any future cloud/native adapter requires actual identity, official current grants/renewal and readback/reconciliation evidence, narrow authority, explicit per-post approval, controlled-provider/real-database tests and separately authorized external acceptance. Preserve sender caps/holds, Shirley identities, routine replies, automatic admission and paid-attempt gates.
