# Evidence and retrieval interface design — October 11, 2026

David authorized this design, contract reconciliation and implementation to finish the roadmap. Reuse ADR0002/0003/0008/0009/0011 and the existing stack. The approved test seams remain authenticated product commands/reads and registered worker handlers with disposable PostgreSQL and fake external adapters; desktop tests exercise rendering/navigation. Actual provider quality, production deployment and native observation remain separate.

## Chosen deep modules

### Original evidence

The external interface stays `CrmMailEvidencePort.loadOriginalInput(context, authority): Promise<string|null>`. Native composition returns a versioned typed envelope containing canonical raw text, exact source/version/hash, representation/completeness/ranges, observed headers/dates/direction and explicit unknown identity. It reports single-message coverage. The implementation owns current native processing authorization and immutable canonical conversion; callers do not each strip quotes, reconstruct author identity or calculate offsets against serialized JSON.

Bedrock composition recognizes only the current trusted mail-envelope format/source/hash and maps a unique exact quote back to raw UTF16. Repeated exact quotations require an already valid original locator rather than an arbitrary match. Publication reloads the envelope after the model wait; metadata changes invalidate claims while conserving known billed usage. No model output or header establishes human authorship or Sent proof.

### Communication observations

The existing public progress read adds bounded owner-scoped communication observations, separately from verified milestones. Its implementation derives observations from current ordinary native copies with consistent received/sent origin and direction, context/source access and original dates. Unknown/imported/diagnostic/erased/other-owner copies are excluded. No new table, stage change, task, reply-hold alteration or sending authority is introduced. Desktop labels this email activity separately from verified progress; body authorship and reply/promise proof remain unverified.

The new desktop explicitly requests observation fields. Legacy requests retain the original four-field response because the still-supported deployed desktop uses strict output parsing. The held rollout installs the backend before distributing the updated signed client; no global client minimum is raised to hide incompatibility.

### Evidence retrieval

The existing scoped history search interface hides English normalization/stopwords and ranked alternative keyword candidates for plain questions; explicit phrases, uppercase OR and exclusions retain literal search intent. Broad ordinary queries can use independently eligible semantic candidates and rank fusion. Explicit literal query intent does not trigger semantic widening. Selected small originals already enter the initial context. Bounded browse and surrounding conversation reads reuse existing canonical references, observed attribution, scope and source erasure.

The retrieval implementation continues to own source admission, authorized context expansion, canonical IDs/current hashes and truthful partial coverage. A source preview is neither full-thread completeness nor relevance ranking. New lexical behavior is controlled source behavior, not measured semantic improvement.

### Exact vector distance

The private PostgreSQL adapter uses schema-qualified pgvector cosine distance when a compatible installed extension is available, and existing exact array computation otherwise. Durable arrays, jobs, proofs, configuration dimensions and deletion remain authoritative. Valid historical float64 values outside float32 range retain array computation. Genuine query failures propagate; capability absence alone uses fallback. No runtime CREATE EXTENSION, schema migration, HNSW or second vector store. CI tests native mode in a pinned disposable PostgreSQL16/vector0.8.2 image and retains ordinary embedded extension-absent coverage.

### Bounded investigator

The host performs one accounted SDK generation per step and revalidates source/consent/cancellation across waits. The SDK uses an explicit strict `emit_answer` data tool with no execution function; its final permitted generation advertises only that output tool, with no external read tools. Exactly one valid output is converted to an answer; mixed, multiple and invalid outputs are refused without executing actions. Finalization remains inside the configured cap, not an uncounted extra request. Per-invocation SDK middleware captures returned usage before tool-choice errors so safe whole-JSON/single-fence compatibility can retain known billing without cross-call contamination. Model routes are explicit allowlisted US profiles with no automatic fallback. Native and SDK transports explicitly disable thinking for this initial comparison so provider defaults do not invisibly consume the output budget.

Model windows carry server-derived evidence authority: selected unverified text, retained mail copy or retained transcript. Inline headers/coverage assertions stay reported text; occurrence and copy-observation dates are separate. Exact CRM tools remain usable and their original hash-bound values are rendered separately, with model-only authority explaining that they are not conversation citations. These labels and source guards do not establish semantic correctness; actual evaluation and owner review remain required.

### Evaluation authority

One fresh exact scope binds one model and stage: known-selected-context interpretation or broad-history investigation. Reviewed labels, source hashes, disabled thinking, prices and all token/input/output/step/financial ceilings are bound before dispatch. Exclusive markers and durable allocation prevent allowance reuse. Historical Haiku4.5 scopes and consumed records remain unchanged. The new runner is prepared source only; it does not grant spending, declare useful outputs or activate production.

Cache accounting remains conservative. Known cache-read tokens are included in actual total input and charged at the configured full input rate. Positive cache-write usage remains unknown where no approved cache-write price bound exists; financial reservations and uncertainty holds are retained. AWS documents implicit Anthropic caching without request breakpoints and warns that writes can exceed ordinary input prices ([prompt caching](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)). Controlled cache-read success does not establish an invoice or current-model paid acceptance. A future write policy must bind pricing and reservation bounds rather than fabricate weighted token counts.

## Why these seams

Source normalization, query construction and model output mapping are in-process computation. PostgreSQL is local-substitutable with actual disposable instances. Product transports are owned modules. Gmail/Bedrock are true external adapters. New abstractions are limited to actual variation (native pgvector versus arrays; real versus controlled provider). Existing source/version/access, deletion and financial infrastructure earns its depth; no replacement framework or new authority platform is added.

## Contracts and completion

#548–#552 were reconciled on GitHub to source104, independent capture/extraction/Ask/index scope and these implementation/evaluation distinctions. #549 now separates ordinary acquisition from observed correspondence/verified authorship. #550 separates model candidates and useful reviewed commitments/progress. #551 owns retrieval/model-with-known-evidence/budget/final-answer and actual usefulness. #552 consumes only applicable readiness and the concrete held deployment/normal owner Enable.

#548 is closed as initial preparation, with actual useful-output review retained downstream in #550/#551 before affected #552 Enable. Eight execution tickets remain open until their actual required outcomes pass; source fixes alone do not close acceptance. Sending-specific #425 remains distinct; #438/#460/#466 retain supported contact, native schedule/cancel and installed notification obligations. Current release hold, cap5/lower caps, original Shirley receipt/cancelled follow-up, uncertain-send protections and admission/routine replies/calling off remain.
