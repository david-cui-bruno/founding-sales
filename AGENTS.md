# Founding-sales workflow

## Start and ownership

Read after compaction: [tracker](docs/agents/issue-tracker.md), [labels](docs/agents/triage-labels.md); use `david-cui-bruno/founding-sales` Issues. Before exploration read [domain](docs/agents/domain.md), `GLOSSARY.md`, relevant ADRs; before roadmap/release/sending read [current-state](docs/operations/current-state.md) and its roadmap. History is not authority; exclude `docs/archive` except historical questions.

Prioritize core daily selling, Gmail capture, manual-first LinkedIn outreach, then release simplification. Parallelize only independent outcomes/read-only investigations, by default in David's workspace. Keep every independent ticket staffed, including one worker per lead source/task. PLAN names each ticket's owner, exclusive files, waits. One worker owns each whole outcome end-to-end within files; immediately assign finishers next ready tickets. Root coordinates/reviews/releases, never bottlenecks implementation.

## Decisions and approvals

Autonomously implement/test/document/reversibly clean. David's October 18 standing authority: release-path infrastructure/IAM/GitHub/Terraform plans/applies, keygen/secret storage retaining old restore copies, read-only production/credential inspection, temporary read-only ops, restarts, main merges. Migration 0105 cached Ask redaction accepted.

Production releases require clean CI/reviews, pinned PITR before migration, paused sending, passing smokes. David alone resumes sending after healthy schema 116; never enable sending for him. Failures: contain by pausing sending/holding releases, report, fix forward.

Ask before new/higher spending, new paid services, AWS changes >~$20/month, Gmail capture/LinkedIn actions, new channels/raised limits/contact groups, contacting people, irrecoverable CRM/Gmail/conversation deletion, write-losing restores, unapproved prospect-visible changes. Approved Bedrock/Vertex credits require ~$50/day runaway protection; verify ledger costs before research-budget increases. Report decisions next update.

## Proof and review

Apply [review skill](.jcode/skills/fss-review/SKILL.md): risk-matched checks; combined docs/low-risk review, otherwise spec+standards; add sending/credentials/privacy/production risk review. Review finished changes once; same reviewers check fixes. Normal local code/tests/docs/refactors checks and one review suffice; production/money/sending/credentials/data-loss require stronger checks; no hash-sealing/proof-packets/per-run-approvals/requalification loops.

## Maintenance and delivery

Build; research unblocks decisions; new `docs/sourcing` needs current ticket. Archive obsolete research/history; replace current entries, never append logs.

Budgets: AGENTS 400 words, current-state 800, roadmap 1,500. Run workflow fast gate. Counts above 800/2,000 file lines or 500 JS/TS function lines cannot increase. Split touched hotspots, not wholesale refactors.

Keep current-state/roadmap/full production-milestone todos independently handoff-ready. Blocked todos: `waiting on: X`; pokes advance unblocked work or reply `blocked, waiting on X` and stop, never busywork/reruns/side-work/false-completion. Report `invalid_request_error` if observed.

Background CI/test/suite observers; context gets final status line only. Workers report 2-3 plain lines, details in private files. Root updates: 3-5 lines. EVERY update: verified callable firms by source, demos booked, active workers N, blocked items; unobserved metrics say unverified. Include production/main schema, selling readiness, Gmail/LinkedIn, merged PRs/open issues, deleted lines/size counts, pending approvals.
