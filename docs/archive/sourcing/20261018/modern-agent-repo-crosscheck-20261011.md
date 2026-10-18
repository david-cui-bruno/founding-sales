# Modern agent repository crosscheck — October 11, 2026

## Decision supported

Keep Callie's existing TypeScript stack, PostgreSQL jobs, AI SDK provider boundary and bounded conversational Ask. Borrow targeted operating patterns from modern agent repositories; do not adopt an entire personal-assistant runtime or start another framework comparison. The useful work is already mostly covered by #580, #581 and #551. This inspection establishes implementation patterns, not measured Callie model quality or production readiness.

## Method and research questions

Read-only inspection of official repository source, documentation, workflows and tests at pinned commits. Downloaded archives outside Callie; installed or executed neither project. GitHub commit metadata was fetched on October 11, 2026:

- **NousResearch/hermes-agent:** `c0ef5af5205dbdc25e9e44acd66873b4bb3503c9`, commit timestamp `2026-10-11T17:27:06Z`. [Official organization](https://github.com/NousResearch), [pinned repository](https://github.com/NousResearch/hermes-agent/tree/c0ef5af5205dbdc25e9e44acd66873b4bb3503c9).
- **openclaw/openclaw:** `74b14401edaf6181615539b8faa33bfff150a325`, timestamp `2026-10-11T18:01:37Z`. [Pinned repository](https://github.com/openclaw/openclaw/tree/74b14401edaf6181615539b8faa33bfff150a325).
- **Callie inspected source:** `3b0674b20d16e83a1c6c1f046d34403983659e5a`; latest approved ADR0009/0011 amendments and live #551/#581 issue bodies inspected separately. Decisions are newer than released implementation.

Questions: How do these projects select tools and manage a loop? How do they retrieve history without stuffing everything into context? What survives compression? How are cancellation, retries and ambiguous writes handled? What does their trust model assume? What CI patterns transfer to a founder-only CRM? Are any missing Callie tickets justified?

## Findings and application

### 1. Tools around a capable model are the right shape, but execution remains host-owned

Hermes exposes enabled/disabled toolsets and delegates the loop to execution modules. Its `AIAgent` constructor defaults `max_iterations` to `sys.maxsize`; a separate per-agent budget counter supplies consume/refund behavior. The budget module's prose gives an older different default, so use the constructor for this observation rather than treating comments as runtime truth. [Constructor and toolset parameters](https://github.com/NousResearch/hermes-agent/blob/c0ef5af5205dbdc25e9e44acd66873b4bb3503c9/run_agent.py#L241-L243), [budget implementation](https://github.com/NousResearch/hermes-agent/blob/c0ef5af5205dbdc25e9e44acd66873b4bb3503c9/agent/iteration_budget.py).

OpenClaw documents schema-validated tool arguments, tool lifecycle events and recovery that does not execute partial arguments. This is a host execution contract, not a claim that model intelligence removes the need for validation. [Agent loop](https://github.com/openclaw/openclaw/blob/74b14401edaf6181615539b8faa33bfff150a325/docs/concepts/agent-loop.md).

**Callie:** `askAgentSdk.ts` already declares read_exact, resolve_records, search_history, read_conversation, read_selected and search_selected. One SDK generation returns requested calls; the worker owns actual execution. `maxRetries:0` and `stepCountIs(1)` do not prohibit inference or tools: they prevent the SDK silently running a second loop/retry outside the worker's financial/cancellation fences. Preserve that seam. Do not adopt an unlimited agent or general shell/browser tools for Ask. [Existing provider adapter](https://github.com/david-cui-bruno/founding-sales/blob/3b0674b20d16e83a1c6c1f046d34403983659e5a/apps/worker/src/providers/askAgentSdk.ts), [worker](https://github.com/david-cui-bruno/founding-sales/blob/3b0674b20d16e83a1c6c1f046d34403983659e5a/apps/worker/src/handlers/askAnswer.ts).

### 2. Discover first, then read bounded original context

Hermes session search uses SQLite FTS5, limits discovery results, deduplicates session lineage, and directs callers to a subsequent session/window read. It filters compaction summaries from original message windows. This is useful evidence for a two-stage retrieval interface; it does not establish CRM identity or access correctness. [Search implementation and schema](https://github.com/NousResearch/hermes-agent/blob/c0ef5af5205dbdc25e9e44acd66873b4bb3503c9/tools/session_search_tool.py).

OpenClaw's memory search combines embedding and keyword paths and can use one when the other is unavailable. Its current docs describe stricter keyword matching first, broadening only when no body/filename matches exist, plus deterministic diversity and ranking. The actual hybrid module merges by candidate ID and separately retains vector/text scores; tests cover the implementation. [Search contract](https://github.com/openclaw/openclaw/blob/74b14401edaf6181615539b8faa33bfff150a325/docs/concepts/memory-search.md), [hybrid source](https://github.com/openclaw/openclaw/blob/74b14401edaf6181615539b8faa33bfff150a325/extensions/memory-core/src/memory/hybrid.ts), [hybrid tests](https://github.com/openclaw/openclaw/blob/74b14401edaf6181615539b8faa33bfff150a325/extensions/memory-core/src/memory/hybrid.test.ts).

**Callie:** whole-business source discovery and bounded conversation reads already exist; don't create another search service. #551 should evaluate actual end-to-end questions and inspect missed/noisy results. If an observed failure warrants keyword expansion, use bounded fallback and preserve exact SQL state queries. Do not copy OpenClaw's temporal decay blindly: an old promise, contract or unresolved conflict can remain relevant in a CRM. Vector usefulness, ranking weights and model answer support remain unmeasured here. [Canonical corpus and discovery](https://github.com/david-cui-bruno/founding-sales/blob/3b0674b20d16e83a1c6c1f046d34403983659e5a/packages/domain/crm/askCorpus.ts).

### 3. Compaction should manage model context, not redefine business evidence

Hermes compression documents deep snapshots, a fenced commit and rejection of work completing after a host timeout. OpenClaw distinguishes compacted model context from retained history: older facts may leave context while remaining available for retrieval; cancellation stops recovery but does not undo an already completed compaction. [Hermes compression](https://github.com/NousResearch/hermes-agent/blob/c0ef5af5205dbdc25e9e44acd66873b4bb3503c9/agent/conversation_compression.py), [OpenClaw compaction](https://github.com/openclaw/openclaw/blob/74b14401edaf6181615539b8faa33bfff150a325/docs/concepts/compaction.md).

**Callie:** retain canonical conversations, revisioned evidence and original source citations independently of summaries. Existing scope/history contracts already recheck access and distinguish immutable intent from admitted sources. Long-running autonomous compaction/memory-learning infrastructure is unnecessary for the bounded founder Ask now. Test existing session limits and disclose partial coverage before adding compression machinery. [Scope](https://github.com/david-cui-bruno/founding-sales/blob/3b0674b20d16e83a1c6c1f046d34403983659e5a/packages/domain/crm/askAgentScope.ts), [evidence admission](https://github.com/david-cui-bruno/founding-sales/blob/3b0674b20d16e83a1c6c1f046d34403983659e5a/packages/domain/crm/askExecutionEvidence.ts).

### 4. Simplify the operator experience, not ambiguous external-write accounting

OpenClaw's command queue is an in-process session/concurrency queue. Its separate durable outbound path tracks producer leases and started/unknown states. Its retry documentation distinguishes safe request retries from non-idempotent sends with ambiguous outcomes; lease expiry does not erase a started send. Actual SQLite claim tests include producer_claimed, send_attempt_started and unknown_after_send states. [Queue](https://github.com/openclaw/openclaw/blob/74b14401edaf6181615539b8faa33bfff150a325/docs/concepts/queue.md), [retry](https://github.com/openclaw/openclaw/blob/74b14401edaf6181615539b8faa33bfff150a325/docs/concepts/retry.md), [claim tests](https://github.com/openclaw/openclaw/blob/74b14401edaf6181615539b8faa33bfff150a325/src/infra/delivery-queue-sqlite-claim.test.ts).

**Callie:** PostgreSQL jobs remain the durable mechanism. Reuse existing cancellation, reservation, unknown-attempt and after-wait checks while #581 removes per-release receipt ceremonies. Don't replace durable jobs with an in-memory tool loop or allow automatic replay of an ambiguous send/paid dispatch. #551 already explicitly calls for cancellation, safe retry, per-provider-step counts and distinguishing provisional output from published results. No extra orchestration platform ticket is needed.

### 5. A personal assistant's trust model is not Callie's CRM authorization model

OpenClaw explicitly supports one trusted operator/team boundary per gateway, not hostile multi-tenant isolation. Its docs describe broad session visibility and host execution as delegated operator capabilities. These defaults cannot establish Callie mailbox consent, member/source access, deletion semantics or permission to send. [Trust model](https://github.com/openclaw/openclaw/blob/74b14401edaf6181615539b8faa33bfff150a325/docs/gateway/security/trust-model.md).

**Callie:** normal authenticated owner consent is sufficient for the approved founder use, but untrusted email remains evidence. It must not acquire the owner's command authority merely because it is included in context. Preserve source/member access, separate capture/processing/send scopes and independent sending controls. This is covered by #581 and #551; no new tool permission matrix is proposed.

### 6. Select CI work by impact, but don't import a mature project's release platform

Hermes has a changed-path classifier with shared-fixture consumer mapping and broad treatment of unknown paths. Its own comments describe expensive lanes, and actual workflow policy must be read separately because some prose is stale. Tests are sharded and workflows distinguish E2E inputs. OpenClaw CI exposes changed-core paths, scoped lanes and exact release targets, but its large workflow is disproportionate to Callie's current needs. [Hermes classifier](https://github.com/NousResearch/hermes-agent/blob/c0ef5af5205dbdc25e9e44acd66873b4bb3503c9/scripts/ci/classify_changes.py), [Hermes test workflow](https://github.com/NousResearch/hermes-agent/blob/c0ef5af5205dbdc25e9e44acd66873b4bb3503c9/.github/workflows/tests.yml), [OpenClaw CI](https://github.com/openclaw/openclaw/blob/74b14401edaf6181615539b8faa33bfff150a325/.github/workflows/ci.yml).

**Callie:** #580 should implement small tested impact mapping, dependent-consumer coverage, broad shared/unknown fallback, real migration upgrades and one serialized deployment path. No self-hosted runner fleet, framework-specific release gate or personal-assistant updater is justified by this crosscheck.

## Roadmap recommendation

- **Keep:** #547 local real-Google acceptance; #580 proportional CI/automatic maintenance releases; #581 owner setup; #548 reviewed useful examples; #549 ordinary capture; #550 Today/progress usefulness; #551 actual conversational support/cost/latency; #552 release and independently enable applicable capabilities.
- **Refine within existing tickets:** #551 can explicitly retain one compact per-request diagnostic summary (model/version, stages/tool names, duration, usage/cost, cancellation/error/partial-coverage outcome) using current execution data. Avoid raw body/tool-output logs. If current acceptance cannot reconstruct a failing run, reproduce that gap before creating a source repair ticket. Existing #551 acceptance already asks for relevant measurements; this is an execution aid, not an independently proven missing implementation.
- **Defer:** framework migration, unrestricted tools, multiagent swarms for CRM runtime, autonomous skill/memory learning, dedicated vector database, mandatory architecture tournaments, elaborate staging/release platforms, and speculative long-session compression.
- **No genuinely new architecture ticket was established.** Repositories validate the chosen patterns, not a missing product capability. Broader phone/SMS/call acquisition and customer-facing rollout need separate product-contract review; these repositories are not evidence that such integrations are shipped or covered.

No provider call, installation, test execution, operational mutation, paid model use or activation occurred in this research. Inspected upstream tests are source evidence, not tests run by Codex or proof of Callie's performance.
