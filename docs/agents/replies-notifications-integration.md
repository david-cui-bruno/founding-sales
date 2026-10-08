# Reply, notification and provider recovery integration

This batch implements #445, #447 and #451 against the approved #441 boundaries, starting from `67b75e42320edd240a02ce46fac9f619cc5914f0`. The feature lanes own their domain operations, contracts and isolated components; the coordinator owns their shared application composition and combined verification.

## Application boundaries

- Both notification and composer routes mount in the existing API registry. Current authentication, workspace scope and command client-version checks remain authoritative. Public dispatcher regressions went from missing-route404 to authenticated401, and route inventories include each mounted path.
- Manual reply editing mounts inside the existing open reply panel. Human text remains in the session-scoped navigation draft provider. Refresh, changed source and late suggestions preserve edits; no reply body is added to a command receipt, cache or new durable store. The shared operations host preserves the caller's generation command identifier and rejects a late answer after identity changes.
- Suggestion composition accepts only an explicitly configured existing Bedrock route. The present production API has neither that transport configuration nor its inference permission, so suggestions are unavailable while manual editing remains usable. Controlled transport tests do not establish live inference access. This batch adds no IAM grant, credentials, environment activation or budget allowance.
- The awake authenticated desktop polls the same current actions as Today without an hour filter. Suspend/quit stop polling and preserve native references where required; sign-out clears identity-bound state. Only a validated native identifier can request current server-authorized context. Typed internal navigation carries the current session generation; the external deep-link allowlist is unchanged. Real signed macOS delivery and cold-start acceptance belong to #466.
- Sender standing-v2 adds coded incident state and deadlines without changing standing-v1. The desktop shows waiting, required authentication/reputation review and unavailable evidence plainly. It exposes no new incident-clear, cap override or sender-enable action.

## Integration evidence

Root public regressions demonstrate authenticated route mounting, visible manual editing in the real reply panel, original generation command identifiers, late-session refusal, current typed notification navigation, and cooldown/revalidation explanations. Controlled runtime checks cover async identity changes, sleep/resume and strict native activation metadata. New-module import failures are distinguished from behavioral red tests in local receipts.

The initial shared wiring passed55 focused desktop checks and16 API checks, with full workspace typechecking and lint. Subsequent owner hardening adds real PostgreSQL source/session/concurrency and provider lifecycle coverage. Final combined checks and independent acceptance review are required before source completion; feature-specific evidence and limits remain in [provider recovery](provider-recovery-seams.md), [notifications](../sourcing/actionable-notifications.md) and [reply composer](../replies/composer-451.md).

Automatic admission, routine replies and autonomous calling remain off. Original Shirley submission, five/day cap, lower caps, pacing, stops, recipient evidence, ownership and budget fences are unchanged. Source completion, an exact verified backend release and signed desktop publication are separate outcomes.
