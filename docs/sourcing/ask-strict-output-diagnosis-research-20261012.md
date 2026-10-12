# Ask strict-output diagnosis research — October 12, 2026

## Decision this research supports

Investigate the terminal `emit_answer` generation before changing models or the public Ask contract. No provider calls, deployments or activation occurred in this research. Strict generation is a plausible contributing factor, not an established cause of Callie's unfinished prose or unsupported claims.

## Documented behavior

- AWS distinguishes native JSON output (`outputConfig.textFormat` / `output_config.format`) from strict tools (`toolSpec.strict`). Both constrain schema shape. Its supported subset excludes string length constraints and numeric bounds, and requires closed objects. Those rules explain why Callie keeps bounds in its host guard; they do not establish prose completeness or evidence truth. [AWS structured outputs](https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html)
- Anthropic says strict tools use grammar-constrained sampling to enforce argument schemas. This is a structural guarantee. A valid string can still contain an unfinished sentence; that conclusion follows from Callie's unconstrained string schema, rather than a documented provider defect. [Anthropic strict tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use)
- Structured generation compiles schemas into grammars; optional fields, unions and nesting increase complexity. Anthropic documents compilation limits and recommends reducing complexity when requests exceed them. This concerns compilation errors; it does not prove semantic degradation for Callie's accepted responses. [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

## Upstream reports: relevant but not interchangeable

- **Maintainer-backed fix, different path:** AI SDK PR #20125 adds a native-vs-JSON-tool override after workload-dependent Sonnet 4.6 native output ran to its token cap. PR #20128 defaults affected models to JSON tools while explicitly preserving strict-tool support. This is evidence against blindly adopting native JSON output as a fix. Callie already uses an explicit output tool, so the fix is not evidence that upgrading dependencies solves its prose. [PR #20125](https://github.com/vercel/ai/pull/20125), [PR #20128](https://github.com/vercel/ai/pull/20128)
- **Issue-author observation:** #1176 reports omitted embedded quotation marks in tool strings for older Sonnet/Opus models on the direct Anthropic API. The listed tests predate Sonnet 4.6, do not use Bedrock, and do not set strict mode. It is a useful special-character probe, not proof of this failure. The issue is closed; closure alone does not establish a relevant fix. [Anthropic SDK issue #1176](https://github.com/anthropics/anthropic-sdk-python/issues/1176)
- **Issue-author observation, different failure:** #1889 reports quoted-input-dependent mid-stream errors under native JSON output on Haiku 4.5. #1926 reports corrupted Unicode escapes in strict tool strings on Sonnet 5 through direct HTTP. These show reasons to inspect raw strings before application parsing, but neither identifies our Sonnet 4.6 Converse bug. [Issue #1889](https://github.com/anthropics/anthropic-sdk-python/issues/1889), [issue #1926](https://github.com/anthropics/anthropic-sdk-python/issues/1926)

## Pinned-source facts

Inspected installed `@ai-sdk/amazon-bedrock` **4.0.194** and Callie's `askAgentSdk.ts`; no dependency change proposed.

- Callie sends `generateText` with an explicit `emit_answer` tool (`strict:true`), not `Output.object` or `responseFormat:json`. The final step selects the named tool; earlier steps require a tool.
- The pinned provider forwards `strict` into Converse `toolSpec` for supported models; named choice becomes `{tool:{name}}`, required becomes `{any:{}}`.
- Nonstreaming Converse responses already contain parsed `toolUse.input`. The pinned provider serializes that object with `JSON.stringify` when returning the SDK tool call. It does not visibly shorten its prose fields in this path. This narrows the likely boundary but raw captured Converse responses are still needed to establish where an individual defect originates.
- Provider lines 1064–1070 distinguish native JSON and synthetic JSON-tool paths. Lines 1369–1378 serialize returned tool input. Callie's adapter lines 37–39 configure the explicit tool. These local code observations are stronger for our pinned behavior than current upstream issue descriptions.

## Discriminating next experiment

