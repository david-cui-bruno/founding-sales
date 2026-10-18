# Current operating state

## October 18, 2026, 08:11 UTC

**Production is healthy at schema 116**, serving `7eb9be2fea0cac7a34ad64c8bdc9483e00161175`, API 2/worker 1. Reviewed release `39106788855`, attempt 1, succeeded. Independent acceptance verified all four candidate images, explicit API/worker Bedrock transport and all six production smoke checks. The shared **$50/day model-credit guard is deployed**. Main is now `22c98ff3`, schema 118, after manual-ledger #667 and throughput #673 merged; migrations 117/118 are **not applied**. There are 19 open issues and **36,894 net source lines removed** since the recoverable pre-deletion source.

Original release `39091230903`, attempt 3, remains **failed**, not retroactively successful. Its migration/restart completed before its smoke child failed to load TypeScript. Independent read-only recovery passed at 04:06. Invocation fix #660 is merged and the later current-path release succeeded. Never replay the original saved plan or downgrade to schema 88.

The latest release pinned PITR to 07:08:10 UTC, observed at 07:12:17 UTC, with 35-day retention. Restore was not tested. Migration 0105's cached Ask-history redaction was accepted. A stale migration-secret mirror was synchronized to the already-current managed password with its prior version preserved. No password reset or rotation occurred.

## Sending and authority

The separate accepted stored sending snapshot at **07:22:04 UTC** was **enabled=false, effectiveSendingEnabled=false, finishing=0, settingVersion 4**, after successful new-runtime acceptance. David was told smoke passed; **he alone resumes sending**. This snapshot is historical, not proof of a later setting. Release hold was restored. Health's deployment `sendingEnabled` is not the stored workspace flag.

Standing authority covers scoped release infrastructure, credentials, read-only operations, restarts and main merges with recovery copies. Ask before unapproved spending, Gmail capture/LinkedIn actions, contacts, prospect-visible changes, irrecoverable business-data deletion or restores losing writes. Keep credentials and raw operational output private.

## Selling readiness and approvals

Follow the [roadmap](../sourcing/roadmap-20261007.md): core selling, Gmail capture, manual-first LinkedIn, then release simplification. Use the [one-page selling guide](how-to-sell.md). Installed **Callie.app 1.0.51**, stamped `d49dda37`, loads Today, Firms, briefs, outcomes and five published sequences. Calling-hour refusal was observed. No real call, enrollment, send or paid research was performed by the release owner, so live daily-flow acceptance remains incomplete. Agreed sequences attempt enrollment immediately; single-email permission needs explicit later enrollment. Preserve old-client compatibility until the lean desktop ships.

Inventory at 06:25 found **30 real TX phone firms**, no real RI/MA CRM prospects, and **62 discovery drafts**: 27 TX, 15 RI, 20 MA. Drafts are not callable firms. The private 92-record HTML/CSV sheet is delivered. At 07:38 David authorized applying its 34 discovery Keeps and 28 duplicate dismissals, with useful evidence preserved. Batch execution is pending. He also authorized future verified TX/RI/MA research-only admission, with only unclear identities reviewed manually; implementation is pending and must never create outreach. Massachusetts personal rule confirmation read back satisfied; RI/TX remain. No MA call was placed.

Gmail setup is deployed but capture is not activated. Pending approval for `david@usecallie.com`: qualified/explicitly included incoming and Sent business messages, no backfill; Bedrock Haiku 4.5 cross-US extraction; proposed $1/day and $20/month credits-only allowance. Historical ledger funding classification does not prove invoice credit coverage; billing balance evidence remains unavailable. Research ceilings have **not yet been raised**. A read-only snapshot at 08:07 found research enabled for 50 firms/day, still at $0.50/day and $10/month, with zero pending/running research or qualification jobs and no completion or provider settlement since 07:21. The deployed Bedrock route and guard are verified; active processing is not.

David approved **Tavily Basic discovery, up to 10 searches/day with a $3/month card ceiling**, at 07:34, conditional on deploying the one-search/day bottleneck fix. A read-only provider account inspection at 07:58 reported 32 of 1,000 included Tavily credits used and zero pay-as-you-go usage, with no search or billing change. Null key/PAYG limits are not proof of an invoice ceiling. Do not raise live search limits before the fix and an exact monthly bound. Twilio calls still require an estimate and approval.

## Merged and in progress

Booking #659, Ask answering #661 and automatic email admission #665 are merged and deployed, with their issues closed. Live Cal.com sync/recordings/capacity, lexical search, source deletion, historical human work, regular sequences and sending safeguards remain. Footer readiness, guide and Gmail setup merged through #663; credit guard through #666.

Manual LinkedIn #667 and lead-throughput #673 are merged with additive migrations 117/118, not deployed. The latter adds opt-in paced discovery slots. Recurring deletion #669, safe-list #671, archive #668 and compact Settings #672 are being refreshed against current main before CI/merge. Corrected fictional Settings screenshots were shown before merge. Desktop release remains pending. Release simplification waits for prior outcomes; a successful current-path workflow is now proven.

Remote tag `archive/pre-lean-selling-20261018-5c7d188e` preserves the original source. Replace this snapshot, never append logs. Exclude `docs/archive` from normal reading. Follow the [current release procedure](lean-release-workflow.md) until its replacement is tested.
