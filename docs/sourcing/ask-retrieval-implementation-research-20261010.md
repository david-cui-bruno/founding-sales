# Ask retrieval implementation research — 2026-10-10

## Recommendation

Use a model-led Ask interface over a strong, bounded retrieval service: exact CRM state reads plus permission-scoped hybrid search, optional reranking, and conversation expansion. Preserve PostgreSQL as the source of truth. A model choosing tools and an engineered retrieval pipeline are complementary: the model chooses what to investigate; the retrieval service efficiently finds evidence and enforces scope.

This is an architecture recommendation from published research, official documentation and inspected implementations, **not a claim that Callie has achieved their published performance**. We can choose this base without collecting private customer threads or first running a homemade architecture tournament. Product-specific correctness and release checks remain necessary later; they should verify the chosen implementation rather than hold architectural progress hostage to nonexistent sales data.

No providers were called, packages installed, operational controls changed, or production activation attempted for this research. This note does not amend the release hold or sending safeguards.

## Sources and inspection boundaries

Primary sources include actual Onyx and LlamaIndex implementation files, PostgreSQL/pgvector/AWS documentation, BEIR and BRIGHT papers, Microsoft GraphRAG and LightRAG papers/code. GitHub source inspections used these immutable revisions:

- Onyx `ab2e6bbe74d968853c67730040123b3b0878a91a` (2026-10-10).
- LlamaIndex `6dd2f3cdd9ce7ff927ea8d46ccee08875bb00f95` (2026-10-08).
- LightRAG `453dce83d6d0354a06e46c8d4029a0895c4e054b` (2026-09-26).
- pgvector `f37c13f68b57d2c3472b2214fbcff699d6d34876` (2026-10-01).

Documentation pages were read as currently published on October 10; they are mutable. This is code inspection, not deployment verification or a security audit. Local ADR0002/0003/0006/0008 constrain versioned evidence, preserved conversation context, whole-copy deletion and private Ask history. The recommendation fits those decisions.

## Existing implementations

### Onyx: useful reference, expensive wholesale replacement

Onyx supplies a retrieval API rather than requiring an agent to individually search every connector. It supports source, document-set, tag and time filters, query expansion, ranked sections and stable citation identifiers. Expansion and LLM selection are optional paid calls; the search endpoints return evidence without generating an answer. This supports exposing a high-level `search_business_history` tool to Callie's model, with explicit search controls rather than an unconditional chain of extra model calls. [Search API guide](https://docs.onyx.app/developers/guides/search_api_guide)

