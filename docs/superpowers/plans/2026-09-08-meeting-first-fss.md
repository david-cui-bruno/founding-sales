# Meeting-First FSS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a preserved-data, account-first FSS that prepares useful daily calls and small campaigns, assists real replies, and books agreed meetings while the Mac sleeps.

**Architecture:** Keep the Electron/SQLite workspace and its truthful history. Add PM account/evidence records, an isolated AWS worker as the sole owner of delegated external actions, and explicit Mac commands/events. Calls and LinkedIn remain human initiated; Gmail serves permitted correspondence, not unsolicited cold campaigns.

**Tech Stack:** Node 24.20.0, Electron 44, TypeScript, React, Zod, Kysely/encrypted SQLite, Swift 6/macOS 26.4+, Vitest/Testing Library/Playwright, AWS Lambda/DynamoDB/API Gateway/EventBridge/SSM with Terraform. AWS is a planning target, not deployed infrastructure or an all-in price guarantee.

**Spec:** `docs/superpowers/specs/2026-09-08-meeting-first-fss-design.md`, explicitly approved by David on 2026-09-08 at 23:55 UTC.

## Global Constraints

- “Build on the existing FSS, not a rewrite.”
- “The first audience is **independent/regional residential PM firms, especially multifamily or mixed rental portfolios**.”
- “The incremental non-AI budget target is approximately **$20/month**.”
- “Genuine cold-email delivery remains an optional, separately gated transport.”
- “No automated prospecting voice, recording, automated SMS, LinkedIn bot or whole-mailbox training is included.”
- “Exact layout and navigation are not yet approved” and require the focused review in D3.
- “For v1, allow one active acquisition enrollment per account.” Paused/held enrollments still occupy that slot.
- “There is no automatic fallback to a second sender when a worker is unreachable.”
- “No blind Git rollback against a migrated workspace.”
- Preserve light/dark/system, density, selection, unsaved edits, suppression, immutable catalogs, identities, drafts and unknown-send evidence.
- Run every npm/npx command with `export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH";` in that command's shell. Do not install another Node major or rebuild native dependencies casually.
- Root/package/native gates have one coordinator owner. Workers run only assigned isolated tests and commit only their files. Do not run full root, native rebuild, package or real-profile acceptance concurrently.
- Source work and fictional tests are separate from activation. New grants, real mailbox reads, external research/model requests, purchases, cloud provisioning, real calls/sends/invitations and real-workspace migration require bounded authorization. No actual recipient/account defaults are embedded in tests.
- Tests must use existing temp encrypted-DB and fictional provider fixtures. Reject all unconfigured real network/provider boundaries. A fake port is not proof of a live integration.

## Baseline and scope

Plan baseline is clean `811d898`, whose only change from product baseline `78592fb` is the approved design document. Planning has not changed runtime source, profiles or connected services.

The source audit found two additional implementation facts worth preserving:

1. `startApplication.ts:491–493` wires **both** an unavailable phone launcher and unavailable inbound-readiness port. Replacing the launcher alone cannot deliver calls. A known registry of enabled/relevant inbound adapters and a real freshness barrier are required. An empty registry is valid only when explicitly initialized as having no enabled inbound adapters, not when configuration or a provider is missing.
2. `DiscoveryWorkerCommands.completeDiscoveryResearch` does not persist new external knowledge. Supplying a real research port to the old discovery worker would still not deliver account research. Plan B writes independent account-source receipts and evidence through its real repository.

## Four independently testable subsystem plans

| Plan | Working deliverable | Tasks |
|---|---|---|
| [A: Calling foundation](2026-09-08-meeting-first-phone.md) | Real native handoff through the existing outbound authorization/receipt service, with honest setup/readiness | A1–A4 |
| [B: Accounts and automatic preparation](2026-09-08-meeting-first-accounts.md) | PM-company discovery, persisted evidence/routes, rank and daily new-call allocation, preserving legacy records | B1–B5 |
| [C: Delegated mail and meetings](2026-09-08-meeting-first-worker.md) | Durable single-owner worker, relevant replies, approved sends, real booking and Mac synchronization | C1–C6 |
| [D: Campaigns and daily workspace](2026-09-08-meeting-first-campaigns.md) | Small multichannel campaigns including manual LinkedIn, approved home, truthful reporting and safe retirement | D1–D5 |

