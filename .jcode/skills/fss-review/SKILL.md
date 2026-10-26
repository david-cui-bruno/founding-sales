---
name: fss-review
description: Review FSS with one combined ordinary correctness/simplicity review and specialist coverage for actual operational, authentication, money, privacy or data-loss risk.
---

# Founding-sales review

## Contract

Review diffs against tickets and `AGENTS.md`. Ordinary changes get one combined spec/correctness and standards/simplicity review. Add specialists for actual migration/authentication/money/sending/credentials/privacy/production/data-loss risks. Preserve hard gates and in-flight reviews; return fixes to the same reviewers for finding-only closure. Report blockers with paths/scenarios, or CLEAN with limits. Fixtures, source, deployment, activation and usefulness are distinct.

## Hard gates

- Apply `AGENTS.md` standing authority and approval limits. Production uses the hosted [release procedure](../../../docs/operations/lean-release-workflow.md): clean CI/reviews, exact builds, pinned PITR before migration, paused sending, passing smokes and exact readback. Preserve stored owner OFF/newer stops. Healthy releases remove only their temporary block for already-authorized sending after fresh consent/eligibility/campaign/source/cap/hold/unknown-write checks (ADR0011). Permission never enables sending. Failures pause sending/hold releases and fix forward. Inspect unknown outcomes, never retry blindly. Cached Ask redaction remains accepted.
- Keep business Gmail and conversation data within approved owner/source/purpose/provider scope. Verify access and deletion across originals, derived claims, search, Ask history and workers after waits. Avoid private content in logs, artifacts, citations visible to other users, prompts or external services without scoped consent. Selected imports are not mailbox-wide capture authority.
- Preserve email cap5, any lower sender caps/ramp, recipient-local weekday mornings, eligibility, consent, unsubscribe/refusal and reply stops. Preserve original provider identity, cancelled follow-ups and uncertain attempts. Admission, routine replies and autonomous calling remain OFF unless explicitly approved.
- LinkedIn invitation/DM limits include manual, accepted, pending and unknown activity. Keep account/profile binding, current consent, cross-channel history and reply stops. Unknown coverage or delivery remains held; switching channels never resets allowances. Posting authority is not outreach authority.
- Keep secrets and private state out of commits, logs and public artifacts. Run `gitleaks` through `npm run verify:secrets` or the scoped approved scanner path. Report scanner failures without exposing matched secrets.

## Completion

Use normal commands, registered workers and disposable databases. Test relevant refusal, deletion, cancellation, duplicate/unknown and approval boundaries. Inspect production only under approved access; source tests do not prove live authorization. State unverified limits.

Check affected [journey/drive links](../../../docs/features/README.md) in feature changes. Reuse evidence while relevant code/configuration/environment assumptions hold. Changed behavior/harness/setup needs relevant checks, not unrelated suite replay. Preserve legal/tool directives and non-obvious safety rationale when removing stale comments.
