# Simplifying CRM activation and acceptance

Research date: October 11, 2026. Source inspected: `3b0674b20d16e83a1c6c1f046d34403983659e5a`. This is a proposal and source audit, not a live readiness or authorization receipt. No operations, grants, provider calls, ticket mutations or activation were performed. Every current release/sending/activation hold remains in force.

## Recommendation

Keep deployment and capability enablement separate. Make deployment produce a trusted release receipt automatically, and make capability readiness a readable list of precise missing prerequisites. Assemble authority proposals automatically in a trusted operations path, rather than asking David to coordinate fingerprints, references and revisions. Preserve the separate approval/publication boundary and runtime checks initially. Do not rebuild the CRM or introduce a third-party feature-flag service to hide this custom authorization contract.

The current UI already has Activate/Disable buttons and discovers receipt IDs itself. The largest activation problems are the missing operational assembly path, vague failure reasons, and overly broad evidence dependencies—not a missing toggle. Gmail's 140-resource acceptance stack is a separate architectural choice under ADR0010, not a Google requirement. Changing that choice requires an explicit ADR revision; treating a browser observation as provider acquisition proof would not solve it.

## What the actual implementation does

Sources: [authority module](../../packages/domain/crm/capabilityAuthority.ts), [authority schema](../../packages/contracts/src/crmActivation.ts), [authenticated routes](../../apps/api/src/routes/crmCapabilities.ts), [desktop controls](../../apps/desktop/src/renderer/settings/CrmCapabilitiesSection.tsx), [worker proof consumers](../../packages/domain/crm/capabilityVerifiers.ts).

1. Settings saves are disabled saves. They increment the configuration revision and clear its authority binding.
2. `provisionCrmCapabilityAuthority` is a trusted operation: the database session must belong to `migration`. It validates the receipt shape, fingerprints and internal consistency, and inserts immutable authority audit history. Ordinary app routes do not expose provisioning.
3. A read discovers a receipt matching the proposed next configuration revision; desktop activation uses that discovered ID. No digest must be typed by the end user at this point.
4. Activation is an authenticated owner/admin command, with optimistic revision checking. It verifies the proposed revision's authority before enabling it. Disable clears the authority association and advances the revision.
5. Verification checks current configuration, runtime adapter availability, release source/images/schema, a stored `ci-gate` release record, owner membership, receipt expiry/revocation and applicable mailbox generation/account/scope observation. Capture additionally requires current enabled metadata authority.
6. Runtime consumers revalidate current authority; processing cannot continue solely because a button was once clicked. Revocation and stale bindings remain meaningful across waits.

The contract permits the receipt's `reviewedBy` to equal the owner; it does not require two different humans. “Independent” here means trusted provisioning is separate from ordinary application configuration, not a compulsory second staff member. ADR0009 calls for independent review; that decision should remain visible when selecting the reviewing actor.

An important limit: many evidence fields are **named references**, not parsed evidence artifacts. Provisioning does not itself fetch an evaluation report, determine whether it is representative, or verify that a deletion acceptance actually occurred. The trusted reviewer/provisioner is responsible for that meaning. An automatic assembler must validate those artifacts; merely filling reference strings would automate paperwork without establishing readiness.

## Genuine complexity versus presentation complexity

| Concern | Current behavior | Simplification |
| --- | --- | --- |
| Why is activation blocked? | Most verification paths return null; read usually exposes `authority_unavailable` or `configuration_unavailable`. | Structured body-free blockers, with a precise action and relevant evidence link. Keep failure closed. |
| Receipt discovery | Already implemented for proposed configuration revision. | Reuse it; no new manual receipt-entry UI. |
| Receipt construction | Trusted provisioning domain seam exists; no complete user-facing assembly workflow was found in the inspected operations scripts. | One trusted prepare/review/publish path producing a compact capability proposal. |
| Exact release binding | Every authority receipt pins commit, API/worker digests and schema. An otherwise harmless new release can invalidate current authority. | Initially automate exact rebinding with evidence reuse only after explicit reviewer approval. Consider compatibility-scoped evaluation reuse later; do not silently relax runtime binding. |
| Metadata and body capture | Separate authorities, with capture dependent on metadata readiness. | One business-email setup flow presenting both steps together; preserve distinct internal scopes. |
| Native acceptance | Receipt schema requires a named native acceptance reference in every release proof. | Define which capability actually needs installed-client acceptance. Avoid making unrelated OS alerts or LinkedIn scheduling block backend capture. Any schema/contract relaxation requires review. |
| Ask answer versus embedding | Separate configured purposes and provider budgets. | Show one Ask setup with independent answering/indexing status and explicit provider data use. Preserve purpose fences. |
| Failed/expired authority | Readiness and expiry cause operational blocks. | Show “configured”, “ready”, “enabled”, and “blocked”; surface expiry before it causes unexplained downtime. |

