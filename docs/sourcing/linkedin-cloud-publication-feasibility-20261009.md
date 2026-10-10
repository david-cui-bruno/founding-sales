# LinkedIn cloud publication feasibility

Research for #461, informing #462. Checked October 9, 2026 against source `157b1afd9f28570b432994174df38f5f2a465cd0`. This is provider research and source inspection, not a live grant attestation or publication test.

## Decision

Keep the existing native LinkedIn scheduler. Cloud publication is not currently established for David's account. Implement an explicit unavailable/manual fallback under #462; do not copy the desktop browser session into a worker. A cloud path can be reconsidered after separately authorized OAuth access and readback are verified.

## Official capability

LinkedIn's [access guide](https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access) lists `w_member_social` as a self-service Share on LinkedIn permission. That describes an available product, not a grant already held by Callie. Sign-in identity permissions do not imply post authority.

The [Posts API, September 2026 version](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-09) documents member writes through `w_member_social`, while `r_member_social` is restricted to approved users. Organization publication has separate role and permission requirements; it is not the founder's personal-profile route. Creation returns a post ID in `x-restli-id`; retrieval supports author and reader views. The documented creation examples publish immediately. No future scheduling parameter was established by this review: a proposed cloud implementation would need Callie's due-time worker, not a claim that the API stores a native future schedule. Use a supported version header; the page warns that version 202510 sunsets October 15, 2026.

The [Images API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api?view=li-lms-2026-09) supports image upload initialization, a returned image URN, upload status and alt text. It explicitly distinguishes write-only member permission from versioned image GET access. Successful upload initiation is insufficient proof of readable saved media, final post identity or alt-text persistence.

[Programmatic refresh](https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens) is documented for approved Marketing Developer Platform partners. Default access-token lifetime is 60 days and refresh lifetime one year, with revocation possible at any time. Basic write permission does not establish refresh entitlement. Record the actual expiry and renewal capability if an authorized account inspection later becomes available; never promise indefinite unattended access.

## Account evidence and limits

`packages/domain/social/accounts.ts` enables only `linkedin-native-v1`. `apps/desktop/src/main/app.ts` registers the isolated native browser adapter, not an OAuth cloud adapter. Existing [native verification](social-adapter-verification.md) records product-owned identity and schedule/cancel evidence, including uncertain attempts retained for inspection. It does not record an OAuth app/client, current write/read grants, refresh entitlement or worker credential custody. These remain **unverified**, not proven absent or revoked. No credential store was inspected or copied in this research.

No current account-specific API pricing, rate allowance or approved app entitlement was measured. Do not infer zero cost, unlimited usage or refresh availability from a native login. No paid service or new grant is selected.

## Proposed implementation and gates

The current `socialApprovalSnapshot` requires a verified connected adapter, and delivery claims require a user/device. A cloud worker must not impersonate either. If enabled later, introduce a narrow authority naming workspace, account, provider app/grant generation, adapter version and permitted publication operation. Bind exact text, image digest/version/alt text, destination, time and immutable approval fingerprint. Recheck all at due time; missed time returns for rescheduling and new approval rather than a backlog burst.

Persist a dispatch marker before an external write. A timeout or lost response retains unknown submission and cannot trigger replacement. Require authorized exact-ID readback and a documented reconciliation path even when the response ID was lost; lack of a complete search/reconciliation path leaves that attempt held. Preserve successful other-platform deliveries. Upload/readback authority and token changes invalidate stale preparations.

Before cloud activation: verify identity and current read/write grants using existing authorized access; establish renewal/expiry behavior; prove media/account/content readback and ambiguous-response reconciliation; run real PostgreSQL plus controlled-provider concurrency/restart/deletion tests; separately review a precisely approved native/provider acceptance test. Source completion, backend deployment, signed desktop release and provider activation are separate receipts.

The safe fallback presents the exact current post as **manual handoff**, never scheduled/published. Copying/opening a composer is not provider acceptance. A human-reported outcome must stay distinct from verified provider receipt. Shared schema/contracts/UI require one integration owner; no fallback should mark an unsupported account connected merely to bypass existing approval checks.
