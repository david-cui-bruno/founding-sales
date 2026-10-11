# Tool-using model architecture for CRM and Ask

Research date: October 10, 2026. Primary-source reading and local source inspection; no paid model calls, benchmark runs, provider access, activation or issue changes.

## Questions being investigated

1. Which CRM operations are fixed state transitions, and which genuinely benefit from a model choosing its own sequence of reads?
2. Does a bounded Ask tool loop outperform a single model call over selected whole threads or existing lexical passages?
3. Which few tools expose useful business context without forcing the model to reconstruct it from dozens of CRUD endpoints?
4. What belongs in deterministic authorization, source validation and deletion handling rather than model judgment?
5. Does semantic retrieval improve evidence recall enough to justify indexing complexity, cost and deletion obligations?
6. Which outcome-based scenarios reveal incorrect attribution, invented commitments, incomplete evidence and needless tool calls?
7. Which orchestration assumptions can be removed when a stronger model succeeds without them?

## What the primary sources say

Anthropic distinguishes predefined workflows from agents whose models choose tool sequences. It recommends starting with simple implementations; an agent loop is useful where steps cannot be predicted, but adds latency, cost and error opportunities. Retrieval and tools are ordinary model augmentations, not an alternative to reliable application storage. This supports testing model-led investigation for Ask while retaining predictable acquisition and processing workflows. [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)

Tool design affects performance: exposing every existing endpoint is not automatically effective. Anthropic recommends a small set of task-oriented tools, useful bounded responses, clear descriptions and evaluations. Tool errors, redundant calls, token consumption and task latency help diagnose poor interfaces. Multiple correct tool sequences may produce the same valid outcome. [Writing effective tools](https://www.anthropic.com/engineering/writing-tools-for-agents)

Newer models can make old orchestration workarounds unnecessary. Anthropic's managed-agent architecture separates durable sessions, model harnesses and execution tools. Its credential boundary remains structural even as models improve. This is relevant design evidence, not a reason that Callie needs a hosted long-horizon sandbox service. [Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents)

Evaluation can begin with product requirements and manual checks. Anthropic recommends clear reference outcomes, balanced positive/negative cases, isolated trials and outcome grading rather than prescribing one exact call path. Strong models still vary between runs; synthetic evaluations can miss real usage patterns. Real conversations improve external validity but are not prerequisites for constructing useful scenarios. [Demystifying agent evaluations](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)

## What is actually in this repository

Local inspection found PostgreSQL lexical queries using `to_tsvector('simple', ...)` and `websearch_to_tsquery` in `packages/domain/crm/ask.ts` and `askCorpus.ts`. Explicit corpus acquisition produces bounded canonical windows (2,000 characters, maximum 1,000 windows, with byte ceilings), source references and coverage metadata. Results re-resolve canonical references before returning passages. These observations describe source, not provider activation or demonstrated retrieval quality.

ADR 0008 requires current evidence/access validation and explicit human actions. A tool-loop experiment must preserve those contracts. The existing canonical evidence layer is reusable underneath model-facing tools; it does not require a new database.

## Proposed comparison, not a settled implementation change

Compare three baselines on identical scenarios: (A) selected whole-thread context, (B) current lexical retrieval plus one answer call, and (C) a bounded read-only model loop. Candidate tools for C are `search_business_history`, `read_conversation`, `get_relationship_context`, `get_exact_crm_state` and `get_capture_coverage`. These names and interfaces are proposals, not shipped tools.

The model may choose searches and evidence reads. Application code still owns authorization, available scope, current source revisions, limits, deletion, and exact task/opportunity state. No send, enrollment, stage mutation or task creation tools belong in this first experiment. PostgreSQL can remain both durable storage and the implementation behind exact-state/search tools. Tool use and vector search are independent choices.

Grade answer correctness, citation support, attribution, honest coverage, critical failures, tool calls, cost and latency. Include paraphrases, duplicate/quoted text, shared endpoints, tentative offers, explicit promises, corrected dates, contradictory evidence, deleted sources, and instructions embedded inside emails. Keep evaluation labels unavailable to the model and separate development cases from held-out variants.

No hosted model/vector quality result was produced by this research. A successful synthetic comparison would establish scenario-level performance, not a measured production sales reliability percentage. Existing sending safeguards, release hold, evaluation and activation gates remain unchanged.
