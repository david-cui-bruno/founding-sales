# Continuous discovery implementation plan

> Execute inline with executing-plans and test-driven-development. Continue the existing isolated branch and PR397.

Goal: repeatedly discover relevant firms without manual CSV batches, retaining source provenance and uncertainty and respecting the free search allowance.

Architecture: reuse Tavily's bounded Basic adapter, the worker/job scheduler, Postgres and the sourcing review surface. Search proposes URLs, never confirmed firm identity, local presence or unmet need. Existing kept-candidate monitoring remains separate. Do not schedule the rejected v2 query set.

## Delivery tasks

- [ ] **Live quality check.** Benchmark short geography-plus-service queries separately from known-firm source checks. Use the existing durable evaluation ledger and preserve its daily/monthly debits (18 requests already used on 5 October). Compare relevance against the DFW baseline. Record rejected and useful results with source evidence. Missing credentials blocks only this live check, not implementation. Do not bypass the remaining daily quota to complete a benchmark.
- [ ] **Shared reservations, schema 49.** Add an account-level search budget and attempt rows, workspace-scoped configurations and result provenance. Reserve one Basic credit and the query/day uniqueness in a committed transaction before any network request. Account caps: 20/day and 600/month, including bootstrap reconciliation of the existing evaluation usage; every failed/uncertain attempt stays charged. Serialize cross-worker reservations. A crash after dispatch must never retry the same paid request. Unknown usage halts new discovery until reviewed. Credential replacement does not reset quota. No secrets in ledger or jobs.
- [ ] **Runner and composition.** Register a bounded daily discovery source only when a dedicated secret and an enabled workspace configuration are present. Use versioned query rotation across Texas, Providence and Boston; no missed-day catch-up. Recheck research enablement and holds before dispatch. Persist reservations independently of the job completion transaction: the existing business_uniqueness runner wraps handlers in a rollbackable transaction and is not safe for paid reservations. Use an at-most-once dispatch fence with its own committed boundary. Stop on provider failures; no hidden retries, paid overage or model fan-out.
- [ ] **Results and review.** Preserve exact result URL/title/snippet, query/version, query geography, retrieval time and provider attribution. Query geography is not verified company location, and result titles are not verified firm names. Deduplicate exact sources and compare known CRM domains without collapsing unrelated franchise branches. Preserve dismissed records across rediscovery. Ambiguous results stay review-only; direct page checks and deterministic verified evidence are required for any later automatic admission. Discovery never creates contacts, enrollments, permissions, calls or deals.
- [ ] **Visible operation.** Extend the sourcing view with enabled/paused status, last attempt, next run, remaining search allowance and stopped/error reason. Reuse research controls where applicable. Make unverified discovery results and verified source observations visibly distinct. No compulsory call questionnaires.
- [ ] **Verification and release.** Tests for concurrent reservations, rollback/crash, replay, missing key, usage mismatch, research holds, cross-workspace isolation, duplicates, dismissed results, query-scope versus actual-location and no outreach effects. Run the full gate and a fresh review; rehearse the schema release before deploying. Store Tavily through the existing secret mechanism, confirm free plan/overage disabled, then enable and observe one production cycle. Report production completion only after persisted results and UI reads are verified.

## Current findings

- The existing source-monitor slice is implemented on this draft branch, not deployed.
- The only current search ledger is single-host evaluation state; it is not suitable for shared worker accounting.
- Tavily credentials were deliberately ephemeral in previous tests. A new user clipboard handoff is required for the live check and eventual secure configuration.
- Two previous search batches were insufficient for autonomous qualification; the second is explicitly rejected. Do not call search configuration alone completed continuous discovery.

## Implementation ledger

- 5 Oct: v3 short DFW/Providence live check returned ten relevant-category results; the unchanged evaluation ledger blocked Boston at the daily limit. No new live requests beyond 20 total.
- Implemented schema49 shared account accounting, pre-request committed dispatch fence, daily worker source, uncertainty/provenance and discovery status in the candidate view. Tests prove the second database connection sees the reservation before network and job replay makes no second request.
- Ruling: first rollout is one query per workspace per day, rotating metro and suburban queries, max5 hits; 20/day and600/month remain shared hard ceilings. This limits unreviewed result accumulation; increasing throughput later is straightforward, but this default may deliver fewer useful prospects than David wants.
- Ruling: a shared search request in flight temporarily prevents other workspace dispatch; any uncertain failure halts the account until examined. Conservative choice costs availability after transient failures but prevents unbounded unaccounted usage.
- Review fixes: preserve original snippets separately from uncertainty; retain native result provenance; check pre-existing candidate source URLs including dismissed rows; flag known CRM domains without merging franchise branches; filter research holds before bounded scheduling; halt on orphaned dispatches.
- Pending: final green gate, release rehearsal, schema/infra deployment, account counter bootstrap, workspace enablement, first production readback. Do not describe discovery as live before these complete.

### Release configuration

The operator imported `module.stack.module.secrets.aws_secretsmanager_secret.this["sourcing-search"]` into the production state with Terraform1.15.8. Import succeeded; no resource was replaced and no secret value entered Terraform. The initial declarative import block was removed after CI correctly rejected it in mock-provider tests. Rehearsal receives a placeholder container value but never injects the search credential into its worker.

After the schema49 release, use the audited operations task:

`fss admin discovery configure --workspace-id <verified-workspace-uuid> --enabled true --prior-day 2026-10-05 --prior-day-used 20 --prior-month-used 20`

These counts reconcile all prior local evaluation attempts. The command maps them to the current UTC period and initializes an absent account only; re-running cannot reset existing quota or lift a halt. To pause, use the same command with `--enabled false`. Research settings and holds independently block dispatch.

Do not run the local evaluation CLI with this shared key after enabling production: its local ledger is not part of the shared account ledger. Future live query evaluations must reserve through production's shared ledger or happen while discovery is paused with an explicit reconciliation before resuming.

### Verification (5 October)

Full Node24 gate passed: typecheck, lint, 6,884 passing tests and16 existing skips. Three additional discovery regressions then passed in the10-test targeted suite (manual dismissal, UTC rollover, missing account). The production Terraform configuration validates with1.15.8. A read-only plan using production's current schema45 images showed1 import,1 add,4 changes,1 destroy: the destroy/add is worker task-definition replacement, not a database or service deletion. It has not been applied.

Fresh independent review was completed. Important findings were addressed and covered by regressions. Deferred minor: secret injection shares the existing production-only classifier-credential switch; the workspace discovery setting independently controls execution. No new secret is injected into rehearsal. Separate deployment flags can be introduced if environments need independent search credential wiring.

CI follow-up: the first infrastructure run rejected the declarative import block because mock providers cannot import resources. Removed that block, successfully adopted the existing secret with the operator import command, and ran the complete offline infrastructure gate (fmt, structural checks, validate/test every module and root) successfully with Terraform1.15.8. No production apply or service restart occurred.
