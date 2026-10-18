# Current operating state

## October 17, 2026 checkpoint

**Priority: catch production up to main before new features.** [Roadmap](../sourcing/roadmap-20261007.md) groups the work into usable production milestones. GitHub ticket bodies remain detailed acceptance contracts.

Source main `048e` targets **schema116**; PRs #651/#655 are merged and #652 is closed. Main CI `39076748071` and images `39076748127` passed. The native release children under #552 remain **#652 backend contract → #653 protected bootstrap → #654 held-backlog rollout**. There are 26 open issues, including four tracking parents. Source closure is not deployed acceptance.

Approved metadata/public-health observation: **October17, 23:18 UTC**, backend `d49dda37`, **schema88**, stable API2/worker1. Health `sendingEnabled=true` is deployment configuration, **not observed DB sending state**. Production services and release hold remain unchanged. Desktop1.0.51 remains dated installed evidence.

## Release path and approval boundary

#652's merged [backend contract](release-backend-contract.md) separates backend/provider credentials and exact state/lock/checksum rights. It preserves S3 AES256/SSE-S3 and refuses unsafe deletion/mutation. Source tests do not attest live effective access.

#653 approved prerequisites are complete: roles, journal listing, actual deployment-policy delta/additive trust, three protected environments and RSA key binding. Services and hold stayed unchanged. First prepare `39078348145` refused before apply on the existing DynamoDB lock-table CMK's Decrypt denial. The narrow service/context-bound reconciliation is this source correction; its separate IAM GO was requested, not approved. Keep plans, key material and inspection evidence private. No key/encryption change is proposed.

#654 requires its own final step7 rollout/hold-transition GO, exact candidate/images and recovery/sending treatment. No application deploy or migration has occurred. Disposable local PostgreSQL upgrade88→116, startup refusal and transactional failure recovery passed, not live acceptance. David waived migration0105 impact counts at23:14 and accepted cached-history redaction subject to final GO; no counts were read or temporary task definition created. Use the serialized [release procedure](lean-release-workflow.md), serving build/schema, smoke and durable release-record readback. Deployment does not Enable Gmail, Ask, outreach, posting or booking.

Every infrastructure apply, role change, deploy, Enable, send, post and booking still requires David's explicit approval. Historical plans and consumed paid-evaluation grants are not reusable authority.

## Product evidence and limits

Business Gmail capture #549, progress/Today #550 and Ask #551 retain separate evidence and activation requirements under #552. Capture is not hosted processing, backfill or outreach consent. Selected-source Ask does not wait for Gmail or native acceptance. Gemini LOW remains the selected next answering route, not permission for a paid run. [Actual ordinary-worker results](../sourcing/ask-vertex-worker-results-20261012.md) retain useful answers and support/latency failures; synthetic publication/reference checks do not establish entailment or representative reliability.

Posting policy #616 and booking lifecycle #624 have integrated source to reconcile against their actual acceptance contracts. Native/account/provider/installed evidence and scoped operation remain pending in #618/#625/#633/#460/#466. The bounded #632 reservation experiment settled gate-first identity/lock composition, but did not implement the coordinator or native action history. Its merge-with-mail foreign-key failure remains open evidence, not a pass.

## Controls and maintenance

Preserve cap5 and lower sender caps/ramp, recipient-local weekday mornings, targeting, original Shirley provider identity/cancelled follow-up, uncertain attempts and reply/refusal stops. Admission, routine replies and autonomous calling remain OFF. Business scope only, no personal mailbox archive. No installed desktop credentials.

Dirty Ask work was preserved reversibly before release implementation: eight commits on `archive/ask-vertex-browse-local-20261017`, plus all 29 dirty status entries under `refs/archive/ask-vertex-dirty-20261017`. No scratch clone was deleted. Audits distinguish genuinely unmerged work from misleading ancestry counts.

Historical size observations were85/7/22. The new reproducible scope counts **92 files over800, eight over2000 and51 JS/TS functions over500**, including tests and callbacks. It includes tracked TS/JS, Python, shell, SQL, Terraform/HCL, CSS and HTML files, excludes prose/data, and parses JS/TS functions with TypeScript's AST. Different scopes are not code growth or reduction. The ratchet locks decreases and rejects increases.

[Archived pre-shortening state, with relocated links](../archive/operations/current-state-before-20261017.md) retains all provider counts, failures, consumed grants and prior observations. [CRM/Ask module map](../agents/crm-ask-modules.md) identifies owning seams; [activation procedure](crm-capability-activation.md) governs scope-specific configuration and Enable/Disable. Replace this snapshot rather than append logs.
