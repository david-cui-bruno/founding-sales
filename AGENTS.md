# Founding-sales workflow

## Start and ownership

Read this file after compaction. For tracker operations use GitHub Issues in `david-cui-bruno/founding-sales` and [tracker conventions](docs/agents/issue-tracker.md); for triage read [labels](docs/agents/triage-labels.md). Before exploration read [domain rules](docs/agents/domain.md), `GLOSSARY.md` and relevant ADRs. Before roadmap, release or sending work read [current state](docs/operations/current-state.md) and its linked roadmap. Historical observations are not live authority.

Prioritize production catching main before new features. One implementer owns each whole outcome. Parallelize only independent outcomes or read-only investigations. Start workers in the workspace David specifies.

## Decisions and approvals

Decide ordinary implementation, tests, docs and reversible cleanup autonomously; list decisions in the next update. Ask David before spending, production or credential access, sending/posting/booking or anything real people see, deploys/Enable/infrastructure applies, irrecoverable deletion, or changing customers' or prospects' experience. Ticket/roadmap approval and source merge grant none of these operations. Obtain explicit approval for each infrastructure apply, role change, deploy, Enable, send, post or booking.

## Proof and review

Match proof to risk. Normal checks and one review suffice for local code, tests, docs and refactors. Avoid hash sealing, proof packets, per-run approvals and requalification loops. Production, money, sending, credentials and data loss need stronger checks.

Use one combined reviewer for docs/low-risk changes; spec plus standards for normal changes; add risk review for sending, credentials, Gmail/conversation privacy or production. Review once per finished change; return fixes to the same reviewers. Reviewers read [.jcode/skills/fss-review/SKILL.md](.jcode/skills/fss-review/SKILL.md).

## Maintenance and delivery

Build by default. Research only to unblock a decision; new `docs/sourcing` research must be referenced by a current ticket. Move dated history and obsolete research to `docs/archive`. Replace current entries rather than append logs.

Keep AGENTS within 400 words, current-state within 800 and roadmap within 1,500. Run the workflow fast gate. Counts of code files over 800/2,000 lines and JavaScript/TypeScript functions over 500 may not increase. Split hotspots when touched; avoid a wholesale refactor.

Keep the full todo plan through release and production-usable milestones. While awaiting approval, advance independent work; do not stop for handoffs. Short updates include production/main schemas, merged PRs, open issues, size counts and pending approvals.
