---
name: fss-review
description: Review founding-sales changes involving release, outreach, Gmail or conversation data, credentials, and owner controls. Apply alongside spec and standards checks.
---

# Founding-sales review

## Contract

Review the finished diff against its ticket and `AGENTS.md`. Report concrete blockers with paths, lines and a failing scenario, or state clean with checks and limits. Review fixes against the same findings. Controlled fixtures, merged source, actual provider evidence, deployment, Enable and usefulness are distinct claims.

## Hard gates

- Require David's explicit approval before every actual send, post, booking or Enable, and before role changes, infrastructure applies and deployments. Roadmap/ticket approval and source merge are not operational permission. Approval must identify the action and scope; ambiguous outcomes require inspection, not blind retry.
- Keep business Gmail and conversation data within approved owner/source/purpose/provider scope. Verify access and deletion across originals, derived claims, search, Ask history and workers after waits. Avoid private content in logs, artifacts, citations visible to other users, prompts or external services without scoped consent. Selected imports are not mailbox-wide capture authority.
- Preserve email cap5, any lower sender caps/ramp, recipient-local weekday mornings, eligibility, consent, unsubscribe/refusal and reply stops. Preserve original provider identity, cancelled follow-ups and uncertain attempts. Admission, routine replies and autonomous calling remain OFF unless explicitly approved.
- LinkedIn invitation/DM limits include manual, accepted, pending and unknown activity. Keep account/profile binding, current consent, cross-channel history and reply stops. Unknown coverage or delivery remains held; switching channels never resets allowances. Posting authority is not outreach authority.
- Keep secrets and private state out of commits, logs and public artifacts. Run `gitleaks` through `npm run verify:secrets` or the scoped approved scanner path. Report scanner failures without exposing matched secrets.

## Completion

Use risk-matched checks through normal commands, registered workers and disposable databases. Test refusal, deletion, cancellation, duplicate/unknown reconciliation and approval boundaries when relevant. For production inspect exact changes, recovery and effective permissions only under approved access; source policy tests do not prove live authorization. State what remains unverified rather than manufacture acceptance.
