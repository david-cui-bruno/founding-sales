# Founding-sales workflow

## Start and ownership

Read after compaction: [tracker](docs/agents/issue-tracker.md), [labels](docs/agents/triage-labels.md); use `david-cui-bruno/founding-sales` Issues. Before exploration read [domain](docs/agents/domain.md), `GLOSSARY.md`, relevant ADRs. Before roadmap/release/sending read [current-state](docs/operations/current-state.md) and its roadmap. History is not authority; exclude `docs/archive` except historical questions.

Prioritize selling/Gmail/manual-first LinkedIn, then release simplification. Root owns integration/interfaces/production. Assign exclusive outcomes with acceptance/dependencies/resources. Refill on completion/blocking. Tracker/PLAN: backlog; todos: active.

## Decisions and approvals

Autonomously implement/test/document/reversibly clean. David's October 18 standing authority covers release-path infrastructure/IAM/GitHub/Terraform plans/applies, keygen/secret storage with old restore copies; read-only production/credential inspection, temporary read-only ops tasks, restarts and main merges. Migration 0105 cached Ask redaction is accepted.

Production releases require clean CI/reviews, pinned PITR before migration, paused sending and passing smokes. David's October23 00:19:49 permission allows the normal sending path only after actual readiness, consent/eligibility, current campaign/source/cap/hold and unknown-write checks pass. Permission alone never enables sending or overrides owner-disabled controls/newer stops. Healthy releases remove only their temporary block for already-authorized sending, preserving newer stops/fresh checks (ADR0011). Failures: pause sending/hold releases, report, fix forward.

Ask before new/higher spending, new paid services, AWS changes above ~$20/month, Gmail capture or LinkedIn actions, new channels/raised limits/contact groups, contacting people, irrecoverable CRM/Gmail/conversation deletion, restores losing writes, or unapproved prospect-visible changes. Use approved Bedrock/Vertex credits with ~$50/day runaway protection; confirm actual ledger costs before raising research budgets. Report decisions next update.

## Proof and review

Match proof to risk. Normal checks and one review suffice for local code, tests, docs and refactors. Avoid hash sealing, proof packets, per-run approvals and requalification loops. Production, money, sending, credentials and data loss need stronger checks.

Use combined review for docs/low-risk; spec plus standards otherwise; add risk review for sending, credentials, privacy or production. Review finished changes once; return fixes to the same reviewers. Read [.jcode/skills/fss-review/SKILL.md](.jcode/skills/fss-review/SKILL.md).

## Maintenance and delivery

Build. Research must unblock decisions; new `docs/sourcing` research needs a current ticket. Archive obsolete research/history. Replace current entries, never append logs.

Budgets: AGENTS 400 words, current-state 800, roadmap 1,500. Run workflow fast gate. Counts over 800/2,000 file lines and 500 JS/TS function lines cannot increase. Split touched hotspots, not wholesale refactors.

Keep full todos through production milestones. Label blocked todos `waiting on: <who or what>` and, on auto-pokes, advance unblocked work or reply `blocked, waiting on X` and stop, never inventing busywork, reruns or side work or marking done to silence pokes. Updates: production/main schema, selling readiness, Gmail/LinkedIn, merged PRs/open issues, deleted lines/size counts and pending approvals.
