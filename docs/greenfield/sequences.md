# Regular follow-up sequences

Regular sequences remain part of daily selling. Manual enrollment and approved-campaign admission under [ADR0013](../adr/0013-approved-email-campaign-admission.md) are distinct paths. Use [current state](../operations/current-state.md) for deployed scope and the [canonical plan](../../apps/web/PLAN.md) for remaining acceptance, not the historical production129/local130 checkpoint. Begin with the [selling guide](../operations/how-to-sell.md) and retain every [sending safeguard](sending.md).

## Desired direction versus retained implementation

Approved eligible outbound automation admits newly qualified leads only into an already-approved EMAIL campaign with approved targeting/messages/limits. The current plan distinguishes campaign admission, raw-source supply and opening generation/selection. Deployment of campaign/opening source is not actual business enrollment, generated-copy usefulness or live dispatch acceptance. Existing manual enrollment remains supported and incoming replies remain manual. Fixed approved offers/pricing/promises, grounded research and no invented familiarity remain binding. Social has its separate supported automatic public-publishing target, not a blanket final-review requirement inherited from this email guide. Effective OFF, eligibility, suppression, reply stops, caps, uncertainty and current consent remain authoritative.

## Definition, enrollment and permission

`packages/domain/sequences/definitions.ts`, `enrollments.ts`, `followUpPermissions.ts` and `eligibility.ts` separate immutable sequence versions, an actual enrollment and the evidence supporting its follow-up permission. An origin label, permission-row id or successful import is not enough. The verifier re-reads the supporting call/message/meeting evidence, actual firm/contact, scope, version, expiry and revocation state.

A human chooses the supported sequence and recipient. After a reached call outcome, the old active sequence stops. Choosing an agreed sequence attempts the matching enrollment immediately. A single-email permission requires later explicit enrollment in the matching one-step sequence. A permission to send one message cannot authorize a multi-step sequence. See [calling](calling.md) and current API refusals.

## Due work is not delivery

Calendar/time-zone rules calculate due instants with their bound holiday/calendar version. The execution and outbound layers recheck current eligibility, permission, suppression, holds, mailbox coverage, recipient-local windows, sender caps/ramp and effective production sending before dispatch. A due card, schedule, approved template or preview does not mean a message was sent.

Human review must include the supported full-body preview where available. Do not infer that a collapsed installed-client summary showed the full final message. A client release grants no sending permission; the server retains current authority.

Reply/refusal and other terminal stop facts cancel or hold follow-up through the existing terminal-stop boundary. Pausing, snoozing, resuming, migrating a sequence version and correcting a call outcome have different semantics. None may erase historical provider identity, clear an uncertain attempt or reopen a cancelled Shirley/other follow-up without authority. Cross-channel history remains conserved.

## Recovery and verification

`executions.ts`, `sendHandoff.ts`, `terminalStops.ts`, `resume.ts` and the worker sequence handler are the public integration seams. Outbound at-most-once fencing and sent-folder reconciliation retain known versus uncertain delivery. Never blindly retry an ambiguous provider acceptance.

Existing domain/API/worker/Today and actual component/browser tests cover permission matching, explicit enrollment, reply stops, stale ownership, suppressed recipients and pending/unknown attempts. Controlled providers and disposable PostgreSQL prove state-machine behavior, not actual production email delivery or recipient consent. A healthy release removes only its own temporary block for already-authorized sending after fresh checks, preserving stored owner OFF and newer stops. It never enables an owner-disabled switch or grants recipients/content; see the [release workflow](../operations/lean-release-workflow.md).
