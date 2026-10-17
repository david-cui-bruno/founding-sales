# Current operating state

## October 17, 2026 checkpoint

**Priority: catch production up to main before new features.** [Roadmap](../sourcing/roadmap-20261007.md) groups the work into usable production milestones. GitHub ticket bodies remain detailed acceptance contracts.

Source main at `9552f53e` includes merged PR #651 and targets **schema116**. All its required CI passed and the recovered independent combined documentation review was clean. The three approved native children under #552 are **#652 backend contract → #653 protected bootstrap → #654 held-backlog rollout**. There are 27 open issues, including four tracking parents. None closes from documentation or source success alone.

Last production observation: **October 14, 13:09 UTC**, backend `d49dda37`, **schema88**, stable API2/worker1. This has not been refreshed on October 17. Desktop1.0.51 is also dated evidence, not a current installed candidate. Release and sending holds remain unchanged. Read-only production/credential inspection needs David's specific approval before a fresh operational plan can be prepared.

## Release path and approval boundary

#652 owns the source/test contract, currently in implementation, separating backend from provider credentials and exact state, lock and checksum permissions. The historical deployment role explicitly denies backend object reads, so an added allow or OIDC trust alone is insufficient. [Backend research](../sourcing/release-backend-roadmap-research-20261014.md) recommends retaining observed AES256/SSE-S3; it does not authorize encryption or permission changes.

#653 must refresh actual bindings and prepare only the protected prerequisites. Reject unrelated application, database, network, secret or deployment changes. Keep state and saved plans private. Obtain separate exact approvals for the saved plan, role/trust/permission actions and GitHub protections/key bindings. Source templates do not attest deployed rights.

#654 then freezes the candidate/images and actual deployed-to-candidate migration evidence, discloses interruption/recovery limits, and requests a separate rollout approval. Use the serialized [lean release procedure](lean-release-workflow.md). Verify serving version/schema, smoke and durable release record. Deployment does not Enable Gmail, Ask, outreach, posting or booking.

Every infrastructure apply, role change, deploy, Enable, send, post and booking still requires David's explicit approval. Historical plans and consumed paid-evaluation grants are not reusable authority.

## Product evidence and limits

Business Gmail capture #549, progress/Today #550 and Ask #551 retain separate evidence and activation requirements under #552. Capture is not hosted processing, backfill or outreach consent. Selected-source Ask does not wait for Gmail or native acceptance. Gemini LOW remains the selected next answering route, not permission for a paid run. Actual ordinary-worker results include useful answers and retained support/latency failures; synthetic publication/reference checks do not establish entailment or representative reliability.

Posting policy #616 and booking lifecycle #624 have integrated source to reconcile against their actual acceptance contracts. Native/account/provider/installed evidence and scoped operation remain pending in #618/#625/#633/#460/#466. The bounded #632 reservation experiment settled gate-first identity/lock composition, but did not implement the coordinator or native action history. Its merge-with-mail foreign-key failure remains open evidence, not a pass.

## Controls and maintenance

Preserve cap5 and lower sender caps/ramp, recipient-local weekday mornings, targeting, original Shirley provider identity/cancelled follow-up, uncertain attempts and reply/refusal stops. Admission, routine replies and autonomous calling remain OFF. Business scope only, no personal mailbox archive. No installed desktop credentials.

Dirty Ask work was preserved reversibly before release implementation: eight commits on `archive/ask-vertex-browse-local-20261017`, plus all 29 dirty status entries under `refs/archive/ask-vertex-dirty-20261017`. No scratch clone was deleted. Audits distinguish genuinely unmerged work from misleading ancestry counts.

Historical size observations were85/7/22. The new reproducible scope counts **92 files over800, eight over2000 and51 JS/TS functions over500**, including tests and callbacks. It includes tracked TS/JS, Python, shell, SQL, Terraform/HCL, CSS and HTML files, excludes prose/data, and parses JS/TS functions with TypeScript's AST. Different scopes are not code growth or reduction. The ratchet locks decreases and rejects increases.

[Archived pre-shortening state, with relocated links](../archive/operations/current-state-before-20261017.md) retains all provider counts, failures, consumed grants and prior observations. [CRM/Ask module map](../agents/crm-ask-modules.md) identifies owning seams; [activation procedure](crm-capability-activation.md) governs scope-specific configuration and Enable/Disable. Replace this snapshot rather than append logs.
