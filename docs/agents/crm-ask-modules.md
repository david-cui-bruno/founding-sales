# CRM and plain search implementation map

Use this map for capture, evidence processing, record search, retained human work, source deletion or capability setup. Read the root glossary and relevant ADRs first. Current operating authority is [current state](../operations/current-state.md). This map describes source ownership, not live readiness.

| Change | Caller-facing interface and implementation | Verification seam |
|---|---|---|
| Business conversations | API businessAcquisition/businessMail routes, domain business acquisition/rules/selection, mail businessQualification and worker bootstrap/crmGmail. | Authenticated commands with PostgreSQL and controlled Gmail transport. |
| Capture and original read | mail/crmSources, crmMailOriginals and worker CRM capture composition. | Command, registered capture worker, canonical original read. Metadata and original copies remain distinct. |
| History and recovery | mail/crmBackfill, crmBackfillWork, crmHistoryRecovery and crmRetainedReconciliation. | Bounded import/recovery and shared authority/coverage checks. |
| People, firms and opportunities | CRM relationships/endpoints and existing contacts/routes/opportunities. | Identity, context, record reads and corrections. A relationship does not authorize outreach. |
| Evidence and Today | CRM processing/evidence/evidenceDecisions/commitments/progress and worker processing adapters. | Request, worker, read and correction. Human decisions and verified progress remain separate. |
| Plain record and original search | API ask route, domain crm/ask, askRecords and askCorpus. | Exact SQL state, names, keyword passages, date scopes, source versions and access checks. No model, embedding, index or backfill job is required. |
| Retained human work | API askActions read/change, domain askActions/askOpenTasks and retained task contracts. | Existing tasks remain readable/completable on records and Today, with current original-source access checks. No answer-derived creation route remains. |
| Historical client compatibility | API askCompat uses the authenticated session version. | Retained legacy1.0.51 parser compatibility remains under ADR0027; no native product or fallback remains. Strict legacy record/task parser fixtures and authenticated session tests protect its plain-search API. Current clients keep relationship details and broader task search. |
| Source deletion | mail/crmSources, retention/deletion and existing privacy triggers. | Preview, deletion and current reads under PostgreSQL. Historical Ask copied content is still redacted. askAnswerLifecycle retains only the shared privacy advisory lock. |
| Owner configuration | API crmCapabilities, domain capabilityAuthority/capabilityVerifiers/capabilityStartup and worker bootstrap/crmCapabilities. | Capture and extraction setup only. Legacy Answer/Embedding JSON is accepted and discarded, never used to construct adapters. |

Answering, private answer history/session UI, answering tools, model adapters, vector/index jobs and evaluation harnesses have been removed. Historical migrations, data tables, immutable receipts and deletion closure remain. No data-dropping migration is part of this deletion.

## Checks and ownership

`apps/api/test/ask*.test.ts` covers retained lexical search, historical task access/completion and installed-client compatibility. `leanAskRemoval.test.ts` checks retired routes and absent worker handlers. Existing privacy, commitments and extraction tests retain their independent coverage. Use workspace test commands, root typecheck/lint and the workflow fast gate. Local tests do not authorize provider calls or activation.

One implementer owns the whole outcome. Root coordinates spec, standards and privacy/risk review, integration and production. Sending controls and release work are independent of this source deletion.