First do a **no-network fixture test** through the pinned provider and Callie adapter: return synthetic tool input containing embedded quotes, backslashes, Unicode and a deliberately unfinished sentence. Compare Converse object, provider tool input, decoded answer and display. Exact preservation would reject an application/SDK shortening hypothesis; it would not prove model correctness.

If traces confirm defective strings originate in the provider response, freeze the failed synthetic final-step prompts and run a paired comparison changing **only `emit_answer.strict:true` to `false`**. Keep the tool schema/descriptions, named choice, model/profile, reasoning-disabled setting, input, token ceiling and host guard identical. Alternate order and repeat a small fixed number; retain malformed/nonaccepted outputs as failures. Measure sentence completeness, special-character preservation, unsupported clauses, structural rejection, tokens and latency separately. Do not repair or retry answers automatically.

If non-strict improves prose while preserving supported meaning, the strict grammar hypothesis gains evidence. If both reproduce failures, inspect prompt/schema instruction interaction next. A later named-versus-required selection comparison must be separate: changing both strictness and choice in one run would confound the result. No paid run was authorized or executed by this note; the integration owner must bind any run to the existing remaining synthetic budget and exact scope.

## Offline diagnosis performed

At merged PR586 source, run the retained diagnostic:

```bash
PATH=/opt/homebrew/opt/node@24/bin:$PATH node --experimental-transform-types --disable-warning=ExperimentalWarning tools/ask-evaluation/diagnostics/replay-ask-output.mjs captured
```

This runs only a fake intercepted Converse response with fake credentials. The response object is reconstructed from the **SDK-returned** synthetic grant15 candidate, not an original native wire capture. `captured` exits1 with two unfinished claims, `minimal` exits1 with one, and `control`/`escaped` exit0. Each takes under a second, makes one intercepted call, reports `strict:true` and named `emit_answer`, and preserves the supplied text exactly. The escaped control includes curly quotes, literal double quotes and a backslash. Exit1 is an intentional symptom signal, not a failing required test or transport failure.

The original grant15 SDK-returned strings also match the published dev08 public-read strings exactly. This rules out downstream text shortening in that observed path. It does not prove where the provider generated the strings, or that changing a prompt would make this frozen bad response disappear. The replay diagnoses preservation/admission; generation is stochastic and requires a distinct live differential signal. No punctuation filter or silent text repair has been added.

### Ranked falsifiable hypotheses

1. **Strict tool grammar contributes.** With otherwise identical fresh final requests, strict off lowers incomplete-string frequency without increasing unsupported conclusions/structural rejection. Equal results weaken this hypothesis.
2. **Prompt/schema interaction contributes.** If strict off does not help, simplify only redundant drafting/provenance instructions while keeping tools/schema/context fixed. Improvements would support that interaction, not a missing retrieval claim.
3. **Stochastic model behavior contributes.** Repeated identical requests reproduce failures variably under both modes. Counts and failure text must be retained; one favorable answer is insufficient.
4. **Our decoding/display shortens strings.** The offline fixture and grant15 SDK-to-public comparison contradict this hypothesis for the reproduced strings. They cannot exclude upstream native response behavior that was not captured.

The confirmed native-JSON upstream bug remains a different path, not a reason for an untested dependency upgrade.

### Missing instrumentation and next probe

Grant15 retained SDK outputs and usage, but neither original Converse response bytes nor exact final request messages. Exact historical wire replay is unavailable. First capture a fresh synthetic-only request body/response content at the Converse seam, excluding headers, signatures and credentials; freeze the resulting fresh prompt for both arms. Preserve canonical host guards and billing, and alternate paired order. Keep strictness as the sole manipulated variable; do not change tool choice, token allowance or model at the same time.

No new paid call, provider configuration, production release, activation or sending change occurred. Campaign remains295calls/3346c conservative allocation (not invoice), leaving105calls/1654c under the existing400/$50 ceiling; any next run needs its own frozen scope and conserved reservation. This research establishes a discriminating test, not a semantic fix or #551 closure.
