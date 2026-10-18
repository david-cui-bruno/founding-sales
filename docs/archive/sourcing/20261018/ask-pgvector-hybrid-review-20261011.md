# Ask: pgvector, hybrid retrieval and the current implementation

October 11, 2026. Research and source inspection only, at local source `a9be6eb05646ff35b22b0ea5a01f15bdabcbab3d`. No provider calls, cloud inspection, spending, migrations, release or activation occurred. Source inspection does not establish production behavior.

## Recommendation

Yes: include PostgreSQL-native semantic retrieval in the architecture review. Prefer hybrid retrieval in the existing database over adding a separate vector database. Removing mandatory AND matching is a query-design change we can make independently of pgvector. A vector extension supplies storage and distance/index operations; an embedding model supplies semantic representations. Neither guarantees good evidence or correct interpretation.

Callie already has a bounded canonical semantic-index foundation and rank fusion. The immediate question is how to complete, evaluate and simplify that foundation, rather than whether to invent vector retrieval from scratch. I recommend an exact-search baseline first, with HNSW contingent on observed query latency and authorized corpus size. The implementation and quality are separate decisions: better standardized distance operations are desirable, while an extra approximate index is not automatically necessary for a small founder CRM.

## What the source already implements

| Path | Inspected behavior | Limitation |
| --- | --- | --- |
| `packages/domain/db/migrations/0095_crm_ask_vectors.sql` / request-local vectors | Numeric `double precision[]` embeddings | Restricted to already admitted request windows; cannot discover omitted sources |
| `packages/domain/db/migrations/0097_crm_ask_canonical_index.sql` | Durable canonical window proofs and numeric vectors, pending/current/stale/deleted states | No `vector` extension/type or ANN index |
| `packages/domain/crm/askCanonicalIndex.ts` | Asynchronous index requests; exact cosine ranking of current indexed windows across eligible source references | Index requests bounded to 100 sources/1,000 windows; search eligibility bounded to 1,000 sources; coverage is partial when appropriate |
| `apps/worker/src/handlers/askIndex.ts` | Registered embedding worker with version/configuration fences, usage receipts, cache reuse and uncertain-attempt protection | Provider correctness and useful semantic recall are not proven by source/controlled checks |
| `apps/worker/src/handlers/askAnswer.ts` (`rankAskHistoryHybrid`) | Query embedding, semantic ranking over `history.eligibleSources`, reciprocal-rank fusion with lexical hits | Requires configured/authorized embedding purpose, adapter and current indexed evidence; otherwise retains lexical behavior |
| `packages/domain/crm/askHistoryInvestigation.ts` | Discovery and lexical search over retained authorized canonical originals; bounded browse preview | Per-source lexical SQL over reconstructed arrays is not a persistent full-text corpus index |

Importantly, canonical semantic search is **not gated on lexical matches being nonempty**. `rankAskHistoryHybrid` passes the eligible history catalog to `searchCanonicalIndex` even when no keyword windows matched. This is different from the request-local vector path, which reranks previously admitted windows. We must preserve this distinction in ticket contracts and evaluation reports.

Existing numeric vectors carry original source version/hash, locator, text hash, context/access closure and model/configuration identities. Search rehydrates and revalidates originals before returning their text. Source invalidation and scoped deletion null the vectors and copied context. Relevant deletion paths: migration0097 source triggers and `packages/domain/retention/deletion.ts`. A new pgvector column, stored lexical document or reranking cache must participate in these same lifecycle contracts.

## AND matching is not a PostgreSQL requirement

