# FSS adversarial product audit

Date: 2026-09-10. Audited application source: `2e629f326a346573865486508a550f831b5df820`.

## Verdict

**The app is not one coherent product yet.** It contains working, carefully guarded slices, but visible routes use competing global design systems and several essential journeys stop at disconnected backend capabilities. Some ordinary operations also have incorrect scope or misleading status. This is not adequately explained by missing live data or an unpaired worker.

I owned integration and acceptance. The previous audit and installation checks did not challenge the product broadly enough. In particular, validating Native Desk and legacy routes separately, then preserving both sets of appearance assertions, allowed the exact defect now reported. Passing those tests was not evidence of whole-app consistency.

This audit made no application-source change, installation, real-profile mutation, service activation, outreach, deployment or push. The signed candidate was exercised only with disposable fictional workspaces. No existing real company/contact data was opened. The report is a bounded adversarial audit, not a guarantee that every defect has been found.

### Evidence labels

- **R-Package:** observed in the actual signed `2e629f3` application, using its production renderer, preload and main process with an owned disposable profile.
- **R-Domain:** reproduced against actual production domain code and a disposable encrypted database, not the installed app or its data.
- **S:** directly traced through current production source. The runtime condition was not separately induced.
- **Candidate:** plausible issue needing a controlled reproduction. Not counted as confirmed behavior.

## What actually happens when switching routes

The same explicitly transitioned `meeting_first` workspace was navigated through all ten real routes, not a fixture that substitutes Today for other destinations.

| Common property, light / comfortable / 1440px | Today, Accounts, Campaigns | Leads, Pipeline, Conversations, Learnings, Inbox, Friday, Settings |
| --- | --- | --- |
| Product wordmark | Callie | FSS |
| Navigation rail | 142px | 216px |
| Heading family and size | System, 25px | Futura family, 32px |
| Workspace background | `rgb(233, 237, 242)` | `rgb(246, 240, 223)` |
| Selected navigation | 6px radius, 44px height | 2px radius, 32px height |
| Secondary destinations | Under More | Expanded |

At 1050px, the rail switches between 124px and 216px. Both light and dark themes exhibit the split, at both comfortable and compact densities.

**Coverage:** 80 route observations: ten routes × two themes × two densities × two sizes. A postprocessing comparison of all captured measurements finds the same seven mismatching routes in every context, 56 mismatching observations. The original Playwright test's final assertion compares the ten light/comfortable/1440 rows and fails on those seven routes. These are not 80 independent passing tests.

Command palette and Import opened from Today also use the old cream surface and Inter font. They sit outside the element that owns Native Desk's theme overrides.

### Direct cause

