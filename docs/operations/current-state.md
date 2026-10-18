# Current operating state

## October 18, 2026, 04:27 UTC

**Production is at schema 116**, serving exact source `5c7d188e32856fc0d68b53b3821aea5a69d6fe5d`, matching main's schema. API 2/worker 1 are stable on the pinned images. All six unchanged production smoke checks passed in independently reviewed read-only recovery. Native release children #652, #653 and #654 are closed. PRs #651/#655/#656/#657/#658/#659 are merged. Tracker count at 04:27: **22 open issues**.

Reviewed release run `39091230903`, attempt 3, remains **failed**, not retroactively successful. Apply, migration and restart completed before the smoke child failed to load TypeScript without explicit Node 24 transform flags. Recovery ran the unchanged smoke with the required flags, checked exact images/services, durable release record and body-free sending state. Do not replay the saved plan or downgrade to schema 88. The minimal invocation regression fix is separate from later release simplification.

PITR was pinned before migration at 03:38:19 UTC, to 03:33:19 UTC, approximately five minutes behind, with 35-day retention. Restore was not tested. Migration 0105's cached Ask-history redaction was accepted by David; CRM, firms and conversations were not intentionally deleted. A stale migration-secret mirror was synchronized to the already-current managed password with the prior version preserved. No password reset or rotation occurred.

## Sending and authority

At 04:05:51 UTC, a read-only snapshot confirmed **enabled=false, effectiveSendingEnabled=false, finishing=0, settingVersion 4** at schema 116. Temporary definition cleanup was verified. David was told smoke passed and **he alone will turn sending back on**. Release hold is held. Health's deployment `sendingEnabled` is not the stored workspace sending setting.

David's standing authorization covers scoped release infrastructure/IAM/GitHub/Terraform, credential inspection, temporary read-only operations, restarts and merges, preserving restore copies. Keep plans, credentials and raw operational output private. Ask for new spending, card-billed provider use, Gmail capture/LinkedIn activation, new contacts/channels/limits, unapproved prospect-visible changes, irrecoverable business-data deletion or restores losing writes. Contain production failures first.

## Lean selling order

The [roadmap](../sourcing/roadmap-20261007.md) now prioritizes **core selling → Gmail capture → manual-first LinkedIn → release simplification**. Start with the [one-page selling guide](how-to-sell.md). No more Ask answering, AI booking, automated email admission or recurring LinkedIn posting development. Remove those in separately reviewed, recoverable PRs while retaining plain record search, source deletion, regular sequences and live Cal.com meetings/recordings.

Installed **Callie.app 1.0.51**, stamped `d49dda37`, was inspected read-only after release: Today and Firms load 32 firms; Today has 31 new prospects; prepared briefs and outcome controls render. Calling-hour refusal works on the inspected TX firm. Five published email sequences exist, but template sign-off warnings need diagnosis. No call, enrollment, send, research-provider run or CRM write was executed. This is not complete selling-flow acceptance. Preserve old-client API compatibility until a reviewed desktop update ships.

Gmail account: `david@usecallie.com`; activation still pending exact consent/model/spend approval. RI/TX remain; MA requires David's personal rule confirmation in Settings. Inventory callable firms, discovery and actual research ledger costs before claiming lead supply or raising budgets. Approved credit-billed model use needs approximately $50/day runaway protection; do not assume ledger classification proves credits cover invoices.

## Maintenance

Remote tag `archive/pre-lean-selling-20261018-5c7d188e` preserves the pre-deletion source. Booking deletion #659 merged as `ba496671`: **7,755 net lines removed**, not yet deployed. Live meeting sync, recordings and installed-client booking capacity remain. #624/#625 are closed. The dirty Ask tree/eight commits remain archived; no scratch clone was deleted. Current reproducible ratchet: **92 files over 800 lines, eight over 2,000, 51 JS/TS functions over 500**. Ask-branch reductions are not merged or shipped counts.

Replace this snapshot, never append logs. Historical records are in `docs/archive`, excluded from normal agent reading. Use [domain module map](../agents/crm-ask-modules.md) for retained ownership and [current release procedure](lean-release-workflow.md) until its replacement is tested.
