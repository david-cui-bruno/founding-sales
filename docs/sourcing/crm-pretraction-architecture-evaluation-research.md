# CRM architecture and evaluation before traction

Research date: October 10, 2026. Source inspected at `2c78dd8e30f588985570ad07b099751c6a011342`. This note reassesses proportionality after David reported that Shirley is the only prospect conversation and insufficient real customer material is available. It makes recommendations, not policy amendments, runtime verification, evaluation results or activation decisions. No private mailbox, provider, infrastructure or credentials were accessed.

## Findings

The existing stack remains a reasonable direction. PostgreSQL, the existing durable job queue, versioned evidence, separate human decisions and SQL/keyword retrieval fit a small CRM. There is no measured reason to replace them with a vector service, workflow platform, fine-tuning pipeline or agent architecture. The main overengineering risk is imposing broad AI acceptance and operational ceremony before there is enough founder-sales activity to learn from, rather than choosing the wrong database.

That conclusion is engineering judgment grounded in the implementation, not a benchmark: [Ask](../../packages/domain/crm/ask.ts) already routes exact state to bounded server-defined operations and lexical passage queries; [processing](../../packages/domain/crm/processing.ts) keys work by source/context/configuration and enqueues existing jobs; [job store](../../packages/domain/jobs/jobStore.ts) already provides idempotency, database-time leases and fencing. Existing controls should be reused rather than replaced.

## Why conversations were requested

Three uses must stay distinct:

| Use | Why data is needed | What a small corpus can establish |
| --- | --- | --- |
| Normal product input | A CRM needs actual communications to display history, observed replies and commitments | Correct tracking of those particular communications |
| Evaluation | Labeled examples check attribution, quotations, commitment interpretation, retrieval, citations and abstention | Case-specific behavior; a growing regression suite |
| Model training | Fine-tuning would change model weights | Not required by the approved architecture or current plan |

The request was for evaluation inputs, **not a prerequisite training dataset**. Runtime retrieval supplies selected evidence to a pretrained model. More history makes Ask more useful; an empty history should yield explicit limited coverage rather than invented facts. Real examples are valuable because they reveal actual quoting, signatures, ambiguous requests and business phrasing. That does not mean the founder must produce nonexistent conversations or connect a personal inbox.

OpenAI recommends choosing evaluation data according to the objective, mixing synthetic, expert-curated, historical and production material, then adding observed failures over time. It warns against datasets that misrepresent production usage. This supports starting with what exists and recording missing evidence; it does not establish a universal mandatory corpus size. [OpenAI evaluation guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices).

Anthropic recommends starting early with a small set of roughly 20–50 tasks and existing manual checks, refining clear expected outcomes and adding real failures. Those are **tasks, not distinct customer conversations**. One conversation can yield several cases, but correlated cases must not be advertised as independent evidence. [Anthropic evaluation guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).

The local #548 package allocates **30 cases**, currently 12 synthetic development examples, eight real development slots and ten unselected holdout slots. It does not require 30 customers or 30 threads, but its proposed sales-heavy real holdout is presently unavailable. Neither filling missing slots with support mail nor generating more synthetic text establishes representative founder-sales quality. The allocation and ≥95% target are local approved decisions, not vendor prerequisites; changing them requires an explicit acceptance-spec revision. See `.context/crm-acceptance/evaluation/README.md` and [#548](https://github.com/david-cui-bruno/founding-sales/issues/548).

## Retrieval can start simpler