UI consolidation alone is compatible with ADR0009. Letting application configuration mint authority, removing independent review, accepting synthetic proof as representative real-business quality, or relaxing exact release binding is a genuine authorization-model change. Each requires an explicit revised decision and tests, not a cosmetic ticket.

## Can Codex verify it directly?

Yes, Codex can perform the engineering checks and record evidence through supported authenticated commands and normal browser interactions. It cannot replace the events those checks are intended to witness.

| Codex can verify when authorized | What that does not establish |
| --- | --- |
| Fresh product sign-in, scope display and actual OAuth callback/account observation. | A Gmail tab already logged in does not prove Callie's own OAuth scopes, tokens or generation. Password/MFA and grant decisions still belong to David. |
| Exact deployed runtime/build/schema, saved release record, feature state and durable activation readback. | Green CI, healthy HTTP or visible navigation alone does not prove provider acquisition. |
| Actual incoming/Sent source capture through product/worker, private canonical read, idempotence and deletion/tombstone behavior. | Seeing an email in Gmail or copying it into a fixture does not exercise Callie's capture parser or deletion path. |
| Disposable PostgreSQL and fake provider tests for races, history interruptions, stale generations, opt-outs, injection and revocation. | Controlled outputs cannot be reported as actual Gmail events or real model/vector quality. |
| Run labeled synthetic evaluations, inspect outputs against source truth, check citation navigation and report cost/latency. | A model reviewing its own generated scenarios is not independent proof of representative business reliability. Small real samples also do not justify broad statistical claims. |
| Normal desktop Settings, notification delivery/click routing and schedule/cancel behavior once separately authorized. | Component tests or a browser screenshot cannot prove native OS delivery or an external scheduling receipt. |

Google documents an OAuth web flow where the user decides consent and the application receives an actual authorization result. Localhost redirect URIs are supported for testing. These facts support a possible local acceptance environment; they do not establish that Callie's present isolation verifier, secret handling or release contracts support localhost. Google also identifies Gmail readonly as a restricted scope; local testing is not an exemption from correct scope and data handling. Sources: [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [Gmail scope reference](https://developers.google.com/workspace/gmail/api/auth/scopes).

## Evidence should be proportionate to the claim

Use three lanes: deterministic correctness/regression, real integration, and business usefulness. One short acceptance checklist can show all three without conflating them. Collect useful synthetic scenarios now; do not wait for a fictional collection of thirty customers. Report the unavailable representative categories and collect authorized real examples as business activity grows.

