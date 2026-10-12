# Engineering design and completion audit — October 11, 2026

## Agreed outcome

David-only Callie captures relevant business Gmail conversations, keeps people/firm/opportunity context, tracks supported progress and dated work, and answers questions using current context and bounded tools. Correction, original navigation, deletion and Disable are usable. No personal-inbox archive, daily briefing, unrestricted agent tools or new outreach authority.

David approved routine Matt Pocock code-review plus applicable checks, structural cleanup that helps agent navigation and testing, and explicit deferral of work outside this immediate outcome. The engineering standard is adapted proportionately, not imposed as a second human-review ceremony. One integration owner controls shared schema/contracts. Each ticket remains owned through its complete outcome; small PRs are safe increments, not ticket completion.

## Scope and evidence

Read-only source audit at a7db0a82 on a throwaway prototype branch, with main CRM implementation merged through PR584 (a2c2b676). Open tracker fetched during this audit: eight execution issues and four parents. No fresh production inspection, deployment, release approval, activation or sending changes. Dated production observations remain d49/schema88/desktop1.0.51; merged source schema104 is held. Untracked research and experiments were preserved, not deleted.

Reviewed repository instructions/glossary, ADR0002/0003/0008/0009/0011, current state/roadmap, open issue contracts, workflow selection, Ask/provider/mail modules and setup seams. Three parallel read-only audits covered contracts, module structure and workflow/evaluation. File sizes are investigation signals, not defects. This is not a full security or performance review.

## Working agreement

- Define observable outcome and failure cases; use the existing authenticated commands/reads and registered workers with disposable real PostgreSQL and fake external adapters.
- Review a frozen diff using Matt Pocock code-review, separate Standards and Spec agents; repair material findings and rerun affected checks. Root integrates shared contracts.
- Focused local checks during iteration; exact-source required CI before normal integration. Reuse unchanged evidence and retain failures. Do not repeatedly run broad checks without a changed risk.
- Routine delivery uses implemented proportional CI and the lean release flow. Protected/bootstrap changes and the current backlog hold retain their actual review prerequisites.
- Actual provider acceptance, semantic usefulness, deployed behavior and Enable are distinct observations. Automate mechanical records; never turn a record into approval.

## Ranked improvements

| Priority | Improvement | Evidence and implementation scope | Verification |
|---|---|---|---|
| First | One current operating view and agent module map | current-state.md and roadmap repeat superseded counts/PR statuses; crm-capability-activation.md leads with superseded procedures; README omits CRM/Ask. Put current instructions first, preserve linked dated history, map request→worker→provider→read→citation→deletion and commands. | Links resolve; no conflicting active counts/procedures; historical evidence retained; docs diff review. |
| First | Concentrate Ask model-facing evidence projection | askAnswer.ts constructs metadata, askAgentSdk.ts projects handles and interpretation rules, askAnswerPorts.ts defines transport. A private projection module should own the typed model view/handle codec, keeping access/lifecycle/accounting host-owned. Format touched logic. | Existing public/registered-worker regressions preserve compatibility/current access/deletion/accounting; new regressions reproduce unsupported provenance/coverage claims where deterministic enforcement is possible. Actual semantic quality measured separately. |
| First, same Ask outcome | Reuse ordinary configured Ask setup | askConfiguredSdkJourney.test.ts, askAgentExecution.test.ts and askMixedExactCitations.test.ts repeat setup and differ in direct seeding versus ordinary consent. Small isolated fixture; scenario inputs and meaningful assertions stay visible. | Authenticate/save configuration/execute registered worker; distinguish controlled fixtures from actual providers; retain substantive race tests. |
| Later unless current edits require it | Gmail read-only locality | packages/domain/mail/crmSources.ts combines capture, read, erasure, recapture, body preparation and observation across 2532 lines. First extraction is read-only copy queries behind existing exports; keep lock-sensitive capture/deletion together. | Public reads/capture/deletion/recapture tests unchanged; no changed lock ordering or authority semantics. |
| Later | Body-free evidence and evaluation reconciliation | Reuse CI/migration/status/readiness/evaluation outputs; runner grant checks and manual summaries duplicate work. A helper may collect revision, scope, outcome and conserved allocation, never approval. | Completed/failed/unknown accounting fixtures; no consumed-grant reuse or ambiguous retry; explicit unobserved fields. |
| Housekeeping before any production merge of experiments | Archive throwaway runners outside worker src | src/providers/ask-interface-prototype is included by worker tsconfig; tools/ask-evaluation/prototype already exists untracked. Preserve artifacts/hashes and avoid overwriting it. | Resolve collisions explicitly, retain historical frozen scopes, production imports exclude prototype, tool typecheck separate. |

