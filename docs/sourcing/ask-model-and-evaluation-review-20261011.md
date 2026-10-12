# Ask model choice and evaluation review — 2026-10-11

## Decision supported by the research

Do not infer that Haiku is inadequate, or that the PostgreSQL/tool architecture is wrong, from the six failed Ask cases. The current result confounds retrieval, output formatting, source admission, generation limits and semantic interpretation. Establish a capable model baseline with sufficient room to retrieve and answer; then determine whether cheaper models preserve the needed quality. This is a recommendation, not a provider configuration change.

For the next design, compare a stronger Sonnet baseline with a current Haiku candidate. Haiku 4.5 remains useful as the historical control, but it should not remain the unexamined default merely because it was inexpensive when the integration was written. Published model availability does not prove our account has access, quotas, compatible SDK behavior, or permission to process data with that model. This review made no provider calls or IAM changes.

## What the existing results actually establish

The retained `final-schema104-synthetic-assessment.json` records three `step_bound_reached` cases, three `unsupported_answer` cases, and zero accepted Ask answers on source `6e13be2`. It also records concept-heavy AND searches missing short originals, free-form prose/fences, uncited exact-state claims, conditional offers emitted as commitments, and old quoted promises emitted as commitments. These are several different failure classes, not one model-quality score. The merged structured-output and browsing repairs have controlled test evidence; they have not yet been observed on the actual provider.

The proposed evaluation scope expressly chooses three generations, 1,000 output tokens per generation and 25,000 input bytes. The product contract permits `maxSteps` from 1 to 32 and output ceilings through 4,096. Three is therefore a local evaluation/configuration choice, not an AWS, Anthropic or AI SDK limit. The adapter deliberately performs one generation per call; the worker owns the iteration and accounting. Local sources: [scope](../../.context/full-roadmap-execution-20261011/structured-output-proposal/scope.json), [adapter](../../apps/worker/src/providers/askAgentSdk.ts), [limits](../../packages/contracts/src/crmActivation.ts), [assessment](../../.context/full-roadmap-execution-20261011/final-schema104-synthetic-assessment.json). Private ignored evidence paths may not exist in other checkouts.

A plausible sequence is resolve identity → search → read surrounding conversation → final answer: four generations if each dependency requires its own model turn. A three-generation cap can stop correct progress. Conversely, more turns cannot repair consistently wrong semantic classifications or unavailable evidence. Inspect traces and distinguish those cases before increasing limits.

## Verified model candidates and lifecycle

These are official public catalog facts checked October 11, not verified account access. Context windows describe provider capacity, not a recommendation to send entire mailboxes.

| Candidate | Documented AWS US geographic profile | Context / maximum output | Role in a comparison |
| --- | --- | --- | --- |
| Haiku 4.5 | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | 200K / 64K | Historical control; lightweight tool-capable model |
| Sonnet 4.6 | `us.anthropic.claude-sonnet-4-6` | 1M / 64K | Stronger established alternative if newer integration is unavailable |
| Haiku 5.5 | `us.anthropic.claude-haiku-5-5` | 1M / 128K | Current inexpensive candidate, released October 7 |
| Sonnet 5.5 | `us.anthropic.claude-sonnet-5-5` | 1M / 128K | Preferred stronger current baseline, released September 28 |

AWS lists all four Active. Haiku 4.5 has “EOL no sooner than” October 16, 2026 and actual EOL N/A: that is not an announced October 16 shutdown. Sonnet 4.6's earliest EOL is February 17, 2027; the 5.5 cards give corresponding 2027 earliest dates. References: [Haiku 4.5 AWS card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-4-5.html), [Sonnet 4.6 AWS card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-4-6.html), [Haiku 5.5 AWS card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-5-5.html), [Sonnet 5.5 AWS card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5-5.html).

