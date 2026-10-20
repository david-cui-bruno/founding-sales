# Founding-sales workflow

## Start and ownership

Read after compaction. Use GitHub Issues in `david-cui-bruno/founding-sales`: [tracker](docs/agents/issue-tracker.md), [labels](docs/agents/triage-labels.md). Before exploration read [domain rules](docs/agents/domain.md), `GLOSSARY.md` and relevant ADRs. Before roadmap, release or sending read [current state](docs/operations/current-state.md) and its roadmap. History is not live authority. Exclude `docs/archive` unless answering historical questions.

Prioritize core daily selling, Gmail capture, manual-first LinkedIn outreach, then release simplification. One implementer owns each whole outcome. Parallelize only independent outcomes or read-only investigations. Use David's workspace for workers.

## Decisions and approvals

Decide implementation, tests, docs and reversible cleanup autonomously. David's October 18 standing authority covers release-path infrastructure/IAM/GitHub/Terraform plans/applies, keygen/secret storage with old restore copies; read-only production/credential inspection, temporary read-only ops tasks, restarts and main merges. Migration 0105 cached Ask redaction is accepted.

Production releases require clean CI/reviews, pinned PITR before migration, sending paused and passing smoke checks. David alone resumes sending after healthy schema 116; never enable it for him. Stop and fix forward on failures. Contain failures first by pausing sending/holding releases, then report.

Ask before new/higher spending, new paid services, AWS changes above ~$20/month, Gmail capture or LinkedIn actions, new channels/raised limits/contact groups, contacting people, irrecoverable CRM/Gmail/conversation deletion, restores losing writes, or unapproved prospect-visible changes. Use approved Bedrock/Vertex credits with ~$50/day runaway protection; confirm actual ledger costs before raising research budgets. Report decisions next update.

## Proof and review

Match proof to risk. Normal checks and one review suffice for local code, tests, docs and refactors. Avoid hash sealing, proof packets, per-run approvals and requalification loops. Production, money, sending, credentials and data loss need stronger checks.

Use combined review for docs/low-risk; spec plus standards otherwise; add risk review for sending, credentials, privacy or production. Review finished changes once; return fixes to the same reviewers. Read [.jcode/skills/fss-review/SKILL.md](.jcode/skills/fss-review/SKILL.md).

## Maintenance and delivery

Build. Research must unblock decisions; new `docs/sourcing` research needs a current ticket. Archive obsolete research/history. Replace current entries, never append logs.

Budgets: AGENTS 400 words, current-state 800, roadmap 1,500. Run workflow fast gate. Counts over 800/2,000 file lines and 500 JS/TS function lines cannot increase. Split touched hotspots, not wholesale refactors.

Keep full todos through production milestones. Label blocked todos `waiting on: <who or what>` and, on auto-pokes, advance unblocked work or reply `blocked, waiting on X` and stop, never inventing busywork, reruns or side work or marking done to silence pokes. Updates: production/main schema, selling readiness, Gmail/LinkedIn, merged PRs/open issues, deleted lines/size counts and pending approvals.
