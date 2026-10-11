# THROWAWAY Ask comparison harness

Question: does model-directed retrieval improve supported answers enough to justify its extra calls, compared with complete relevant conversations or lexical excerpts?

Offline only. No dependencies, credentials, network adapter, paid calls, production database, sending or activation. Synthetic access checks illustrate a design; they do not verify actual authenticated product authorization or deletion contracts. All 20 cases are exposed development cases, not a holdout. Open `ask-strategies.html` directly for the interactive demonstration. It uses simplified narrative fixtures and a four-read free-play allowance; the CLI corpus is the structured experiment preparation. Neither executes a model.

Run from repository root with pinned Node 24:

```sh
PATH=/opt/homebrew/opt/node@24/bin:$PATH node tools/ask-evaluation/prototype/compare.mjs prepare .scratch/ask-prototype
```

Outputs:

- `synthetic-corpus.json`: 20 scoped fixtures with multiple timestamped messages, draft/sent direction, exact state and coverage. Synthetic IDs and Sent proofs are fixture identifiers, not provider evidence.
- `model-requests.json`: 60 requests, one per case and approach. Expected/forbidden outcomes are omitted. Same evidence corpus and question underlies all approaches; different evidence delivery is the experimental variable. Current whole-context export omits already-deleted messages; deletion race cases also identify an explicit event requiring orchestration, not a model prompt assertion.
- `review-labels.DO-NOT-SEND-TO-MODEL.json`: separate human-review gold sidecar. Labels remain pending review.
- `draft-run-plan.json`: model/provider/budget are unbound; execution not approved and results null.
- `response-import-template.json`: schema example only, not an actual response.

The lexical candidate uses intentionally simple literal word overlap. Its retrieval can be empty and is not a production search benchmark. Exact state and coverage accompany both one-call candidates. The tool-loop candidate starts with coverage and uses only scoped reads: `search_history`, `read_conversation`, `get_exact_state`, `get_coverage`, max six calls/four turns. No read tool mutates state or grants permission.

To obtain offline observations from actual externally collected tool calls, save an array in a file:

```json
[{"caseId":"dev_14","toolCallId":"call-1","name":"search_history","arguments":{"scopeId":"synthetic:dev_14:authorized","query":"security","limit":5}}]
```

```sh
node tools/ask-evaluation/prototype/compare.mjs observe .scratch/ask-prototype /absolute/path/calls.json
```

Observations must be appended to a model's actual transcript by the operator; this harness does not execute a model loop. Bound the entire experiment to six calls/four turns, not six calls per file. For deletion-race cases, `fixturePhase: "before_deletion"` on a `read_conversation` call returns the pre-deletion read; the default later read returns `source_unavailable`. This simulates observations only. Record both reads and discard unavailable evidence before delivery; a model that merely received a pre-deletion body is not proof of deletion enforcement. Access-refusal and timeout cases are declared controlled fixtures; there is no hidden inaccessible private body in the corpus.

Import actual responses with valid case/approach, answer and declared provenance (`model`, `origin`, optional runAt/config/cost/latency/toolCalls). Imports are operator-declared and not independently verified. Do not put expected labels in model transcripts.

```sh
node tools/ask-evaluation/prototype/compare.mjs report .scratch/ask-prototype /absolute/path/actual-responses.json
```

Without a responses file the report has `actualResults: null`; it never generates fake answers or scores. Human review must evaluate source support, attribution, commitments, missing coverage and failures. Imported latency/cost remain declared measurements unless independently verified. All production release/sending/evaluation gates remain intact.

No prototype tests per skill. Dry-run export/report is the execution check. Capture only on a throwaway branch; adoption requires a separate validated decision.

## Proposed hosted experiment envelope

Prepare all three approaches on the same model, with 20 exposed development scenarios, at most 120 model calls total (20 × two one-call approaches plus 20 × four loop turns), 8,000 input / 1,000 output tokens per call, six tool calls per investigation and four model turns including final answer. Proposed maximum spend is $2. These are draft ceilings, not an approved budget, measured token estimate or implemented dispatch guard. Model, provider route, verified token prices, reserve/settlement behavior and execution authority remain unbound. Actual provider calls require an adapter with enforced aggregate limits and unknown-submission handling; this offline harness has no provider adapter. No private sources are needed.

## Current answer

The demonstration makes source selection and invalidation inspectable, and the export separates candidate requests from review expectations. It does not decide which approach answers best, whether Pi/Hermes is worth adopting, or whether vectors help. Those remain empirical questions for actual model runs. Keep this code on its throwaway branch; no production contracts or gates changed.
