# Ask ticket and codebase audit — October 11, 2026

Read-only source/contract audit at `a9be6eb05646ff35b22b0ea5a01f15bdabcbab3d`, using the freshly retrieved issue bodies in `.context/roadmap-audit-20261011/issues.json`. This audit made no provider calls, production observations, issue edits or code changes and ran no new tests. The source citations below describe inspected behavior; existing test bodies establish intended controlled scenarios, not newly executed or actual model quality results.

## Conclusion

The approved stack already supplies substantial reusable depth: exact CRM reads, canonical source proofs, configured AI SDK transport, a host-controlled tool loop, conversation expansion, semantic indexing jobs, scoped conversational history, current-source publication checks, cancellation and conserved billing. The immediate gap is demonstrated usefulness and a retrieval interface that gives the model useful evidence without requiring guessed AND terms. A replacement agent framework or external vector database is not warranted by the observed failures.

The best next work is a targeted contract update to #551, a compact retrieval/module design, and proportionate implementation/evaluation. Keep closed #555–#561 source tickets closed; their fake-adapter outcomes are not actual quality acceptance. #548 owns labels; #551 owns actual useful Ask; #552 owns deployment/configuration/enabled operation. Capture and deterministic progress retain independent readiness.

## What is implemented and reusable

| Module / seam | Source evidence | What it does and does not prove |
| --- | --- | --- |
| Product commands and reads | `apps/api/src/routes/askAnswers.ts:10`, `askSessions.ts:7`, `askIndex.ts:8` | Authenticated answer request/read/cancel/investigate, private sessions, and indexing commands. These are the existing integration test seam; no new diagnostic product is necessary. |
| Current original evidence | `packages/domain/crm/askAnswerInput.ts:21` | Rebuilds original source/access/context/window proofs and session input; empty business/record scope begins without text and requires discovery. For `agent_v1`, selected originals supply all bounded canonical windows rather than only keyword hits (`:79`). |
| Canonical text construction | `packages/domain/crm/askCorpus.ts:163`, `:195`, `:218` | Refuses oversized transcript/body inputs, splits each original into at most 2,000-character windows without overlap, retains utterance locators, and strips the conventional `\n-- \n` signature tail. This is a versioned deterministic chunker, not a researched optimum. |
| Bounded ordinary agent transport | `apps/worker/src/providers/askAgentSdk.ts:27`, `:46` | Composes native tools and `Output.object`, one SDK generation per host step, no inner retry. Complete composed schema/tool/message bytes plus overhead are conservatively reserved. Last-step instruction requests final cited answer or abstention. Actual repaired transport quality remains unmeasured in the retained completed run. |
| Host loop and publication | `apps/worker/src/handlers/askAnswer.ts:146`, `:156`, `:253` | Supports 1–32 configured generations and at most 60 seconds, checks current purpose/source/cancellation after waits, and executes only named reads. Citation IDs must be live admitted windows. Agent claims publish as `cited_unverified`, correctly distinguishing locator validity from meaning. |
| Lexical history search | `packages/domain/crm/askHistoryInvestigation.ts:51` | Scans up to 1,000 catalog sources, reconstructs each corpus and applies `simple` full-text query/ranking over arrays. Unquoted terms are AND; ranking does not solve absent matches. This is not a durable GIN-indexed corpus. |
| Browse and conversation reads | `askHistoryInvestigation.ts:38`, `:67`; worker `askAnswer.ts:212` | Term-free preview, correct continuation and original-aware nearby messages. Host limits admitted sources to 10 and returned tool windows to 20. Browse order is catalog order, not relevance/recency; first-window previews can miss late source evidence. |
| Broad semantic retrieval | `packages/domain/crm/askCanonicalIndex.ts:26`, `:82`; worker `askAnswer.ts:336` | Registered asynchronous canonical indexing, real configured embedding adapter, exact SQL cosine over `double precision[]`, then reciprocal-rank fusion. Semantic discovery uses the whole eligible history catalog, even when lexical matches are empty. This differs from request-local reranking over already admitted windows (`askAnswer.ts:263`). |
| Real embedding adapter | `apps/worker/src/providers/askTitan.ts:8` | Actual Titan v2 conversion supports 256/512/1,024 dimensions with no inner retry. Existence and controlled transport tests do not establish embedding quality or approved operational use. |
| Private continuity and actions | `packages/domain/crm/askSessionContext.ts:10`; `apps/desktop/src/renderer/ask/AskConversation.tsx:18` | Up to eight prior completed turns are included only when dependency/current scope/original access still permit them. Session scope preview, history and exact human actions are reusable. Source-free earlier turns are not arbitrary permanent agent memory. |
| Diagnostics and UI | `packages/domain/crm/askDiagnostics.ts:6`; `apps/desktop/src/renderer/ask/AskAnswer.tsx:582` | Body-free request-lineage tools/duration/usage/cost/config/coverage exist. UI explicitly calls agent facts “Cited interpretation; verify against original evidence.” No need for a separate observability platform. |
| Erasure | `packages/domain/retention/deletion.ts:1373`; migrations0095/0097 | Canonical embeddings/context, request vectors, admitted records/sources, windows, answers and action private text participate in erasure. New stored lexical documents, vector types and rerank/context caches must extend this inventory. |

