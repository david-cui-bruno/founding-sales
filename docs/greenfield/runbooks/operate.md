# Operating FSS

**Production execution has moved to [lean release workflow](../../operations/lean-release-workflow.md).** It is the sole supported production release entrypoint. This page is an orientation/reference, not a local production write recipe. The earlier admin-profile hand-applies, direct secret/service writes, automatic sending-ON assertions and standalone rollback application instructions are retired.

## Locate the system

- [Current operating state](../../operations/current-state.md) owns dated production build/schema, stored sending posture, accepted receipts and actual waits. Never infer those from this page or from public health's process configuration.
- [Feature map](../../features/README.md) owns browser/desktop user journeys and verification navigation. [Processes](../processes.md) locates API/worker composition and registered work.
- [Release invariants](../release.md) explains image/record binding, migration-auth/drain/stopped writers, PITR, unknown-write handling, smokes/readback and recovery constraints.
- [Restore](restore.md) is the separately authorized data-recovery procedure, not an ordinary deploy/rollback shortcut. A restore potentially loses writes and requires owner approval.
- [Retained artifacts](../../operations/retained-client-artifacts.md) protects historical signed restore objects; the web app is the sole product.

Production has API and worker services, private PostgreSQL and separately bound migration/operations tasks. Observe actual current task definitions, counts, images, schema and database host through the approved read path before planning. A remembered ARN or schema is not current evidence. One-off work must retain exact task identity and reconcile its outcome before retrying.

## Operating boundaries

All production release writers use the shared hosted queue, with applicable protected approval and unchanged shared holds. Rehearsal is isolated and cannot address production. Direct cloud/IAM/Terraform mutation is not authorized by documentation or by a failed hosted run.

Sending has independent deployment, authenticated owner and runtime eligibility controls. Current stored owner OFF stays OFF. Release success removes only that release's temporary block for already-authorized sending, after fresh checks and without clearing newer stops. Disabling cannot recall a provider write already in flight. Keep uncertain history and resolve exact receipts, never blindly retry or switch channels.

Secrets Manager entry names/configuration may be discussed, never values, password fingerprints, private state or auth callback/cookie contents. Terraform creates entries without storing their values. Existing standing authority is in AGENTS, not expanded here.

## Recovery and diagnostics

A failed smoke, readback or migration means contain sending/hold releases and inspect actual state before forward repair. A successful smoke without exact record readback is not release acceptance. A lost observer connection is not cancellation. PITR timestamps/retention do not certify restoration.

For alarms, use the existing [runbook index](README.md) and each alarm's **What must stay held** section. A safety refusal is often the intended property, not a condition to clear. Do not invoke a digest/email or provider recovery merely to test documentation.

Discovery-account recovery remains an exact observed-state operation, not a quota reset: inspect current authenticated provider allowance and local counters/outstanding dispatched attempts under approved access. Existing `apps/worker/src/tools/fss.ts` parser and domain guards define the command contract. Fresh provider observation, unchanged expected counter, unresolved-attempt checks and daily/monthly allowance all remain mandatory. Recovery never refunds reservations, retries a past search, enables research or changes sending. Do not guess a CLI invocation or expand provider access from this reference.