Anthropic describes starting with a small meaningful evaluation set, combining graders, examining actual outcomes rather than transcript appearances, and adding real failures over time. LangSmith distinguishes offline evaluation from online monitoring and routes sampled production runs to review. These support continuous evaluation instead of treating a large initial corpus as a fixed finish line. They do **not** prove that our current implementation passes, nor authorize waiving the current `actual_representative` activation requirement. Sources: [Anthropic agent evaluations](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), [LangSmith evaluation types](https://docs.langchain.com/langsmith/evaluation-types).

OpenFeature exposes evaluation reason/error details and defaults under failure. That is a useful readiness/read UX pattern; it does not replace an authorization registry. LaunchDarkly's release pipelines separate audience, environment, approvals and automated steps, illustrating that the operator can see a simple release flow while internal checks remain automated. Neither service is recommended as a new dependency for this founder-scale application. Sources: [OpenFeature flag evaluation](https://openfeature.dev/specification/sections/flag-evaluation/), [LaunchDarkly release pipelines](https://launchdarkly.com/docs/fed-docs/home/releases/release-pipelines).

## Concrete edits to existing tickets

The following refer to issue bodies read on October 11: [#547](https://github.com/david-cui-bruno/founding-sales/issues/547), [#548](https://github.com/david-cui-bruno/founding-sales/issues/548), [#549](https://github.com/david-cui-bruno/founding-sales/issues/549), [#550](https://github.com/david-cui-bruno/founding-sales/issues/550), [#551](https://github.com/david-cui-bruno/founding-sales/issues/551), [#552](https://github.com/david-cui-bruno/founding-sales/issues/552).

- **#547:** Replace infrastructure-specific acceptance wording only after choosing and approving the revised isolation contract. Keep the two selected originals, real product/worker transport, exact read conservation, canonical delete/unavailable read, consent/revocation and body-free receipts. Evaluate local disposable environment or scoped acceptance on the held deployment; neither is approved by this note. Avoid introducing another sprawling diagnostic framework.
- **#548:** Keep thirty as allocation/coverage planning, not a prerequisite for sourcing thirty real threads. Separate synthetic release regression from real-provider integration and real-business monitoring. Freeze a small useful labeled set first and mark missing categories. Explicitly decide what evidence permits limited first-user AI use when representative real conversations are unavailable; current gates cannot be bypassed by renaming synthetic tests.
- **#549:** Produce one capture checklist with each criterion's expected evidence class. Use controlled adapters for rare history/race states and a short real-provider path for ordinary acquisition. Do not force all adversarial states to be manufactured in David's live Gmail. Reuse existing deletion tests and provider acceptance only for their actual scope.
- **#550:** Separate database-derived conversation progress from hosted extraction. Evaluate relevant supported facts and critical attribution errors; do not make deterministic progress wait on unrelated model readiness. Keep opportunity stages human-controlled and no silence-triggered sending.
- **#551:** Make end-to-end cited answer usefulness the acceptance target. Keep lexical/vector/fusion diagnostics optional and aimed at reproduced retrieval failures, as the reconciled body already says. No architecture tournament. Preserve exact versions, budget, deletion/injection/access tests and uncertainty reporting.
- **#552:** Use the trusted activation proposal assembler and precise readiness screen. Remove stale schema89/90 references in favor of inspected released/target versions, while retaining schema88 as the dated production receipt. Capture, progress, hosted answering and embedding should carry independent states. Avoid an umbrella “all native acceptance” blocker unless the specific capability needs it. Document separate deployed and enabled receipts.

## Minimal additive simplification tickets

Keep this to **two source tickets**, not a new acceptance platform:

1. **Trusted readiness and evidence assembly.** One shared computation returns typed blockers and current binding summaries; desktop and operations consume it. A trusted assembler fetches actual releases, grants, evaluation/deletion/provider artifacts and proposed revisions, emitting a body-free immutable proposal. A protected publisher consumes the independently approved proposal, rechecks current bindings, provisions through the migration authority seam, and supports idempotent readback/revocation. Acceptance covers stale revision/generation/release, concurrency, expiry, duplicate publication and failed/unknown outcomes; ordinary application access cannot write authority. Reuse existing Activate/Disable commands and UI, adding precise blockers rather than another control system.
2. **Release coordinator with trusted readiness input.** One normal deploy operation combines existing preflight, migration/rollout, health checks and exact release-record readback, and produces a capability impact report. The assembler consumes that exact record instead of manually copying digests/schema/source. Preserve recovery and independent approval for protected changes; deployment must not activate externally effective capabilities. Reuse release machinery that already works rather than rebuilding it.

Refreshing an exact-release authority receipt is **not the same as repeating every semantic-quality evaluation**. Current code requires a new valid receipt for a changed release binding, but does not require a fresh evaluation run merely because the deployment commit changed. The trusted review can determine which existing evidence remains applicable and which regressions need rerunning; the proposal must expose that decision. Keep exact runtime commit/image/schema binding until an explicitly approved compatibility policy says otherwise. A broad capability-relevant compatibility model is optional later work, not a prerequisite for these two simplification tickets.

## Decision points requiring the parent discussion

1. Replace ADR0010's isolated cloud-deployment mechanism with the smallest environment that still separates diagnostic copies, authority, tokens, database and sending. Local support is feasible at the Google protocol layer, but requires Callie implementation verification.
2. Decide whether limited first-user hosted use may pass a synthetic critical-safety suite plus real provider integration and explicitly monitored provisional quality when representative business data is sparse. Current `actual_representative` policy forbids silently treating that as ready.
3. Decide whether independent operations review remains manual approval of an automatically assembled proposal or can be an approved automated policy for unchanged scopes. Application settings must not become self-authorizing.

These are three product/security tradeoffs, not invitations to reopen the chosen stack, invent extra recipients or deploy while held. The shortest route is the simple verified acceptance path, automatic evidence assembly, and one visible enable/disable flow.
