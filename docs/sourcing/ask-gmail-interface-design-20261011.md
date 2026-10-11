# Ask and business Gmail interface design

Focused source review, October11 UTC / October10 America/New_York, at main `f76089d725fd5617b0683a716e09a06a90b5bd50`. Applies the codebase-design skill to approved specs #554 and #562. This is implementation preparation, not new architecture authority, runtime proof, a comprehensive security/performance audit or completed refactoring. No product code, migration, package, provider, release or sending control changed.

## Conclusion

Proceed with TDD on #555 and #563 after one integration owner records the concrete additive contracts. Keep their initial paths narrow: one exact-state tool and provider step for Ask; versioned metadata qualification through existing capture for Gmail. Both tickets remain complete vertical slices; do not turn every private helper into another public interface or split them into horizontal infrastructure tickets.

The existing domain/evidence modules provide substantial depth. Preserve that depth and extend the seams that callers already use. The useful preparation is ownership and lifecycle definition, not moving files because they are large.

## Source findings and proposed interfaces

### 1. Ask execution owns the investigation; the adapter owns one provider step

Evidence: `apps/worker/src/handlers/askAnswer.ts` currently owns input snapshots, verification, reservation, dispatch, timed provider wait, recovery and final publication in a single answer path. `packages/domain/crm/askAnswerPorts.ts` exposes an answer adapter that receives the complete question/windows/groups and returns an entire answer. `apps/worker/src/providers/crmBedrock.ts` is deliberately text-only. Adding a tool loop inside that existing adapter would hide multiple accepted paid requests behind one reservation.

Recommended module: an Ask execution module owns request/turn/step identity, server-side scope, approved tool dispatch, public progress, per-step admission/settlement and terminal publication. The worker adapter retains job decoding, lease/fence and invocation. AI SDK is an internal loop implementation; a provider-step adapter is the external dependency seam, with real Bedrock and deterministic test adapters.

Its caller-facing interface should let authenticated callers request/read an investigation and execute one worker continuation, without requiring callers to orchestrate every lock and reservation. Internally, each provider step returns accepted/not-accepted/unknown, observed usage and typed tool calls or candidate output. The model never receives SQL, scope authority or financial settlement operations as tools.

Do not copy SDK retry decisions into durable recovery. Preserve the established no-wait-in-transaction rule and current Ask lifecycle lock order. Do not duplicate the whole request lifecycle in a second agent framework.

### 2. Exact state and evidence-backed synthesis need different result proofs

Evidence: `packages/domain/crm/askAnswerInput.ts` requires a nonempty selected-source corpus and chooses ten lexical groups in ordinal order. `askAnswer.ts` publication accepts only extractive text. Therefore #555 cannot merely route an exact-state tool into the legacy citation-window validator; an exact count is not a quotation.

Use an additive execution/result version: exact-state output carries the bounded domain read operation, dated result and coverage; sourced answer claims carry canonical evidence references; inference/conflict status is explicit. Keep old requests/history readable and current extraction behavior compatible. Do not force empty source lists into old contracts or treat valid citation IDs as semantic proof.

#555 establishes the exact-state path and result envelope. #556 adds cited conversation synthesis. #557 implements ranked lexical/semantic search and expansion behind the same business read interface. No independent rewrite of each caller's access filters.

### 3. Financial identity must distinguish steps from retries

Evidence: migration0082 already permits financial uniqueness by request version/epoch/stage/attempt, but the handler queries broadly by request/stage and reserves only attempt1. Reusing that handler in a loop would suppress later legitimate steps or encourage unsafe duplicate dispatch.

The integration owner must define stable run/turn/step identifiers, current authority/source fingerprint, dispatch state and operation key before changing schema. A new planned step is distinct from retrying an unknown accepted step. Preserve minimal source-free financial evidence after private content deletion; recovery cannot require an erased body to conserve money.

#555 provides per-step correctness before normal execution can make a second provider call. #559 adds explicit cancellation/deeper-work UX and safe continuation/retry. Cancellation stops fresh work; it cannot promise to undo a provider request already accepted. No default framework checkpoint store is required.

### 4. Gmail qualification returns a disposition, not permission

Evidence: `apps/worker/src/bootstrap/crmCapabilities.ts` supplies no `categorizeMetadata`; `createApprovedBusinessMailObserver` defaults to uncertain. `packages/domain/business/acquisition.ts` owns review/policy revisions. `observeApprovedBusinessMail` separately checks actual capture controls and only queues a worker intent; the capture handler verifies body authority independently.

Recommended module: business-conversation qualification owns normalized authorized metadata, identity/relationship context, current conversation decisions and applicable correspondent rules. Its interface returns business/review/excluded, a fixed reason, qualification version and exact input/decision fingerprints. Known endpoints inform relevance without inventing a person, opportunity or blanket sender/domain rule.

Keep this implementation in the domain module; bootstrap supplies dependencies and registration. Do not make sync, backfill and desktop each implement their own business criteria. Body-dependent or hosted classification requires separately authorized inputs; uncertain metadata does not authorize a body read merely to improve classification.

#563 supplies the automatic path using existing observation/capture intent. #565 owns user rule changes and explicit missed-conversation selection using the same decision interface. Rule precedence and account generation must be frozen by the integrator before both agents edit shared contracts.

### 5. Expansion intent is narrower than a Gmail thread

