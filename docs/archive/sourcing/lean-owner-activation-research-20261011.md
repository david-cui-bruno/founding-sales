# Lean owner-controlled activation: feasibility audit

October 11, 2026. Inspected source: `3b0674b20d16e83a1c6c1f046d34403983659e5a`. Proposal for the next user interview, not an implemented or operational decision. No source implementation, ADR/issue changes, operations, provider calls or activation. Existing holds remain.

## Finding

**Ordinary authenticated owner consent, scoped configuration, budgets and enable/disable controls can replace privileged per-release capability receipts for founder-only CRM/AI use.** Current membership, original-source access/deletion, job fencing, provider cost accounting and sending safeguards can remain. They are not inherently dependent on an independent reviewer or a second human.

This is a substantive authorization-model change to ADR0009, requiring source and database work. It cannot be achieved by simplifying setup labels, returning `true` from a verifier or enabling controlled-fixture mode. The existing provisioner already permits the reviewer to be the owner; “independent” means the privileged operations path cannot be reached from ordinary settings. Removing that boundary changes the trust model, even for one owner.

## Two practical choices

| Choice | What changes | What remains burdensome |
| --- | --- | --- |
| Keep registry; automate exact release refresh | Trusted operations assembles/reviews/publishes receipts and refreshes exact runtime binding after deployment. Product UI remains normal controls. | Privileged provisioning, expiry/revocation and exact deployment coupling still exist internally. Easier initial source change, less true simplification. |
| Owner consent and configuration become operational authority | Authenticated owner commands explicitly approve data handling, provider route, source scope and budget, enable the capability and retain immutable audit. Runtime validates the current owner approval/configuration and source access. | Requires replacement verifier and additive migration, plus careful preservation of race/cost/source guarantees. Removes routine deployment-to-activation choreography. |

For a founder who accepts normal startup breakage, the second is a coherent option. Keep deployment health and schema compatibility checks in the deployment/runtime platform; don't require every model request to prove that a separately provisioned receipt names the latest deployment image. Keep capability/purpose/model/configuration revision checks because changed behavior or scope can invalidate an in-flight request. This is a recommendation to discuss, not authorization to implement it.

## Actual coupling and required source changes

Sources: [capability authority](../../../packages/domain/crm/capabilityAuthority.ts), [contracts](../../../packages/contracts/src/crmActivation.ts), [capability verifiers](../../../packages/domain/crm/capabilityVerifiers.ts), [authenticated routes](../../../apps/api/src/routes/crmCapabilities.ts), [migration88](../../../packages/domain/db/migrations/0088_crm_capability_authority.sql), [migration98](../../../packages/domain/db/migrations/0098_crm_ask_execution_evidence.sql).

- Mail/Ask/extraction saves currently reject enabled configuration or persist disabled configuration and clear `authority_receipt_id`. Activation requires a receipt UUID and an exact configuration revision. Replace these activation contracts with an explicit owner approval referencing the current consent/configuration, rather than quietly making generic saves authorize external work.
- `verifyCurrentCrmCapability` and `verifyCrmCapabilityAuthority` require the registry, exact release commit/images/schema, independent review references and current receipt expiry. Replace the receipt-dependent portion with current authenticated owner policy/purpose checks. Preserve active membership, owner identity, adapter availability, mailbox account/generation/scopes, current configuration revision and disable/disconnect semantics.
- `capabilityVerifiers` composes both capability approval and separate source/request proofs. Replace the capability approval dependency without deleting its remaining checks: extraction generation/context/source owner, Ask pending/cancelled version/epoch, canonical index ownership, original evidence fingerprints, conversation attribution and exact allowed source closure.
- Backfill directly queries registry receipts for `mail_backfill` bound to allocation and scope fingerprints. An owner-config model must also replace this path with explicit bounded import approval and conserved read allocation. Otherwise capture may appear enabled while backfill still fails.
- Ask proof outputs contain a `validUntil` and `evaluationKind`; the current producer derives expiry from the receipt and returns `actual`. Update their meaning/types to represent the new current-owner authorization and actual integration/quality status honestly. Do not call provisional quality representative or use `allowControlledEvaluation=true` in production.
- Database migration88 grants only migration-role authority writes, makes registry history immutable and attaches foreign keys from four control tables. Migration98 constrains receipt contents. Use an additive migration introducing owner approval/audit support and replacing active associations. Preserve historical receipts as documentary records; do not rewrite old migrations or erase past review history.
- API/worker bootstrap currently composes the registry-backed verifiers. Compose the new shared verifier in both; avoid a UI-only shortcut where reads say enabled but workers still require old proof.
- Preserve replay-safe command receipts, expected revisions, current rechecks after waits, cancellation and financial settlements. Test concurrent disable, membership departure, account reconnect/generation changes, budget change, source deletion, changed model/purpose and unknown provider dispatch through existing authenticated/worker seams.

