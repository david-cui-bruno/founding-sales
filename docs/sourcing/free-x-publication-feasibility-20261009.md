# Free X scheduling and manual handoff

Research for #465. Checked October 9, 2026 against source `157b1afd9f28570b432994174df38f5f2a465cd0`. Outcome: implement exact manual handoff first; free native scheduling entitlement on David's account is unverified. No paid fallback, API call, grant change, real post or schedule was performed.

## Official capability and cost

X's [manual posting guide](https://help.x.com/en/using-x/how-to-post) documents browser posting, ordinary 280-character posts and up to four media items. This is sufficient to support a human-operated composer handoff, subject to current account identity and exact approval; it does not establish unattended scheduling.

The [scheduled-post guide](https://help.x.com/en/business-and-advertising/scheduled-tweets) documents Ads composer scheduling, management of scheduled posts and an unchanged post ID on publication. It does not prove this founder account has an Ads account, free eligibility or the requested organic route. Do not create an Ads account or enter payment information to manufacture feasibility.

[X Pro scheduling](https://help.x.com/en/using-x/advanced-xpro-features) is documented, but [Premium help](https://help.x.com/en/using-x/x-premium) places Pro in paid subscription features. It is not the approved free fallback. [API pricing](https://docs.x.com/x-api/getting-started/pricing) now describes pay-per-use credits and separately priced reads/writes. Promotional credits require eligibility and are not a durable free-publication guarantee. No API integration, payment card or spending limit change is proposed.

This review found no accessible official source establishing free ordinary x.com composer scheduling for David's account. Secondary claims are deliberately not used as capability evidence. This is **unverified**, not a statement that the UI cannot have a free scheduler. A later authorized read-only browser inspection can establish account identity and whether a scheduling control is offered without pressing a final Schedule/Post button.

## Character validation finding

X's [character rules](https://docs.x.com/fundamentals/counting-characters) use weighted character counting, special URL treatment and emoji handling. The [official twitter-text configuration](https://github.com/twitter/twitter-text/blob/30e2430d90cff3b46393ea54caf511441983c260/config/v3.json) has a 280 weighted limit, default double weight and normalized URL length 23. Callie's current `[...post.text].length` check in `packages/domain/social/posts.ts` is a scalar count, despite its “conservative” comment. It can admit overweight CJK text. Before claiming platform-ready X text, use the provider's maintained weighted parser or retain a clearly labeled preliminary check plus the native visible counter. Do not merely multiply all text by two: that loses URL/emoji/normalization correctness. Plain text alone remains supported; no thread or Premium-length extension is authorized.

## Existing source and implementation plan

`packages/domain/social/accounts.ts` always stores X as unsupported; no X adapter is registered. The current approval snapshot requires a connected, verified adapter. A manual handoff must therefore be a separate, explicitly approved authority, not a fake connected state or a scheduled delivery with no provider submission.

Under coordinated integration ownership, add a caller-facing exact handoff preview/confirmation bound to owner/workspace, stable founder account identity, current post revision, text, image versions/digests/alt text, requested instant/zone and fingerprint. Opening a composer or copying text records only handoff. Display **Manual publication needed**, **Outcome unknown**, or **Time missed—reschedule and approve**. A human report may record a dated reported result/permalink separately; it cannot manufacture a verified provider receipt. Block replacement when a prior native/API submission is unknown; do not erase successful other-platform publication. Account/content/time/media changes invalidate prior handoff approval. After the requested time, no automatic late publication or backlog burst is allowed.

Public-command/database tests should cover exact revision/account matching, changed approvals, ownership, character rules (ASCII boundary, CJK, emoji, normalized URLs), missing media, unknown prior submissions, missed time and unchanged other-platform successes. Desktop tests cover preview/copy/navigation and honest status, with fake clipboard/browser ports and no network publication. If free native scheduling is later verified, require exact account/content/media/time readback and restart/lost-response recovery before registering it. Schedule acceptance, eventual publication with the Mac closed, signed client availability and activation each need separate evidence.

The research part is reviewable; #465's implementation/demo acceptance remains open. Keep original Shirley identities, sender cap/holds, automatic admission and routine replies unchanged.
