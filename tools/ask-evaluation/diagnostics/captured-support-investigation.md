# Captured support failure investigation — 2026-10-12

Controlled diagnostic, intentionally red by default. Not required CI, a source fix, hosted quality acceptance, or activation evidence. No new provider calls, spending, production writes or sending changes.

## Exact symptom and feedback loop

Replay retains the actual Sonnet semantic text; only old private reference handles are rebased to freshly authorized live handles. Authenticated API commands seed anonymous selected notes and current opportunities, configured SDK receives a fake external model, and the registered worker executes and publishes. Readback uses rejection as a diagnostic target for the two reviewed defects. This is not a historical schema-contract breach: current `cited_unverified` deliberately proves reference membership, not entailment. A future repair/recomposition can also meet the product goal; blanket rejection is not prescribed. The anonymous case is already minimized to the offending first claim and its exact original note. Mixed replay initially retains all three actual claims; `CAPTURED_SUPPORT_MINIMAL=1` removes the two neighboring claims, retaining the unchanged faulty inference. It still performs current SQL read. This is a captured host-publication counterexample, not a fresh model behavior experiment.

```sh
PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config tools/ask-evaluation/diagnostics/captured-support-vitest.config.ts
CAPTURED_SUPPORT_MINIMAL=1 PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config tools/ask-evaluation/diagnostics/captured-support-vitest.config.ts
CAPTURED_SUPPORT_MINIMAL=1 CAPTURED_SUPPORT_INVALID_REF=1 PATH=/opt/homebrew/opt/node@24/bin:$PATH npx vitest run --config tools/ask-evaluation/diagnostics/captured-support-vitest.config.ts
```

Executed full replay: 2/2 red, 5.39 seconds. Minimized replay: 2/2 red, 4.70 seconds; repeated after adding explicit current SQL prompt observation: 2/2 red, 5.43 seconds. Exact symptom is `expected unavailable, received complete` for both reviewed candidates. Negative reference control: 2/2 green, 5.28 seconds. Unknown handles are rejected; valid handles attached to unsupported semantic claims pass.

Anonymous original has speaker null, first-person “I could show”; unchanged candidate asserts “the team could show.” The mixed inference says “Based on the note and CRM records ... one or both of these pilots” with only its original citation, omitting SQL support. The current East/qualified and West/new observations are present in the model prompt. Neither retrieval omission nor absent metadata explains these minimized counterexamples.

## Ranked hypotheses (sent to integrator before probes)

1. Reference membership validates availability, not semantic entailment. Prediction: unknown handle rejects while unchanged unsupported wording with an authorized handle publishes. Confirmed negative control.
2. Final-tool prose guidance is advisory. Prediction: captured violations still publish despite configured guidance; removing a neighboring cited SQL claim does not change rejection. Confirmed minimized replay. This is not a claim about the probability a fresh model follows guidance.
3. The fact/inference schema lacks structured attribution and per-premise dependency obligations. Prediction: the host cannot distinguish anonymous-author invention or omitted SQL premise without an additional support representation. Source inspection confirms present guard only checks schema, duplicate/reference membership, and current authority.
4. Retrieval omission explains semantic failure. Prediction: making source speaker metadata and current exact records available should eliminate publication. Falsified in the controlled replay (same bad candidate, both observations available).

## Smallest credible engineering prototype

There is a correct full integration seam to replay and lock down host behavior. There is **no existing deterministic general semantic entailment seam**: broad model prose plus valid citations is insufficient to prove an actor or that all reasoning premises are cited. A word regex such as rejecting “team” cannot solve attribution in general, and blindly appending all SQL references would invent support.

Prototype typed support assertions for the narrow high-risk classes: source quote/span with observed speaker identity (unknown stays unknown), and current CRM fact selected from executed result fields. Host validates the asserted identifiers/values and renders those facts with canonical citations. Keep optional model synthesis clearly inferential and separately reviewed; do not claim that typed selection alone validates all free-form reasoning. A model support-review/repair stage could improve general prose but requires a measured evaluation and is not deterministic proof. Research should choose the smallest contract change; do not add a new retrieval platform based on these failures alone.

## Artifact integrity

- `history_02-answer.json` SHA-256 `eb556a33c364e5ae7ed536f3e22a0d37f72fb62414dedf2fe8cc6a8b96ce33e2`
- `history_03-answer.json` SHA-256 `fc2c812d5133e3f2c4714d94978fc73b5a61dd29d1f402701d235daa88ed1676`