## Important distinctions in the issue contracts

1. #554's problem statement describes the historical text-only/excerpt-only foundation. Closed #555/#556 added tool execution and cited synthesis. Do not infer today's transport remains tool-free from the parent introduction. Source completion still says nothing about useful model interpretation.
2. #557 requires an actual semantic projection/query path, not just fake similarity scores. That path exists in canonical indexing plus Titan conversion. Native pgvector types/extension, an indexed lexical projection and actual embedding-quality evidence do not exist merely because #557 is closed. A pgvector improvement is an additive implementation change, not proof the existing source ticket was never implemented.
3. #548/#551/#552 still mention the dated target schema99; audited source has migration0104. Their “verify actual state” language takes precedence, but replace these target references at the next contract reconciliation. Historical shipped d49/schema88 should remain explicitly dated rather than silently updated from local source.
4. #479 and old readiness documents mandate lexical/vector/fused comparisons and representative quality. The October11 amendments and #551 narrow them: monitored David-only provisional quality is allowed; a vector tournament is optional diagnosis; customer-thread scarcity is not a universal blocker. Preserve the original history and point readers to the operative amendment instead of multiplying gate documents.
5. #551's “answers cite supporting passages” is an outcome to measure, not a runtime claim that valid citation IDs establish entailment. Current code and UI correctly label support unverified. The next contract should explicitly separate deterministic citation/access validation, reviewed semantic support, and whether a future semantic verifier is necessary.
6. Three generations is evaluation configuration, not an architectural constant. The actual synthetic harness reads per-run `maxAskSteps`, pins Haiku4.5 and caps the aggregate at25steps/$1 (`apps/api/test/syntheticActualAcceptance.test.ts:29`, `:34`, `:64`). It always starts its six Ask cases with empty firm source input (`:100`), so it does not isolate model interpretation under known supporting context.

## Highest-value remaining research

### 1. Evidence access, chunking and context expansion

Decide what the retrieval module returns: scored canonical candidates plus message/speaker/date/quote attribution and bounded neighbor context, with a single coverage/cursor contract. Compare current fixed windows with message/utterance-aware windows and bounded overlap; include promises corrected in the next message, repeated quotations, long signatures, and relevant evidence late in a source. Favor the smallest context that retains the decisive meaning. Generated contextual summaries must remain separate from original citation text and join deletion/versioning. This can change retrieval quality more directly than swapping vector storage.

Inspect actual retained retrieval traces before adding rewrite/rerank agents. The current lexical loop performs corpus reconstruction and SQL ranking once per source (`askHistoryInvestigation.ts:55–61`), while canonical semantic search rehydrates each returned row through `indexOriginal` (`askCanonicalIndex.ts:86–90`). This is a plausible scale/latency cost, not a measured performance bug. Measure query counts, candidates/windows, cache behavior and latency on a specified small/medium corpus before selecting persisted lexical projection or ANN.

### 2. Model interpretation with oracle evidence

Run selected-context cases where the decisive evidence is known and already supplied, separately from history discovery. Compare stronger versus cheaper supported models using identical quoted/conditional/corrected/conflicting evidence. Score attributed support, unsupported definitive statements, abstention and useful partial answers independently of JSON transport. This separates model capability from retrieval and makes a model upgrade decision meaningful. Model catalog claims require actual access/transport verification, not assumptions.

