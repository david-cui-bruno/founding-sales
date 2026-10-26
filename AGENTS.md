# Founding-sales workflow

## Start and ownership

Read after compaction: [tracker](docs/agents/issue-tracker.md), [labels](docs/agents/triage-labels.md); use `david-cui-bruno/founding-sales` Issues. Before exploration read [domain](docs/agents/domain.md), `GLOSSARY.md`, relevant ADRs. Before roadmap/release/sending read [current-state](docs/operations/current-state.md) and its roadmap. History is not authority; exclude `docs/archive` except historical questions.

Prioritize the [selling journeys](docs/features/README.md): supply, browser calling, eligible outbound/manual incoming email and founder-voice public social. Root owns integration/interfaces/production. Assign exclusive outcomes with acceptance/dependencies/resources. Refill on completion/blocking. Tracker/PLAN: backlog; todos: active.

## Decisions and approvals

Autonomously implement/test/document/reversibly clean. David's October 18 standing authority covers release-path infrastructure/IAM/GitHub/Terraform plans/applies, keygen/secret storage with old restore copies; read-only production/credential inspection, temporary read-only ops tasks, restarts and main merges. Migration 0105 cached Ask redaction is accepted.

Production releases require clean CI/reviews, pinned PITR before migration, paused sending and passing smokes. David's October23 00:19:49 permission allows the normal sending path only after actual readiness, consent/eligibility, current campaign/source/cap/hold and unknown-write checks pass. Permission alone never enables sending or overrides owner-disabled controls/newer stops. Healthy releases remove only their temporary block for already-authorized sending, preserving newer stops/fresh checks (ADR0011). Failures: pause sending/hold releases, report, fix forward.

Ask before new/higher spending, new paid services, AWS changes above ~$20/month, Gmail capture or LinkedIn actions, new channels/raised limits/contact groups, contacting people, irrecoverable CRM/Gmail/conversation deletion, restores losing writes, or unapproved prospect-visible changes. Use approved Bedrock/Vertex credits with ~$50/day runaway protection; confirm actual ledger costs before raising research budgets. Report decisions next update.

## Proof and review

Normal checks and one review suffice for ordinary changes. Avoid hash sealing, proof packets, per-run approvals and requalification loops. Consequential risks need stronger checks.

Use one combined spec/correctness and standards/simplicity review for ordinary changes. Add specialists for actual migration/authentication/money/sending/credentials/privacy/production/data-loss risks. Preserve hard gates/in-flight reviews; return fixes to the same reviewers. Read [.jcode/skills/fss-review/SKILL.md](.jcode/skills/fss-review/SKILL.md).

## Maintenance and delivery

Build. New sourcing research needs a current ticket. Replace current entries, not logs. Maintain affected [journey/drive links](docs/features/README.md) with features. Reuse applicable evidence; changed behavior/harness/environment needs relevant checks. Remove stale comments, retain legal/tool/safety rationale.

Budgets: AGENTS/review skill 400 words, current-state 800, roadmap 1,500. Run `npm run gate:workflow`. Threshold counts above 800/2,000 file lines and 500 JS/TS function lines cannot increase. Never inflate baselines. Split touched hotspots, not wholesale refactors.

Keep todos through production. Mark blockers `waiting on: <who or what>`; advance approved ready work or report the wait and stop. Updates: outcome/evidence, production/main/schema, selling/Gmail/LinkedIn, merged PRs/open issues, approvals. Size/deletion counts are diagnostic unless gated; report deltas for relevant cleanup/gate changes, not delivery scores.