- [themes.css](../../src/renderer/design/themes.css#L147-L183) chooses global shell tokens using `.app-shell:has(.native-desk[data-presentation='native-a'])`.
- [nativeDesk.css](../../src/renderer/features/today/nativeDesk.css#L281-L321) lets one feature change its ancestor's rail, fonts, branding and content padding. Later rules also change global navigation disclosure and geometry.
- [routeRegistry.tsx](../../src/renderer/app/routeRegistry.tsx#L34-L101) mounts that feature on only three of ten routes.
- [FounderApp.tsx](../../src/renderer/app/FounderApp.tsx#L43-L75) puts shared dialogs outside AppShell. [LeadInspectorProvider.tsx](../../src/renderer/features/leadInspector/LeadInspectorProvider.tsx#L456-L490) does the same for contact surfaces.

Different route **compositions** are appropriate. Changing the application's identity, global navigation geometry and theme when navigating is not.

## Prioritized findings

P1 means data scope, a core product journey, materially misleading behavior, or an acceptance failure that blocks credible release claims. P2 means an important reliability/interaction problem. No P0, live data corruption, unauthorized send or security bypass was established.

### F01 · P1 · Editing one person's company can rename other people's company

**Evidence: R-Domain + S.** An isolated actual-domain probe imported Alice and Bob at Shared Org plus an unrelated control. Updating only Alice to New Employer changed both Alice and Bob; Control stayed unchanged and both original links remained. The mutation receipt listed only Alice. This is confirmed incorrect scope, not a conjecture or evidence that real user data has already been damaged. The Leads field is labelled “Edit organization for [person]” and sends one person ID. [applyLeadField](../../src/main/domain/founderSalesDomain.ts#L675-L702) finds that person's linked organization and updates its shared `canonical_name`, instead of reassigning just that relationship. Normal [source intake](../../src/main/domain/source/sourceService.ts#L667-L692) deliberately reuses an organization for matching company names. The receipt describes the selected person, not every affected linked person. Existing aliases are not renamed alongside the canonical label.

**Repair:** distinguish per-person company assignment from explicit global company rename. Preview and receipt the actual affected scope. Preserve identities, aliases and history rather than deleting or splitting records blindly. Until repaired, avoid using the Leads organization editor as a per-person reassignment tool.

### F02 · P1 · Global design changes by route

**Evidence: R-Package + S.** Quantified above. This is the reported defect, not a stale installed bundle or an unintended workflow-mode change.

**Repair:** one application-level presentation contract around all routes and shared overlays. Workflow authority selects content and permissions, not a second design system. Remove feature-owned ancestor-shell overrides only after the common styles and real-route tests exist.

### F03 · P2 · Shared overlays use the wrong theme and rail geometry

**Evidence: R-Package + S.** The actual signed full-page contact was also measured after opening a real imported fixture person and navigating to Native Today: left edge 216px versus rail edge 142px at 1440, and 216px versus 124px at 1050. The visible gaps are **74px and 92px**. The full-page contact surface uses root `--nav-rail-width: 216px` in [leadInspector.css](../../src/renderer/features/leadInspector/leadInspector.css#L438-L450), while the visible Native rail is 142px or 124px. The measured exposed strip matches the source prediction. Tokens do not inherit sideways from AppShell into its siblings.

**Repair:** a common presentation/overlay host and one rail geometry source. Do not add another route-specific hardcoded offset. Retain the global selected-person owner and command/draft safeguards.

### F04 · P1 · Inbox offers privacy and repair actions that production rejects

**Evidence: R-Domain for rejection, S for the enabled UI path.** Both actual domain operations returned `REVIEW_RESOLUTION_UNSUPPORTED` with the 120-table content digest and `total_changes` unchanged. The probe deliberately used an absent review ID because rejection occurs before lookup. It is not a UI-click/existing-review-row test. [ReviewDetailPanel](../../src/renderer/features/review/ReviewDetailPanel.tsx#L149-L160) enables **Mark personal (Never Record)**. Its [system-error branch](../../src/renderer/features/review/ReviewDetailPanel.tsx#L229-L259) enables **Repair invariant** for arbitrary nonempty command text. The actual [resolver](../../src/main/domain/founderSalesDomain.ts#L2041-L2052) accepts only unmatched-communication promotion, rejecting both advertised actions. The UI then presents a generic changed-item error.

**Repair:** remove/disable unsupported affordances with honest guidance, or implement exact narrow domain commands. A privacy label must not imply a protection that did not occur. Never turn arbitrary repair text into arbitrary execution.

### F05 · P1 · Inbox asserts health and successful ingestion it never checks

**Evidence: R-Package for all six displayed empty-tab claims, S for the missing source aggregation and >200 filtering case.** An unconfigured disposable workspace displayed the quoted successful/healthy statements after each actual Inbox tab was selected. [listReviewItems](../../src/main/domain/founderSalesDomain.ts#L1988-L2038) reads lifecycle reviews and maps only unmatched communication or system error. It does not aggregate every import, identity, transcript and adapter source. Nevertheless [reviewKindMeta](../../src/renderer/features/review/reviewKindMeta.ts#L30-L58) says “Every imported row landed cleanly,” “Every call, text, and email is matched to a person,” and “All adapters are healthy.” [ReviewQueue](../../src/renderer/features/review/ReviewQueue.tsx#L25-L29) applies a success-colored Queue clear state.

There is a second false-zero path: the query limits the oldest 200 records before kind filtering, and the tabs count only those returned rows. Later categories can appear empty while records exist. The shell badge also starts at zero and only gets populated when Inbox itself mounts ([FounderApp](../../src/renderer/app/FounderApp.tsx#L39-L48), [ReviewRoute](../../src/renderer/features/review/ReviewRoute.tsx#L52-L57)).

**Repair:** source-aware availability, complete counts and paging. “Not checked/not connected” is not zero or healthy. Preserve unresolved records rather than deleting them to reach later ones.

### F06 · P2 · Leads cannot browse beyond the first 200 matching people

**Evidence: R-Package + S.** Actual UI import produced **208 people**. The signed UI advertised 208 but its virtualized grid row model represented only 200 people (`aria-rowcount=201`, including the header) and had no next/load-more control. The public production read API returned a non-null next cursor and the remaining eight rows when that cursor was supplied. [useLeadGridState](../../src/renderer/features/leads/useLeadGridState.ts#L45-L54) always requests `cursor: null, limit: 200`. [LeadsRoute](../../src/renderer/features/leads/LeadsRoute.tsx#L106-L113) discards the backend's `nextCursor`. [LeadsPage](../../src/renderer/features/leads/LeadsPage.tsx#L113-L133) has no continuation control. Virtualization does not load a second page. The header still reports the full total.

**Repair:** real cursor-based continuation with stable filters, keyboard traversal and selection. Searching for a known hidden name is not a replacement for browsing the queue.

### F07 · P2 · Bulk edit's advertised selection differs from submitted targets

**Evidence: R-Package + S.** Select Kevin and Maya, filter to Kevin, submit “Organization for 2 selected”: only Kevin changed, the selection toolbar disappeared, and the source clears the entire selected set. Maya belonged to a different company, deliberately separating this proof from F01. Checked IDs survive filter changes, and the bar says “N selected.” [LeadsRoute](../../src/renderer/features/leads/LeadsRoute.tsx#L122-L140) intersects those IDs with only currently returned rows, submits that subset, then clears the entire selection. This is independent of F01's shared-organization widening.

**Repair:** either retain and submit the exact selected set, or explicitly clear/prune selection when the filter changes. Report actual affected identities. Never claim a two-person edit when only one target was submitted.

### F08 · P1 · New-company intake stops before the useful sales workflow

**Evidence: S, plus actual package creation/readback in the route audit.** Review/Create/Open existing really works and is not being dismissed. But [LocalAccountLibrary](../../src/renderer/features/today/LocalAccountLibrary.tsx#L13-L20) is read-only name/domain/evidence/routes. There is no company edit, research, contact admission/linking or next-conversation control. The [public local workspace contract](../../src/shared/contracts/localWorkspaceContract.ts#L35-L41) lacks those operations. Company-only Calls tells the user to link a contact without offering a linking path.

**Repair:** finish one local company → source-backed research → verified contact/route → explicit next action journey using the existing pipeline. Do not fabricate people or convert a company's office number into a person's direct route. A working identity form is not a working sales workflow.

### F09 · P1 · Setup instructions point to controls that do not exist

**Evidence: S.** Native Desk says to review worker pairing/configuration in Settings. [Settings route composition](../../src/renderer/app/routeRegistry.tsx#L85-L100) supplies local outreach configuration, not delegation setup. [ConnectionsSection](../../src/renderer/foundation/ConnectionsSection.tsx#L43-L70) configures desktop OpenAI/Gmail, not worker pairing or owner mailbox/calendar authority.

Fresh phone handoff has a separate missing start: the [phone setup API](../../src/shared/contracts/phoneSetupContract.ts#L29-L33) exists and [confirmation](../../src/main/communications/phoneRouteSettings.ts#L100-L111) creates the necessary exact proof, but there is no production renderer consumer. This finding concerns a fresh/unconfirmed setup, not an assertion about a historically configured live profile.

New-call capacity is initialized null, and its [CAS writer](../../src/main/domain/workspace/workspaceSettingsRepository.ts#L131-L152) has no production caller. Due obligations remain, but fresh-call allocation cannot be configured through the product.

**Repair:** explicit, distinct setup/status paths using existing APIs. Keep grants, proof, owner identity and activation gates. Do not silently enable services or fill proof files to mask missing UI.

### F10 · P1 · Campaign and approval screens lack preceding or completing actions

**Evidence: S.** These are capability gaps, not invitations to weaken safety:

- [CampaignReview](../../src/renderer/features/campaigns/CampaignReview.tsx#L28-L86) always says audience definition unavailable and always disables approval. The route cannot create/edit/enroll a campaign.
- Requested-email and LinkedIn screens require preexisting drafts. [requestedDraftSession](../../src/renderer/features/today/requestedDraftSession.ts#L13-L16) uses get/edit/approve but no preparation, and [LinkedInStep](../../src/renderer/features/linkedin/LinkedInStep.tsx#L16-L32) requires a saved answer. Existing preparation APIs have no production renderer first-use caller.
- [DailyAnswers](../../src/renderer/features/today/DailyAnswers.tsx#L347-L364) puts replies under Needs your approval, then shows a permanent missing-editor/permission hold instead of an approval workflow.

**Repair:** connect first-use preparation and exact audience/permission-bound approval, or present these surfaces clearly as read-only capability previews/history. Seeded drafts prove continuation, not that a founder can get there from an empty workspace. Keep the functioning local-contact email flow distinct from worker follow-ups.

### F11 · P2 · Navigation discards company input and can abandon unresolved-command UI state

**Evidence: R-Package for unsaved text, S for the unresolved-state consequence.** Type a company name, visit Campaigns, return to Accounts: the form closes and the entered text is empty. [FounderApp](../../src/renderer/app/FounderApp.tsx#L50-L60) keys and unmounts each route. [LocalCompanyIntake](../../src/renderer/features/today/LocalCompanyIntake.tsx#L21-L47) retains its form and exact request only within that hook's owner lifetime.

The Close button prevents dismissing unresolved creation, but ordinary navigation bypasses that UI retention. No lost saved record or duplicate account was reproduced. Backend receipt/duplicate guards still exist.

**Repair:** a workspace-scoped draft/unresolved-command owner, or an explicit navigation/recovery choice. Do not reset a genuinely unknown operation or mint a new command merely because the route remounted.

### F12 · P2 · File → Import Leads / Cmd-I is disconnected

**Evidence: R-Package for the actual production menu script, S for its native menu hookup.** Executing the imported `openImportScript` constant in the signed renderer navigated to Leads but opened **zero** Import dialogs. This checks the exact producer payload and actual consumer, not the physical macOS keyboard accelerator. [applicationMenu](../../src/main/applicationMenu.ts#L40-L42) navigates to Leads and emits `callie:open-import`. There is no mounted renderer listener. The button and Command-K use different callbacks that do work. The menu's comment still calls a missing listener “harmless,” although this is now a shipped user command.

**Repair:** one lifecycle-safe bridge into the existing global ImportDialog. Test the actual producer and mounted consumer together, including navigation ordering.

### F13 · P2 · Modal and error-state interaction contracts are inconsistent

**Evidence: R-Package for stacked Escape, S for missing explicit modal isolation and failed-detail close controls.** In the actual signed app, opening Command-K over full-page contact details then pressing Escape dismissed **both** layers. One Tab step landed on the palette list itself, so this audit does **not** claim that step escaped the modal or that full keyboard traversal was reproduced. [CommandPalette](../../src/renderer/app/commandPalette/CommandPalette.tsx#L98-L137) declares `aria-modal` but does not contain Tab focus or inert the background. Its Escape bubbles into [LeadFullPage](../../src/renderer/features/leadInspector/LeadFullPage.tsx#L56-L65)'s unconditional document listener. Other custom dialogs have similarly partial focus handling. ImportDialog's real native modal is a useful counterexample to preserve.

Lead detail loading and failure also remove the visible Close control: [LeadInspector](../../src/renderer/features/leadInspector/LeadInspector.tsx#L228-L243), [LeadFullPage](../../src/renderer/features/leadInspector/LeadFullPage.tsx#L67-L85). Escape is not a discoverable substitute for a close button.

**Repair:** shared topmost-layer Escape ownership, focus entry/containment/restoration where modal, and a stable closable frame around asynchronous detail content. Keep nonmodal inspectors nonmodal where appropriate.

### F14 · P2 · Several mutations lose input or hide rejection instead of reporting an outcome

**Evidence: S.** Leads invokes the same refresh for success and rejection ([LeadsRoute](../../src/renderer/features/leads/LeadsRoute.tsx#L115-L140)); inline/bulk editors close before completion. [FridayRoute](../../src/renderer/features/friday/FridayRoute.tsx#L95-L100) similarly refreshes on either result while forms clear input. Learning capture does not guard repeated Save clicks while its promise is pending.

**Repair:** preserve the user's input and command identity until the outcome is known. Show pending/rejected/unknown state locally. Prevent duplicate intent submission. Do not infer save success merely because a list refreshed.

### F15 · P2 · Diagnostics and startup failures need a current, reachable status model

**Evidence: S.** [useFoundationHealth](../../src/renderer/foundation/useFoundationHealth.ts#L18-L57) fetches on mount/API change and explicit Retry, without ongoing polling, and [healthService](../../src/main/health/healthService.ts#L34-L55) derives Operations only from sourcing health, not all product capabilities. Foundation health is fetched independently from subsequent sourcing status polling, so a rendered Operations summary need not track later sourcing success/failure. Startup initializes before exposing the normal window; a rejected startup promise reaches a catch that quits rather than the renderer's friendly retry screen. The quit handler is [main.ts](../../src/main.ts#L270-L275). A separate nonfatal domain-blocked report can admit the ordinary shell, where route Refresh repeats the same immutable startup hold rather than repairing it ([DomainRuntime](../../src/main/domain/domainRuntime.ts#L215-L249), [App](../../src/renderer/App.tsx#L19-L36)). No real failure was induced and the cause of the previously seen live Operations degraded state remains unattributed.

**Repair:** explicit freshness/source for health and a minimal reachable startup-failure surface that does not pretend the database is ready. Keep safe error redaction, full integrity/migration requirements and recovery semantics.

### F16 · P2 · Queue names and unavailable counts do not consistently mean what they say

**Evidence: S; raw unpaired Accounts/Campaigns rendering also captured in the signed audit.** [NativeDeskRoute](../../src/renderer/features/today/NativeDeskRoute.tsx#L579-L586) adds every retained commitment to Calls. Retained work includes non-call onboarding/inbound/warm obligations. Accounts/Campaigns use empty worker arrays as numeric zero while adjacent copy says the worker scope is unavailable ([account/campaign lanes](../../src/renderer/features/today/NativeDeskRoute.tsx#L703-L747)). This is why a visible local company can sit above “Accounts 0.”

**Repair:** distinguish local evidence, worker scope, call-specific work and other retained commitments. Keep all obligations visible, but stop labelling unknown counts as measured zero.

### F17 · P1 · Acceptance tests protect the split and sometimes substitute the page under test

**Evidence: S plus the new failing real-package audit.**

- [startupPresentation.spec.ts](../../tests/browser/startupPresentation.spec.ts#L201-L213) expressly restores the old brand/canvas after legacy resolution and excludes that sample from the A appearance check.
- [NativeDeskPresentation.test.tsx](../../src/renderer/features/today/NativeDeskPresentation.test.tsx#L85-L89) requires the same opt-out for all three desk surfaces.
- [bauhausWorkflow.spec.ts](../../tests/e2e/bauhausWorkflow.spec.ts#L30-L60) positively requires the old cream/FSS design. Its “all workspaces” route list omits Accounts/Campaigns.
- [nativeDeskBrowser.tsx](../../tests/fixtures/nativeDeskBrowser.tsx#L17-L35) maps most non-Accounts/Campaigns routes to Today. The [Conversations navigation check](../../tests/browser/nativeDesk.spec.ts#L808-L832) checks `aria-current`, not the actual Conversations component.
- The older [FounderApp test](../../src/renderer/app/FounderApp.test.tsx#L130-L188) omits the production daily API and therefore takes a different route branch.

**Repair:** actual production registry, destination-specific content assertions and a common shell/overlay oracle. Separate first-use, continuation, authority and live acceptance. A large suite is valuable only for the expectations it actually exercises. Retain its functioning data/authority/signature/recovery tests.

### F18 · P2 maintainability · Tests and production use duplicate adapter implementations

**Evidence: S, caller tracing, not a bundle-size measurement.** Nine direct-domain adapter factories have only test callers while the real application constructs parallel mappings in [registerApplicationIpc](../../src/main/ipc/registerApplicationIpc.ts#L83-L216). They cover Leads, lead detail, Today, Pipeline, Inbox, Friday, imports, Conversations and Learnings. For example, the direct-domain [Today factory](../../src/main/today/todayService.ts#L55-L68) tested in isolation is not the factory the shipped app uses. A change to one need not exercise the other. Some tests also exercise the real mapping, so this is not a claim that all production IPC is untested.

**Repair/remove:** consolidate mapping bodies behind the real readiness boundary, or explicitly designate intentionally separate adapters as test helpers. Then delete redundant bodies. Do **not** delete entire modules blindly: types and `unavailableOutboundCapabilities` remain live. This is a specific cleanup candidate, unlike deleting useful account/campaign/research adapters simply because their product entrypoints are unfinished.

## How this accumulated

Read-only source history traces the design split through global Bauhaus work (`e3dcc04`), route-scoped Native binding (`6ae3107`), local A refinements (`0c502f6`), and startup-marker refinement (`d06d5f9`). The last step correctly separated presentation from authority but did not make presentation global. Successive feature overrides accumulated rather than replacing the ownership boundary.

There were four integration failures:

1. **Feature-owned global styling.** A child route was allowed to change the entire product shell.
2. **Capabilities were confused with journeys.** A backend method or a populated fixture was treated as progress toward a usable workflow without requiring the preceding UI entrypoint.
3. **Compatibility assertions became product acceptance.** Tests preserved old behavior even where the user wanted one new product.
4. **Verification was scoped to islands.** Unit, browser and package checks covered many useful details, but not the joins between real routes, shared state and first-use paths. The latest installation walkthrough also did not visit those older destinations and catch the visual regression.

The recent artifact-identity release repairs did their job: this audit found defects in the intended signed bits, not a different unverified package. The problem is the acceptance contract, not simply packaging provenance.

## Fix, remove, retain

### Fix first

1. Contain incorrect mutation scope and unsupported privacy/repair affordances: F01, F04, F07, F14.
2. Establish one root presentation and overlay/layout contract across all ten routes and all workflow modes: F02, F03, F13, with F17's real-route tests first.
3. Make existing operations dependable and honest: paging, truthful counts/status, menu routing and preserved drafts: F05, F06, F11, F12, F15, F16.
4. Complete one company-to-conversation path, then the precise phone/worker/campaign/follow-up setup and preparation steps: F08-F10. Keep deployments, grants, uploads and live actions separately authorized.

These are repair priorities, not authorization for a new installation or service activation.

### Remove or retire

- The second route-selected global visual system after a common replacement is verified.
- Unsupported “all healthy/all matched/queue clear” certainty, inert action affordances that imply a usable operation, and stale keyboard instructions.
- Misleading whole-app test names and route proxies from acceptance coverage. Keep scoped fixtures for honestly named component tests.
- Redundant override blocks after their responsibilities have moved to the shared contract, not via blind CSS deletion.

### Retain

- Real legacy Leads/Pipeline/Conversations/Learnings/Inbox/Friday data and useful workflows. Their old appearance is not evidence that the data or functionality is dead.
- Canonical identities, receipts, migration and recovery code, retained obligations, suppression and current authority checks.
- Verified startup/read-performance changes, safe parsing, exact artifact selection/signature verification, and the real company intake/readback/reuse path.
- Existing useful research, campaign and communication adapters. Wire or deliberately retire their capabilities based on product decisions, not an unused-import count alone.

**No broad rollback or history deletion is justified by this audit.** No production modules were deleted. The nine duplicate factory bodies are an additional evidence-backed consolidation candidate, not a blanket deletion authorization. This is primarily integration debt, missing workflow composition and a set of concrete defects, not a reason to start the application over.

## Verification record and limits

- The 80-screen audit completed all captures and intentionally failed the common-shell oracle. Its captured child exited with code 0 and its owned profile was removed.
- The final bounded signed follow-up completed actual menu, all six empty Inbox tabs, hidden-selection bulk edit, 208-person paging, two full-page geometries and stacked Escape observations. Four expectations failed as predicted: menu dialog, whole selected bulk scope, zero full-page gap and topmost-only Escape. Paging was demonstrated by exact read/UI counts and absence of a continuation control, not counted as another failed assertion.
- The scratch follow-up initially used the wrong exact text locator for a split heading. It was corrected to the actual accessible heading. A preserved original test was accidentally rediscovered by the broad scratch test glob and reran sequentially before the corrected test. These harness failures are retained and are not counted as product findings. No concurrent candidate processes or owned profiles remained. The scratch configuration now excludes the preserved copy; no additional app run was needed to establish the completed corrected test's observations.
- Three final isolated production-domain probes reproduced the shared-organization behavior and two unsupported Inbox results. The first attempt used a wrong property name in a scratch assertion, then was corrected to the actual DTO's `organization`. Initial and corrected evidence are retained. This is six individual probe executions, not six independent product defects.
- No full release suite was rerun for a documentation-only audit. The earlier passing suite remains evidence of its scoped checks, not a reason to discount newly reproduced defects. No main-process-wide egress sandbox or exhaustive side-effect proof is claimed from the renderer request observer.

## Remaining uncertainty and evidence location

Not reproduced here: all configured live provider paths, real iPhone/carrier behavior, global research deduplication, all failure/recovery interleavings, data-dependent unknown-command navigation, and populated Native queue density. The density rules appear to override spacing with constants, but this remains a candidate rather than a confirmed queue-height regression. Previously observed startup latency is not remeasured or claimed fixed.

The current restore drill checks a temporary copy, integrity/schema and selected legacy counts. It is **not** a full restored-app/domain-launch acceptance test or an existing live-workspace rescue UI. This limit does not establish damaged backups and does not justify rolling back schema/history.

Private audit evidence is under `~/.jcode/scratch/fss-adversarial-audit-20260910/`: frozen baseline, actual 80-route measurement JSON/screenshots, grouped comparison, independent design/workflow/architecture/verification reviews, scratch probes and process cleanup records. The user reading copy includes selected paired screenshots and the detailed reports.

The audit request is fulfilled by identifying, testing and prioritizing these defects. It does not mean the defects are fixed or that the installed app is now accepted.
