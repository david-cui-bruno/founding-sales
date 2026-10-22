# Regular follow-up sequences

Regular sequences remain part of daily selling. Automatic email admission was removed; it is not the same thing as a human choosing an existing regular sequence for an authorized contact. Begin with the [selling guide](../operations/how-to-sell.md) and retain every [sending safeguard](sending.md).

## Desired direction versus retained implementation

October22 product decisions explicitly change desired scope: newly qualified leads should auto-enroll into an already-approved EMAIL campaign with approved targeting/messages/limits. Short prospect-specific AI openings may use verified research without per-variation review, keeping approved offers/pricing/promises unchanged and never inventing familiarity. The manual admission described below is retained implementation, not a settled future restriction. Replies and other one-off external/social messages remain drafts for final review. This requires future implementation and actual acceptance under the [canonical plan](../../apps/web/PLAN.md), not live sending authority. Effective OFF, eligibility, suppression, reply stops, caps, uncertainty and current consent remain authoritative; no campaigns or provider actions are created by this plan.

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
