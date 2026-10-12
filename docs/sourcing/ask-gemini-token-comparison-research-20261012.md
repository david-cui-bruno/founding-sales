# Ask: token budget versus Gemini comparison — October 12, 2026

## Recommendation

Run an **output-budget-only Sonnet4.6 ablation first**, then a separately identified Gemini arm on the same frozen cases and answer protocol. Prefer current GA `gemini-3.8-flash` through a full Google Cloud project, location `us`, for the first Gemini comparison. `gemini-3.5-flash` is an alternative with a longer stated availability policy. The currently documented Pro choice is `gemini-3.1-pro-preview`, not a stable Pro release; its global-only availability makes it a different data-location/preview decision.

Do not simultaneously change model, output ceiling, prompts and final construction protocol and call the result a model comparison. Preserve the same host tools, current source/access/deletion checks, per-attempt accounting and no retries. GCP credits affect payment, not quality or authority. This note uses public primary documentation and package metadata only; no credentials, cloud changes, model calls or activation occurred.

## What the actual failures tell us

The [repaired construction run](ask-construction-repaired-results-20261012.md) returned ten AskHTTP200 responses. Three final generations stopped at exactly1,000output tokens, returning incomplete tool input and no answer. Two completed candidates omitted optional construction and took the legacy path. This establishes a binding output cutoff and an adoption gap; it does **not** explain what missing tokens contained, establish model incapability, or show that a larger budget will fix semantic defects.

The earlier same-case Sonnet run published5/5 at1,000tokens with different source/schema/tool choices. That is a useful historical comparison, not a causal budget test. Increase only the ceiling on the repaired frozen protocol, keep thinking disabled and retain the incomplete outputs as failures. A4,096-token ceiling is a proposed diagnostic setting, not a performance recommendation. Existing evaluation validators/allowance bounds need an explicit scoped update; unused old allowance is not permission.

## Current Google model choices

Official model pages and lifecycle documentation were inspected on October12; do not infer availability from old2.5 examples.

| Choice | Exact public model ID / stage | Context / maximum output | Role in this evaluation |
| --- | --- | --- | --- |
| Gemini3.8Flash | `gemini-3.8-flash`, GA; releasedSeptember2,2026 | 1,048,576 /65,536 | Preferred current Flash arm; no fixed retirement announced. |
| Gemini3.5Flash | `gemini-3.5-flash`, GA; releasedMay19,2026 | 1,048,576 /65,536 | Longer availability commitment throughMay19,2027or later. |
| Gemini3.1Pro | `gemini-3.1-pro-preview`, preview | 1,048,576 /65,536 | Optional quality comparison only with explicit preview/global scope; not a stablePro recommendation. |

These are documented availability/capability limits, not proof the owner's project can invoke them or they answer our cases well. Google lists Gemini2.5Pro/Flash retirement onOctober20,2026; avoid starting a new adapter against those near-retirement versions. [3.8Flash model](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-8-flash), [3.5Flash model](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-flash), [3.1Pro model](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-1-pro), [lifecycle](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions).

## Thinking and budget comparability

Gemini3 uses `thinkingLevel`; `thinkingBudget` is deprecated there and may produce400s.3.8Flash supportsLOW/MEDIUM/HIGH, defaultMEDIUM;3.5Flash also supportsMINIMAL, defaultMEDIUM; Propreview supportsLOW/MEDIUM/HIGH, defaultHIGH. None should be described as equivalent to Sonnet's explicit thinking-disabled setting. FreezeLOW for the initial3.8arm and disclose the distinction. `includeThoughts:false` hides summaries, not the billable process. Thought signatures must be retained between tool turns; MINIMAL explicitly requires them. [Google Cloud thinking](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking).

The DeveloperAPI GenerateContent documentation says `max_output_tokens` includes thought tokens; a low cap can exhaust reasoning before producing visible output. This is a separate API's explicit statement, so verify the selected Vertex transport/accounting rather than silently importing every DeveloperAPI behavior. Reserve conservatively, inspect actual thought/candidate totals, and refuse unknown accounting. [GenerateContent thinking/token limits](https://ai.google.dev/gemini-api/docs/generate-content/thinking).

## Existing AI SDK integration requirements

The repository pins `ai@6.0.303`. Registry metadata gives `@ai-sdk/google-vertex`'s `ai-v6` tag as4.0.212, with `@ai-sdk/google@3.0.131` and provider3.0.18. Latest5.0.110 uses provider4, so do not blindly installlatest or select3.x. These observations identify a candidate version, not verified lockfile/build compatibility. [Vertex package registry](https://registry.npmjs.org/@ai-sdk/google-vertex), [candidate package metadata](https://registry.npmjs.org/@ai-sdk/google-vertex/4.0.212).