PostgreSQL provides native full-text indexing, normalization and query operations. These support an inexpensive lexical baseline without another datastore. They do not establish semantic recall or implement BM25 by default. [PostgreSQL text-search documentation](https://www.postgresql.org/docs/current/textsearch-intro.html).

For a small, selected thread, a bounded prompt containing its authorized full conversation can be a useful baseline before chunk retrieval or embeddings. Anthropic explicitly describes whole-corpus prompting for small corpora; its historical 200,000-token example is not a universal current context, cost or accuracy guarantee. In Callie, limits must bind actual model capacity, cost, permission and source validity; never include all personal mail merely because it fits. [Anthropic contextual retrieval](https://www.anthropic.com/engineering/contextual-retrieval).

When actual questions expose lexical paraphrase misses, test vectors against the same frozen sources and questions. pgvector supports exact nearest-neighbor search inside PostgreSQL and combination with full-text search. Approximate indexes trade some recall for speed; they are not necessary merely to run an embedding experiment. Its exact-vector recall refers to the defined distance search, not semantic correctness. [pgvector implementation documentation](https://github.com/pgvector/pgvector).

Recommendation: SQL for exact records/state → timelines and lexical search → selected full-thread cited answers → vectors only after measured retrieval misses justify them. Retaining a disabled bounded hybrid prototype preserves the approved architecture; it need not become the first activated feature.

The whole-thread baseline is a proposed comparison, not a description of shipped answer behavior. Current [answer input preparation](../../packages/domain/crm/askAnswerInput.ts) performs a canonical corpus census, lexical matching, bounded grouping and selected windows; it has no automatic vector dependency. Lexical filtering can omit relevant passages whose phrasing lacks the query terms, so compare full selected-thread context before assuming embeddings are the necessary fix.

## Integration complexity is separate

Reliable Gmail ingestion genuinely requires initial purpose-bounded synchronization, subsequent history-based updates and recovery when a cursor expires. Google recommends fetching the messages necessary for the application's purpose and performing full synchronization when history is unavailable; a 404 on an expired history cursor is a real recovery path. These requirements exist even with one thread. They are different from requiring many customer conversations. [Google synchronization guide](https://developers.google.com/workspace/gmail/api/guides/sync).

The dedicated OAuth project, isolated deployment, canonical grants, protected operations and teardown flows are consequences of Callie's current acceptance/release decisions. They are not proof that CRM generally requires this much setup or that vectors require such infrastructure. [ADR0009](../adr/0009-separate-capability-authority-from-settings.md) separates configuration from capability authority; [ADR0010](../adr/0010-isolate-acquisition-acceptance-from-activation.md) requires isolated provider acceptance. Those decisions currently govern this repository and must remain visible if reconsidered. This research does not bypass them or authorize a different mailbox.

## Proportionate proposal

1. Verify acquisition/deletion and deterministic permissions with controlled tests plus the separately approved Shirley provider diagnostic. Shirley diagnostic copies remain excluded from ordinary CRM, AI and Ask.
2. Continue useful deterministic CRM functions: people/firms, explicit opportunities, actual communication history, exact reply observations, manual follow-ups, coverage and lexical Ask. Capability-specific release and acquisition gates still apply.
3. Use synthetic scenario tests for ambiguous commitments, wrong identity, conflicting evidence, injected instructions and deletion races. Label them synthetic; do not report real-world sales accuracy from them.
4. Reframe unavailable representative evaluation as **pending evidence**, not a blocker on all engineering. If David wants to use AI sooner, propose a separately specified experimental, human-reviewed scope with limited claims and its own authority/budget/release checks. Do not activate automatically from this recommendation.
5. Add genuine business cases as they arise, score each against a human reference and grow a regression suite. Broad autonomous progress/task creation and broad semantic-answer quality remain unproven until relevant evidence exists. Personal-email material is optional, not an obligation.

In particular, thirty scenario passes do not establish a reliable population-level 95% rate: class denominators may be much smaller, cases may share a thread and selection may be unrepresentative. Report actual counts, missed events and limitations rather than manufacture statistical certainty. The architecture can be sound while real model quality and product value remain unmeasured.

## What remains unchanged

No code, issues, ADRs, acceptance gates, release controls or sending settings were changed. Source completion does not establish live capture, real vector/model quality or activation. The release hold, cap five, routine replies off, automatic admission off and separate outreach permissions remain in force.