Do not rebuild PostgreSQL jobs, replace AI SDK, add staging or introduce a new review/authority platform. Optional pgvector/ANN/reranking remains diagnostic or deferred until observed retrieval/latency benefit warrants it. Representative data and unseen holdout support later reliability claims; scarcity does not stop the approved provisional David-only path.

## Complete ticket execution map

| Lane | Issues | Complete outcome and sequence |
|---|---|---|
| Core Gmail | #549 plus #552 | #549 produces pre-enable configuration/controlled/provider readiness. #552 owns held release, genuine scoped Enable and first ordinary capture. Shared observations complete #549; no reciprocal blanket tracker dependency or duplicate ceremony. Verify recovery, original read and deletion. |
| Core progress | #550 | Separately demonstrate configured extraction, supported deterministic progress/Today/corrections, and booking→opportunity→brief→human outcome. Extraction alone cannot close the journey. |
| Core Ask | #551 | Engineering fixes, actual configured model→host tools→useful cited answers; history/session/scope/cost/latency/cancellation/current deletion. Selected-source work can proceed without Gmail; Gmail-backed claims consume #549. |
| Core delivery/setup | #552 | One-time bootstrap/held-backlog review, deployment/configuration/readback, independent capability Enable/Disable. Do not wait on unrelated native/social acceptance. Existing release hold remains. |
| Independent outreach | #438 → applicable #425 | Supported discovery and guarded admission under existing targeting/evaluation/authentication/sender safeguards. Not a prerequisite for David-only CRM/Ask. |
| Independent native | #460, #466 | Exact approved LinkedIn schedule/inspect/cancel and real OS notification/click/restart/sleep-wake. Remain open full obligations; not backend CRM blockers. |
| Tracking | #418/#441/#479/#497 | Parents, not four additional builds. Closed foundations stay closed. |

#549–552 are broad completion tickets because most source foundations are already shipped to main; retain separate observable acceptance rows/owners rather than spawning another horizontal framework. Newly found substantive source work gets a coherent child ticket. No real outcome closes from this audit.

## Reasoning comparison informs Ask work

Frozen run5dc395be-3b59-439f-b662-fe8ad77789c3: six familiar synthetic cases, two repetitions, identical supplied context/current output protocol, auto tool choice, medium effort and4096 output ceiling. Disabled/adaptive each completed12/12. Median latency3535/3650.5ms, input28676 each, output2221/2677 tokens; reasoning blocks observed0/6. Both retain pasted-header→observed-envelope and pasted-coverage→live-CRM mistakes. Some answers remain fragments or label interpretation fact. No clear useful advantage; keep reasoning disabled pending a narrower demonstrated need.

24 calls/448c conservative allocation, not invoice. Campaign now281 dispatched calls/3190c conserved allocation within approved400/$50; no further dispatch planned. Fixed-context synthetic observations do not establish ordinary integration, retrieval quality, representative reliability or activation. Do not attribute changes versus older forced-tool/1000-token runs solely to reasoning.

## First execution order

1. Finish the current-instructions/module-map cleanup; reconcile tracker counts/schema/reviewer and shared capture checklist.
2. Complete Ask evidence-projection/test-setup work in #551 with TDD and frozen two-axis review. Progress/booking and Gmail readiness can proceed in parallel under the shared integrator.
3. Complete approved release/bootstrap prerequisites and #552 deployment once the hold is explicitly lifted through supported procedures, then capture ordinary observations shared with #549.
4. Finish affected #550/#551 actual end-to-end outcomes and enable independently passing scopes. Keep independent outreach/native obligations visible.

Success for the cleanup pass: an agent can identify current outcome, source/deployed distinction, owning module, relevant command and exact next gate without reconstructing historical chat. No line-count quota, ticket-count quota or perfect-cleanliness gate.
