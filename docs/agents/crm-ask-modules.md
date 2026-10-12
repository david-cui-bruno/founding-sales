# CRM and Ask implementation map

Use this map when changing business capture, evidence processing, Ask, source deletion or capability setup. Read the root glossary and relevant ADRs first. Current outcome/status is in [operating state](../operations/current-state.md), acceptance in GitHub #549–552. This map describes module ownership, not live readiness.

## Follow the user journey

| Change | Caller-facing interface and implementation | Verification seam |
|---|---|---|
| Relevant business conversations | API businessAcquisition/businessMail routes → domain business acquisition/rules/selection → mail businessQualification; worker bootstrap/crmGmail composes Google adapter. | Authenticated qualification/inclusion/rule commands with real PostgreSQL and controlled Gmail. |
| Capture and original read | domain mail/crmSources and crmMailOriginals, worker CRM capture composition, mail/crmGmailProvider and gmailClientHttp. Original copy and metadata observations stay distinct. | Normal commands → registered worker → canonical source read. Fake transport proves lifecycle; real consent/provider observations are separate. |
| History and recovery | mail/crmBackfill, crmBackfillWork, crmHistoryRecovery and crmRetainedReconciliation. | Bounded import/recovery requests and worker continuations; shared authority/read reservation/coverage checks. |
| People/firms/opportunities | crm relationships/endpoints plus existing contacts/routes/opportunities. | Existing authenticated identity/context/record reads and corrections. Shared endpoints do not identify a speaker; recording identity does not authorize outreach. |
| Evidence and Today | crm processing/evidence/evidenceDecisions/commitments/progress; worker processing adapters and crmMailProgress. | Request/worker/read/correct journey. Interpretations, human decisions, observed activity and verified commitment progress are different outcomes. |
| Ask request and scope | API askAnswers/askSessions/askHistory routes → crm askAnswers/askSessions/askAnswerInput/askAgentScope/askSessionContext. | Authenticated request, current read, session/scope commands and history reads. |
| Ask execution and tools | worker handlers/askAnswer owns lease/admission/settlement/publication; provider askAgentSdk supplies one generation; provider askModelEvidence owns the shared model-facing provenance/date projection and private citation codec; crm askAnswerPorts is its injected interface. Domain askRecords/askCorpus/askExecutionEvidence own bounded SQL/evidence. | Registered worker with real PostgreSQL and fake model. Host executes permitted tools; no provider wait inside transactions or automatic retry of unknown dispatch. |
| Cited answer and explicit action | crm askAnswers/askHistory/askActions; desktop renderer/ask modules show answers, original navigation and confirmed tasks/annotations. | Published answer/current original navigation and explicit action commands, plus desktop interaction tests. Valid reference membership is not semantic entailment. |
| Canonical index | crm askCanonicalIndex/askVectorDistance, worker handlers/askIndex. | Registered index handler/current eligible reads; optional vector adapter proof is separate from actual embedding quality. |
| Source deletion | mail/crmSources and existing scoped-deletion closure invalidate CRM/Ask copied content; askAnswerLifecycle/history/actions participate. | Preview/delete/current reads with real PostgreSQL races; preserve source-free financial audit. |
| Owner configuration | API crmCapabilities → crm capabilityAuthority/capabilityVerifiers/capabilityStartup; worker bootstrap/crmCapabilities. | Ordinary save/explicit approval/Enable/Disable and registered worker. Settings are not actual provider evidence. |

Paths above are relative to `apps/api/src/routes`, `apps/worker/src` or `packages/domain` as named. Start at the public command/worker for the behavior you change; follow imports to internal seams rather than adding another facade.

## Test selection

Existing configured Ask journey: `apps/api/test/askConfiguredSdkJourney.test.ts`. Related behavior: `askAgentExecution.test.ts`, `askMixedExactCitations.test.ts`; worker provider protocol tests live under `apps/worker/test`. API and worker Vitest use the existing real PostgreSQL setup; integration resources must be isolated. Scenario inputs/assertions stay visible; direct-purpose seeding is controlled evidence, not normal owner-consent acceptance.

Use workspace commands in package.json with an explicit test path for focused checks. Root typecheck/lint and required CI verify integration; CI suite selection is implemented in tools/ci. Paid/provider tests require their actual separately approved scope and allowance. Routine test commands do not authorize them.

## Ownership and review

One integrator owns shared contracts/schema, current source/member access/deletion, lock ordering and financial/read-accounting semantics. Flow agents own explicit separate writable scopes. Review the frozen diff through Matt Pocock code-review's independent Standards and Spec axes before merging; material edits renew affected review/checks. Keep sending controls and the release hold independent from CRM work.

A prototype remains on its archival branch. Do not merge its runner/results into worker production source; preserve original hashes and evaluation artifacts when extracting demonstrated reusable behavior.
