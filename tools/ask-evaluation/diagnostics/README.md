# Ask support investigation — archived experiment

Question: can the present publication guard distinguish authorized references from claims actually supported by those references?

Verdict: no. Captured anonymous-speaker invention and an original-only mixed CRM inference still publish through the authenticated API, configured SDK and registered worker. Unknown-reference controls reject. Root independently repeated the minimized replay (2/2 expected failures, 5.13 seconds) and negative control (2/2 pass, 5.50 seconds). These are deterministic host-publication observations, not new model quality measurements. The existing `cited_unverified` contract is membership-only; this is a product quality gap, not evidence that it promised semantic verification.

This branch archives intentionally red diagnostics and a throwaway standalone HTML experiment. Do not merge them into required CI. Read [the investigation](captured-support-investigation.md) for commands and limitations and [the research](../../../docs/sourcing/ask-grounding-mechanisms-research-20261012.md) for primary sources.

## Proposed next implementation

Use the existing SDK, worker and answer publication seams. Root owns the shared contract.

1. Add a bounded answer-construction representation for executed exact observation fields and verbatim original spans. Resolve values, current authority, canonical citations and recorded/unknown speaker labels on the host. Do not accept arbitrary model prose as an exact fact or attribution.
2. Keep interpretations separately labeled with explicit original/exact premises. Missing declared dependencies can be checked deterministically; relevance, hidden dependencies and entailment cannot. A source-only answer needs no SQL, and an exact-only answer needs no original.
3. Lock down useful supported cases as well as the captured failures through the existing integration seam. Include revoked/deleted sources, stage changes during generation, ambiguous records, quoted third parties and irrelevant citations. Rejecting everything does not satisfy the contract.
4. Evaluate unchanged baseline versus the single construction change on frozen unseen synthetic variants. Review usefulness, unsupported attribution, claim support, overcitation, refusal, latency and cost separately. A bounded evidence-aware verifier remains an alternative if free-text errors justify it; do not implement both without evidence.

These steps propose a limited implementation and evaluation; they do not establish semantic improvement. Fresh paid evaluation requires its actual frozen scope and allowance. Keep affected hosted acceptance pending, release held and sending safeguards unchanged. Independently ready release/capture preparation can proceed in parallel.

## Prototype

Double-click [grounded-construction-prototype.html](grounded-construction-prototype.html). It uses synthetic in-memory state and makes no network or provider calls. Exact facts and quote attribution illustrate enforceable construction; mixed prose remains explicitly semantically unverified even with both reference families.

Root inspected the source. Browser interaction was not verified: Codex Browser rejected `file://` loading as an unsupported protocol. No alternate route was used to bypass that rejection. This prototype is not production code, a measured quality result or an activation gate.
