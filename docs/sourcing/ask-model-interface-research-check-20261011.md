# Research check: Ask model interface

October 11, 2026. Focus: [proposed interface](ask-model-interface-design-20261011.md), repository `ec57e77162baf9479d67e55558a392a5f072dadc`. Read-only source/documentation research; no model dispatch, infrastructure operation, source implementation or gate change.

**Assessment:** the general design patterns have strong primary-source support. The exact Callie interface and paragraph format are an engineering hypothesis that still needs comparative evaluation. Research does not show that typed JSON or paragraph citations eliminate the observed unsupported interpretations.

## Five strongest supported claims

1. **Separate, concise context is a supported design practice.** Anthropic recommends high-signal context, clear instructions and distinct prompt sections. This supports separating source content, recorded provenance, current CRM observations and scoped coverage. Our particular TypeScript frame types and field names are an implementation inference, not a published benchmark winner. [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).

2. **Tool results should expose meaningful quantities and manageable reference handles.** Anthropic reports better retrieval precision from interpretable identifiers and recommends selective high-signal responses. It explicitly says response formatting is task/model dependent and should be evaluated. This supports short handles and names such as “verified outgoing receipts without a verified reply,” rather than letting a model interpret that as “unanswered conversations.” It does not prove that JSON, XML or paragraph arrays are universally superior. [Anthropic tool design](https://www.anthropic.com/engineering/writing-tools-for-agents).

3. **Typed tool exchanges and application-owned execution fit the existing SDK.** AI SDK documents schema-defined tool arguments and optional execution functions, permitting calls to be forwarded to another process or queue. Tool calls/results are explicit messages. Thus a host-controlled, bounded step adapter is a normal integration pattern; a framework migration is not necessary to represent clearer context. Current web docs are version 7, while Callie pins `ai` **6.0.303**. API names/examples from current docs are not promises of compatibility with the installed version: implementation must use the installed types and existing adapter behavior. [AI SDK tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling), [local dependency](../../apps/worker/package.json), [current adapter](../../apps/worker/src/providers/askAgentSdk.ts).

4. **Schema validity and evidence validity are different checks.** SDK structured outputs validate object shape/types; that is not a factual entailment test. The original ALCE research evaluates fluency, correctness and citation quality separately, and demonstrates that cited generation can still lack complete support. Therefore resolve reference membership/currentness mechanically, but evaluate whether the prose follows from those references separately. No ALCE dataset result is a Callie or current-model accuracy estimate. [AI SDK structured outputs](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data), [Gao et al., ALCE, EMNLP 2023](https://arxiv.org/abs/2305.14627).

5. **Host controls remain essential around the model loop.** OpenClaw's actual runtime documentation separates intake/context/inference/tool execution/persistence, validates tool arguments and bounds runtime attempts. Its security material separately describes access control, tool permissions and untrusted input. These corroborate placing current access, allowed operations and lifecycle limits in the host rather than treating an instruction or model interpretation as authority. They do not certify Callie's controls or justify copying OpenClaw's broader capabilities. [OpenClaw agent loop](https://docs.openclaw.ai/concepts/agent-loop), [OpenClaw security](https://docs.openclaw.ai/gateway/security).

## What Hermes and OpenClaw establish

The inspected [Hermes runner source](https://github.com/NousResearch/hermes-agent/blob/main/run_agent.py) exposes conversation execution, enabled/disabled toolsets, maximum iterations and diagnostic budget state. This is independent implementation evidence for a configured agent harness with runtime controls, not a controlled trial of Callie's paragraph protocol or CRM truth handling. OpenClaw likewise provides an implementation precedent for an application-owned runtime. These moving-main sources were inspected on the research date; they are examples, not dependency recommendations or immutable reproducibility receipts. Neither is evidence that more tools, memory or additional agents would improve this specific Ask defect.

## Engineering inference and security limit

Typed `SourceEvidence` versus `CrmObservation` is a sensible way to preserve the provenance distinction already present in Callie's source/SQL contracts and reduce adapter shape discovery. The host can mechanically reject an unknown handle, stale source or changed exact-value proof. It cannot infer from the schema alone that a sentence is supported, a pasted From header names the true author, or a count of scoped receipts describes all correspondence. The model-visible separation is guidance; the security boundary is host authorization, source admission, operation validation and publication/read revalidation.

One to three cited paragraphs are a product/presentation choice. Replacing `fact` claim arrays with `summary` paragraphs may improve readability and reduce misleading labels, but remains unproven. `summary` still means generated interpretation, not verified truth. No source reviewed requires a paid critic/rewriter or a new retrieval platform for this change.

## Exact remaining experiment

Freeze the cases, model, decoding settings, source windows, current observations and conserved budget. Compare the existing protocol against the proposed typed context/paragraph protocol on identical admitted evidence. Keep earlier failure cases, then add fresh scenario variations not used to tune the candidate. Evaluate separately:

- Source text versus actually observed headers/authorship/dates; note-reported coverage versus Callie coverage.
- Conditional offers versus commitments, historical quotations and ambiguous business associations.
- `not_established` reply status, zero scoped receipt counts and partial coverage without definitive unsupported state.
- Per-sentence support/citation completeness, conflicts, abstention and source-only/exact-only/mixed references.
- Human readability/directness, incomplete sentences, necessary tool usage, latency and conserved allocation versus actual usage.

Run controlled contract/lifecycle tests for forged/stale references, SQL changes during waits, deletion/revocation, cancellation, ambiguous spending, old answer/session clients and action-proof eligibility. These tests establish mechanical behavior; they cannot establish model usefulness. Report actual denominators and failures, not only successful parsing. Reused synthetic cases are regression evidence, not unseen representative business acceptance.

The proposed change is research-informed and worth testing. Improved Callie quality is still an experimental claim. No new provider/data purpose, budget, release, activation or sending authority follows from this note.