Callie's ordinary keyword calls use `websearch_to_tsquery('simple', query)`. PostgreSQL turns unquoted words into AND terms, recognizes explicit OR, and supports phrase/negation syntax. `to_tsquery` also supports explicit boolean combinations. Thus “what did Shirley offer to help with” is a poor literal default, whereas selecting useful terms or OR alternatives is possible without vectors. English text configuration additionally normalizes words and drops configured stop words; `simple` is a different lexical choice. GIN is PostgreSQL's preferred text-search index. [Query parsing and ranking](https://www.postgresql.org/docs/17/textsearch-controls.html), [full-text indexes](https://www.postgresql.org/docs/17/textsearch-indexes.html).

Proposal: expose a relevance-oriented search interface that owns normalization, bounded alternatives and hybrid ranking, rather than requiring the answering model to manufacture exact query syntax. Keep explicit phrase/name/email retrieval available. Do not replace every query with broad OR: that may recover more evidence while admitting distracting material. This is an implementation recommendation, not measured relevance improvement.

## What pgvector changes

pgvector supports exact and approximate distance search. Exact search preserves nearest-neighbor recall; this means recall relative to the supplied vectors, not perfect relevance. HNSW trades recall for speed, uses more memory and builds more slowly than IVFFlat; it needs no training phase. Filter-column indexes can support efficient exact search. ANN filtering occurs after scanning and can return too few allowed matches; iterative scans mitigate underfilling within limits. Shared tenant indexes can affect other tenants' recall and speed. The project recommends full-text hybrid retrieval with rank fusion or a cross-encoder. [Official pgvector README](https://github.com/pgvector/pgvector#readme).

Those mechanics do not make SQL authorization optional. For Callie, apply workspace, actor, source type/relationship/date, state and model/version constraints in database candidate retrieval, then revalidate current original access before returning text. Never retrieve unauthorized text to the model and “filter later.” If ANN is added, measure relevance and candidate underfilling after real restrictive filters, not just unfiltered nearest-neighbor throughput.

## Proportional proposed design

1. Retain exact SQL state reads for identities, opportunities and explicit status. Use retrieval for communication evidence; vector similarity must not infer an authoritative opportunity stage or commitment.
2. Retain bounded direct context for a user's selected small conversation. An available source should not require multiple search turns to rediscover it.
3. Reuse the canonical asynchronous index lifecycle. Configure one versioned embedding model/dimension and purpose; make index coverage/lag visible. Reindex or mark incompatible embeddings stale when model, chunker or relevant access/context changes. Never combine embeddings from incompatible models merely because dimensions match.
4. Run lexical and semantic candidate retrieval independently within the same authorized corpus, combine candidate rankings, deduplicate canonical windows, and add bounded neighboring context before answering. A unified search tool can reduce model turns without expanding source or spending authority.
5. Use native exact vector distance initially. Keep an indexed filter on owner/workspace/current configuration. Add HNSW only after an exact baseline reveals an actual latency problem; compare against exact nearest-neighbor results and labeled evidence recall.
6. Consider reranking only if labeled candidate analysis shows it solves a real ordering/noise problem. It adds latency and processing/spend scope, not free quality.

This proposal preserves the PostgreSQL/jobs/AI SDK architecture. It may require a reviewed schema/index contract amendment and retrieval-version change; it is not authorization to deploy, embed business Gmail or lift the release hold.

## Deployment and testing constraints

Inspected infrastructure declares PostgreSQL16 (`infra/modules/database/main.tf`); CI service databases use `postgres:16`. The current embedded PostgreSQL/local acceptance setup does not establish pgvector availability. A migration depending on the extension must be tested with actual extension-enabled service images and actual deployed-baseline upgrades. We should not silently skip vector tests when an extension is absent.

AWS publishes a PostgreSQL-engine-specific pgvector support matrix, including releases that provide0.8.x. This is a compatibility reference, **not evidence of the installed or available version in Callie's production database**. Verify actual engine minor version, `pg_available_extensions`, `pg_extension` and installation role privileges before a release proposal. [AWS RDS extension versions](https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-extensions.html).

Adding durable lexical data creates another sensitive derived copy. Include physical redaction and stale-source exclusion for its text/lexemes, vectors, neighbors and reranking caches. Query vectors and financial audit history have different retention purposes; do not conflate copied content cleanup with immutable usage conservation.

## Decisions and evidence still needed

Compare current lexical, improved lexical, exact semantic and hybrid candidates on the same reviewed labels. Include paraphrases with no shared terms, exact names/addresses, current versus old quoted promises, offers versus commitments, conflicting sources, wrong firms/owners, deletion and incomplete coverage. Measure supporting-passage recall at a fixed candidate count, distractor rate, citation support, final usefulness, latency and cost separately.

Also measure asynchronous indexing coverage/lag and missing-index fallback, and preserve tests for cancellation, source changes during waits, purpose/model changes and uncertain provider acceptance. A stronger answering model should be tested with known correct evidence to isolate model interpretation from retrieval misses. None of these vector relevance/latency results has been measured in this review. Synthetic cases can expose integration defects; they do not establish representative customer performance.

No ADR change is necessary merely to research pgvector: the bounded hybrid direction is compatible with the approved existing-stack approach. New embedding processing, backfill and paid evaluation still need their applicable explicit owner scope and allowance; sending and release protections remain independent.
