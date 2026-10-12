# Ask answer-contract correction — October 12, 2026

The [actual v2 comparison](ask-answer-v2-results-20261012.md) showed both models producing correct SQL-only answers that the original-required Claim grammar rejected. David approved the correction and proportionate wording/quality decisions. This source work changes answer expressibility and model-facing guidance, not production settings or observed model usefulness.

## Implemented contract

- Agent claims have at least one actual support reference: original windows for communication clauses, executed exact-result IDs for CRM-state clauses, or both for mixed interpretations. Exact-only claims use an empty original array. Legacy extractive/inferred claims still require original support; exact-only results require the agent result version.
- Host publication and current reads still reject unknown, cross-request, duplicate, overlong or stale exact IDs. All selected/admitted inputs remain in access/deletion closure even when the answer does not cite them. Known usage settles when publication is invalidated; uncertain dispatch is not retried.
- Existing rich-citation negotiation carries exact-only prose through answer and session history. Older readers cannot represent it and receive unavailable, never a downgraded original-only claim. Exact-backed actions remain unavailable; original-only confirmed actions retain their existing behavior.
- The desktop presents SQL-only prose with dated exact CRM evidence and its existing navigation link. It hides an empty original-evidence section and avoids falsely calling the answer mixed evidence. Mixed interpretation presentation remains intact.
- The SDK retains strict structured transport for natural sentence claims. Instructions permit exact-only support, material uncertainty and explicitly plausible supported interpretation. Model-facing original content and actually executed CRM observations have distinct host-projected roles; caller/source-supplied role labels cannot override original provenance. This does not prove entailment or prevent every semantic error.

## Approved decisions and deferred runtime changes

Repeated authentication boilerplate and mandatory quotation are not usefulness requirements. Material uncertainty remains necessary for ambiguous identity, tentative offers, contradictory history and coverage. A short source-cited business summary may be useful without repeatedly saying it was not independently measured. Unsupported definitive association/state or system coverage remains a critical error.

Reasoning is an option to test, not permanently forbidden. Its actual transport, tool-choice, continuation, output/time and billing behavior must work before comparing it. Thinking remains disabled in this source correction. Bounded investigation already supports configured limits and explicit deeper-work requests while reserving final synthesis; the owner-approved budget/deadline remains authoritative. This work changes no live allowance, maxSteps or deadline and introduces no infinite loop or hidden call.

Evaluate exact-state answering, conversation summaries and ambiguous history separately. The small synthetic diagnostic is not representative customer reliability. Source completion, controlled composition, real provider semantics, deployed version and Enable remain separate. No new release or sending permission is implied. Existing stack, PostgreSQL jobs and bounded AI SDK tools remain; no compulsory vector database or framework migration.

## Verification seams and evidence

The user previously approved authenticated product commands/reads and registered workers with disposable PostgreSQL plus controlled model adapters; desktop tests cover interactions/navigation. The exact-only request first failed as unavailable, then passed after the shared contract/publication repair. Adapter tests first exposed contradictory original-only guidance and an overrideable role projection; the focused regressions passed after the fix. Desktop exact-only rendering first failed on the empty original heading, then passed.

Regressions cover selected and source-free exact answers, ordinary configured SDK → host SQL tool → decoded exact citation → persisted session/read/list, old readers, rejected exact-backed actions, unknown/cross-request/duplicate references, SQL changes during/after generation, uncited selected-source deletion during/after generation, billing, existing cancellation and source-backed behavior. These are controlled tests, not actual Bedrock quality evidence. The earlier paid v2 authority is consumed; any next actual repaired-source comparison needs its own reviewed cases/source and explicitly approved allowance.

No schema migration, provider dispatch, settings change, deployment, activation or sending occurred. #551 remains open for its actual configured quality outcome. Preserve the release hold, cap5/lower caps/ramp, Shirley identity/cancelled follow-up, uncertain sends and admission/routine replies/autonomous calling OFF.

Local verification on the correction diff: root typecheck/lint passed; contracts105tests, four focused API files27tests, SDK31tests and desktop answer component18tests passed. Commands: `npm run typecheck`, `npm run lint`, `npm run test --workspace packages/contracts`, API `test/askMixedExactCitations.test.ts test/askConfiguredSdkJourney.test.ts test/askInvestigationControls.test.ts test/askAgentExecution.test.ts`, worker `test/askSdkEvidenceProjection.test.ts test/askSdkInputBound.test.ts test/askSdkJsonEncoding.test.ts test/askSdkCredentials.test.ts`, desktop `test/askAnswers.component.test.tsx`. Node24 and isolated PostgreSQL were used. CI and two-axis review are recorded with the PR source revision; these checks do not claim paid model quality.
