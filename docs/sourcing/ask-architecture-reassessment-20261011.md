# Ask architecture reassessment — October 11, 2026

Research and implementation inspection, not a deployment, activation, model comparison or paid evaluation. Root integration owner; independent primary-source reviews are linked below. Production release hold and all sending controls remain unchanged. No new provider calls occurred during this research.

## Conclusion

Retain the existing stack, PostgreSQL jobs/state, canonical source access and AI SDK provider adapter. Improve the Ask retrieval and execution implementation before judging a model from the failed integration run. A three-generation synthetic allowance is not an empirically justified product default. Establish useful answers with a sufficiently capable model and evidence access, then optimize cost. A wholesale framework/database rewrite is not supported by the observed failures or this literature.

This is a design recommendation, not evidence that the repairs pass actual model quality. Product latency/cost preferences are being asked separately. No researched model is activated or approved for paid calls by this document.

## What our evidence actually says

The last completed actual run used source6e13/schema104, Bedrock Haiku4.5 and the same independently reviewed synthetic expectations. Six Ask cases produced three step-bound and three unsupported-answer outcomes. Their answer field is null; transport and legal tools did execute. Structural validity, source retrieval and semantic correctness were not measured independently in that end-to-end failure rate. Four extraction cases were separate: three structurally accepted, one invalid format, with offer/current-versus-historical semantic errors retained.

The observed searches included `commitment deadline promised` and `commit will deliver provide complete`. Our keyword tool treats unquoted terms as AND requirements. These query strings can exclude originals that actually support the question. More iterations or a stronger model alone does not repair an impoverished retrieval interface. Original business-wide Ask started with no source windows; source candidates had to be discovered through guessed keywords. The new merged source adds bounded browse previews, correct business-native acquisition visibility, SDK structured output and remaining-step guidance. Their actual model usefulness remains untested.