Anthropic publishes capability improvements and coding/agent benchmarks for newer models. Such results identify candidates; they do not measure Callie's promise-versus-offer interpretation, quotation provenance, firm ambiguity, deletion behavior or citation accuracy. Even a published enterprise document-QA example is another product's corpus and grader. [Haiku 5.5 launch and benchmark context](https://www.anthropic.com/claude-haiku-5-5).

## Prices and budgets

Anthropic's published base input/output prices per million tokens are Haiku 4.5 $1/$5, Sonnet 4.6 $3/$15, Sonnet 5.5 $2/$10, and Haiku 5.5 $0.10/$0.50 for prompts up to 100K ($0.50/$2.50 above that threshold). These are first-party list prices, not an AWS invoice or the approved conservative reservation. Newer tokenizers can change token counts; comparing prices alone is insufficient. Geographic routing premiums, caching, service tiers and endpoint-specific billing must be verified for the actual selected Bedrock route before updating reservation rates. [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), [AWS pricing authority](https://aws.amazon.com/bedrock/pricing/).

Measure cost per **useful accepted answer**, not cost per generation. A cheap model that needs more searches, repeated answers or human correction can be worse value. Keep the durable hard spend ceiling; make generation count a separately adjustable latency/work guardrail. Budget a final answer explicitly instead of allowing search to consume every generation.

## Output and thinking compatibility

AWS now documents native JSON schema outputs and strict tools on Bedrock runtime. Its documentation also warns that Anthropic provider-native citations cannot be combined with structured outputs, and that some geographic profiles lack support. Callie's canonical citation IDs inside its own answer JSON are an application contract, not that provider-native citations feature. Verify the pinned SDK's request translation rather than assuming a model card guarantees the SDK emits the desired native format. Grammar compilation can add initial latency; avoid interpreting it as agent-loop failure. [AWS structured outputs](https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html).

The current Haiku5.5 and Sonnet5.5 AWS model cards explicitly mark provider-native structured outputs unsupported on their listed endpoints. Do not infer support for these candidates from the general AWS feature page. Our SDK JSON-output-tool transport is a different implementation and needs candidate-specific protocol and actual-provider verification; structural checks still remain in Callie.

Haiku 4.5 supports explicit extended thinking. Newer Sonnet/Haiku cards document adaptive thinking defaults and effort controls. AWS warns that model migrations can introduce billed thinking when the thinking field is omitted; total output includes thinking and final text. A 1,000-token ceiling that worked without thinking can leave insufficient answer space after migration. Pin thinking/effort explicitly and account for it; don't silently turn it on or compare one model with a different hidden budget. [Extended thinking](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-extended-thinking.html), [adaptive thinking](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-adaptive-thinking.html), [Haiku 5.5 defaults](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-5-5.html), [Sonnet 5.5 defaults](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5-5.html).

## Evidence collection that separates architecture from model quality

The following is a proposed comparison design, not authorization for additional spending or activation.

1. **Replay the actual six traces offline.** Classify each lost answer by retrieval miss, exhausted generation, output encoding, unsupported citation, semantic error or legitimate abstention. Preserve the original results. Capture body-free production diagnostics and synthetic-only readable traces; no need to expose private chain-of-thought.
2. **Give gold evidence directly to the answer model.** Use the same frozen questions and labels, with the known supporting canonical windows already supplied. If this fails, improve interpretation/output before investing in vectors or longer loops. If it succeeds while tool retrieval fails, the problem lies chiefly in retrieval or orchestration.
3. **Compare identical evidence and tools across models.** Prefer current Sonnet as the capable baseline and current Haiku as the inexpensive candidate, subject to access/SDK checks. Keep labels, scope, output schema, grading and thinking policy fixed. Preserve Haiku 4.5 as the historical control where useful.
4. **Compare three versus six permitted generations after the baseline.** Six is a diagnostic candidate, not a proven optimal default. Stop on a valid answer, clear inability or spend/deadline limit; reserve the final generation for an answer or explicit abstention. Record how many cases genuinely need extra work, repeated calls, elapsed time and total tokens.
5. **Grade layers separately.** Structural acceptance, relevant-source recall, quote/citation support, semantic correctness, correct abstention, coverage disclosure, final usefulness, latency and conserved cost. An invalid JSON response is not a semantic failure; a correctly formatted false commitment is. Exact database results need their own correctness checks, not invented quotation citations.
6. **Repeat a small discriminating subset before drawing reliability conclusions.** Four extraction and six Ask cases are useful regressions, not representative business reliability. Add offers versus accepted promises, rescinded/old promises, forwarded quotations, shared endpoints, conflicting opportunities, absent evidence and partial coverage. Human review should calibrate graders, rather than a model judging its own answers unchecked.

These evaluation principles have independent precedent. Berkeley BFCL separates executable tool choice/arguments and multi-turn behavior, useful for tool-protocol diagnosis but not CRM promise semantics. [Official BFCL](https://gorilla.cs.berkeley.edu/leaderboard). CRAG supplies varied factual QA and simulated retrieval APIs, a useful model for separating retrieval from answer quality; its public-domain tasks are not a replacement for Callie's labels. [CRAG paper](https://arxiv.org/abs/2406.04744), [original dataset repository](https://github.com/facebookresearch/CRAG). τ-bench evaluates agents with real executable domain tools/policies and emphasizes repeated-run reliability; it supports testing the whole system, not equating one successful model response with reliable operation. [τ-bench paper](https://arxiv.org/abs/2406.12045), [original implementation](https://github.com/sierra-research/tau-bench). Anthropic additionally recommends inspecting transcripts and combining deterministic checks, semantic grading and human calibration. [Agent evaluation guidance](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).

## Questions still worth answering before implementation changes

- What latency and approximate spend per useful Ask answer is acceptable to David? This determines whether higher-capability models and six-turn investigations are sensible product defaults.
- Should Ask return a useful supported partial answer when some evidence is absent, with the missing coverage explicit? Avoid treating every incomplete investigation as total failure.
- Which questions need exact CRM SQL, which need one conversation, and which need investigation across history? A single generic loop may impose unnecessary work on the simple cases.
- Do traces show evidence absent from the retained corpus, present but not retrieved, or present and misinterpreted? Each needs a different fix.

Retain ADR 0008's private scoped history, current source/deletion checks and explicit human actions. No finding here requires writes, outreach, routine replies, broader Gmail acquisition or lifting the release hold. Recommended next skill is **diagnosing-bugs** for causal trace analysis, followed by **codebase-design** only if the evidence identifies poor tool boundaries; use **tdd** once the revised behavior is concrete. No broad rewrite or additional architecture tickets are justified solely by the six failed cases.
