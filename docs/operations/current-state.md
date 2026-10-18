# Current operating state

## October 18, 2026, 06:10 UTC

**Production is at schema 116**, serving source `5c7d188e32856fc0d68b53b3821aea5a69d6fe5d`, API 2/worker 1. All six unchanged production smoke checks passed in independently reviewed read-only recovery at 04:06. Main is also schema 116, now `5b72ea8b`, but its lean changes are **not deployed**. There are **19 open issues**. Since the recoverable pre-deletion source, main has **38,830 net lines removed**.

Reviewed release run `39091230903`, attempt 3, remains **failed**, not retroactively successful. Apply, migration and restart completed before its smoke child failed to load TypeScript. Read-only recovery used the required Node 24 flags and verified exact images, services, durable release record and sending state. The minimal invocation fix #660 is merged. Do not replay the saved plan or downgrade to schema 88.

PITR was pinned before migration at 03:38:19 UTC to 03:33:19 UTC, approximately five minutes behind, with 35-day retention. Restore was not tested. Migration 0105's cached Ask-history redaction was accepted by David. A stale migration-secret mirror was synchronized to the already-current managed password with its prior version preserved. No password reset or rotation occurred.

## Sending and authority

The last accepted sending snapshot, at 04:05:51 UTC, was **enabled=false, effectiveSendingEnabled=false, finishing=0, settingVersion 4**, schema 116. David was told smoke passed; **he alone resumes sending**. Release hold was restored. Health's deployment `sendingEnabled` is not the stored workspace setting. Later private exports did not change either.

Standing authority covers scoped release infrastructure, credentials, read-only operations, restarts and merges with recovery copies. Ask before new spending, card-billed provider use, Gmail capture/LinkedIn activation, new contacts/channels/limits, prospect-visible changes, irrecoverable business-data deletion or restores losing writes. Contain failures first. Keep raw operational output and credentials private.

## Selling readiness and approvals

Follow the [roadmap](../sourcing/roadmap-20261007.md): core selling, Gmail capture, manual-first LinkedIn, then release simplification. Use the [one-page selling guide](how-to-sell.md). Installed **Callie.app 1.0.51**, stamped `d49dda37`, loads Today, Firms, prepared briefs, outcomes and five published sequences. Calling-hour refusal was observed. No real call, enrollment, send or paid research was performed, so production daily-flow acceptance remains incomplete. An agreed sequence attempts enrollment immediately; a single-email agreement records permission and needs explicit enrollment afterward. Preserve old-client compatibility until the lean desktop ships.

Inventory found **30 real TX phone firms**, no real RI or MA CRM prospects yet, and **62 discovery drafts**: 27 TX, 15 RI, 20 MA. Drafts are unverified candidates, not callable firms. The private 92-record HTML/CSV review sheet is delivered outside the repository; David will mark decisions in the app. RI/TX remain; Massachusetts requires David's personal rule confirmation.

Gmail owner setup is merged, not activated. Pending approval for `david@usecallie.com`: qualified/explicitly included incoming and Sent business messages, no backfill; Bedrock Haiku 4.5 cross-US extraction; proposed $1/day and $20/month credits-only allowance. Credit funding evidence is still needed. The shared ~$50/day model-credit guard is in PR #666, not deployed. Historical ledger classification does not prove invoice credit coverage. Research limits have not been raised. Tavily and Twilio may incur cash charges and need an estimate plus approval.

## Merged and in progress

Booking #659, Ask answering #661 and automated email admission #665 are merged, with their issues closed. Live Cal.com sync/recordings/capacity, lexical search, source deletion, historical human work, ordinary sequences and sending safeguards remain. Guide, footer readiness and Gmail setup merged through #663. Current ratchet: **89 files over 800 lines, seven over 2,000, 48 functions over 500**.

Manual LinkedIn #667 is source-only with additive migration 117 under test, not applied. Recurring posting deletion #669 is under finding-only review. Archive #668 and safe-list cleanup remain in progress. No LinkedIn actions were enabled. Release simplification waits for these outcomes and a successful current-path release.

Remote tag `archive/pre-lean-selling-20261018-5c7d188e` preserves the original source. Replace this snapshot, never append logs. Exclude `docs/archive` from normal reading. Follow the [current release procedure](lean-release-workflow.md) until its replacement is tested.
