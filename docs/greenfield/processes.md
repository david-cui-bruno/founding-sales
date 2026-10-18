# API and worker processes

The API and worker share domain rules and schema declarations. The desktop is an authenticated client, not a replacement policy engine. This page locates current source; the protected [release invariants](release.md), [operate runbook](runbooks/operate.md) and [lean release procedure](../operations/lean-release-workflow.md) remain the operational instructions.

## API composition

`apps/api/src/bootstrap/main.ts` assembles actual route modules and dependencies. `bootstrap/routes.ts` supplies readiness/admin-job modules plus the explicitly mounted extras. Inspect the complete startup composition when deciding whether an endpoint is served; an import, file or historical contract is insufficient. Authenticated requests derive current workspace/session authority and use command receipts for mutations.

`bootstrap/deployment.ts` and `config.ts` validate deployment configuration. Missing credentials/adapters are explicit unavailable or startup refusal states, never permission to borrow another capability's credentials. Readiness and deployment sending state are distinct from the stored workspace switch and effective sending decision. A health response cannot be used to claim the owner enabled sending.

## Worker composition

`apps/worker/src/bootstrap/main.ts` constructs adapters, registers handlers and due-work sources. `bootstrap/worker.ts` starts bounded scheduler passes, runner slots and metrics on separate sessions. It checks supported database schema before ordinary execution. Current source includes mail, replies, regular sequences, calls, retained meeting work, Today, retention, research/sourcing and separately authorized CRM capture/extraction. Provider-dependent handlers may be conditional or fail closed without an adapter.

Removed generated-answer/index, AI booking lifecycle, automatic email admission and recurring posting modules are not restored by historical rows or archived documentation. Retained meeting follow-through, manual social drafting and research-only verified-firm intake are different capabilities with their own boundaries.

The scheduler materializes work; a leased job is not proof of an external effect. Runner fencing, business uniqueness and outbound uncertainty are described in [jobs](jobs.md). Process shutdown drains in-flight work before sessions close, subject to its deadline. Heartbeats and metrics are operational signals, not business consent or provider-quality evidence.

## Tools and recovery

The existing worker operations entrypoint is `apps/worker/src/tools/fss.ts`. Do not guess a new CLI or run a command merely because its parser exists. Use current procedures and scoped approval, preserve release/sending holds and data, and reconcile unknown writes before retrying. Configuration/secret names may be documented, never secret values or private runtime evidence.

Verification uses existing startup/config/registry/runner tests, workspace typechecks and operations checks. A local process with fakes is not deployed runtime acceptance. [Current state](../operations/current-state.md) records dated production/main observations. Release simplification is a later separately authorized outcome, not implemented by this documentation rewrite.
