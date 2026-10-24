# 0018: Human-reviewed retained qualification recovery

October24 2026, issue760, child of745. Accepted LOCAL engineering contract. This does not authorize live recovery, acquisition, provider work, spending, admission, contact, sending or deployment. Existing qualification policy and owner OFF/holds remain unchanged. Controlled acceptance is not actual business eligibility.

## Separate human decisions

Two explicit current-user administrator commands reuse the existing API command runner and its atomic receipt/payload hash:

- POST `/sourcing/qualification/recovery/identity`: `retainedIdentityDecisionCommandSchema`. IDs, original hashes and UTF-16 span offsets identify a literal retained trade-name. Server derives the exact trimmed 2..300-character name, rejects surrogate splits, empty/nonalphanumeric names and unsupported/conflicting identity. It is not legal verification, a qualification fact or admission.
- POST `/sourcing/qualification/recovery/interpret`: `retainedInterpretationCommandSchema`. Human selects 1..30 unique citation-role/original-block tuples. Server resolves full original blocks and applies existing `qualificationCitationRoles`, strict evidence parsing and existing qualifier/decision owners. No client prose, quote, verdict or model output is accepted. Whole-selection failure refuses, never drops contrary selections.

The strict schemas in `packages/contracts/src/sourcingRetainedRecovery.ts` are authoritative wire shapes. Standard commandId/clientVersion, authenticated workspace, existing exact Origin/CSRF/public session revision, founder restriction, no-store and current admin policy apply. System actors are refused. Only these two closed browser command paths are added. Generic name correction/evaluation is not exposed or weakened.

Existing qualification reads add optional `currentCandidateRevision`, `interpretationOrigin` and IDs-only `recovery` metadata. Old run revision is never repurposed as the current candidate revision. `methodVersion` is `human-retained-v1`. Original source text stays escaped, in-memory and explicitly disclosed, not browser storage or audit prose.

## Identity transaction

Use canonical send-gate/identity advisory lock/candidate/run lock order. Lock/recheck current membership after waits. Require exact workspace, candidate revision and latest run ordered by requested_at DESC,id DESC. First bounded origin is terminal unavailable/invalid_evidence with immutable diagnostic extraction_rejected/citation_roles/identity_not_literal. Missing/contradictory diagnostic refuses. No company-specific exception.

Refuse nonlegacy/discovery-v1, dismissed/blocked, admitted/outreach-linked, competing identity, missing evidence, newer run, or any pending/running/unknown acquisition/reservation/runnable or claimed job for any candidate revision. Do not cancel uncertain work. Candidate-serialized source/qualification claims and network lifetime must prevent a decision from racing an in-flight fetch.

Bind exact observation/block/contentHash/relevantTextHash. Recompute retained-text hash, not an unreconstructable raw body hash. Require current website host, first-party nontruncated original, original capture within the preceding seven days and not future, selected block at most2000 characters. Reuse citation-role literal/forbidden-context checks against the proposed name. Display context and require explicit human confirmation, with unresolved/conflict refusal. Semantic certainty is not inferred by code.

Insert immutable identity decision and acquisition fence atomically before candidate mutation. Reuse collision/key checks. Changed name increments revision exactly once, needs_review and clears source-check scheduling metadata. Unchanged name retains revision but still records decision/fence. Preserve original rejected run, facts, diagnostic, timestamps, sources and hashes byte-for-byte. One decision per candidate/original scope. Different command UUID duplicates refuse, same UUID reconciles via existing receipt.

## Retained interpretation

Require exact decision/result revision/current identity/website and immutable original to remain latest. Original context/policy must match qualification-context-v7/qualification-v5. Resolve selections from original blocks, retaining all observations and their original capture/publication dates, including contrary text. Reuse citation roles, qualifier and decision owners. Review is a valid result, not eligibility.

Create exactly one NEW terminal run per decision in the same transaction. It references the decision, current revision and current policy/context, with `model_name=human-reviewed-retained-v1`. This sentinel is provenance only, never authorization. Original model provenance remains on the parent. Fingerprint includes method/version, decision, revision, original hashes and canonical selections, not ordinary provider daily-request identity. No model reservation/counting/provider invocation. Failed interpretation rolls back all partial run/fact changes, preserving the decision.