Each child is an implementation plan with its own file map, interfaces, red/green steps and acceptance boundary. This index is the shared coordination contract, not a substitute for reading the child plan and spec.

### Dependency order

1. Start A1 and A2, plus B1. A3 consumes A1/A2. A4 is the authorized real-phone proof.
2. B2/B3/B4 consume B1. B5 validates the assembled account preparation and preservation path.
3. C1 consumes B1 account IDs and B2's research-store contract. C2 and C3 follow C1, C4 consumes C1–C3, C5 consumes C1–C3 and its own scheduling rules. C6 integrates ownership and acceptance.
4. D1 consumes B1 and C1's command/event vocabulary. D2 consumes D1. D3 consumes B3, B4, C3/C5/C6 and D2, after the layout review. D4 consumes the actual events from those tasks. D5 is the final whole-workflow release/transition gate.
5. D1's pure planner may be developed alongside C3–C5, but its production adapter is not enabled until C4/C6 enforce owner/context/suppression. Missing campaign authorization is blocked, never an allow-all stub.

D3's static layout/setup review can happen early while backend work proceeds. Its implementation dependencies do not delay that review or create a dependency cycle with A3's setup screen.

Offline work can continue while a live authorization is pending, but that task's live acceptance remains visibly incomplete. Do not represent the first working call or one booked fixture meeting as completion of the whole product. Small campaigns remain part of v1.

### Database and shared-file ownership

- B1 owns `0020PmAccounts`, account tables/contracts and all schema-20 readiness/fixture updates.
- C1 owns `0021DelegatedWork`, local command/event/approval/thread/meeting projection tables and all schema-21 readiness/fixture updates.
- D1 owns `0022Campaigns`, campaigns/enrollments/manual LinkedIn drafts/outcomes and all schema-22 readiness/fixture updates.
- These numbers are allocated against this baseline. If another migration lands first, the coordinator renumbers **before** workers write migrations and updates all child references together. Never renumber an already-released migration.
- Every migration updates `app_meta.schema_version`, the ordered registry and exact fingerprint generated from actual schema. Keep historical 17/18/19 fixtures and add genuine new-version fixtures. Never relabel a current fixture as historical.
- Every current-schema change also updates the distinct admission paths in `src/main/db/plaintextDatabaseUpgrade.ts` and `src/main/backup/preReleaseBackupRuntime.ts`, with historical restore and future-version refusal tests. Passing `storageReadiness` alone does not prove upgrade/backup admission.
- The coordinator serializes hunks in `startApplication.ts`, `founderSalesDomain.ts`, preload assembly, schema/readiness files and shared test fixtures. Feature services live in focused modules, not more large facade methods.
- Source baseline tests that intentionally assert old policy remain as **legacy-mode** coverage. Add meeting-first assertions. Do not delete a failing safety test merely because the UI changes.

## Cross-plan contracts

The owner task defines both strict Zod schemas and TypeScript interfaces. The names and semantics below are fixed; field-level additions must be coordinated before consumers compile against them.