### 3. Hybrid retrieval quality and implementation

Reuse the existing canonical index lifecycle and independently eligible semantic candidates. Compare improved lexical query handling, exact semantic and fusion only where current traces show retrieval misses. Specify model/dimension/chunker version, known coverage/lag, candidate count and authorized filters. Measure retrieval recall/distractors separately from final answer quality. Native pgvector installation/test-image/RDS support and privileges need verification before proposing a migration; HNSW remains contingent on measured exact-search latency. See the existing [pgvector review](ask-pgvector-hybrid-review-20261011.md).

### 4. Execution budgets and diagnostic specificity

Choose a practical normal-generation/context/time budget and reserve a final synthesis generation inside it; explicit deeper work remains the existing confirmation path. The last-step instruction is present, but the tools are still offered (`askAgentSdk.ts:32–33`), so model compliance is not a guaranteed reserved synthesis step. Research whether the pinned SDK/provider can disable read-tool choice on that final step while keeping its structured-output transport. Do not increase all budgets without measuring what retrieval returned and why the model spent each turn.

Current `unsupported_answer` combines malformed tool arguments, unauthorized citation references, structurally invalid output and other refusal paths. Keep the public outcome stable if appropriate, but add precise body-free internal reason/stage codes for demonstrated failure classes. Similarly, deadline expiry currently shares `input_bound_reached` at worker`:170`; verify whether a separate timeout diagnostic would improve repair without new product complexity. Existing request-lineage diagnostics are the correct module to deepen.

## Controlled test coverage and remaining blind spots

- `apps/api/test/askCanonicalAnswer.test.ts:11` covers independent index reuse and semantic retrieval when the keyword query does not match; its vectors are scripted. It proves the semantic path is not restricted to lexical hits, not that Titan retrieves useful paraphrases.
- `askCanonicalIndex.test.ts:49` covers deletion/revocation during provider waits and accounting; keep these deterministic controls rather than requiring dangerous live adversarial races.
- `askHistoryBrowse.test.ts`, `askBusinessNativeSources.test.ts`, `askSdkInputAccounting.test.ts` cover recent catalog/cursor/owned-source/accounting repairs. No actual relevance or latency score follows from their scripted responses.
- `askSessions.test.ts`/desktop session tests exercise continuity/scope behavior; actual model-follow-up interpretation needs its own labeled observation.
- Fixed synthetic firm cases do not isolate selected-context answer quality, larger mixed-history distractors, late-chunk evidence, semantic-only actual embedding retrieval, ordinary Gmail attribution, or load-dependent latency. Those are targeted coverage gaps, not reasons to demand a large private customer corpus first.
- `askAnswerInput.ts:68–79` still derives `retrievalPartial` partly from keyword group selection even when the agent receives all selected windows. This may conservatively overstate partial input; inspect/reproduce before calling it a bug or changing disclosure semantics.

## Proposed targeted ticket amendments

**#548:** retain the reviewed existing labels, add oracle-context versus discover-history categories, late-source/neighbor corrections, per-case decisive passage IDs and unsupported-outcome labels. Freeze one useful initial set, unavailable categories and a genuinely independent holdout; do not keep tuning against a holdout while calling it independent.

**#551:** make the retrieval module contract explicit; preserve existing scope, original-source, deletion and financial seams. Complete improved lexical/hybrid/context behavior where justified, select an evidence-based model and normal turn budget, retain precise diagnostics, and observe actual transport plus useful answers. Add measured candidate recall/support, final usefulness, abstention, latency and cost denominators. Do not close from controlled SDK output or native pgvector installation alone.

**#552:** update the current source target/readiness reference and keep structured/lexical, hosted answering and semantic indexing scopes independent. No mandatory vector rollout or native desktop/social prerequisite should block otherwise passing backend capability scopes. Preserve actual owner choices, release hold and all sending controls.

No new umbrella architecture ticket is required to address these observed gaps. If native pgvector/storage migration is selected after extension/scale verification, isolate that complete implementation slice with upgrade, real-extension tests, versioned backfill and erasure acceptance; it can parallelize against stable retrieval result contracts. One integration owner keeps shared schema/contracts coherent.
