# Ask answer construction: primary-source research

Research date: October 12, 2026. Scope: read-only web research for #551. No paid model calls, dependency changes, production changes or activation. This report separates published evidence from design recommendations; the repository audit and local evaluation artifacts must establish what Callie actually does.

## Decision supported by the research

Keep the existing bounded tool loop and strict final-answer interface as the comparison baseline. Review the meaning and amount of context supplied to the model before changing models or adding another framework. A schema controls shape; it does not establish that a sentence is supported, that a note is a direct communication, or that missing CRM records prove no commitment exists. No reviewed source establishes a universally best CRM Q&A architecture or that replacing a final tool with prose will fix our failures.

The strongest immediate design question is whether the host can provide a small, explicit evidence packet that separates observed CRM state, source reports, and acquisition coverage, allowing the model to summarize rather than reconstruct those distinctions from overlapping fields and instructions. This is a recommendation to test, not an externally proven implementation.

## What the three output approaches actually change

| Approach | Application contract | Main tradeoff for Callie |
| --- | --- | --- |
| Tools followed by free-text final answer | Tools retrieve authorized data; the last generation produces readable text. Citation markers or provider citation blocks need a separate rendering/publication contract. | Gives prose freedom but does not guarantee claim-level citation shape. Introducing a second model to extract claims adds another interpretation boundary. |
| Tools followed by strict `emit_answer` | The terminal tool supplies structured claims and references that the host validates before publication. | One machine-readable publication boundary; schema-valid strings can still be unfinished or unsupported. Keep prose fields simple and avoid asking the model to compute authority. |
| Tools followed by provider-native structured output | The provider constrains a JSON response independently of action-tool definitions; the SDK validates its shape. | A distinct provider path with distinct compatibility limits. It is not a drop-in semantic repair for a strict final tool. |

AI SDK documents both normal text generation after a tool result and combining tools with structured output. Its multi-step API exposes stopping conditions and intermediate steps; output generation needs an available final step. These are supported patterns, not comparative quality evidence. Current documentation uses newer examples and helper names, so root must verify behavior against Callie's pinned versions before adopting examples. [AI SDK tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling), [AI SDK structured data](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data).

AWS explicitly distinguishes Converse `outputConfig.textFormat` from tool definitions with `strict: true`. Grammar compilation and the supported schema subset apply to these paths; notably string length and numeric constraints are unsupported in the documented provider schema subset. Local application validation therefore remains necessary even when a provider enforces structural conformance. AWS's page is living documentation, consulted October 12; model/profile support must be verified separately. [AWS structured outputs](https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html).

Anthropic documents JSON output and strict tool use as complementary interfaces. It also documents schema-complexity limits and additional prompt-token cost. This supports treating schema size as part of the context and latency budget, but does not demonstrate that Callie's specific schema causes its interpretation errors. Shape compliance is not an empirical measure of evidence support or useful prose. [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).

## Important platform-specific finding

AI SDK maintainer PR #20128, dated September 1, 2026, separates Bedrock native structured-output support from strict-tool support. Its stated failures are Sonnet 4.6 native JSON degeneration with complex schemas and Haiku 4.5 native-format rejection depending on account. It defaults those models to a JSON-tool fallback under automatic structured-output mode **while preserving strict tools**. The PR discusses different version backports, including a v5 interface that does not expose strict definitions. It supports avoiding an unsupported assumption that native JSON will fix our strict-tool answer. It does not prove the same failure occurs in Callie's pinned adapter or justify an upgrade without checking source and requests. [AI SDK PR #20128](https://github.com/vercel/ai/pull/20128).

## Citation validity, claim support and coverage are separate