The Vertex provider accepts explicit project/location and GoogleAuth options; its Gemini controls use `providerOptions.vertex.thinkingConfig`. This is not a Bedrock endpoint/model identity or interchangeable provider-options object. [AI SDK Vertex provider](https://ai-sdk.dev/providers/ai-sdk-providers/google-vertex).

Inspected google3.0.131 source maps output total to `candidatesTokenCount + thoughtsTokenCount`, with separate text/reasoning counts. It preserves opaque `thoughtSignature` through provider metadata. Callie's present host reconstructs tool transcripts without that metadata; a model substitution alone would lose required state. Add only the private round-trip data needed by the adapter, under the same current-source/deletion lifecycle, and verify with fake external fetch before any real dispatch. Do not put signatures in public answers or a second uncontrolled content store. [Pinned Google provider source](https://unpkg.com/@ai-sdk/google@3.0.131/dist/index.js).

## Tools and structured grammar

Google's function calling supplies typed calls, withANY forcing a call and `allowedFunctionNames` restricting choices. Function responses and opaque thought signatures form subsequent-turn context. Keep tool execution host-owned; no Google Search, code execution, automatic functions or external writes are needed. [Function calling reference](https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/models/function-calling).

Structured response schemas support a subset including `anyOf`; unsupported fields can be ignored and complex schemas can400. That is not proof every field in the Bedrock strict `emit_answer` schema maps correctly to Gemini function declarations. Inspect the actual serialized request, required construction selection, final-call restriction, union conversion, output cutoff and provider metadata. Host Zod/canonical validation remains authoritative; schema conformity never proves claim entailment. [Structured output](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/control-generated-output).

## Billing, locations and data handling

Use a billing-linked full Cloud project and Vertex/AgentPlatform API when evaluating with eligible GCP credits. The DeveloperAPI/AIStudio billing documentation excludes new-account $300Welcomecredits afterMarch2,2026. CloudFreeTrial documentation also names AIStudio's GeminiAPI exclusion. Actual startup/promotional-credit restrictions, expiry, remaining balance and eligible SKUs remain **unverified**; no account was inspected for this research. [DeveloperAPI billing](https://ai.google.dev/gemini-api/docs/billing), [CloudFreeTrial](https://docs.cloud.google.com/free/docs/free-cloud-features).

Both Flashchoices support jurisdictional`us` and`eu` endpoints; the currentPropreview page listsglobal. Do not assume old`us-central1` examples support these models. Google distinguishes endpoint availability from processing guarantees: jurisdictional`us` keeps processing in the UnitedStates;global may process worldwide. Use`us` for the initialFlasharm and bind that to consent. [Endpoint availability](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations), [data residency](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/data-residency).

Cloudmanaged models are not used for training without permission, but zero retention is not automatic: abuse monitoring and optional request logging have separate conditions. Keep this initial comparison synthetic-only and omit search/maps grounding, caching or logging features not required by the comparison. Real Gmail requires its separately approved purpose/data-handling scope. [Cloudretention](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/zero-data-retention).

Current standard rates per1Mtokens below200Kinput:3.8Flashglobal introductory$0.75/$3.75, non-global$0.825/$4.125;3.5Flashglobal$1.50/$9, non-global$1.65/$9.90;Propreviewglobal$2/$12. Output includesresponse+reasoning.3.8promotional pricing endsDecember31; published footnote describes credits-back, so do not assume immediate net price or stacking with ownercredits. Budget3.8USconservatively at post-promotion$1.65/$8.25 until billing applicability is verified. No invoice or credit eligibility follows from this table. [Cloudpricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing).

## Minimal execution plan

1. Offline: add a narrow Vertex adapter/protocol test at existing seams; preserve thought signatures, actual serialized schema, usage totals, stop reasons and no-retry handling. Keep all public/private authority checks unchanged.
2. Sonnet: compare1,000 versus4,096output-only ceilings on unchanged repaired protocol/cases. Record construction adoption separately from publication and usefulness; do not silently upgrade to a new final protocol mid-comparison.
3. Gemini: use the same cases/protocol/tool permissions and explicitLOW, separately frozen model/project/USendpoint/budget. A larger total output ceiling may be necessary to accommodate thinking; report this as a provider-policy difference rather than an equal-token causal model test.
4. Review usefulness, attribution, every mixed claim's evidence, partial/refusal rate, construction adoption, observed thought/text usage, cost and latency. A publication without construction cannot establish construction success. Keep failed and unavailable outcomes in the denominator.

If increasedSonnettokens restore complete answers but construction remainsunused, simplify/require the configured final protocol as a separate engineering change. IfGemini is better on these cases, that supports a limited configured choice, not general superiority or production activation. Obtain concrete project/credit confirmation and separately frozen call authority before actual dispatch; releases and independently passing capture work can continue in parallel.
