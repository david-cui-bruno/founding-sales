# Deep CRM research: Gmail acquisition and durable processing

Research date: October 8, 2026 (local). Source inspected at `acd0b927869ffc5937273388b64a2a7c7f3e074c`. Primary-source documentation checked during this research. No live mailbox, installed credentials, provider inference, grants, sending controls, deployment or production database was accessed or changed. This is research and a proposed design, not an implementation or final ADR.

Historical source findings remain dated to October8. Current source/policy distinctions are documented in [the October10 constraints review](gmail-comprehensive-capture-constraints-20261010.md); in particular, lifecycle history parsing has since changed. Use the current operating record and #562 implementation scope rather than treating this note as current readiness.

## Main findings

1. Reuse the existing authenticated notification, cursor recovery and PostgreSQL job machinery. A new workflow service is not justified by the observed requirements.
2. Gmail permissions requested in source already support body reads. The important gaps are application acquisition policy and data modeling: unknown correspondents are metadata-only, and most manual Sent bodies are not captured. These are not fixed by adding a Gmail UI connector.
3. The current history adapter requests/parses additions only. Delete and removed-label events need explicit handling for a trustworthy CRM timeline and evidence lifecycle.
4. Preserve the urgent reply/suppression path. Rich classification, historical extraction and embeddings belong behind separate asynchronous, bounded stages.
5. The current published Gmail quota table changed in May 2026. Backfill estimates must use the actual project's effective limits, not remembered old defaults.
6. CRM/AI-summary use is explicitly supported by Google policy, but indefinite source retention, hosted transfers and public OAuth distribution require concrete policy/configuration verification. The user-approved product intent is not evidence of provider approval.

## Shipped foundations, source-only foundations, and new work

The [current operating record](../operations/current-state.md) describes production at `be846f68`, schema63, with subsequent source at schema69 held for the integrated release. This research did not refresh live state. Do not describe current source features as deployed capabilities.

| Foundation or gap | Repository evidence | Interpretation |
| --- | --- | --- |
| OAuth read/send separation | `packages/domain/mail/types.ts:59`; `oauth.ts:424` | Requests `gmail.readonly` and `gmail.send`, and refuses incomplete grants. Existing source permits read bodies; actual configured grant still needs verification before activation. New read-only CRM capability must not inherit authority to send. |
| Metadata-first acquisition | `pipeline.ts:282`; `messages.ts:337`; `db/migrations/0009_mail.sql:352` | No match ends processing before body acquisition; body storage requires a match, including a database constraint. Unknown business prospects need an explicit new acquisition boundary, not a fabricated firm match. |
| Manual Sent body gap | `pipeline.ts:332` | Only an active meeting follow-through draft generally causes direct outbound content acquisition. General manual replies currently remain metadata-only. |
| Current body representation | `gmailClientHttp.ts:646`; `messages.ts:340` | HTTP adapter normalizes full MIME content and caps at100,000 characters. Body table upserts one current text, not versioned evidence. Empty/truncated content must remain explicit; a versioned projection system needs more than this table. |
| Missing history event types | `gmailClientHttp.ts:577`; `gmailClientHttp.ts:610` | Only `messageAdded`/`labelAdded` are requested and parsed. Deletions and label removals currently cannot arrive through this interface. |
| Recovery | `recover.ts:41`; `sync.ts:359`; `mailboxes.ts:128`; `apps/worker/src/scheduler/mailSources.ts:54` | Generation fences, whole-record cursor progress, overlap/unresolved-outbound floor, periodic reconciliation and continuous recovery handoff are strong reusable foundations. |
| Manual reply / safety effects | `effects.ts:547`; `today/actions.ts:31` | Direct-send activity uses actual message time and verified recipients. Current Today source tests same mailbox/thread, firm/contact and later outgoing date before clearing the incoming action. Preserve hold/stop semantics independently. Today improvements are source-only under release hold. |
| Jobs / paid attempts | `jobs/jobStore.ts:114`; `jobs/jobKinds.ts:24`; `apps/worker/src/runner/jobRunner.ts:38`; `research/reservations.ts:19` | Durable unique jobs, atomic claims, fencing, transaction-bound completion and conservative paid submission stages already exist. New kinds must register real protection, not assume a lease protects effects. |
| Existing retention | `retention/coverage.ts:159` | Unmatched metadata expires; matched correspondence follows business records. New versions/chunks/answers/embeddings/imports need their own complete retention and deletion membership. |

