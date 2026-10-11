# Gmail connector architecture comparison

Research date: October 11, 2026, America/New_York. Callie source inspected at `aa96fc761dadc5fe71e9a6176e5eb8f6d747e5de`. “Hermes” is interpreted as NousResearch Hermes Agent. Public primary-source research and local source inspection only; no mailbox/provider access, consent, activation, deployment or sending. This is an architectural assessment, not a completed runtime, security or performance audit.

## Verdict

Keep Callie's Gmail API/OAuth/Pub/Sub foundation. The inspected design follows Google's sync architecture; there is no evidence that replacing it with OpenClaw, Hermes, IMAP or an agent framework would improve durable business capture. The stronger concerns are our integration boundaries, steady-state lifecycle coverage and the amount of operational ceremony before actual provider acceptance. We should validate and simplify these before building more infrastructure.

The [external implementation research](gmail-connector-external-research-20261011.md) records the exact first-party sources and comparator limitations. Agent Gmail tools and a durable CRM ingestion system solve different problems. An agent that can search an inbox has not thereby implemented resumable backfill, retained evidence, deletion barriers or verifiable source coverage.

| Comparator | How Gmail is connected | What to borrow |
| --- | --- | --- |
| OpenClaw | Gmail API → Pub/Sub → gog watcher → agent hook; supervised renewal | Simple connector supervision and command ergonomics; our provider transport is already in the same family. [Official guide](https://docs.openclaw.ai/automation/cron-jobs/gmail) |
| Hermes Agent | Workspace OAuth tools through gws/Python; separate IMAP/SMTP gateway for a dedicated agent inbox | Tool usability, while distinguishing an email chat channel from business-history ingestion. [Workspace guide](https://github.com/NousResearch/hermes-agent/blob/97a9ae8ee55d31bebce49f1fb6b5ef775323976a/website/docs/user-guide/skills/google-workspace.md), [gateway guide](https://github.com/NousResearch/hermes-agent/blob/97a9ae8ee55d31bebce49f1fb6b5ef775323976a/website/docs/user-guide/messaging/email.md) |
| Google Workspace CLI | General API commands plus a Pub/Sub pull/NDJSON watch helper | Development/debug ergonomics; inspected helper does not provide Callie's durable cursor/recovery guarantees. [Pinned source](https://github.com/googleworkspace/cli/blob/a3768d0e82ad83cca2da97724e46bea4ff0e6dbd/crates/google-workspace-cli/src/helpers/gmail/watch.rs) |
| EmailEngine | Gmail REST/history, shared Pub/Sub pull, daily renewal, fallback polling | Closest ingestion comparator; pull can remove a public notification endpoint, at the cost of another connectivity service/state owner if adopted. [Pub/Sub documentation](https://learn.emailengine.app/docs/accounts/gmail/gmail-pubsub) |

## What we actually built

| Layer | Inspected Callie behavior | Assessment |
| --- | --- | --- |
| Connection | Server OAuth, signed state, PKCE, scope validation, envelope-encrypted refresh tokens, account/generation binding | Appropriate for server workers that must continue when the desktop is closed |
| Change detection | Authenticated Pub/Sub webhook commits dedupe/coalesced work before acknowledgment; daily watch renewal; minute reconciliation | Correct overall pattern, with more frequent reconciliation than a purely notification-driven connector |
| Progress | String/BigInt history IDs, whole-record progress, cursor compare-and-set, bounded recovery anchored before enumeration | Necessary durable-sync correctness, not agent-framework overhead |
| Business capture | Metadata relevance/explicit decisions precede body authority; canonical retained copy; separate processing and sending authority | Product-specific policy layered above transport |
| History | Ninety-day discovery, selected older thread expansion, metered bounded recovery; attachment references and bounded text | Business-history coverage, not a complete Gmail mirror |
| Answers | Ask reads canonical permitted evidence and projections | Connector transport does not need to own the agent loop |

Source anchors: [OAuth](../../packages/domain/mail/oauth.ts), [token storage](../../packages/domain/mail/tokens.ts), [webhook route](../../apps/api/src/routes/pubsub.ts), [watch renewal](../../packages/domain/mail/watch.ts), [scheduler](../../apps/worker/src/scheduler/mailSources.ts), [sync](../../packages/domain/mail/sync.ts), [capture provider](../../packages/domain/mail/crmGmailProvider.ts), [CRM handoff](gmail-continuous-source-readiness-568.md). Google describes full/purpose-bounded synchronization, history-based partial synchronization and optional push; push can drop, so reconciliation remains necessary. [Google sync guide](https://developers.google.com/workspace/gmail/api/guides/sync), [Google push guide](https://developers.google.com/workspace/gmail/api/guides/push).

## Changes or decisions worth pursuing

### 1. Make steady-state original lifecycle coverage explicit

This is the clearest source-level coverage concern found in this inspection:

- [Normal sync](../../packages/domain/mail/sync.ts) calls `listHistory` without `includeLifecycleChanges`.
- [HTTP adapter](../../packages/domain/mail/gmailClientHttp.ts) defaults to additions and label additions; deletions and label removals require that option.
- [CRM backfill](../../apps/worker/src/handlers/crmMailBackfill.ts) requests all four change kinds and updates retained-original observations.
- [CRM scheduler](../../apps/worker/src/scheduler/crmMailBackfillSource.ts) excludes completed imports unless a thread expansion remains pending; it also skips completed recovery without expansion.

Consequently, these inspected paths do not establish continuous original deletion/label-removal tracking after backfill completion. New-message capture can still continue through the ordinary metadata observer. Do not confuse that with continued original lifecycle reconciliation. This is a source gap/handoff concern; no actual stale mailbox state was observed.

Recommended acceptance scenario: finish an import, then trash, restore, remove a label and permanently delete retained originals; run the normal registered steady-state scheduler and verify dated original observations, retained-copy behavior and truthful coverage. If continuous observation is required, assign one durable lifecycle consumer with its own current cursor/authority and route all relevant change kinds to it. Shared detection is desirable, but cursor consolidation must preserve each consumer's scope and progress.

Do not auto-delete retained Callie evidence merely because the Gmail original vanished: [ADR0006](../adr/0006-preserve-mail-copy-identity-through-deletion.md) and [ADR0007](../adr/0007-separate-original-lifecycle-and-recovery-coverage.md) deliberately separate those lifecycles. Google's history API tracks resource changes; it does not recover vanished historical contents. [History reference](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list).

### 2. Bring older operational sync onto short transaction boundaries

[Mail handlers](../../packages/domain/mail/handlers.ts) declare `business_uniqueness` for sync/recovery and `fencing_token` for watch renewal. [Job runner](../../apps/worker/src/runner/jobRunner.ts) executes both protection types inside an enclosing database transaction. The called domain code performs Gmail/token-provider network waits there. The newer CRM paths instead reserve, wait outside transactions, and revalidate before publication.

This is a verified difference in transaction shape. Long external waits can occupy connections and extend locks; throughput/lock impact was not measured. Use the newer prepare → external read → short fenced publication pattern where practical. Preserve atomic cursor/effect publication, stolen-lease refusal, sending reconciliation and partial-prefix behavior; simply removing the enclosing transaction would break existing guarantees. This deserves a focused migration, not a mechanical wrapper edit.

### 3. Offer capture-only connection if read-only CRM is a normal product mode

Ordinary [scope configuration](../../packages/domain/mail/types.ts) requests `gmail.readonly` and `gmail.send` together. Isolated acquisition OAuth already requests readonly only. The broad grant is understandable for the original sales sender, but it couples CRM onboarding to sending consent even though application authority separates them.

Recommendation: if users should connect solely to capture/search business history, make readonly a first-class connection mode and request send when that feature is enabled. Capability checks must handle absent send scope and reconnection correctly. This is a product/consent improvement, not evidence that existing sends are uncontrolled. Google recommends minimum necessary scopes; readonly is restricted and server handling has assessment implications under applicable verification rules. Distribution/verification status was not inspected. [Google scope documentation](https://developers.google.com/workspace/gmail/api/auth/scopes).

### 4. Measure capture throughput before adding concurrency or replacing adapters

The capture adapter obtains metadata and then body; historical reads are separately reserved and verified. Metadata-only qualification is intentional, but repeated metadata/token checks and sequential requests may cost latency. There is no measured real-mailbox throughput in this research.

Record requests/units per captured message, duplicate reads, queue age, history lag, backfill messages/minute, parser gaps and recovery duration. Then consider safe metadata reuse and bounded concurrent reads behind the existing provider seam. Google batching reduces HTTP overhead, not quota accounting; each inner request still counts separately. [Batch documentation](https://developers.google.com/workspace/gmail/api/guides/batch), [current quota documentation](https://developers.google.com/workspace/gmail/api/reference/quota).

Minute reconciliation is an intentional freshness contract with a heartbeat/alarm dependency. Tune it only from measured requirements and update that contract; a blind interval change would make diagnostics misleading.

### 5. Simplify provider acceptance separately from connector correctness

The operating record describes repeated isolated diagnostic provisioning/proposal/receipt fixes while actual ordinary provider acceptance remains gated. That supports investigating acceptance complexity; it does not prove every control is unnecessary. Preserve independent capture/processing/sending authority and deletion barriers while seeking one reusable bounded acceptance path.

[ADR0010](../adr/0010-isolate-acquisition-acceptance-from-activation.md) expressly requires verified isolation for acquisition diagnostics. Replacing isolated deployment with ordinary production testing would contradict that ADR and needs an explicit decision; this research makes no such change. A simpler CLI integration in a personal agent is not proof that a server CRM can discard its authorization model.

## Recommended boundary

Keep four responsibilities clear: (1) Gmail connection and bounded transport; (2) durable change/recovery orchestration; (3) business selection, retained evidence, access and deletion; (4) Ask retrieval and reasoning. Read/capture and sending share account identity but need separate capability checks. No agent framework belongs inside the connector's cursor or authority machinery.

For a durable ingestion comparator, prioritize systems such as Nango/EmailEngine alongside Google sync guidance. For agent command ergonomics, study gogcli/gws and OpenClaw/Hermes. Adopt useful implementation patterns behind Callie's existing interfaces rather than replacing its evidence model with subprocess output or raw model-facing Gmail tools.

## Practical next step

Validate the completed-backfill lifecycle scenario and transaction-boundary behavior first, then complete the existing bounded actual-provider acceptance using the approved procedure. Add a compact measured report before authorizing another broad architecture rewrite. Readonly onboarding and throughput improvements can be scoped afterward from those results.

The [current operating record](../operations/current-state.md) and [roadmap](roadmap-20261007.md) retain provider/evaluation/release/activation gates. These are dated records, not fresh deployed-state verification. This document changes no ADR, issue, product code, configuration or operational state.