## Safeguards that are separable and should remain

Source ownership and deletion checks are separate from the privileged registry in the inspected `capabilityVerifiers` implementation. Ask checks its request version/epoch/cancellation, exact source/evidence/attribution and canonical-index closure before returning proof. These checks are reusable under owner approval.

Cost safety also has separate durable machinery. [Extraction handler](../../../apps/worker/src/handlers/crmExtract.ts) calculates configured daily/monthly headroom, records provider reservations and dispatch state, revalidates before dispatch/publication and conserves known/unknown usage. [Ask purpose](https://github.com/david-cui-bruno/founding-sales/blob/3b0674b20d16e83a1c6c1f046d34403983659e5a/packages/domain/crm/askAnswerAuthority.ts) keeps route/model/prices/limits/configuration snapshots separate from source evidence. [Backfill handler](../../../apps/worker/src/handlers/crmMailBackfill.ts) conserves read reservations and rechecks scope/recovery bindings. Replace the authority producer, not these financial and original-source boundaries.

Mail acquisition, hosted extraction, answering and embedding remain distinct controls; connecting Google or enabling capture must not silently approve hosted processing. Sending/calling/admission are separate systems and approvals. Ordinary owner CRM/Ask controls must never enroll recipients, resume cancelled Shirley follow-ups, approve routine replies or authorize calls. Preserve cap5 and current sending holds throughout the simplification.

Owner consent should identify provider/data use, scope, model purpose and budgets clearly, retain a dated audit, and have immediate disable/revoke semantics. It need not contain a manually entered hash, independently provisioned acceptance receipt or expiry requiring renewed consent on every ordinary deployment. Whether material scope/model/data-use changes require fresh approval is an explicit interview decision.

## What is merely setup UX

The desktop [current controls](../../../apps/desktop/src/renderer/settings/CrmCapabilitiesSection.tsx) already discover receipt IDs and provide Activate/Disable. Precise blocker messages, one combined business-email setup, provider credential readiness, plain-language budgets and Codex-readable status are presentation/integration work. They do not remove the privileged authority model or its exact-release dependency.

Codex can execute deterministic checks and inspect actual authenticated product output. David should need only genuine owner decisions/Google consent and a small set of useful outputs for product judgment. A Gmail browser tab still cannot attest Callie's capture path; a few screenshots cannot replace durable source/cost/deletion assertions. Local real transport acceptance plus synthetic scenarios is the proposed lean acceptance path, with quality limitations disclosed.

Google's OAuth flow obtains the user's grant, returns actual granted scopes and supports incremental authorization and testing localhost redirect URIs. It does not require an application-specific migration-role evaluation registry or a full cloud replica per acquisition test. That registry is our decision. Sources: [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).

## Questions worth asking before implementation

1. Should routine CRM/Ask owner Enable consent be the operational authority, retaining audit and hard guards, or should an invisible trusted acceptance registry remain?
2. Should ordinary deployments preserve enabled capabilities whenever configuration/purpose/source permissions remain compatible, with health failures stopping the affected worker, instead of requiring new authority per image?
3. Which changes require fresh owner consent: mailbox identity, source scope expansion, provider/data handling, materially changed purpose/model, increased budget? Can nonexpanding configuration changes and routine releases preserve consent?
4. Should AI quality be monitored and correctable founder-only behavior after critical deterministic checks and actual provider integration, rather than a blocking independent certification step? Critical privacy/access/cost/sending failures remain blocking; ordinary answer quality does not imply broader public readiness.

No extra reviewers, second staff member or new paid-call approval is inferred. ADR0009's approved provisional amendment remains the current documented decision until the interview explicitly revises it; source still enforces the old registry and `actual_representative` condition.