Fresh-after-lock snapshot uses database `clock_timestamp()`, not transaction-start `now()`. A narrow trusted internal qualifier/admission parameter may carry this snapshot after the owning function obtains its locks. Never accept time from wire input or change global databaseNow semantics. New requested_at must be strictly later than original/latest and not fabricated to outrank future data. Deadline is new requested_at+30minutes for existing storage constraints, never renewed source freshness. Audit is IDs/revisions/hashes/roles/versions/actor/outcome only, no name, private source text or freeform rationale.

## Durable no-acquisition fence and admission

Migration0133 adds immutable sourcing_retained_identity_decisions, unique candidate/original scope and composite workspace lineage, plus nullable retained_identity_decision_id on sourcing_qualification_runs with unique nonnull decision linkage. Existing runs default null/provider origin. Decision presence is the durable candidate retained-only fence across revisions, status/day/policy changes and retries. No automatic/browser lift exists.

Guard qualification request before fingerprint/counters/enqueue, worker claims/continuations before fetch/token/reservation/extraction, scheduler due and committed-result branches, source-check request/claim/continuation/monitoring and automatic identity/publication/proof owners. All direct invocation and queued-job paths enforce the fence. Existing unrelated acquisition is unchanged. Known pending/running/unknown work refuses recovery rather than pretending cancellation.

Existing separate reviewed admission remains the ONLY admission path, requiring a fresh exact new run/current revision, current eligible qualifier result and canonical duplicate/identity/route checks. Recovery lineage must NOT acquire research via either new-Firm creation or reused-Firm admission.

Lock internal-only `retainedRecoveryDecisionId?: string` on domain createFirm options, never generic CRM wire input. Admission validates exact current recovery lineage/admin and supplies it. createFirm validates it and inserts a durable Firm fence before its initial enqueue. Reused Firm is locked, outstanding/uncertain research refuses admission, and the fence is inserted before any enqueue. No system-actor impersonation or client suppression boolean.

Migration0133 also adds sourcing_retained_firm_acquisition_fences keyed by workspace/Firm, with Firm FK ON DELETE CASCADE and content-free decision/candidate audit IDs that do NOT cascade away on source deletion. Candidate deletion may remove source/decision lineage but surviving Firm stays fenced. Canonical merge must preserve the restrictive fence atomically or refuse the merge. No silent release. research enqueue/sweep/registered handler/enrichment enforce the Firm fence before acquisition and after waits. Admission stays refused for recovery lineage until every required candidate/Firm acquisition guard is implemented and tested. No partial delivery may claim Firm/Today success.

## Custody, ownership and checks

Persist only IDs/hashes/span offsets/role enums/acknowledgments/exact UUID and public session binding/expiry BEFORE dispatch. Storage failure refuses dispatch. Unknown/malformed/lost responses retain exact identity across reload, never auto-dispatch/remint. Explicit same-UUID reconciliation only. Clear private evidence/custody on genuine auth/session/role/expiry/workspace transitions and fence late results. Historical receipt is not current admission authority. Explicitly reread current candidate/new run before separate admission.

Root owns this ADR, shared contracts/browser boundary, tracker and integration. After the interface commit, sole outcome owner Blowfish owns migration0133, necessary domain/API/worker/research/client/server adapters and focused tests end-to-end. Shared files are handed off only by explicit root grant. Split touched hotspots within existing size ratchets. No other implementation writer. Root alone grants disposable PG/Chrome and coordinates release.

Finished spec, standards and privacy/scheduler risk reviews run once, fixes return to same reviewers. Focused tests cover original immutability, identity-only no facts/verdict/Firm, whole-selection refusal, provenance, freshness/newer-run/revision/role/CSRF/workspace/duplicate/uncertain custody and direct/queued/retry/day/version zero acquisition for recovery lineage. One actual HTTPS/signed-OIDC/disposable-PG/Chrome controlled journey composes recovery, existing policy, reviewed admission and exact canonical Firm/Today. Preserve zero outbound and unrelated normal behavior, with exact owned teardown. Actual separate phone/name blocks may remain unsupported by existing phone policy. Do not concatenate blocks or loosen qualification to manufacture business success.
