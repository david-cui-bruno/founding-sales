# Ask model interface design

Keep PostgreSQL jobs, the existing AI SDK adapter and the bounded read-only tool loop. Deepen the model protocol module so the model receives clearly separated source content and current CRM observations, then writes concise paragraphs with references. Avoid a second rewriting model, critic pipeline, framework migration or new retrieval platform.

This is an implementation recommendation under [#551](https://github.com/david-cui-bruno/founding-sales/issues/551), based on source `ec57e771` and the delegated review of actual synthetic outputs. It does not record quality acceptance, a deployed version or activation. [PR584](https://github.com/david-cui-bruno/founding-sales/pull/584) already supplies mixed-proof validation, compatibility projection and citation handles; reuse those foundations. The production release hold and sending safeguards remain in effect.

## Findings in the current implementation

The ordinary path already supplies selected source windows to the first generation. The registered worker owns tool execution, limits, financial reservations, current source checks and publication. The SDK performs one generation per step without automatic tool execution or retries. Missing direct context is therefore not the explanation for every poor answer.

The model-facing interface is harder than the product question. `AskAgentStepAdapter` accepts `transcript: readonly unknown[]`. The worker mixes prior turns, canonical source windows, attribution, coverage and raw tool results into that transcript. `askAgentSdk.ts` discovers their shapes, projects handles and encodes provider messages. The model must then understand the meaning of each JSON shape as well as the citation rules. Changing a representation requires coordination across the worker and adapter.

Three distinctions are especially easy to lose:

- Selected source text can contain a From line, a date or a statement about capture coverage. These are statements in the source, not provider-observed metadata or Callie's capture status.
- A source's event date and its retained-copy observation date have different meanings. Neither establishes verified human authorship by itself.
- `readAsk` returns `verifiedOutgoingCount` and `withoutVerifiedReplyCount` over **authorized progress receipts**, with `unanswered: not_established` and partial acquisition. A zero receipt count cannot establish zero unanswered conversations.

The actual latest run returned six structurally complete Ask answers and four complete extraction generations. Its 19 model calls used 227 cents of conservative allocation, not invoiced cost. The opportunity answer used both proof types correctly. Other answers upgraded pasted headers and dates, promoted note-reported coverage into system knowledge, stated zero unanswered threads despite `not_established`, contained an unfinished sentence, or labeled a suggested solution as fact. Reference membership validation cannot determine whether a sentence follows from its evidence.

The current output asks for independent `fact`, `inference` or `conflict` claims. Each needs an original-window citation even when the useful answer concerns only SQL state; SQL-only observations must currently appear separately. The desktop renders claim text as plain paragraphs with per-claim controls. This creates a credible composition and presentation problem, but the causal claim that an array alone causes awkward prose remains unmeasured. Removing the array would not fix the observed semantic mistakes.

Code inspected: `packages/domain/crm/askAnswerPorts.ts`, `askAnswerInput.ts`, `ask.ts`, `askAnswers.ts`; `apps/worker/src/handlers/askAnswer.ts`; `apps/worker/src/providers/askAgentSdk.ts`; `packages/contracts/src/askAnswers.ts`; and `apps/desktop/src/renderer/ask/AskAnswer.tsx`.

## Alternative interfaces

| Design | Depth and locality | Cost and limit |
| --- | --- | --- |
| One execute/read module enclosing the whole Ask lifecycle | Callers learn very little; coordination concentrates behind two entry points | Broad consolidation of working lifecycle code. More change than the observed model-protocol problem needs |
| Typed context and tool exchanges with cited answer paragraphs | The existing step seam hides provider encoding, evidence projection and canonical reference decoding | Deliberate answer-version compatibility work; still requires semantic evaluation |
| One narrative with character-level evidence spans | Simple reading experience, potentially precise references | Offset, Unicode and editing rules add another failure surface. No demonstrated need for that complexity |

Choose the second design, with the third design's context-first experience and the first design's small caller interface. Preserve the current asynchronous request/read/cancel commands. Do not consolidate all domain reads, jobs and lifecycle operations into a new facade just to simplify model encoding.

## Recommended model protocol module

The seam stays at the existing Ask step adapter. Replace the untyped transcript convention with explicit current context and typed tool exchanges. The module hides the model-only projection, short-reference map, provider message/schema encoding and answer decoding. Its input accounting uses exactly the same prepared representation as dispatch.

Illustrative interface, not implemented source:

```ts
type AskModelContext = {
  question: string;
  scope: AuthorizedScopeDescription;
  sources: readonly SourceEvidence[];
  observations: readonly CrmObservation[];
  retrievalCoverage: ScopedRetrievalCoverage;
  priorTurns: readonly RevalidatedPriorTurn[];
  exchanges: readonly ReadonlyToolExchange[];
};

type AnswerPassage = {
  text: string;
  interpretation: "summary" | "inference" | "conflict";
  references: readonly EvidenceHandle[];
};

type AnswerDraft = {
  passages: readonly AnswerPassage[];
  abstained: boolean;
};
```

Each source has an untrusted `content` field and separately projected provenance. A selected note has no observed mail envelope merely because its content contains headers. Retained mail exposes its actually observed envelope with its recorded origin and limits. Dates retain their real basis; unknown identity and time remain unknown. Existing canonical associations are not upgraded to verified authorship.

CRM observations preserve their actual operation, scope and current-value proof. The model projection uses names that describe the quantities being measured. In particular, reply progress exposes counts of verified outgoing receipts and outgoing receipts without a verified reply; unanswered-conversation status remains explicitly unknown. Do not invent a new unanswered count, silently equate all correspondence with verified progress or hide inconvenient results.

Coverage describes only the current inspected scope. Acquisition coverage, retrieval scan completion and processing coverage are separate. A complete scan of selected copies is not a complete scan of Gmail. The `readCurrentAskInput` calculation also mixes lexical-group selection with `retrievalPartial` even when `agent_v1` receives all canonical windows. Reconcile that calculation with the actual provided windows and source completeness; prove complete-source and partial-source behavior through the existing seams before changing it.

Prior generated answers remain historical interpretations, not sources of current authority. Existing parent/current-source revalidation still applies. Only current admitted windows and executed observations mint reference handles.

The output is one to three directly responsive paragraphs where practical, each with bounded nonempty references. A paragraph can reference originals, SQL observations or both. The host derives its proof category from resolved references. `summary` does not mean verified fact; all generated interpretation remains explicitly unverified. The model can still mislabel inference, so the field is a presentation cue rather than a semantic certificate.

Do not add a second uncited summary field or a paid rewriting stage. That would duplicate generated content, deletion work and semantic risk. Use the same retained paragraphs for display and navigation. Prefer plain prose rather than Markdown while the renderer displays text literally.

## Host responsibilities and compatibility

The worker retains current access, owner scope, canonical identity, purpose verification, step/deadline/input/output limits, financial conservation, cancellation and current-proof validation before and after external waits. Reads retain exact-value hash checks and original-source invalidation. Unknown reference handles fail validation; never repair them heuristically or import references from arbitrary source text or old answers.

References establish current provenance, not entailment. No generic text heuristic can reliably reject every dangling sentence or unsupported inference. Keep those as actual quality failures rather than pretending structural tests solve them.

An exact-only paragraph is not legal under the current original-citation-required public schema. Introduce an explicitly negotiated answer representation, provisionally named `agent_v2`; do not loosen `agent_v1` silently. Preserve historical decoding and the safe legacy projection for answer reads and nested session read/list results. Inspect supported processor/answer versions, purpose fingerprints and database constraints before choosing the exact version fields; JSON storage alone does not prove that no migration is necessary.

The new representation requires typed retained canonical references and current-read invalidation, not merely new model strings. Exact-only and mixed paragraphs cannot use existing original-only action proof. Preserve existing historical source-only actions and manual work. Any new source-only paragraph action must deliberately freeze its original proof and immutable paragraph index through the existing action command; never reinterpret a mixed paragraph as source-only or reindex surviving passages.

Server-owned exact observations and scoped coverage remain independently visible when interpretation is insufficient. A stale narrative is withheld; opening saved history never starts a model call. Deletion must clear every newly introduced copied paragraph/reference field through the existing closure.

## Implementation and evaluation sequence

1. **Integrate the existing repair:** verify PR584's exact checks and source state. This supplies proof and compatibility behavior, not accepted quality.
2. **Own the typed protocol:** one integration owner defines current frames, source/observation projections and the supported output version. Keep worker lifecycle checks in place. Replace redundant shape-discovery code rather than layering another generic registry over it.
3. **Implement the composed answer:** paragraph/reference decoding, persistence/current reads, old-client projection, desktop rendering and explicit action eligibility belong to the same contract. Provider mapping and desktop work can run in parallel after the integration owner freezes those types; publication/readback remains one owner.
4. **Evaluate once the whole contract works:** freeze source, cases, model and limits before any dispatch. Reuse the approved synthetic-only budget only within its remaining conserved allowance. Measure known-context interpretation separately from history discovery; add natural business questions and fresh synthetic variations for the changed interface, keeping the earlier failures intact. Repeated development cases are not unseen acceptance.

Use the agreed test surface: authenticated commands and reads, registered workers, real disposable PostgreSQL and controlled external adapters. Exercise source-only/exact-only/mixed paragraphs, forged or stale references, parent-reference isolation, changed SQL during a wait and on later read, deletion/revocation, cancellation, unknown spending, old answer/session clients and human-action proof. SDK/fake-HTTP checks cover the actual strict schema and identical input-bound/dispatch preparation. Desktop checks cover readable paragraphs and correct reference navigation.

Measure actual semantics and usefulness separately: source versus observed metadata, conditional promises, historical quotes, ambiguous opportunities, not-established reply status, material coverage gaps, topic inference and incomplete input. Also measure tool necessity, time, usage and response length. Critical unsupported definitive state remains a failure even when all responses parse. This design grants no fresh private-data purpose, release, activation or outreach authority.

## Decision limits

The general model-plus-tools pattern and clear context/tool interfaces have primary-source support. The exact paragraph/reference schema, proposed answer version and expected quality improvement are engineering hypotheses. Anthropic's [tool-design guidance](https://www.anthropic.com/engineering/writing-tools-for-agents) explicitly recommends evaluating response formats for the task and model. [ALCE](https://aclanthology.org/2023.emnlp-main.398/) measures fluency, correctness and citation quality separately. Therefore validate the proposed model-facing projection and output format at the existing SDK seam before committing to the full public answer-version migration. Typed JSON is neither an entailment proof nor an enforceable prompt-injection defense; host controls remain necessary.

The recommendation preserves ADR0002's PostgreSQL processing and versioned evidence, ADR0003's original context and unresolved/shared identities, and ADR0008's current-source history and explicit human actions. It changes the proposed model/answer representation, not those settled decisions. No new research platform, vector tournament, permanent staging environment or additional owner interview is necessary to start implementation.

Source completion, actual provider operation, model usefulness and activation remain distinct. The synthetic campaign currently records 192 dispatched calls and 2045 cents of conservative allocation; earlier allowances remain separate. No further paid call ran during this design review. Production release hold, cap five and lower caps, Shirley's original send and cancelled follow-up, uncertain-send holds, and automatic admission/routine replies/autonomous calling off remain preserved.
