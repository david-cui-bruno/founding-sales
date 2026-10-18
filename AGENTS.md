# Founding-sales workflow

## Start and ownership

Read this file after compaction. Use GitHub Issues in `david-cui-bruno/founding-sales`: [tracker conventions](docs/agents/issue-tracker.md), [triage labels](docs/agents/triage-labels.md). Before exploration read [domain rules](docs/agents/domain.md), `GLOSSARY.md` and relevant ADRs. Before roadmap, release or sending work read [current state](docs/operations/current-state.md) and its roadmap. Historical observations are not live authority. Exclude `docs/archive` from normal reading unless a specific historical question requires it.

Prioritize core daily selling, Gmail capture, manual-first LinkedIn outreach, then release simplification. One implementer owns each whole outcome. Parallelize only independent outcomes or read-only investigations. Start workers in David's specified workspace.

## Decisions and approvals

Decide implementation, tests, docs and reversible cleanup autonomously. David's October 18 standing authority covers release-path infrastructure/IAM/GitHub/Terraform plans/applies, keygen/secret storage with old restore copies; read-only production/credential inspection, temporary read-only ops tasks, restarts and main merges. Migration 0105 cached Ask redaction is accepted.

Production releases require clean CI/reviews, pinned PITR before migration, sending paused and passing smoke checks. David alone resumes sending after healthy schema 116; never enable it for him. Stop and fix forward on failures. Contain failures first by pausing sending/holding releases, then report.

Ask before new/higher spending, new paid services, AWS changes above ~$20/month, Gmail capture or LinkedIn actions, new channels/raised limits/contact groups, contacting people, irrecoverable CRM/Gmail/conversation deletion, restores losing writes, or unapproved prospect-visible changes. Use approved Bedrock/Vertex credits with ~$50/day runaway protection; confirm actual ledger costs before raising research budgets. Report decisions next update.

## Proof and review

Match proof to risk. Normal checks and one review suffice for local code, tests, docs and refactors. Avoid hash sealing, proof packets, per-run approvals and requalification loops. Production, money, sending, credentials and data loss need stronger checks.

Use one combined reviewer for docs/low-risk; spec plus standards for normal changes; add risk review for sending, credentials, privacy or production. Review finished changes once; return fixes to the same reviewers. Read [.jcode/skills/fss-review/SKILL.md](.jcode/skills/fss-review/SKILL.md).

## Maintenance and delivery

Build by default. Research must unblock a decision; new `docs/sourcing` research needs a current ticket. Archive obsolete research/history. Replace current entries, never append logs.

Budgets: AGENTS 400 words, current-state 800, roadmap 1,500. Run workflow fast gate. Counts over 800/2,000 file lines and 500 JS/TS function lines cannot increase. Split touched hotspots, not wholesale refactors.

Keep full todos through production milestones. Advance independent work while waiting. Updates: production/main schema, selling readiness, Gmail/LinkedIn, merged PRs/open issues, deleted lines/size counts and pending approvals.
