# Regular follow-up sequences

Regular sequences remain part of daily selling. Retained production129 uses manual admission. Isolated LOCAL issue741 adds explicit approved-campaign admission under [ADR0013](../adr/0013-approved-email-campaign-admission.md); it is not deployed or permission to send. Begin with the [selling guide](../operations/how-to-sell.md) and retain every [sending safeguard](sending.md).

## Desired direction versus retained implementation

October22 product decisions change desired scope: newly qualified leads auto-enroll only into an already-approved EMAIL campaign with approved targeting/messages/limits. Local source130 implements immutable campaign approval/revocation and automatic admission of current canonical qualified research Firms, not automatic raw-source supply. Actual new acceptance and correction evidence are recorded in the [canonical plan](../../apps/web/PLAN.md); local acceptance at17ac4804d and all three finished reviews are CLEAN after four finding closures. Existing manual enrollment below remains supported and retained production129 is unchanged. Short verified-research AI openings remain future work, with fixed approved offers/pricing/promises and no invented familiarity. Replies and one-off external/social messages remain final-review drafts. No live enrollment/send/provider activation follows from local implementation. Effective OFF, eligibility, suppression, reply stops, caps, uncertainty and current consent remain authoritative.

## Definition, enrollment and permission

`packages/domain/sequences/definitions.ts`, `enrollments.ts`, `followUpPermissions.ts` and `eligibility.ts` separate immutable sequence versions, an actual enrollment and the evidence supporting its follow-up permission. An origin label, permission-row id or successful import is not enough. The verifier re-reads the supporting call/message/meeting evidence, actual firm/contact, scope, version, expiry and revocation state.

A human chooses the supported sequence and recipient. After a reached call outcome, the old active sequence stops. Choosing an agreed sequence attempts the matching enrollment immediately. A single-email permission requires later explicit enrollment in the matching one-step sequence. A permission to send one message cannot authorize a multi-step sequence. See [calling](calling.md) and current API refusals.

## Due work is not delivery

Calendar/time-zone rules calculate due instants with their bound holiday/calendar version. The execution and outbound layers recheck current eligibility, permission, suppression, holds, mailbox coverage, recipient-local windows, sender caps/ramp and effective production sending before dispatch. A due card, schedule, approved template or preview does not mean a message was sent.

Human review must include the supported full-body preview where available. Do not infer that a collapsed installed-client summary showed the full final message. Installing a new desktop is not permission to send, and an old compatible client does not bypass server authority.

Reply/refusal and other terminal stop facts cancel or hold follow-up through the existing terminal-stop boundary. Pausing, snoozing, resuming, migrating a sequence version and correcting a call outcome have different semantics. None may erase historical provider identity, clear an uncertain attempt or reopen a cancelled Shirley/other follow-up without authority. Cross-channel history remains conserved.

## Recovery and verification

`executions.ts`, `sendHandoff.ts`, `terminalStops.ts`, `resume.ts` and the worker sequence handler are the public integration seams. Outbound at-most-once fencing and sent-folder reconciliation retain known versus uncertain delivery. Never blindly retry an ambiguous provider acceptance.

Existing domain/API/worker/Today and actual component/browser tests cover permission matching, explicit enrollment, reply stops, stale ownership, suppressed recipients and pending/unknown attempts. Controlled providers and disposable PostgreSQL prove state-machine behavior, not actual production email delivery or recipient consent. David alone resumes production sending after the required release/health checks.