| Contract / owner | Public boundary |
|---|---|
| `accountContract.ts` / B1 | `Account`, `AccountRoute`, `AccountEvidenceBatch`, `AccountEvidenceSnapshot`; IDs are stable strings, not fake person IDs |
| `AccountRepository` / B1 | `create(input)`, `admitEvidence(input)`, `snapshot(accountId, asOf)`, `listCandidates()` through the existing scoped DB transaction discipline |
| `AccountResearchStore` / B2, C1 | Awaitable create/snapshot/admitEvidence/enqueue/claimNext/settle operations with local SQL and remote DynamoDB bindings; research events confer no execution rights |
| `accountRanking.ts` / B3 | `rankAccount(snapshot, asOf): AccountRank`, `planDailyAccountCalls(input): DailyAccountCallPlan` |
| `accountOutreach.ts` / B4 | `authorizeAccountRoute(input): AccountRouteAuthorization`; never route company-only contact data through invented people |
| `delegationContract.ts` / C1 | `DelegationCommand`, `CommandReceipt`, `WorkerEvent`, `AuthorityState`, `ApprovalSnapshot` |
| `ExecutionRepository` / C1 | `applyCommand(command)`, `reserveDispatch(input)`, `appendOutcome(input)`, `eventsAfter(cursor)` with durable CAS/transaction semantics |
| `ExecutionClient` / C6 | `submit(command): Promise<CommandReceipt>`, `sync(signal): Promise<SyncReport>`; admitted/pending and owner-applied are distinct |
| `mailThreadContract.ts` / C3 | `RelevantThread`, `ThreadReadRequest`, `ThreadPage`, `ReplyClassification` with provider and RFC identifiers separate |
| `meetingContract.ts` / C5 | `SchedulingRules`, `MeetingIntent`, `MeetingOutcome`; UTC instants plus explicit IANA timezone, durable provider event identity |
| `campaignContract.ts` / D1 | `CampaignVersion`, `Enrollment`, `StepEvidence`, `CampaignDecision`; account enrollment and step transport outcome are separate |
| `dailyContract.ts` / D3 | `DailySnapshot` with calls, answers, meetings, freshness and a bounded operational-issue summary |

### Common execution semantics

```ts
type ActionState =
  | 'prepared' | 'queued' | 'dispatching' | 'unknown'
  | 'human_reported_sent' | 'provider_accepted' | 'cancelled';
type AuthorityState = Readonly<{
  accountId: string;
  owner: 'local' | 'worker';
  generation: number;
  state: 'local' | 'delegating' | 'active' | 'paused' | 'revoked';
}>;
type CommandReceipt = Readonly<{
  commandId: string;
  status: 'pending' | 'applied' | 'rejected';
  authorityGeneration: number;
  aggregateVersion: number;
  reason: string | null;
}>;
```

`ActionState` belongs to C1's delegation contract and is reused, not redefined with divergent meanings. No lease timeout converts `dispatching`/`unknown` into safe-to-resend. No connection acceptance becomes email permission. A returned `CommandReceipt.status='pending'` is not an effective pause.

## Test/commit loop for every task

- [ ] Read the exact spec sections, task interfaces and owned source/tests.
- [ ] Add the specified production-interface regression, not a copied implementation in a test.
- [ ] Run the focused command and observe the intended failure. A typo/import path problem unrelated to the task is not sufficient RED evidence.
- [ ] Implement the task's minimal code and run focused GREEN plus typecheck/lint. Use actual SQLite services where persistence is part of the claim.
- [ ] Review spec compliance and code quality independently before integration. Resolve concrete findings with permanent tests.
- [ ] Commit only the task's enumerated files with its specified commit message. Inspect the staged path list first. Do not use `git add .` in a shared worktree.

The child task gives the actual paths, assertions and commands. No task may stop at interfaces/success stubs when its deliverable is an operational adapter.

## Coordinated source and package gates

Run after assembled source is stable, never simultaneously from workers:

```bash
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run verify
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run verify:lambdas
export PATH="/opt/homebrew/Cellar/node@24/24.20.0/bin:/opt/homebrew/bin:$PATH"; npm run verify:secrets
```

For the final candidate use the existing `verify:release` exact-marker/package sequence rather than rebuilding between checks. Extend its packaged workflow list for the new fixture paths. Build/sign a **separate candidate** and prove it with fictional profiles. Do not overwrite the installed app or canonical package as a side effect of tests. Actual source/native/platform requirements and secret scans remain enforced.

