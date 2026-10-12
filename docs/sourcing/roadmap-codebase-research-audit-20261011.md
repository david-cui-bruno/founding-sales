# Roadmap, codebase context and remaining research — October 11, 2026

Requested by David after the Ask model/agent and pgvector research. This is a source and ticket audit with fresh GitHub/CI and public-health reads; no new tests, model calls, embedding calls, runtime implementation, cloud application, Gmail acquisition, issue mutations or activation. Findings distinguish inspected implementation, retained measured results and proposed work. The root agent corrected only stale current-state/roadmap documentation alongside writing these reports.

## End state and evidence

Callie should retain relevant business conversations, independent people/firms/relationships and multiple opportunities; track supported communication progress; propose useful evidence-backed work; and answer questions with exact state or cited history. David handles substantive replies and calls. Today is action-focused with no daily briefing. Ask is a section, not a separate mode. Business Gmail is in scope; personal inbox acquisition and a wholesale inbox archive are not. Source capture, hosted extraction, Ask answering, indexing and outreach keep independent configuration/permissions.

Thirty core CRM/Ask implementation children are closed (#480–#496, #555–#561, #563–#568). #547/#580/#581 are also source-complete after PR582. Nine execution issues remain #425/#438/#460/#466/#548/#549/#550/#551/#552, with #418/#441/#479/#497 as tracking parents. Closed source is reusable implementation, not proof of complete actual semantics or ordinary enabled operation.

PR582 merged `b57e7dcc8295fd0002a4b3f5ee77c8263efa30b8`, source schema104. Required PR checks and exact main application/image/infrastructure checks passed. [Main deployment38178977774](https://github.com/david-cui-bruno/founding-sales/actions/runs/38178977774) completed as HELD with deployment/maintenance/review/smoke/readback skipped. Fresh public health during this audit confirms serving buildd49/schema88 accepted. No fresh authenticated sender-state observation is claimed. Private evidence: `.context/roadmap-audit-20261011/issues.json`, `main-deployment.log`, `public-health.json`.

## Codebase journey now understood

| Journey | Reusable implementation | Actual unfinished result / design question |
| --- | --- | --- |
| Acquire relevant business email | Normal OIDC/readonly consent, metadata qualification/rules, capture intents, canonical MIME/body representation, bounded initial and thread history, recovery/deletion | Ordinary deployed account/configuration/registered-worker capture. Subject/known-endpoint heuristics need real qualification examples, not assumptions about perfect relevance. |
| Preserve identity/context | Independent people, firm relationships, shared endpoints, copied-source contexts, explicit opportunities and reviewed corrections | Do not convert a shared endpoint or current relationship into historical individual authorship. |
| Observe progress | Event/projector and operational matching, booking and human attendance transitions, uncertain-reply holds | Real Gmail body's unknown authored ranges currently cannot satisfy the authored/Sent evidence demanded by contacted/replied and promises. Clarify supported observed-communication facts separately from verified authored commitments. |
| Extract interpretations | Configured native provider, versioned context/evidence/claims, strict output transport, conserved attempts and human decisions | Actual semantic quality, model evidence envelope, offer/current/quoted/historical/date attribution and scope. |
| Create useful work | Commitment reviews, tasks, human confirmed actions, Today/brief and prepared follow-through | Automatic promise recognition is intentionally narrow UTC prepare/review/summarize syntax. Broader useful work relies on review; decide the desired supported contract rather than claiming arbitrary promises already auto-project. |
| Ask exact state | Existing scoped authenticated SQL records/tools | Keep current state independent of narrative interpretation. |
| Ask history | Canonical original reads, selected context, browse/search/conversation expansion, sessions, safe human follow-on actions | Retrieval useful to unfamiliar questions; context packing and meaningful partial answers. |
| Semantic retrieval | Async canonical index jobs, real embedding adapter, PostgreSQL array cosine and independent hybrid rank fusion | Actual embedding configuration, coverage/lag and relevance; prospective pgvector integration is an additive change, not a new architecture. |
| Operate | Host-accounted SDK iterations, current-source checks across waits, diagnostics, cancel/recovery/deletion; owner controls and held lean release | Actual model usefulness and ordinary deployment/configuration/Enable outcomes; bootstrap and concrete held rollout remain separate approvals. |

## The material support gaps

The ordinary Gmail provider currently preserves unknown unquoted authorship instead of asserting original authored proof. `crmGmailProvider.ts` supplies those ranges; `progress.ts` requires authored support; Sent proof in `crmSources.ts` also requires it. The retained Shirley local observation illustrates the distinction: provider origin sent, sentProof false. It is not a failed send. A message's existence/direction/date can support an observed communication event without proving a human authored every body passage; commitments need a different standard. Research and reconcile those contracts before relaxing anything.

The mail extraction adapter loads `JSON.stringify({text,representation,completeness,ranges})`, while its generic prompt asks for original-text offsets. Sender, recipient, provider date, direction and neighboring-thread context are not included in that model input. Canonical product reads retain more context. This omission is a concrete interface fact and a plausible interpretation weakness, not a proven cause of the completed synthetic failures (which were selected synthetic sources). Investigate a typed model evidence envelope and explicit mapping back to raw canonical offsets. Preserve original content/context hashes and unknown identity rather than inferring certainty from headers.

Ask's fixed2,000-character nonoverlapping windows and first-window browse previews are inspected policies, not optimized context selection. A promise may be contradicted in a later message or its date may depend on the original event time. Better embeddings alone do not restore missing neighboring context. Runtime labels agent claims `cited_unverified`: canonical citation validity is not semantic entailment. That honest contract should remain visible.

## Research priorities that can change the next decisions

1. **Evidence representation and authorship.** Compare deterministic MIME/quoted/forwarded/signature parsing and sender/date/direction envelopes; define observed communication milestones versus authored commitments. Target #549/#550. The useful output is a concrete proof/unknown/error contract, with real-public-provider compatibility and test cases—not another general email parser abstraction.
2. **Context granularity and expansion.** Compare message/utterance windows, bounded overlap and neighboring messages; preserve correction chronology and provider event dates. Target #550/#551. Measure required-evidence recall and interpretation with known supporting context before adding expensive rerankers.
3. **Model capability and explicit thinking/output policy.** Establish a stronger answer/extraction baseline with known evidence, then compare cheaper current models. Pin model/endpoint/effort/output/token prices. Target #548/#550/#551. The six prior Ask failures confound discovery, format and step exhaustion; they do not rank models.
4. **Hybrid retrieval and indexing.** Improved lexical query semantics plus exact semantic candidates and rank fusion; pgvector is the leading in-database storage candidate. Preserve canonical jobs/deletion rather than add a new vector service. Target #551 and its implementation follow-ups. Measure recall/distractors/coverage/lag; add HNSW on measured latency need, not by habit.
5. **Useful partial results and generation budgets.** Reserve answer synthesis within total allowed generations/spend/deadline, bound repeated ineffective queries and separately present exact facts, supported findings and evidence gaps. Target #551. Larger caps are not a substitute for useful tools, and explicit deeper work remains separately scoped.
6. **Proportional semantic evaluation and diagnostics.** Separate output schema, citation existence, entailment/attribution/time correctness, retrieval misses, legitimate abstention and usefulness. Extend existing body-free diagnostics rather than install an observability platform. Use independent frozen expectations and controlled/public benchmark patterns; never declare repeated development cases unseen or six cases representative.

Reranking, generated contextual indexes and memory summaries are candidates only if the above measurement shows a specific deficit. We do not need more generic research on replacing PostgreSQL, adding multi-agent Ask, moving to another framework, or building another release/authority platform now. Native notifications/LinkedIn and email admission have their own retained acceptance work; they do not become dependencies for passing backend scopes.

## Ticket reconciliation to do after the design is agreed

#548 should state the useful current labeled set and development/holdout boundaries; current schema target104 and approved provisional policy supersede stale99/30-thread wording. #549 should explicitly consume ordinary deployed Gmail observation and the representation/progress distinction. #550 should evaluate typed evidence and meaningful commitments/progress, not equate structural extraction with semantic correctness. #551 should separate direct-evidence model quality, discovery quality, bounded execution, useful partial results and actual vectors. #552 should consume only the applicable independent readiness and concrete held release/configuration/ordinary operation. Keep #425's sending-specific authority separate from CRM owner consent.

Do not reopen the closed core foundations as though they do not exist. There may be targeted implementation left beneath these acceptance outcomes; source-complete is not a claim that broader automatic progress is already supported. Publish narrowly scoped follow-up work only after these identified contracts are settled. Proposed provider/model/step changes are not an expansion of the existing pending allowance.

## Audit and research navigation

- [Ask code and ticket audit](ask-ticket-codebase-audit-20261011.md)
- [Gmail/CRM capture and progress audit](crm-capture-ticket-codebase-audit-20261011.md)
- [Release and roadmap audit](roadmap-release-contract-audit-20261011.md)
- [Architecture reassessment and primary paper evidence](ask-architecture-reassessment-20261011.md)
- [Model/endpoint/evaluation review](ask-model-and-evaluation-review-20261011.md)
- [Pinned open-source implementations](ask-open-source-architecture-review-20261011.md)
- [pgvector/hybrid review](ask-pgvector-hybrid-review-20261011.md)

The next skill is codebase-design focused on evidence input and retrieval interfaces, then ticket-contract reconciliation, then TDD for agreed behavior. The research is meant to narrow implementation decisions, not indefinitely postpone live use. No release/sending/activation hold is lifted by an audit.