All paths above are repository-relative at the inspected commit. They cite executable code, not live availability.

## Gmail facts verified against current official documentation

Push is a wake-up mechanism, not a change log or message payload: it carries mailbox/history identifiers. Watches need renewal at least every seven days; Google recommends daily. Per-user notifications above one/second may be dropped; delivery can also be delayed, so periodic reconciliation remains necessary. Acknowledge a webhook only after durable acceptance; disconnect must reject delayed notifications even after watch stop. [Push guide](https://developers.google.com/workspace/gmail/api/guides/push)

History IDs increase with gaps. Expired/invalid cursors return404 and require full synchronization; validity is usually at least a week but occasionally hours. Commit only an exhausted stream's high-water ID or completely processed history-record prefix. Specific change arrays avoid duplicate identities. Permanent deletion is a distinct change from trash labels. The approved90 days is our import policy, not Gmail history-log retention. [History API](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list), [Synchronization](https://developers.google.com/workspace/gmail/api/guides/sync)

Message listing returns IDs/threadIDs, not full bodies; pages must be exhausted and `resultSizeEstimate` is not a complete count. `q` cannot be used with `gmail.metadata`. Read bodies through message get/full; keep provider message/thread identities and parsed MIME source boundaries. Date-only search uses Gmail's documented timezone interpretation; use epoch seconds for precise rolling bounds. Gmail API searches do not perform the UI's alias expansion or thread-wide matching, so known aliases must be explicit. [Message listing](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list), [Message get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get), [Formats](https://developers.google.com/workspace/gmail/api/reference/rest/v1/Format), [Filtering differences](https://developers.google.com/workspace/gmail/api/guides/filtering)

The Gmail resource's `internalDate` orders mailbox messages, normally representing SMTP acceptance; imported mail can override it. Keep provider time, parsed sender Date, acquisition time and processing time separate. Gmail thread membership alone does not establish commercial topic, human identity, current firm or answered commitment. [Message resource](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages)

The September10,2026 scopes document classifies readonly as restricted and send as sensitive. Metadata cannot read bodies; modify/full-mail permissions are unnecessary for the proposed CRM reads. Server storage/transmission of restricted-scope data normally brings security-assessment requirements; exemptions and actual app distribution must be checked. A working existing grant is not evidence of public-app verification. [Scope classifications](https://developers.google.com/workspace/gmail/api/auth/scopes), [Verification overview](https://support.google.com/cloud/answer/13463073)

## Proposed acquisition and classification boundary

Do not weaken `mail_messages_body_needs_match` by marking arbitrary mail as matched. Introduce a reviewed source acquisition authorization distinct from an operational contact match. Conceptual states:

| State | Acquisition and downstream behavior |
| --- | --- |
| Known tracked conversation / explicit selected import | Acquire bounded content with source provenance; normalize and associate. |
| Clear business outreach supported by metadata/policy | Acquire bounded content under explicit business-ingestion policy; create independent person/conversation, firm unknown if necessary. |
| Uncertain business-versus-personal | Hold in compact review queue; no automatic CRM record or richer extraction until accepted. |
| Excluded category | Retain only minimal policy-permitted acquisition bookkeeping; no body persistence, embeddings or prospect. |
| Deleted / denied / disconnected | No acquisition or downstream provider processing; retain only approved tombstone/health state. |

Metadata rules should use known business addresses, sent-to context, list/auto-submission headers, approved domain rules and explicit user overrides. A company domain or outgoing message alone is insufficient proof: receipts/support and personal introductions can share those attributes. Where confidence needs message content, the implementation must define a bounded transient classification read with clear disclosure; otherwise it remains reviewable uncertainty. Do not silently send the entire inbox to a hosted classifier merely to decide which part may be retained. This is an acquisition-policy seam for the spec, not a second questionnaire about already approved uncertain-item review.

Classification results need rule/model/prompt versions, confidence category and bounded evidence. Human inclusion/exclusion overrides survive model upgrades. Newsletter exclusion and business classification do not decide opt-out/suppression; existing safety processing remains authoritative.

## Ninety-day backfill without losing live changes

Recommended sequence, adapted from the existing recovery rather than a second competing cursor:

1. Record exact mailbox/account identity, connection generation, approved acquisition policy and bounded backfill window. Capture a provider history anchor before historical enumeration.
2. Enumerate message IDs in deterministic date slices with precise epoch bounds, bounded pages/calls and persisted progress. Do not assume paginated results are an immutable mailbox snapshot; overlap/reconciliation and ID uniqueness are required.
3. Run history synchronization from that anchor alongside bounded backfill. Use source identity uniqueness so overlap creates one message/activity, not duplicate tasks or AI spend.
4. Mark backfill complete only when all approved slices and required handoff history are exhausted, or explicitly partial with listed failures. A latest timestamp alone cannot establish coverage.
5. If history expires during backfill, renew the generation-fenced baseline handoff. Preserve the existing unresolved-outbound safety floor even when older than90days. The CRM import window and send-reconciliation window are different obligations.

Prioritize urgent live reply/suppression work over historical acquisition; then normalization/lexical visibility; then AI bulk work. Backfill retains original activity dates and never replays old outreach or floods Today with historical overdue promises. Old conversations do not create opportunities automatically.

Attachments initially remain references/names. Selective attachment analysis is a separately authorized source and cost boundary. Full-thread fetching must not silently expand the approved90-day import into older unrelated messages; an explicit on-demand older-context request can expand scope.

## Exact manual reply and source truth

A captured message can establish an observed outgoing communication only with provider-backed identity and direction, dated participants and account context. Pasted text marked draft is never a sent event. Distinguish Callie's fenced automated send from David's normal Gmail send; existing fence/RFC conflict handling must continue.

Resolve an unanswered incoming task only when the outgoing message demonstrably addresses that conversation/contact and is later than its source. Imports arriving out of order must compare source time, not processing time. A reply before a later incoming question does not clear that newer task. A forward, shared mailbox, changed firm relationship or ambiguous cross-firm recipients may require association review. Clearing a reply reminder does not clear a suppression/uncertain hold, reenroll a prospect or authorize another send.

Represent observed events separately from inferred meaning: sent/replied are dated facts, while needs/objections/commitments are evidence-backed proposals with human correction. A direct reply is not proof that every commercial question was answered. Keep body acquisition completeness visible when summaries cannot establish that meaning.

## PostgreSQL stage graph and recovery

```text
authenticated hint / explicit selected import
  -> bounded source acquisition + transactional successor intent
  -> normalization / classification / identity association
  -> dated business activity + versioned evidence
       -> deterministic tasks / lexical projection
       -> budgeted extraction -> fact proposals
       -> authorized embedding projection -> hybrid retrieval
```

This is a durable DAG implemented through existing jobs and stage state, not an enqueue-order guarantee. Each job names workspace, connection generation, source identity/revision, processor version and projection kind. Job uniqueness prevents duplicate work intent; business constraints prevent duplicate public activity/tasks. Store stage result and successor enqueue in one transaction. PostgreSQL transactions supply all-or-nothing database effects, and `SKIP LOCKED` supports contending queue consumers but does not provide global ordering or exactly-once provider calls. [Transactions](https://www.postgresql.org/docs/current/tutorial-transactions.html), [Queue locking](https://www.postgresql.org/docs/current/sql-select.html)

For new AI stages, reserve budget and mark dispatch intent durably, release broad database locks before network waits, then apply results only after rechecking worker fence, source revision, access/invalidation epoch and processor version. Generic automatic retries must not repeat ambiguous paid submissions: preserve conservative reservations and reconcile if provider supports it. A result superseded during flight can settle actual cost without becoming an active projection. Reprocessing uses new version keys, with bounded reconciliation for missing projections; it does not reset historical actions or human corrections.

Maintain separate acquisition coverage, association state, extraction state and lexical/embedding coverage. Ask may use structured/lexical results while semantic processing is pending, explicitly identifying incomplete coverage. Exact counts must remain exact structured-state queries with their coverage limitation, not approximations from vector hits.

## Deletion, disconnected accounts and in-flight races

User intent is retention until explicit deletion; disconnect stops synchronization and optional explicit deletion is separate. Preserve that design intent while checking provider requirements below. An account switch must increment connection generation so old sync jobs cannot attach one account's content to another.

Deletion first commits a tombstone/invalidation epoch and makes content inaccessible, then removes copied source versions and every dependent chunk, vector, cached answer context and derived projection. Minimal tombstones prevent reimport without keeping deleted body text. Pending workers check before reading/paying/applying; current ACL and tombstone checks also apply at retrieval and response release. Completed real-world actions remain dated facts while their deleted evidence becomes unavailable. Human-authored decisions can remain with appropriate redacted provenance; do not leave copied source quotes inside supposedly harmless correction/audit metadata.

Provider permanent deletion and Callie explicit deletion must be modeled separately. Trash is not unsend or proof of permanent deletion. After a404 history gap, enumeration of recent messages cannot reveal older source deletions; reconcile the bounded set of retained provider sources, with denied/transient reads distinguished from confirmed missing originals. Do not infer deletion from a rate-limit failure. The actual CRM treatment of provider-deleted originals must follow the documented retention policy; do not silently equate it to user-requested Callie deletion.

## Quota and cost implications

The current quota document says May1,2026 changes apply to new projects while projects used November2025–April2026 retain previous quotas. Published new limits:6,000 units/user/project/minute and1.2million/project/minute; message get20units, list5, history list2, thread get40, watch100. A daily80million/project threshold precedes planned later2026 billing; full current billing status and actual project limits remain unverified. [Current quota table](https://developers.google.com/workspace/gmail/api/reference/quota?hl=en)

Illustrative engineering calculation, not mailbox measurement: for N metadata reads and B subsequent body reads, acquisition consumes approximately20×(N+B)+5×listPages+2×historyPages, excluding retries/watch/other activity under the published table. A separate metadata then body fetch doubles message-read units for included content. Optimize after preserving acquisition policy; do not fetch all full bodies to save calls. Aggregate rate control across workers and reserve headroom for safety reads. No claim about David's N/B or completion time is possible without authorized inventory.

Model cost is separate: estimate eligible text/token bounds and versioned prices before historical inference. Reuse unchanged evidence; extract only new content rather than repeatedly processing entire growing threads. Embeddings follow changed normalized chunks and are independently versioned from extraction. A model replacement does not require reacquiring unchanged provider content.

API failures must be classified by error reason:403 can mean rate limiting or domain policy,429 can include bandwidth/concurrency limitations. Apply jittered bounded backoff to transient reads; revocation/domain denial is a connection issue, not infinite retry. No quota or account expansion is authorized by this research. [Error handling](https://developers.google.com/workspace/gmail/api/guides/handle-errors)

## Provider-policy verification checkpoint

Google's September3,2026 Workspace policy explicitly lists CRM and generative summaries as approved Gmail uses. It restricts hosted transfers to consented user-facing purposes, prohibits generalized model training, requires deletion controls/security, and separately restricts unsolicited commercial sending. Read-side CRM feasibility is not permission for cold-send operations. The same page contains a broad permanent-copy/cache note. Keep total interpretation grounded in its scope rather than declaring either unrestricted retention or a blanket CRM ban. [Workspace policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy?hl=en)

The linked API Terms section5e qualifies content-copy restrictions with content-owner permission or applicable law; section5d requires equivalent user data portability while storage persists. Those clauses and the explicit approved backup/CRM uses mean a cache header alone is not a complete retention analysis. Document the permission and retention basis, deletion/export behavior and relevant privacy disclosures before activation; do not infer ownership rights over every correspondent's content from mailbox access. No legal conclusion or provider approval is established here. [Google API Terms](https://developers.google.com/terms)

Actual OAuth client distribution/internal exemption, consent screen verification, security-assessment status, effective token scopes and hosted-provider no-general-training terms remain engineering/policy checks. The settled desire to retain imported business history is preserved, subject to those checks. These checks do not undo the deliberate release hold or change existing sending controls.

## Required evaluation cases and remaining unknowns

Verify duplicate/reordered pushes; two copies with conflicting RFC IDs; history expiry during ongoing backfill; exact time boundary and alias differences; repeated delete/removed-label events; source vanished between metadata/body reads; empty/truncated/encrypted MIME; business/personal ambiguity; shared-address unknown speaker; late old Sent import following newer incoming; draft versus send; a stale connection generation; transaction rollback between source and enqueue; stolen worker lease; delete/revoke during classification/embedding; missing projection sweep; and ambiguous paid acceptance. Assert one public CRM effect and unchanged send/hold/stop authority.

Measure live activity latency under backfill load, source coverage holes, queue age, reconciliation throughput and acquisition quota usage independently from AI tokens/cost. Set numerical SLOs after measured synthetic/authorized corpus evaluation, not an invented mailbox volume.

Unknowns requiring access/configuration verification, not guesses: actual project quota generation/limits; mailbox aliases and corpus volume; public/internal OAuth configuration and assessment status; configured grants/budgets for new processing; MIME/attachment completeness under current adapter; and the final retention/provider-delete semantics. The first mailbox remains an unanswered explicit user choice from the interview; proposed David-only default is not an accepted multi-mailbox decision.
