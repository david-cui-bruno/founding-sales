# Current operating state

## October 18, 2026, 08:46 UTC

**Production is healthy at schema 116**, serving `7eb9be2fea0cac7a34ad64c8bdc9483e00161175`, API 2/worker 1. Reviewed release `39106788855`, attempt 1, succeeded. Independent acceptance verified four images, API/worker Bedrock transport and six smoke checks. The shared **$50/day model-credit guard is deployed**. Main is `abb2d250`, schema 118, including manual-ledger #667, throughput #673 and recurring-posting deletion #669; migrations 117/118 are **not applied**. There are 18 open issues and **38,772 net lines removed** since the recoverable pre-deletion source.

Original release `39091230903`, attempt 3, remains **failed**: migration/restart completed before its smoke child failed to load TypeScript. Independent read-only recovery passed at 04:06. Invocation fix #660 and the later current-path release succeeded. Never replay the original saved plan or downgrade to schema 88.

PITR was pinned to 07:08:10 UTC, observed 07:12:17, with 35-day retention; restore was not tested. Migration 0105 redaction was accepted. The stale migration-secret mirror was synchronized to the current managed password, preserving its prior version. No reset or rotation.

## Sending and authority

The separate stored sending snapshot at **07:22:04 UTC** was **enabled=false, effectiveSendingEnabled=false, finishing=0, settingVersion 4**, after successful new-runtime acceptance. David was told smoke passed; **he alone resumes sending**. This snapshot is historical, not proof of a later setting. Release hold was restored. Health's deployment `sendingEnabled` is not the stored workspace flag.

Standing authority covers scoped release infrastructure, credentials, read-only operations, restarts and main merges with recovery copies. Ask before unapproved spending, Gmail capture/LinkedIn actions, contacts, prospect-visible changes, irrecoverable business-data deletion or restores losing writes. Keep credentials and raw operational output private.

## Selling readiness and approvals

Follow the [roadmap](../sourcing/roadmap-20261007.md) and [selling guide](how-to-sell.md): core selling, Gmail capture, manual LinkedIn, then releases. Installed **Callie.app 1.0.51**, stamped `d49dda37`, loads Today, Firms, briefs, outcomes and five published sequences. Calling-hour refusal was observed. No real call, enrollment, send or paid research was performed by the release owner, so live daily-flow acceptance remains incomplete. Agreed sequences attempt enrollment immediately; single-email permission needs explicit later enrollment. Preserve old-client compatibility until the lean desktop ships.

Inventory at 06:25 found **30 real TX phone firms**, no real RI/MA CRM prospects, and **62 discovery drafts**: 27 TX, 15 RI, 20 MA. Drafts are not callable firms. The private 92-record HTML/CSV sheet is delivered. At 07:38 David authorized applying its 34 discovery Keeps and 28 duplicate dismissals, with useful evidence preserved. Batch execution is pending; a private read at 08:23 preserved 62 revisions. He also authorized verified TX/RI/MA research-only admission, with only unclear identities reviewed manually. PR #674's verifier, scheduler and visibility findings are fixed and all three reviewers are clean; deployment and audited activation remain pending. It must never create outreach. Massachusetts personal rule confirmation read back satisfied; RI/TX remain. No MA call was placed.

Gmail setup is deployed but capture is not activated. Pending approval for `david@usecallie.com`: qualified/explicitly included incoming and Sent business messages, no backfill; Bedrock Haiku 4.5 cross-US extraction; proposed $1/day and $20/month credits-only allowance. Historical ledger funding classification does not prove invoice credit coverage; billing balance evidence remains unavailable. At 08:40, a reviewed owner-authorized operator applied **100 shared processing steps/day, $12.50/day and $387.50/month**, using existing domain configuration and an atomic audit receipt. Enabled state, Bedrock model, page limits and $50/day guard stayed unchanged; task exit/cleanup passed. Qualification plus brief normally uses two steps, targeting about 50 fresh firms before failures/other work. Historical completed briefs averaged 1.1 cents; qualification averages are unmeasurable. The 08:07 snapshot was idle; configuration does not prove processing.

David approved **Tavily Basic, up to 10 searches/day, $3/month card ceiling**, conditional on the bottleneck fix. Provider account read at 07:58: 32/1,000 included credits used, zero PAYG; no searches/billing changes. Null key/PAYG limits do not prove an invoice ceiling. Do not raise limits before the fix and monthly bound. Twilio needs an approved estimate.

## Merged and in progress

Booking #659, Ask answering #661 and automatic email admission #665 are merged and deployed, with their issues closed. Live Cal.com sync/recordings/capacity, lexical search, source deletion, historical human work, regular sequences and sending safeguards remain. Footer readiness, guide and Gmail setup merged through #663; credit guard through #666.

Manual LinkedIn #667 and lead-throughput #673 are merged with additive migrations 117/118, not deployed. Recurring-posting deletion #669 is merged and issue #618 closed, not deployed. Safe-list #671, archive #668, compact Settings #672 and verified-firm policy #674 are composed unchanged through normal merges into #670 for one combined CI and integration review. The Settings research label is being corrected to processing steps; its refreshed screenshot must be shown before merge. A missing discovery CLI flag is being fixed before activation. Desktop release remains pending. Release simplification waits for prior outcomes; a successful current-path workflow is now proven.

Remote tag `archive/pre-lean-selling-20261018-5c7d188e` preserves the original source. Replace this snapshot; exclude archives from normal reading. Follow the [release procedure](lean-release-workflow.md) until its replacement is tested.