Evidence: `requestCrmMailImport` fixes the90-day enumeration window. Metadata observation and decisions enforce that window too. The current Gmail interface exposes bounded message listing/body reads but no generic full-thread operation. Provider capability to fetch a thread does not define application permission to retain all messages in it.

#564 should own a versioned qualifying-thread expansion intent: mailbox/account/generation, conversation/decision revision, permitted discovery provenance, original date boundary, current allocation, progress cursor and coverage. The Gmail adapter may enumerate IDs or fetch a thread, but every resulting message still passes current inclusion, draft, deletion and body-authority checks. Do not silently widen the existing review window for every operation.

#565's selected older conversation gets explicit selection provenance; existing ninety-day bulk discovery remains bounded. #567 recovers expansion using the same intent, not an independent backfill mechanism. Enumeration, expanded-context, body and semantic coverage are separate fields.

### 6. Normalize message representation once; retain proof uncertainty

Evidence: `crmGmailProvider.ts` infers incoming only from INBOX and emits unknown authored ranges. `gmailClientHttp.ts` bounds body text and skips external MIME parts. `GmailMessageBody` already carries attachment references, but the capture adapter does not publish them into the captured message shape inspected here.

#566 should deepen the existing normalization module: supported account/participant/direction observations, original provider dates, body completeness, authored/quoted/forwarded ranges with uncertainty, and attachment references. Capture, progress and Ask consume one canonical representation. No caller independently strips quotes and declares a promise fulfilled.

Externally stored body text and named attachment content are different acquisition cases; meter body reads, preserve bounds and require explicit attachment selection before bytes/analysis. A parsing heuristic is not definitive original-authored or Sent proof. Preserve draft exclusions already implemented; new tests target actual gaps rather than rebuild those protections.

## Ownership and concurrency

| Owner | Responsibility | Coordination rule |
| --- | --- | --- |
| Integration owner | Shared contracts/schema, version compatibility, canonical access/deletion, provider-step accounting, migration numbers | Approves additive contract changes before dependent implementation starts; one migration sequence |
| Ask owner | #555 → #556; then tool/answer integration | Reuse domain exact reads/source resolver; no independent global permission store |
| Gmail owner | #563 → qualifying/selection/expansion work | Reuse decision/capture/read-allocation interfaces; no direct provider bypass |
| Independent flow owners | #557/#558/#559/#560 and #564/#565/#566/#567 | Own distinct observable flows after prerequisite contracts settle |
| Integration/acceptance owner | #561/#568 then #551/#549 receipts | Exact source readiness and real provider/semantic acceptance remain distinct |

Ask and Gmail share source identity, canonical references, coverage, original access and erasure. They do not need a new universal conversation-body table or a generic policy framework. Ask can proceed with existing captured/selected fixtures while ordinary Gmail provider acceptance is pending.

## Test seams and dependency categories

- Pure qualification/ranking/normalization computation is in-process; test only decisions needed to establish observable behavior, not every helper.
- PostgreSQL is local-substitutable through the approved real disposable PostgreSQL setup. Constraints, concurrency, transactions and recovery remain integration-tested.
- API/worker/desktop transport is remote-but-owned. Prefer existing authenticated commands/reads and actual registered worker handlers over new test-only control interfaces.
- Gmail and Bedrock are true external dependencies. Keep real adapters and deterministic controlled adapters at internal seams; adapter protocol checks remain separate from provider acceptance.

Existing evidence paths to extend: API Ask answer safety/privacy/recovery-deletion and history/action tests; business acquisition/capture/backfill/retention tests; worker CRM startup/provider tests; desktop Ask answers/history/actions and business review/operations tests. Verify exact-state tool output, second-step financial admission, unknown acceptance after interruption, rule precedence, older-thread expansion, archived incoming direction, partial MIME, source erasure mid-wait and preserved sending controls.

Replacement tests can supersede obsolete internal-helper tests only after equivalent public behavior coverage exists. Never delete lifecycle/authority regressions merely to make a refactor green. Full repository checks and actual applicable upgrade tests belong to implementation tickets; none was rerun or claimed for this documentation review.

## Ticket sizing and readiness

The thirteen approved implementation tickets remain coherent vertical outcomes. #555 and #563 are the largest because they establish shared interfaces; keep their first demonstrated paths as described above. #561/#568 integrate source work, while #551/#549 verify actual affected capabilities. Native dependency edges link those acceptance gates to the new source integration without making Ask a blanket prerequisite for capture.

Model/package/extension configuration remains an implementation verification task; actual grants, consent, paid calls and representative quality remain operational/evaluation evidence. Unknown facts are not solved by another placeholder adapter. If implementation reveals a materially larger indivisible migration or provider protocol change, report it and resize that ticket from evidence rather than preemptively multiplying tickets.

## Housekeeping and next action

Preserve the throwaway prototype on `prototype/ask-three-approaches-20261010`; start product implementation from current main. Save selected primary research with this documentation change and keep private scratch/historical evidence intact. Reconcile canonical roadmap pointers with #554/#562 and their dependencies. No deletion of untracked material or credential reuse.

Next: TDD on #555 and #563 with centralized contracts, then the dependency frontiers. Apply code-review against each completed specification/source diff; use diagnosing-bugs for reproduced failures and retro after the first integrated milestone. No repository-wide cleanup or new architecture interview is justified by this review.

Preserve the further release hold, cap5/lower caps, original Shirley provider identity/cancelled follow-up, uncertain holds, admission/routine-replies-off and all purpose/evaluation/provider/activation requirements. No fresh live-state verification is claimed.