Anthropic's citation API returns pointers to provided document content and extracts cited text. It describes valid document pointers and improved citation relevance in its evaluations. Titles/context metadata are not themselves citable document content. Its compatibility guidance explicitly rejects combining document citations with native JSON output format. AWS more broadly lists Anthropic citations as incompatible with structured outputs; do not infer compatibility of every strict-tool/document combination from the narrower direct-API description. The current documentation includes models beyond our Sonnet 4.6 deployment. [Anthropic citations](https://platform.claude.com/docs/en/build-with-claude/citations), [AWS compatibility](https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html).

**Design inference:** A valid pointer proves where text came from, not that the text entails the answer. A source saying “the inbox was checked through Tuesday” supports a report that someone said this; it does not establish Callie's acquisition cursor or channel coverage. Similarly, a query returning no commitment rows establishes the query's result under its scope, not the absence of promises in all communications. A citation system cannot substitute for host-owned scope, identity, freshness, deletion and coverage facts.

The ALCE paper evaluates fluency, correctness and citation quality separately. Its 2023 retrieval-and-generation experiments found incomplete citation support even in the best evaluated systems. This is evidence to evaluate support independently from readable prose and citation presence. It is **not** a contemporary Sonnet 4.6 error-rate estimate, a CRM benchmark or proof that any one citation API resolves attribution. [Gao et al., EMNLP 2023](https://aclanthology.org/2023.emnlp-main.398/).

## Context and tool design: research relevant to our failures

Anthropic's September 29, 2025 context-engineering guidance recommends high-signal context, clear instructions, minimal non-overlapping tools, and a few diverse canonical examples instead of a growing edge-case list. It distinguishes upfront retrieval from on-demand agentic search and describes their latency tradeoff. Its “simplest thing that works” guidance supports auditing what the model sees, not adding autonomous orchestration by default. This is first-party engineering guidance rather than a controlled comparison of CRM answer architectures. [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).

Anthropic's September 11, 2025 tool-design article recommends tools tailored to meaningful workflows, related metadata in tool results, unambiguous descriptions and bounded relevant output. It reports internal held-out evaluations and recommends reviewing raw transcripts, token consumption, redundant calls and tool errors. The transferable lesson is that a tool's return contract matters as much as its name. Its examples do not prove that consolidating every CRM read into one large tool is optimal. [Writing effective tools](https://www.anthropic.com/engineering/writing-tools-for-agents).

**Empirical evidence beyond vendor guidance:** Kate et al., EACL March 2026, studied 1,298 questions over real API JSON responses and 15 models, including Claude-4-Sonnet and GPT-4o, not Sonnet 4.6. Responses averaged roughly 24,000–74,000 characters. Longer responses degraded performance; strategy depended on question type. Code-based processing generally improved filtering/aggregation, while direct answer generation often performed better for extracting one value. Adding response-schema information sometimes helped. This supports doing exact filtering/counting in host tools and presenting concise results; it does **not** justify arbitrary code execution or assume our much smaller evidence packet exhibits their rates. [How Good Are LLMs at Processing Tool Outputs?](https://aclanthology.org/2026.eacl-long.134/), [paper and experimental setup](https://aclanthology.org/2026.eacl-long.134.pdf).

Liu et al.'s 2023/2024 long-context research varied evidence position in multi-document QA and key-value retrieval and measured position-sensitive performance. It supports checking relevant-evidence placement rather than assuming a large context window is enough. The tested models and tasks differ from ours; it does not diagnose our short prompts. [Lost in the Middle](https://arxiv.org/abs/2307.03172).

## Does output format or model capacity explain the problem?

Tam et al.'s August 2024 study reports task-dependent effects of format restrictions on reasoning and classification. It is a reason to test burden rather than assume format is neutral; it is not evidence that all constrained generation harms quality or that our Bedrock strict-tool path behaves like their JSON-mode experiments. [Let Me Speak Freely?](https://arxiv.org/abs/2408.02442).

JSONSchemaBench (January 2025 initial release) explicitly separates constraint coverage, generation efficiency and quality when assessing constrained decoding frameworks. It evaluates frameworks and schema workloads, not Callie's current service/model. This strengthens the case for measuring those axes separately instead of calling schema acceptance “quality.” [JSONSchemaBench](https://arxiv.org/abs/2501.10868).

Anthropic's December 19, 2024 architecture guidance recommends simple solutions first and recognizes that agents add cost/latency while workflows offer predictability. It notes that retrieval plus one generation can suffice for many tasks. This makes a bounded retrieval-and-summary design legitimate; it neither mandates one-shot retrieval nor proves a stronger model is unnecessary for every question. [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents).

**Model-change criterion (our recommendation):** First show that an answer fails with sufficient, concise, correctly typed context and a reasonable output allowance. Then compare a candidate model using the same frozen evidence and publication contract, with repeated cases, held-out variants, cost and latency recorded. Choose a more capable model only if it materially improves the actual failure categories within the spending/product budget. Consider a cheaper model only after correctness is adequate. Marketing benchmarks or model size alone cannot settle this. The current research establishes neither Sonnet 4.6 inadequacy nor the superiority of an alternative.

## Concrete audit questions before another implementation

1. What information reaches the model twice or under different names? Can the host issue one canonical source record with an evidence reference, source type, actual observed speaker/time when known, and explicit unknowns?
2. Which answers require exact CRM state, which require interpretation of a source, and which require acquisition coverage? Can the host return those as clearly separate result types rather than prose warnings repeated across prompt/tool/schema?
3. Can `get_context` or equivalent supply a small relevant packet for common questions, with search/read tools available only when necessary? Preserve original source access; do not replace evidence with an unverified model summary.
4. Is there a final generation allowance after investigation? Do full request size and actual output usage indicate a real limit problem, rather than merely suggesting one?
5. What does the final schema genuinely need for product behavior? Keep claim text and citation references; reassess redundant labels that ask the model to certify authority or repeat source text. A schema change requires a reviewed migration/publication contract.
6. Can absence statements include their actual query scope? Can coverage be presented from host-owned acquisition/processing records outside model-composed claims?
7. Does every interpreted promise cite the exact source supporting the promise? Does the final output preserve uncertainty and opportunity ambiguity without turning them into definitive assertions?

## Recommended next work and verification

Use codebase-design to audit one end-to-end ordinary request: question, selected records, each tool result, final native output, host validation and rendered answer. Propose one simpler context/publication boundary and retain the existing implementation as baseline. Do not pile further prose prohibitions onto the prompt without identifying a specific ambiguity.

Test any design change through the ordinary authenticated read/worker path with disposable PostgreSQL and fake model adapters for host contracts. Quality evaluation needs actual model outputs; deterministic tests cannot certify semantic entailment. Separate structural success, citation validity, claim support, readability and usefulness. Review failures against exact evidence, not only an aggregate score. Add held-out variants to the existing familiar six cases so improvements do not merely encode their wording.

Do not run a broad cross-model tournament, switch to provider-native JSON, add an embedding store or introduce another agent framework solely because the present six-case score is disappointing. If the audit reveals missing evidence retrieval, investigate retrieval; if sufficient evidence remains misinterpreted under a clean contract, a controlled model comparison becomes justified. These are diagnosis branches, not new activation authority.

All proposals remain source/evaluation work. Preserve release hold, approved spending conservation, deletion/permission boundaries and sending safeguards. Synthetic findings cannot establish representative customer quality or authorize outreach.

## Research limits

This report reads current official documentation, one first-party SDK fix and primary papers. Living documentation was consulted October 12, 2026 and may describe capabilities newer than pinned source or available AWS account profiles. No new model was tested, no existing six-case outputs were independently rescored here, and no conclusion is a production readiness claim. Local findings supplied in the research assignment should be linked and verified by the integration owner before this report is used as a roadmap decision.

## Repository audit: what the model actually receives

Audited source `249781d0b36d1325874d242ddbddcd396cbbd887`, including the pending PR587 correction; no source implementation changed during this research. The actual evaluation capture was produced by source1799807b before the later narrow host draft refusal. The current code keeps one host-owned registered-worker loop and one billed SDK generation per runStep. Host code validates and executes readonly tools, reserves/settles each dispatch, checks current source access and publishes a candidate with host-validated references. The SDK does not own a recursive tool loop. [Worker](../../apps/worker/src/handlers/askAnswer.ts), [SDK adapter](../../apps/worker/src/providers/askAgentSdk.ts), [model projection](../../apps/worker/src/providers/askModelEvidence.ts).

In the latest ordinary run, all six final emissions occurred before the last allowed generation and therefore saw the full menu of seven readonly tools plus emit_answer with required/any tool choice. A terminal-only menu exists for remainingSteps=1, but none of the thirteen captured requests reached it. Current model policy already permits six generations in this frozen run; the failures cannot be attributed to the obsolete three-generation cap.

The request-size audit used compact JSON UTF-8 serialization, not a token estimate or HTTP wire measurement:

| Measured field | Bytes or observed tokens |
| --- | ---: |
| System instructions | 2,787 bytes |
| Tool definitions and choice | 7,019 bytes |
| Static system plus tools | 9,806 bytes |
| Messages across13 captured requests | 400–4,651 bytes |
| Whole request across13 captures | 10,405–14,656 bytes |
| Final-emission observed input | 4,308–4,891 tokens |
| Final-emission observed output | 112–310 tokens |

The final output ceiling was1,000. The observed unfinished claim arrived under normal tool_use stop, well below that ceiling, not max_tokens. Raising the output ceiling is therefore not an evidenced correction for this fragment. The private audit is `.context/ask-construction-research-20261012/request-size-audit.json`, derived from run4c427384's native frames. Shapes and limits are also recorded in the [TDD evaluation](ask-evidence-authority-tdd-20261012.md).

**Locality opportunity:** selected-note classification appears in source.kind, evidenceAuthority, answerGuidance, interpretationLimits, sourceMetadata, separate attribution records, the system instructions and final schema descriptions. Occurrence/observation dates also repeat. The host needs canonical IDs, hashes and revisions for permission/deletion; the model does not need every internal bookkeeping field to interpret a short excerpt. The initial empty firm context marks its selected scan complete, while a later catalog result admits a source: those scopes are legitimate but require the model to reconstruct what each coverage field means. A compact representation should preserve each scope instead of collapsing them into global completeness.

This overhead and repetition are measured design findings, **not proof of the semantic failure's cause**. The decisive contract and coverage text was retrieved; vectors cannot correct its meaning merely by retrieving it again. An interpretation problem and a missing-evidence problem must be measured separately.

## Fresh open-source source comparison

Inspected snapshots: Hermes8a7a5a9, OpenClaw73f9f4e5, AI SDKba05943b, LlamaIndex6dd2f3cd. They are inspected code patterns, not executed Callie benchmarks or recommended dependency upgrades.

**Hermes:** its session search offers query-free browsing, discovery, anchored expansion and direct session reads without an extra LLM call in the tool. It exposes truncated content and index progress. These are useful retrieval interfaces; personal-session lineage is not a replacement for firm/person identity or source access. [Pinned search tool](https://github.com/NousResearch/hermes-agent/blob/8a7a5a905fc66ed82b922587a8e3c011e819dbb5/tools/session_search_tool.py).

Hermes returns ordinary assistant prose but also detects empty, stalled and degenerate finals, with additional generation/continuation machinery. Its fragment handling shares a bounded two-continuation counter. This refutes an assumption that switching from structured claims to prose inherently removes fragments; it does not establish a policy we should copy. Recovery adds calls and must obey Callie's pre-dispatch budget and unknown-acceptance rules. [Pinned final response handling](https://github.com/NousResearch/hermes-agent/blob/8a7a5a905fc66ed82b922587a8e3c011e819dbb5/agent/turn_final_response.py).

Its optional grounded-citations skill uses source IDs, a ledger and literal quote occurrence checks. Those verify provenance and quote presence, not semantic entailment or CRM coverage. [Pinned citation workflow](https://github.com/NousResearch/hermes-agent/blob/8a7a5a905fc66ed82b922587a8e3c011e819dbb5/skills/research/grounded-citations/SKILL.md).

**OpenClaw:** memory search separates result snippets from partial, staleness, provider and corpus-attempt metadata; semantic timeout can return keyword-only results with transcript absence explicitly disclosed. This is a useful precedent for host-owned coverage separate from source text. Its hybrid ranking and path/line citations demonstrate provenance preservation, not a superior ranking method for our corpus. Its citation auto mode can omit references in group/channel contexts and does not satisfy Callie's mandatory-reference contract. [Pinned memory tools](https://github.com/openclaw/openclaw/blob/73f9f4e54257784cac122cae7466a44cc8f098a3/extensions/memory-core/src/tools.ts), [citation presentation](https://github.com/openclaw/openclaw/blob/73f9f4e54257784cac122cae7466a44cc8f098a3/extensions/memory-core/src/tools.citations.ts).

**AI SDK:** the source wrapper does not hide a special grounding algorithm. A prepare-step example forces retrieval first and removes tools later, but its retrieval is a placeholder. That demonstrates a way to separate acquisition and synthesis, not a measured accuracy advantage or a reason to adopt the default twenty-step wrapper. Keep our host-owned accounting and current low-level SDK use. [Pinned ToolLoopAgent](https://github.com/vercel/ai/blob/ba05943b69ad070558bb5bc912da99ec66d7d263/packages/ai/src/agent/tool-loop-agent.ts), [prepare-step example](https://github.com/vercel/ai/blob/ba05943b69ad070558bb5bc912da99ec66d7d263/examples/ai-functions/src/stream-text/openai/prepare-step.ts).

**LlamaIndex:** CitationQueryEngine retrieves nodes, numbers source chunks and synthesizes natural cited prose. This is a concrete simple baseline. Its default metadata mode is NONE; copying it could discard source kind, observed time and attribution that Callie needs. Numbered sources still cannot establish actual Gmail coverage from a note reporting a cutoff. [Pinned citation engine](https://github.com/run-llama/llama_index/blob/6dd2f3cdd9ce7ff927ea8d46ccee08875bb00f95/llama-index-core/llama_index/core/query_engine/citation_query_engine.py).

## Design comparison and recommendation

| Candidate | Interface and locality | What it discriminates | Cost/compatibility risk |
| --- | --- | --- | --- |
| Compact typed evidence view, current loop/output | Deepen existing askModelEvidence; keep runStep and host lifecycle. One representation of originals, exact observations and scoped coverage; private codec retains canonical proofs. | Whether evidence encoding/repeated authority instructions contribute to interpretation errors. | No mandatory additional generation or public schema; can lose meaningful metadata if over-compressed. |
| Separate investigation and synthesis modes | Internal modes of the same host loop. Investigation has readonly tools; final synthesis sees admitted evidence and only emit_answer. | Whether transcript/menu burden interferes with final answer construction. | Potential extra generation and new stopping protocol; must reserve final allowance, not create a second orchestrator. |
| Natural prose with mapped citations | New internal/provider and potentially public publication contract. No second model merely to reconstruct claims. | Whether strict final string/schema burden is responsible after context is clean. | Citation parsing, exact-only/mixed support, actions and old readers need explicit compatibility review. No demonstrated advantage yet. |

**Recommended first change:** compact the model-only evidence view within the existing deep module, without changing model, tool policy, stopping behavior or public answer shape. Keep source text exact, its server-known kind, meaningful recorded time/association with unknowns, exact operation/scope/value, and host coverage separately. Keep canonical hashes/revisions and access/deletion proofs privately in the host. Do not pre-extract promises, invent identity or transform a note's coverage assertions into host facts.

The earlier paragraph prototype at source5c2131 still used a strict final tool (`passages`, interpretation and references), so it did not test true free-prose final generation. Its lack of useful improvement nevertheless argues against simply renaming claims or migrating the public format. A genuine prose comparison would be a distinct, more expensive contract experiment, not an already proven win or loss.

Illustrative internal shape (proposal, not a new public interface):

```text
question
originals: [{reference, kind, exactText, eventTimeAndBasis, copyObservedAt, canonicalAssociations, reportedSpeaker}]
observations: [{reference, operation, queryScope, currentValue}]
coverage: [{scope, observedStatus, knownGaps}]
```

SDK composition and conservative input accounting must consume the same projection. Keep the navigation identifiers needed by unchanged tool arguments (for example sourceId and firmId), or supply an explicit reviewed codec for them; removing them while retaining current tool schemas would break investigation. Source-event time plus basis stays separate from copy-observation time. Canonical person/firm associations stay separate from unverified reported headers/speaker labels, including unresolved identity. Current source/exact short handles remain authoritative only through the private canonical codec; source text, old history and inline JSON cannot mint them. Preserve user scope, source chronology, ambiguity, unavailable fields and current deletion/access checks. An unknown typed field is not a placeholder for model invention.

Test contracts at the existing authenticated command/read and registered worker seams, disposable PostgreSQL and fake external model, including canonical text/time preservation, body-injection and forged-handle rejection, mixed exact references, ambiguity, scope/deletion/cancellation and billing. Then use actual outputs for semantic support, natural phrasing and useful abstention; fake models cannot prove those.

Do not copy upstream autonomous memory, unrestricted writes, max-iteration defaults or paid recovery. No ADR change is required for a private projection under ADR0002/0008. Public answer changes, persisted model summaries, exact-only original claims or different consent/model/provider need their actual contract/approval review.

## Minimal next decision, not a broad model tournament

For a research-backed design choice, first compare the current and compact view using identical sufficient evidence, model, strict output, tool menu and thinking policy; keep evidence order and output ceiling fixed. A native terminal-frame comparison can freeze preceding tool history and evidence. An ordinary-loop comparison can change model-selected tools/stopping/call count even with identical configured policy; record those as outcomes rather than pretending call count is held fixed. Do not introduce separate synthesis mode in the same first comparison. Use the familiar failures plus separate held-out wording variants and an independent review. If clean supplied context still fails, a same-input model comparison is warranted. If supplied context works and history fails, investigate retrieval/orchestration. If failures only occur in structured final generation, consider the separate output-mode comparison.

This is not a request to rediscover general architecture from a tiny homemade benchmark. Primary evidence narrows sensible implementations; a limited Callie test distinguishes the remaining integration choices. It must not be presented as representative reliability, a guarantee that Sonnet4.6 is sufficient, or new activation authority. No new paid dispatch occurred here; campaign335calls/3809c and all operational holds remain unchanged.

## Evaluation categories beyond the six familiar cases

LongMemEval separates extraction, multi-session reasoning, temporal reasoning, knowledge updates and abstention in long-term conversation memory. Its task and tested models differ from our CRM; it supplies useful failure categories, not an expected Callie accuracy or an argument to ingest more personal mail. Add independently reviewed variants of historical/withdrawn promises, later corrections, unknown speakers and incomplete coverage, while retaining decisive source IDs and genuinely held-out wording. [Original LongMemEval paper](https://arxiv.org/abs/2410.10813).

The existing six-case scores should remain development evidence. Do not keep adjusting the same wording and call the next score representative. Actual source-backed support, correct uncertainty, usable prose, valid citations, cost and latency are separate judgments; successful parsing and a larger context window cannot substitute for them.