Evidence: `.context/full-roadmap-execution-20261011/final-schema104-synthetic-assessment.json`, completed run `.context/synthetic-acceptance-8661b04a-a2d6-435a-9e69-a280338456c8/`, merged [PR582](https://github.com/david-cui-bruno/founding-sales/pull/582). Current relevant implementations: [worker loop](../../apps/worker/src/handlers/askAnswer.ts), [SDK adapter](../../apps/worker/src/providers/askAgentSdk.ts), [configuration](../../packages/domain/crm/capabilityStartup.ts).

## Why three steps is not a general architecture requirement

The evaluation manifest chose `maxAskSteps:3`, `maxAskOutputTokens:1000`, a60-second deadline and a total25-step/$1 allowance. One model generation consumes one step; multiple independent tools may be requested in the same generation. A final answer also consumes a generation. Record resolution → search → context read → final answer therefore needs four generations if performed sequentially. The earlier run had no last-generation guidance. The latest merged adapter provides it, but forced abstention at an early cap is not an answer-quality solution.

The runtime and configuration accept1–32steps; `stepCountIs(1)` inside the SDK intentionally makes a single accounted generation per host iteration. It does not limit the complete request to one step. The host owns each paid attempt and checks current source/consent/cancellation across waits. Public current [AI SDK loop docs](https://ai-sdk.dev/docs/agents/loop-control) describe configurable limits and custom host-managed loops. Their latest defaults/names must not be assumed to apply to our pinned installed version. There is no researched universal optimal turn count.

Recommendation: a total monetary/token/time cap plus a larger, empirically checked generation ceiling; reserve a final generation inside that ceiling. Finish early on a supported answer or clear evidence absence. Detect repeated ineffective queries and report partial coverage. A proposed6–8generation diagnostic is a test setting, not measured sufficiency. All model output, repair and finalization calls must count; do not copy an upstream extra-summary call outside our allowance. No existing approved allowance is expanded or reused.

## Architecture to carry forward

Use a single readonly investigator with three useful paths behind one product interface:

1. Exact current CRM questions use existing authorized SQL reads. The model may interpret the question, but it does not derive current state from conversation prose.
2. Questions about an explicitly selected small conversation receive enough authorized original context directly. Avoid making the model search for a source the user already selected. Dates, speakers, quoted ranges, coverage and source IDs accompany the text.
3. Broad or ambiguous questions use evidence discovery and progressive context reads. Start with scoped previews or relevant context; use lexical and, when configured/evaluated, semantic retrieval. Return canonical references and enough surrounding evidence to answer, then let the model investigate further when needed.

A deeper retrieval module should hide normalization, multi-query/rank fusion, deduplication, current-access filters and context expansion behind a small interface. Preserve separate canonical-source reads for further investigation. Server-owned scope, provenance, budgets and deletion remain outside model discretion. Do not expose arbitrary SQL, Gmail acquisition, sending or record mutations through Ask.

Keep embeddings as a separately configured implementation at an existing seam, not a new database mandate. Better vectors cannot find uncaptured sources, establish an individual author from a shared endpoint, or prove a current commitment. Prefer deterministic envelope/time context before model-generated index augmentations. Retain honest lexical-only/partial fallback and deletion of derived copies/vectors.

These are proposals to reconcile with #551 and existing source contracts, not instructions to silently replace their implementation. They preserve ADR0008 private source/action behavior and the approved lean owner/activation amendments.

## What literature supports, and what it does not

[ReAct](https://arxiv.org/abs/2210.03629) supports iterative observation-driven tool use on its studied tasks; it does not establish a turn count, CRM correctness or permission design. [A-RAG](https://arxiv.org/abs/2602.03442) exposes keyword search, semantic search and chunk reads and studies model/compute scaling on open-domain QA. This supports useful hierarchical tools, not importing its benchmarks as Callie results.

[LongMemEval](https://arxiv.org/abs/2410.10813) evaluates extraction, cross-session reasoning, temporal reasoning, updates and abstention with500questions. Its indexing/retrieval/reading decomposition is a better model for our research questions than coding scores. User-assistant histories still differ from email forwards, shared addresses, opportunities and deletion.

[Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval) reports benefits from contextual lexical/vector retrieval and reranking on the author's datasets; its results are not a mandate for all three additions or a measured gain here. [Lost in the Middle](https://arxiv.org/abs/2307.03172) demonstrates context-position sensitivity in studied models, so a long context window alone does not prove reliable whole-corpus answers. [Searching for Best Practices in RAG](https://arxiv.org/abs/2407.01219) studies combinations and efficiency tradeoffs rather than a universal best stack.

[CRAG](https://arxiv.org/abs/2401.15884) evaluates retrieval quality and corrective actions; its external web-search expansion does not transfer to questions about our private CRM evidence. [Self-RAG](https://arxiv.org/abs/2310.11511) uses a specifically trained reflective model; adding a generic “check your answer” prompt is not implementing or reproducing it.

[Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) recommends starting simply and adding orchestration when warranted. [Writing effective tools](https://www.anthropic.com/engineering/writing-tools-for-agents) makes tool design and task-driven evaluation central. Neither supports more frameworks as the first repair for our observed discovery/output failures.

## Questions to settle before more implementation or paid tests

| Question | Evidence needed / recommendation |
| --- | --- |
| Can the answer model interpret the evidence correctly when it is supplied? | Give the same frozen gold originals to each candidate; score current vs historical, offer vs commitment, attribution, ambiguity and useful partial answers. This isolates reading from search. |
| Can retrieval find the required originals? | Measure required-source recall and noise without an answer model. Separate selected-context, keyword, preview and proposed hybrid results. |
| Does the agent investigate efficiently? | Report model generations, tool batches, repeated queries, admitted sources/windows, stop reasons and actual latency/usage. Vary one setting at a time. |
| Are failures structure or meaning? | Record invalid output/schema, unknown citation, stale/access refusal, unsupported meaning and insufficient coverage separately. A valid citation ID is not entailment. |
| Is Haiku an adequate default? | Compare with a verified stronger same-host candidate using identical context/tools and sufficient bounded turns. Do not use the old three-step integration failure to rank models. |
| How fast/expensive should Ask be? | Owner preference plus observed p50/p95 latency and actual billed token rates. Correctness-first is a proposal while preference is pending. |
| Does Ask preserve usefulness on partial evidence? | Supported partial statements plus explicit coverage gaps; do not turn every uncertainty into total unavailability or accept a definitive negative from empty search. |
| What requires real customer threads? | Representative production claims, not transport debugging or initial synthetic development. Public conversational benchmarks inform design; domain synthetic cases still test our implementation. |

The next comparison should have separately frozen source/labels/model/endpoint/step/output/token/financial ceilings. The existing pending3-step Haiku-only proposal is a repair verification, not a model-selection or architectural comparison. Do not run it as though it answers these broader questions. Repeated development labels remain development evidence; preserve untouched held-out expectations.

## Current model catalog refresh

Official AWS cards now list [Haiku5.5](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-5-5.html) and [Sonnet5.5](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5-5.html), launched October7 and September28 respectively. They are comparison candidates, not verified account routes or quality. Both document adaptive thinking defaults; explicitly pin its policy and include all billed thinking in bounds. The cards mark native structured outputs unsupported, so verify our output-tool transport rather than assuming native JSON grammar support. The model companion report records exact IDs, lifecycle, first-party prices and remaining access/SDK uncertainty.

## PostgreSQL vector-search follow-up

The follow-up user question specifically asks whether pgvector can remove dependence on AND retrieval. Yes, semantic discovery is worth pursuing; the storage extension and retrieval semantics are separate choices. PostgreSQL [websearch_to_tsquery](https://www.postgresql.org/docs/current/textsearch-controls.html) already accepts OR and phrase syntax. We can improve lexical candidate recall without installing an extension. An embedding model makes text into semantic vectors; [pgvector](https://github.com/pgvector/pgvector) stores/compares them and supports exact or approximate search. It does not create useful embeddings by itself or validate the meaning of a claim.

Current merged source already has two distinct vector foundations: request-local arrays (migration0095), and asynchronous canonical corpus windows/jobs (migration0097, domain askCanonicalIndex and worker askIndex). Broad-history hybrid retrieval searches the canonical index over eligible authorized sources, then fuses rankings with lexical matches. It is not restricted to lexical matches. These foundations were not enabled in the failed synthetic evaluation, which had no embedding allowance; quality/latency remain unmeasured.

Recommend scoped PostgreSQL full-text plus semantic candidates, with exact endpoint/name/phrase handling, fused ranks and bounded context expansion. For a small initial authorized corpus, exact vector distance is a simpler correctness baseline than tuning HNSW. Introduce approximate indexes when observed volume/latency warrants them; [pgvector filtering guidance](https://github.com/pgvector/pgvector#filtering) explains why approximate filtering can underfill authorized results. Preserve source/context revisions, configuration/dimensions and derived-content erasure. Reuse existing indexing jobs rather than introducing another synchronization system.

[The focused pgvector report](ask-pgvector-hybrid-review-20261011.md) covers candidate storage, RDS/CI support and proportional evaluation. No extension was installed, production queried for extension state, embedding funded or feature enabled in this research.

## Skills and next work

Research now; codebase-design for the retrieval/agent module interface after the evidence review; targeted contract/spec reconciliation next; TDD for agreed observable behavior. Diagnose retained traces before paid retries. No further broad codebase clean or generic retro is necessary before addressing these specific failures. Model and open-source implementation details are captured in the companion reports.

- [Open-source architecture review](ask-open-source-architecture-review-20261011.md)
- [Model and evaluation review](ask-model-and-evaluation-review-20261011.md)
