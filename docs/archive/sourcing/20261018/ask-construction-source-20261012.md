# Bounded Ask construction — source change

Part of #551. This implements the limited construction option from the research archived on `codex/ask-grounding-investigation-551` at `97aa4c9d`. It does not establish actual model usefulness, close #551, deploy or activate Ask.

The existing configured SDK final answer tool can select a verbatim source quote, executed opportunities/tasks count, current opportunity record, or an interpretation declaring source/exact/mixed premises. The registered worker owns construction: quotes must occur in the current authorized window; attribution is the recorded speaker label or unidentified speaker, never a firm inferred from association. Counts and opportunity name/stage/status come from the selected executed result. Host-constructed claims ignore model-authored prose and citation arrays and receive canonical references to the selected evidence.

Interpretations remain model text, are published as inference and must supply the declared evidence families. Missing mixed premises refuse publication. This cannot detect hidden dependencies, irrelevant premises, inappropriate quote selection or general entailment. No universal semantic validator or model verifier was added. All claims retain `cited_unverified`: even a verbatim quote is a recorded statement, not proof it is true or describes the right context.

The construction field is additive for existing/custom adapters and legacy final JSON compatibility. SDK guidance directs supported fact types through construction; an omitted construction field still follows the existing unverified prose path. Therefore the old captured arbitrary-prose failures are not claimed universally eliminated. A real evaluation must establish that the configured model uses construction and produces useful supported answers; additional enforcement can be considered from observed output rather than silently rejecting all legacy answers. Source-only and exact-only answers remain independent.

Canonical source/access, cancellation, exact-result freshness, deletion and financial settlement are unchanged. Construction is ephemeral; only existing published claim fields persist, avoiding a migration and a second private-content store. No external call, browser or extra inference stage is introduced. Closed foundations and sending controls are unchanged; the release hold remains.

## Verification

At the approved authenticated API → configured SDK with fake external model → registered worker seam, using disposable real PostgreSQL:

- Quote, exact count and opportunity-record tests failed before their respective implementations and pass afterward.
- Model-invented actor/number/stage prose is replaced only when explicit evidence construction is requested. Useful source and mixed interpretations remain available and labeled inference.
- Missing mixed exact premises, nonexistent quote spans, unknown windows, unknown exact observations and absent opportunity records refuse publication.
- A stage change during generation invalidates the answer; deletion erases constructed source answers and canonical source navigation resolves their actual passage.
- Existing session/history, source-only/exact-only compatibility and mixed citation controls remain passing.

Actual semantic improvement, strict-provider acceptance of the extended output grammar, load latency and real model use of these construction selections remain unmeasured. Prior paid grants stay consumed. A fresh comparison needs frozen source/cases and its actual approved allowance; no paid call or production change occurred in this work.
