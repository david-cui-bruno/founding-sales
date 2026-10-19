# API and worker processes

The API and worker share domain rules and schema declarations. The desktop is an authenticated client, not a replacement policy engine. This page locates current source; the protected [release invariants](release.md), [operate runbook](runbooks/operate.md) and [lean release procedure](../operations/lean-release-workflow.md) remain the operational instructions.

## API composition

`apps/api/src/bootstrap/main.ts` assembles actual route modules and dependencies. `bootstrap/routes.ts` supplies readiness/admin-job modules plus the explicitly mounted extras. Inspect the complete startup composition when deciding whether an endpoint is served; an import, file or historical contract is insufficient. Authenticated requests derive current workspace/session authority and use command receipts for mutations.

`bootstrap/deployment.ts` and `config.ts` validate deployment configuration. Missing credentials/adapters are explicit unavailable or startup refusal states, never permission to borrow another capability's credentials. Readiness and deployment sending state are distinct from the stored workspace switch and effective sending decision. A health response cannot be used to claim the owner enabled sending.

## Worker composition

`apps/worker/src/bootstrap/main.ts` constructs adapters, registers handlers and due-work sources. `bootstrap/worker.ts` starts bounded scheduler passes, runner slots and metrics on separate sessions. It checks supported database schema before ordinary execution. Current source includes mail, replies, regular sequences, calls, retained meeting work, Today, retention, research/sourcing and separately authorized CRM capture/extraction. Provider-dependent handlers may be conditional or fail closed without an adapter.

Removed generated-answer/index, AI booking lifecycle, automatic email admission and recurring posting modules are not restored by historical rows or archived documentation. Retained meeting follow-through, manual social drafting and research-only verified-firm intake are different capabilities with their own boundaries.

The scheduler materializes work; a leased job is not proof of an external effect. Runner fencing, business uniqueness and outbound uncertainty are described in [jobs](jobs.md). Process shutdown drains in-flight work before sessions close, subject to its deadline. Heartbeats and metrics are operational signals, not business consent or provider-quality evidence.

## Registered due-work sources

The default `workerDueWorkSources()` registry contains exactly the following names. Registration is not activation: composition flags, configured adapters and current domain authority determine whether a source materializes eligible work. Sources only touch PostgreSQL; provider effects belong to guarded handlers.

| Source | What it materializes |
| --- | --- |
| `crm-mail-progress` | CRM mail progress work from retained business state. |
| `crm-processing-recovery` | Financial recovery of interrupted extraction, not another external dispatch. |
| `crm-mail-backfill` | Explicitly enabled, authorized CRM backfill work. |
| `social-drafts` | Manual requests/explicit weekly draft opt-ins and expiry, when configured; no posting authority. |
| `outreach-replies` | Email attribution/expiry and enabled routine-reply work; registration is not sending consent. |
| `meeting-analysis` | Eligible retained meeting analysis, when configured. |
| `meeting-follow-through` | Follow-through from retained meeting business state. |
| `meeting-recording-setup` | Authorized automatic recording setup for retained meetings, when configured. |
| `meeting-transcription` | Eligible meeting transcription, when configured. |
| `canary` | Periodic worker canary jobs. |
| `today-build` | Due Today projection rebuilds. |
| `sequence-action` | Due regular sequence actions. |
| `terminal-stop` | Consumption of terminal stop events. |
| `send-day-close` | Closing due sender-day accounting. |
| `retention-batch` | Due bounded retention/privacy batches. |
| `social-assets-cleanup` | Cleanup of eligible social assets. |
| `research-sweep` | Daily research scheduling and abandoned-run recovery. |
| `sourcing-monitor` | Eligible sourcing-monitor work when that composition is enabled. |
| `sourcing-qualification` | Due candidate qualification under configured composition. |
| `sourcing-discovery` | Due configured discovery searches. |
| `apollo-discovery` | Apollo Free company-only pages with matching operator-bound account/key references and a verified exclusive Free-cycle allowance. One atomic spent reservation per page, no retry or paid fallback. Disabled without key/attestation, intake remains unverified and first-party qualification still requires current owner approval. |
| `telephony-sweep` | Due telephony reconciliation/sweep work. |
| `calcom-reconcile` | Cal.com reconciliation, when configured. |
| `call-transcribe-resume` | Resumption of held call transcription, when configured. |
| `call-transcribe-collect` | Collection of recorded transcription jobs, when configured. |
| `call-summarize` | Due call summaries, when configured. |
| `call-analyze` | Due call analyses, when configured. |
| `call-analyze-sweep` | Call-analysis recovery/sweep work, when configured. |
| `mail-recovery`, `mail-sync-reconcile`, `mail-watch-renewal`, `outbound-reconcile` | Current-generation recovery, coalesced mailbox sync, watch renewal and observation of uncertain outbound fences. |
| `classify-reply` | Due reply classification. |
| `route-validation` | Due route validation. |

Supplying the explicit CRM mail-processing port additionally registers `crm-mail-intents`; it derives authorized CRM mail-processing intents and is not part of the default registry above. Neither registration nor scheduler execution grants capture, backfill, processing, sending or other provider consent.

## Tools and recovery

The existing worker operations entrypoint is `apps/worker/src/tools/fss.ts`. Do not guess a new CLI or run a command merely because its parser exists. Use current procedures and scoped approval, preserve release/sending holds and data, and reconcile unknown writes before retrying. Configuration/secret names may be documented, never secret values or private runtime evidence.

Verification uses existing startup/config/registry/runner tests, workspace typechecks and operations checks. A local process with fakes is not deployed runtime acceptance. [Current state](../operations/current-state.md) records dated production/main observations. Release simplification is separately owned; this page does not replace current operational procedures.