Inspected code builds ACL and other index filters before retrieval and joins adjacent chunks into sections. Its MCP search rejects unusable source and document-set filters, but malformed `time_cutoff` is caught and dropped. Therefore, do not copy the assumption that every requested filter is honored or fails closed. Callie should reject invalid dates and never widen an identity or authority scope silently. [Pipeline code](https://github.com/onyx-dot-app/onyx/blob/ab2e6bbe74d968853c67730040123b3b0878a91a/backend/onyx/context/search/pipeline.py), [MCP tool code](https://github.com/onyx-dot-app/onyx/blob/ab2e6bbe74d968853c67730040123b3b0878a91a/backend/onyx/mcp_server/tools/search.py)

Its current stack is Next.js, FastAPI, Python workers, PostgreSQL, OpenSearch, Redis, object storage and separate query/index model servers. OpenSearch is tightly integrated; importing the whole system is not a thin library integration. The split between heavy indexing and live queries is useful, but adopting all services is disproportionate before Callie needs that scale. Older Vespa-only descriptions are stale against the current system documentation. [System description](https://docs.onyx.app/security/architecture/system_description)

Document-level access controls and external permission mirroring are Enterprise Edition features. A free open-source install is consequently not equivalent to our existing owner/context authority semantics. [Access controls](https://docs.onyx.app/security/architecture/access_controls)

Onyx's Gmail connector turns a thread into a document with each message as a section, retains creation/update dates, and tags external access with the fetching mailbox. Its pruning path deliberately rejects incomplete/stuck pagination because omission could incorrectly delete unlisted threads. This is practical evidence for conversation-aware ingestion and conservative deletion reconciliation. It does not establish Callie's person/firm context, message Sent proof, or deletion barriers. [Connector code](https://github.com/onyx-dot-app/onyx/blob/ab2e6bbe74d968853c67730040123b3b0878a91a/backend/onyx/connectors/gmail/connector.py)

Official Gmail docs describe ten-minute polling and plain-text support. That is a stated configuration, not a measured synchronization SLA, and not a sufficient reason to replace our acquisition contracts. [Gmail overview](https://docs.onyx.app/admins/connectors/official/gmail/overview)

### LlamaIndex: composable patterns, not mandatory orchestration

AutoMergingRetriever retrieves smaller nodes and replaces enough matching children with their parent context. That supports preserving conversational context after passage-level candidate discovery rather than treating isolated sentences as complete evidence. The documentation example uses the Llama 2 paper, not customer email; it demonstrates an algorithm, not validated business reliability. [Auto-merging documentation](https://developers.llamaindex.ai/python/framework/integrations/retrievers/auto_merging_retriever/), [Implementation](https://github.com/run-llama/llama_index/blob/6dd2f3cdd9ce7ff927ea8d46ccee08875bb00f95/llama-index-core/llama_index/core/retrievers/auto_merging_retriever.py)

QueryFusionRetriever runs several retrievers/query variants, optionally asynchronously, and merges with reciprocal-rank fusion or score-based alternatives. Its default generates extra queries; that is a design choice, not free performance. We can reuse the pattern without requiring a Python framework in Callie's TypeScript worker. [Fusion implementation](https://github.com/run-llama/llama_index/blob/6dd2f3cdd9ce7ff927ea8d46ccee08875bb00f95/llama-index-core/llama_index/core/retrievers/fusion_retriever.py)

Its index API exposes document/node deletion, with docstore deletion an explicit option. Deleting an index entry is not proof that every materialized answer, trace, cache or application copy was erased. Callie's own dependent-evidence invalidation contract remains the integration authority. [Index implementation](https://github.com/run-llama/llama_index/blob/6dd2f3cdd9ce7ff927ea8d46ccee08875bb00f95/llama-index-core/llama_index/core/indices/base.py)

## What published measurements actually support

| Evidence | Actual result or scope | What it does not establish |
| --- | --- | --- |
| Onyx OpenSearch quantization benchmark, October 1, 2026 | 500 questions, 511,958 documents, 1,572,105 chunks. Unquantized hybrid recall@50 79.28%; semantic-only 60.65%. Hybrid native retrieval median 170 ms and p95 269 ms. | End-to-end Ask latency, email quality, model reasoning or Callie hardware performance. Query-embedding network time, reranking and answer generation were excluded. |
| BEIR | Eighteen heterogeneous retrieval datasets; BM25 is a robust baseline, with reranking/late interaction strong average performers at greater compute cost. | A universal best modern model or CRM architecture; this is a 2021 retrieval comparison. |
| BRIGHT | Reasoning-intensive retrieval exposes shortcomings of matching-oriented retrieval; question reasoning can help retrieve relevant documents. | That every Ask query needs an agent loop or knowledge graph. |
| GraphRAG | Global sensemaking over approximately million-token corpora improved comprehensiveness/diversity against naive RAG. | Correct current commitments, speaker attribution, permissions or faster local lookup. |
| LightRAG | Four-domain corpus-level questions, 125 generated questions/domain, GPT-4o-mini comparative judging; graph/vector combination wins many reported comparisons. | Human-labeled sales accuracy or production p95 latency; relative token-cost claims are not end-to-end time measurements. |

Onyx's benchmark scores gold-document coverage in retrieved chunks on the 470 questions with gold IDs. It reused embeddings, used six CPUs/12 GiB and did no LLM judging. The quantization variants did not improve speed; paired hybrid recall intervals included zero. This is useful, unusually concrete evidence for hybrid retrieval at enterprise scale, but **vendor-authored and one configuration**, not an independently established architecture winner. [Pinned benchmark](https://github.com/onyx-dot-app/onyx/blob/ab2e6bbe74d968853c67730040123b3b0878a91a/backend/onyx/document_index/opensearch/QUANTIZATION_BENCHMARK.md)

[BEIR paper](https://arxiv.org/abs/2104.08663), [BRIGHT paper](https://arxiv.org/abs/2407.12883), [GraphRAG paper](https://arxiv.org/abs/2404.16130), [LightRAG paper](https://arxiv.org/html/2410.05779v3).

## PostgreSQL fit and operational caveats

PostgreSQL text search supplies phrase/web-style query parsing, weighting and `ts_rank`/`ts_rank_cd`; those ranking functions are not BM25. Lexical retrieval can stay in the current database, with exact identity/time/current-state queries remaining SQL. Do not advertise existing keyword matching as a completed BM25 engine. [PostgreSQL controls](https://www.postgresql.org/docs/current/textsearch-controls.html)

pgvector explicitly supports combining PostgreSQL full-text results with vector candidates through reciprocal-rank fusion or a cross-encoder. It defaults to exact nearest-neighbor search; approximate indexes trade recall for speed. With approximate indexes, filters apply after index scanning, potentially returning too few eligible records; iterative scans, scoped exact scans or suitable partition/index design address this. Vector similarity must never override authority filters. [Pinned pgvector README](https://github.com/pgvector/pgvector/blob/f37c13f68b57d2c3472b2214fbcff699d6d34876/README.md)

RDS publishes engine-specific extension availability, including pgvector. Actual target-engine/extension versions still need verification before implementation. The extension table does not mean every arbitrary native Postgres extension is installable. [AWS extension table](https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-extensions.html)

ParadeDB offers BM25 and search/aggregation indexes in PostgreSQL. It is worth considering if lexical ranking becomes inadequate, but its native extension/deployment/license requirements must be checked, not assumed compatible with current RDS. Its supplied benchmark harness measures single-query hot/cold SQL latency, not answer correctness or complete agent responsiveness. No numeric ParadeDB-versus-Callie claim is made here. [Project](https://github.com/paradedb/paradedb), [Benchmark methodology](https://github.com/paradedb/paradedb/blob/main/benchmarks/README.md)

## Why not start with a generated knowledge graph

GraphRAG's official query modes separate entity-centered local retrieval from resource-intensive map/reduce over community reports; DRIFT adds community-informed follow-up exploration. This is appropriate when global sensemaking matters, not evidence that basic CRM history needs graph extraction. [Query documentation](https://microsoft.github.io/graphrag/query/overview/)

LightRAG is a relevant advancing implementation, including citations, document deletion with graph regeneration and PostgreSQL storage. Those features are not proof its graph merging preserves our historical person/firm distinctions or revocation semantics. Treat generated graph relationships as rebuildable claims, never replace canonical CRM relationships with inferred entity merges. [Pinned project](https://github.com/HKUDS/LightRAG/tree/453dce83d6d0354a06e46c8d4029a0895c4e054b)

Engineering inference: Callie already has explicit person/firm/opportunity/conversation relations. We can exploit those joins and read chronological evidence now, without paying an LLM to rediscover all of them and creating a second authority/deletion subsystem. Reconsider graph summaries when cross-corpus thematic questions become a meaningful workload.

## Concrete base to build

1. **Canonical acquisition and evidence:** existing versioned message copies, provider IDs, timestamps, direction/Sent proof, contexts and coverage; jobs maintain rebuildable retrieval projections.
2. **Two strong read tools:** `read_crm_state` for exact records/tasks/commitments and `search_business_history` for scoped lexical/semantic evidence. Add a `read_conversation` expansion tool or return appropriately expanded windows from search.
3. **Hybrid candidate discovery:** SQL lexical and dense candidate paths in parallel, same authority/date/context scope, rank fusion; optional bounded reranker. For very small eligible corpora, scoped exact vector search is adequate—ANN tuning is not compulsory.
4. **Evidence preparation:** deduplicate results, expand relevant neighboring messages/threads under a token budget, preserve speaker/time/direction, and disclose capture coverage. A recent thread update is not the same as a promise due date.
5. **Bounded model loop:** let the model investigate further when needed; straightforward selected-conversation questions can answer directly. Do not impose query rewriting, reranking and multiple agents on every request.
6. **Current evidence validation:** check live source revisions/access before publication; deleted source-derived answers/history/actions follow existing ADRs. The retriever/runtime cannot supersede these contracts.

These are proposed interfaces, not newly shipped tools. Hosted embedding/reranking/model calls still require configured purposes and budgets. Existing acquisition, processing, evaluation, activation and release gates remain unchanged.

## Decisions possible now versus verification later

We can now choose PostgreSQL-backed hybrid retrieval with conversation expansion, a small read-tool surface and optional model-directed iteration. We do **not** need private customer conversations to recognize these established patterns or start implementing them.

Later verification answers narrower questions: does our actual query honor owner/context/date filters; can it distinguish drafts/quotes from current sent messages; does deleted evidence remain unavailable; does an answer cite the right speaker/time; and what are actual end-to-end latency/cost under our deployment? Public retrieval corpora and synthetic scenarios can cover broad architecture/behavior checks; a growing set of real approved examples informs business reliability without claiming more evidence than exists.