## Live activation and outcome gates

| Gate | Prerequisite and evidence |
|---|---|
| Phone | Named consenting endpoint, user approves one manual call, actual caller ID/receipt observed; cancellation and no-auto-redial verified |
| Research | Explicit public-cohort/model request authorization, configured search provider and bounded credit/cash accounting, source/claim quality checked on the actual pipeline |
| Worker | Reviewed cost estimate including table/requests/logs/SSM/KMS/egress, isolated resource namespace and an approved deployment owner; no Callie production edits |
| Mail/calendar | User confirms account, read/send/calendar scopes, data processing/retention, safe recipients and scheduling rules before OAuth/reads/sends/invitations |
| Overnight | Real worker applies approved work while Mac is asleep and reconnects without duplicate send/book; pause/revocation acknowledged by owner blocks later work |
| Real workspace | Normal quit, fresh authorized hash-verified backup including relevant recovery material, fixture restore proof, controlled upgrade and read-back preservation |
| Campaign launch | Actual bounded audience/offer/steps/caps approved; provider permission established per channel; manual LinkedIn outcome capture explained |

If approval or a device/provider prerequisite is absent, record `acceptance_blocked` with the exact missing input. Do not replace it with a fake success, silently relax a guard, or block unrelated offline tasks.

## Spec-to-task coverage

| Spec requirement | Implementing tasks |
|---|---|
| Correct Callie positioning, residential PM-first, source-backed claims | B1–B3, C3, D1/D4 |
| Real daily own-number calling, not handoff=conversation | A1–A4, B3/B4, D3 |
| Automatic company discovery and contact preparation, no routine review homework | B1/B2/B4/B5, C1/C6, D3/D4 |
| Small approved multichannel campaigns with one account enrollment | B1, C1/C4/C6, D1/D2 |
| Durable edits, warm/substantive approval, recipient/thread/context fencing | C1/C3/C4/C6, D2/D3 |
| Pure scheduling only with agreed slot and saved rules | C2/C3/C5/C6 |
| Worker single ownership, offline pending, pause/revoke, unknown reconciliation | C1/C2/C4/C6, D1/D5 |
| Manual LinkedIn, copy/open not sent, unknown inbox not silence | D1/D2/D3 |
| Bauhaus/preferences, low-noise default, focus/edit continuity | D3, D5 |
| Preserve schema/history/suppression/catalogs, no blind rollback | B1/B5, C1/C6, D1/D4/D5 |
| Booked/held/pilot facts, cost/time/edit burden and real acceptance | B5, C5/C6, D4/D5 |
| Privacy, bounded permissions, budget and prohibited integrations | Global Constraints; A4, B2/B5, C2/C6, D2/D5 |

## Planning self-review

The coordinator must check this index and all four child plans together before calling planning complete:

- [x] Every spec section maps to tasks above, including cold-call allocation, company-only contact authorization, manual LinkedIn uncertainty and actual booking.
- [x] Existing `Modify`/`Test` paths exist. Proposed `Create` paths do not accidentally overwrite existing modules. New names match across consumers.
- [x] Every task has a concrete failing assertion, implementation algorithm/boundary, focused verification and a scoped commit instruction.
- [x] Schema numbers, authority transitions and action-state vocabulary are consistent. No event-publication or lease-expiry gap becomes a duplicate external action.
- [x] No placeholder steps, hidden campaign deferral, automatic grants, counterfeit integration status or live endpoint in tests.
- [x] Document-only planning diff passes lint/whitespace/link checks and is ready for a docs-only commit separate from implementation.

## Execution choice

Recommended: subagent-driven implementation with a fresh worker per bounded task and coordinator-owned integration, reviews and release gates. Inline execution is also possible. Choose the execution mode once, not at every routine engineering step. The first executable tasks are A1/A2 and B1; no live action is needed to start their offline implementation.
